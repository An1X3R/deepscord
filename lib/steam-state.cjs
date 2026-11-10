// @ts-check
'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { validateAvatar, validateProfileId } = require('./profile-avatar.cjs');
const { readNetworkPolicy } = require('./network-policy.cjs');
const { parseGovernance,parseMemberKey,createGovernanceVerifier } = require('./server-governance.cjs');
const {parseChatMessage,parseMediaMetadata}=require('../public/js/chat-protocol.js');
const {verifyContentPolicy,verifyContentOwner}=require('./content-upgrade.cjs');
const {verifySealedMessage,reactionRequestId}=require('./content-crypto.cjs');
const {parseRadioConfig}=require('../public/js/radio-protocol.js');
const {reactionActor}=require('./message-reactions.cjs');

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
/** @typedef {{id:string,name:string,userLimit:number} & ({type:'voice'|'text'}|{type:'radio',radio:import('../public/js/radio-protocol.js').RadioConfig})} RoomChannel */
/** @typedef {{id:string,name:string,icon:string,color:string,channels:RoomChannel[]}} RoomServer */
/** @typedef {Omit<import('../public/js/chat-protocol.js').ChatMessage,'bot'> & {bot?:boolean}} HistoryMessage */
/** @typedef {{version:1,servers:RoomServer[],messages:Record<string,HistoryMessage[]>,retainedReactionAssets?:import('../public/js/chat-protocol.js').MediaMetadata[],governance?:import('./server-governance.cjs').GovernanceJournal,content?:import('../public/js/content-protocol.js').ContentPolicy}} RoomStore */
/** @typedef {{roomId:string,creatorKey:string,document:import('./room-replica.cjs').RoomDocument|null,governance?:import('./server-governance.cjs').GovernanceJournal}} SteamRoomSeed */
/** @typedef {{id:string,name:string,color:string,profileId:string|null,avatar:string|null,muted:boolean,deafened:boolean,serverMuted?:boolean,voiceChannelId:string|null,signalConnected:boolean,memberKey?:string|null}} SteamPublicUser */
/** @typedef {{version:1,lobbyId:string,ownerId:string,epoch:string,sequence:number,stunUrls:string[],store:RoomStore,users:SteamPublicUser[],roomDocument?:import('./room-replica.cjs').RoomDocument}} SteamCheckpoint */
/** @typedef {{steamId:string,session:string,mac:string}} SteamIdentity */
/** @typedef {(value:JsonValue,descriptor:import('./room-replica.cjs').RoomDescriptor)=>import('./server-governance.cjs').GovernanceJournal} VerifyJournal */
/** @typedef {(value:JsonValue)=>RoomStore} ParseStore */

const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_UINT64 = (1n << 64n) - 1n;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const SESSION_PATTERN = /^[a-f0-9]{32}$/;

/** @param {JsonValue|undefined} value @param {string} field @returns {JsonObject} */
function object(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be a JSON object.`);
  return value;
}

/** @param {JsonValue|undefined} value @param {string} field @param {number} maximum @returns {JsonValue[]} */
function array(value, field, maximum) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array.`);
  if (value.length > maximum) throw new RangeError(`${field} exceeds its ${maximum}-entry limit.`);
  return value;
}

/** @param {JsonValue|undefined} value @param {string} field @param {number} maximum @returns {string} */
function string(value, field, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new TypeError(`${field} must contain 1-${maximum} characters.`);
  return value;
}

/** @param {JsonValue|undefined} value @param {string} field @returns {string} */
function identifier(value, field) {
  const result = string(value, field, 80);
  if (!ID_PATTERN.test(result) || ['__proto__', 'prototype', 'constructor'].includes(result)) throw new TypeError(`${field} must be a safe nonreserved ASCII identifier.`);
  return result;
}

/** @param {JsonValue|undefined} value @param {string} field @param {number} maximum @returns {string} */
function name(value, field, maximum) {
  const result = string(value, field, maximum);
  if (!result.trim() || /[\u0000-\u001f\u007f]/.test(result)) throw new TypeError(`${field} must be nonblank and contain no control characters.`);
  return result;
}

/** @param {JsonValue|undefined} value @param {string} field @returns {string} */
function color(value, field) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError(`${field} must be a six-digit hexadecimal color.`);
  return value;
}

/** @param {JsonValue|undefined} value @param {string} field @returns {boolean} */
function boolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must explicitly be a boolean.`);
  return value;
}

/** @param {JsonValue|undefined} value @param {string} field @param {number} minimum @param {number} maximum @returns {number} */
function integer(value, field, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${field} must be a safe integer in ${minimum}..${maximum}.`);
  return value;
}

/** @param {ReadonlySet<string>} ids @param {string} id @param {string} field @returns {void} */
function unique(ids, id, field) {
  if (ids.has(id)) throw new TypeError(`${field} contains duplicate identifier '${id}'.`);
}

/** @param {JsonValue|undefined} value @returns {HistoryMessage} */
function parseMessage(value) {
  const row = object(value, 'History message');
  const id = identifier(row.id, 'History message id');
  const parsed=parseChatMessage(row);
  const text = parsed.text;
  return {
    id, userId: identifier(row.userId, 'History message userId'), name: name(row.name, 'History message name', 24),
    color: color(row.color, 'History message color'), text,
    ts: integer(row.ts, 'History message ts', 0, Number.MAX_SAFE_INTEGER), system: boolean(row.system, 'History message system'),
    ...(row.bot === undefined ? {} : { bot: boolean(row.bot, 'History message bot') }),
    ...(parsed.attachment ? {attachment:parsed.attachment} : {}),
    ...(parsed.reactions ? {reactions:parsed.reactions} : {}),
    ...(parsed.reactionRevision===undefined ? {} : {reactionRevision:parsed.reactionRevision}),
    ...(parsed.clientRequestId===undefined ? {} : {clientRequestId:parsed.clientRequestId,authorId:parsed.authorId}),
    ...(parsed.sealedReactions===undefined?{}:{sealedReactions:parsed.sealedReactions}),
    ...(parsed.sealed===undefined ? {} : {sealed:parsed.sealed}),
  };
}

/** @param {JsonValue} value @param {VerifyJournal} verifyJournal @returns {RoomStore} */
function readStore(value, verifyJournal) {
  const input = object(value, 'Room store');
  if (input.version !== 1) throw new TypeError('Room store version must be 1.');
  /** @type {Set<string>} */ const serverIds = new Set();
  /** @type {Set<string>} */ const channelIds = new Set();
  /** @type {Set<string>} */ const messageIds = new Set();
  const servers = array(input.servers, 'Room servers', 12).map(value => {
    const row = object(value, 'Room server');
    const id = identifier(row.id, 'Server id');
    unique(serverIds, id, 'Room servers');
    serverIds.add(id);
    const icon = name(row.icon, 'Server icon', 2);
    if ([...icon].length !== 1) throw new TypeError('Server icon must be exactly one Unicode code point.');
    /** @type {RoomChannel[]} */
    const channels = array(row.channels, 'Server channels', 40).map(value => {
      const row = object(value, 'Room channel');
      const id = identifier(row.id, 'Channel id');
      unique(channelIds, id, 'Room channels');
      channelIds.add(id);
      if (row.type !== 'voice' && row.type !== 'text' && row.type !== 'radio') throw new TypeError('Channel type must be voice, text or radio.');
      const userLimit = integer(row.userLimit, 'Channel userLimit', 0, 100);
      if (row.type === 'text' && userLimit !== 0) throw new TypeError('Text channel userLimit must be zero.');
      const base={id,name:name(row.name,'Channel name',20)};
      // Keep the v1 field order: persisted room digests include JSON key order.
      if(row.type==='radio'){const radio=parseRadioConfig(row.radio);parseMemberKey(radio.creatorKey);return {...base,type:'radio',userLimit,radio};}
      return {...base,type:row.type,userLimit};
    });
    return { id, name: name(row.name, 'Server name', 20), icon, color: color(row.color, 'Server color'), channels };
  });
  const sourceMessages = object(input.messages, 'Room messages');
  /** @type {Array<[string,HistoryMessage[]]>} */
  const messages = Object.entries(sourceMessages).map(([channelId, value]) => {
    identifier(channelId, 'Messages channel id');
    if (!channelIds.has(channelId)) throw new TypeError(`Messages channel '${channelId}' does not exist in the room store.`);
    const entries = array(value, `Messages for '${channelId}'`, 300).map(parseMessage);
    for (const message of entries) { unique(messageIds, message.id, 'History messages'); messageIds.add(message.id); }
    return [channelId, entries];
  });
  const governance = input.governance === undefined ? undefined : verifyJournal(input.governance, require('./room-replica.cjs').parseRoomDescriptor(input.governance));
  const content=input.content===undefined ? undefined : verifyContentPolicy(input.content,governance?.roomId || '');
  if(content){
    if(!governance)throw new TypeError('Encrypted room store requires its governance journal');
    verifyContentOwner(content,governance);
    for(const [channelId,entries] of messages)for(const message of entries){
      if(!message.sealed||message.sealed.keyId!==content.keyId||!message.clientRequestId||message.authorId!==reactionActor(message.sealed.memberKey))throw new TypeError('Encrypted room history contains an unsealed or unbound message');
      verifySealedMessage({roomId:content.roomId,channelId,requestId:message.clientRequestId},message.sealed);
      for(const event of message.sealedReactions ?? []){if(event.sealed.keyId!==content.keyId)throw new TypeError('Reaction history uses a different room key');verifySealedMessage({roomId:content.roomId,channelId,requestId:reactionRequestId(message.id,event.requestId)},event.sealed);}
    }
  }else if(messages.some(([,entries])=>entries.some(message=>message.sealed)))throw new TypeError('Plaintext room store cannot contain encrypted messages without a policy');
  const retainedReactionAssets=input.retainedReactionAssets===undefined?undefined:array(input.retainedReactionAssets,'Retained encrypted reaction assets',4096).map(value=>parseMediaMetadata(value));
  if(retainedReactionAssets&&(!content||retainedReactionAssets.some(asset=>asset.encrypted!==true)||new Set(retainedReactionAssets.map(asset=>asset.sha256)).size!==retainedReactionAssets.length))throw new TypeError('Retained reaction assets require unique encrypted files and a room policy');
  return { version: 1,...(retainedReactionAssets?{retainedReactionAssets}:{}), servers, messages: Object.fromEntries(messages), ...(governance ? {governance} : {}),...(content?{content}:{}) };
}

/** @param {JsonValue} value @returns {RoomStore} */
function parseSteamStore(value) { return readStore(value,parseGovernance); }

/** @param {string} steamId @returns {string} */
function stableSteamUserId(steamId) {
  if (typeof steamId !== 'string' || !/^[1-9][0-9]{15,19}$/.test(steamId) || BigInt(steamId) > MAX_UINT64) throw new TypeError('Steam ID must be a canonical 16-20 digit decimal uint64.');
  return 'u_steam_' + steamId;
}

/** @param {JsonValue|undefined} value @param {string} field @returns {string} */
function steamId(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a decimal Steam ID.`);
  stableSteamUserId(value);
  return value;
}

/** @param {JsonValue} value @param {RoomStore} store @returns {SteamPublicUser[]} */
function parseSteamUsers(value, store) {
  const voiceChannels = new Set(store.servers.flatMap(server => server.channels.filter(channel => channel.type !== 'text').map(channel => channel.id)));
  /** @type {Set<string>} */ const ids = new Set();
  return array(value, 'Steam public users', 10).map(value => {
    const row = object(value, 'Steam public user');
    const id = identifier(row.id, 'Steam user id');
    if (!id.startsWith('u_steam_') || stableSteamUserId(id.slice(8)) !== id) throw new TypeError('Steam user id must be derived from its canonical Steam ID.');
    unique(ids, id, 'Steam public users');
    ids.add(id);
    const voiceChannelId = row.voiceChannelId === null ? null : identifier(row.voiceChannelId, 'User voiceChannelId');
    if (voiceChannelId !== null && !voiceChannels.has(voiceChannelId)) throw new TypeError(`User voiceChannelId '${voiceChannelId}' is not an existing voice channel.`);
    return {
      id, name: name(row.name, 'User name', 24), color: color(row.color, 'User color'),
      profileId: row.profileId === null ? null : validateProfileId(row.profileId), avatar: validateAvatar(row.avatar),
      ...(row.serverMuted===undefined?{}:{serverMuted:boolean(row.serverMuted,'User serverMuted')}),
      muted: boolean(row.muted, 'User muted'), deafened: boolean(row.deafened, 'User deafened'),
      voiceChannelId, signalConnected: boolean(row.signalConnected, 'User signalConnected'),
      ...(row.memberKey === undefined ? {} : { memberKey:row.memberKey === null ? null : parseMemberKey(row.memberKey) }),
    };
  });
}

/** @param {JsonValue} value @param {ParseStore} parseStore @returns {SteamCheckpoint} */
function readCheckpoint(value, parseStore) {
  // The caller must also bound the original transport bytes before JSON.parse.
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_CHECKPOINT_BYTES) throw new RangeError('Steam checkpoint input exceeds the 4 MiB JSON limit.');
  const input = object(value, 'Steam checkpoint');
  if (input.version !== 1) throw new TypeError('Steam checkpoint version must be 1.');
  const lobbyId = string(input.lobbyId, 'Steam lobbyId', 20);
  if (!/^[1-9][0-9]*$/.test(lobbyId) || BigInt(lobbyId) > MAX_UINT64) throw new TypeError('Steam lobbyId must be a canonical positive decimal uint64.');
  const ownerId = steamId(input.ownerId, 'Steam ownerId');
  const epoch = string(input.epoch, 'Checkpoint epoch', 32);
  if (!SESSION_PATTERN.test(epoch)) throw new TypeError('Checkpoint epoch must be 32 lowercase hexadecimal characters.');
  const sequence = integer(input.sequence, 'Checkpoint sequence', 1, Number.MAX_SAFE_INTEGER);
  const urls = array(input.stunUrls, 'Checkpoint stunUrls', 8).map(value => {
    const url = string(value, 'STUN URL', 2048);
    if (url.includes(',')) throw new TypeError('Each stunUrls entry must contain exactly one STUN URL.');
    return url;
  });
  const network = readNetworkPolicy({ ECHO_NETWORK_MODE: 'server', ECHO_MEDIA_POLICY: 'direct', STUN_URLS: urls.join(',') });
  const store = parseStore(input.store);
  const users = parseSteamUsers(input.users, store);
  const rawDocument = input.roomDocument === undefined ? undefined : object(input.roomDocument, 'Checkpoint roomDocument');
  const roomDocument = rawDocument === undefined ? undefined : parseSteamRoomSeed({ roomId: rawDocument.roomId, creatorKey: rawDocument.creatorKey, document: rawDocument }).document;
  if (input.roomDocument !== undefined && roomDocument === null) throw new TypeError('Checkpoint roomDocument must be an explicit room document.');
  if (roomDocument && store.governance && (store.governance.roomId !== roomDocument.roomId || store.governance.creatorKey !== roomDocument.creatorKey)) throw new TypeError('Checkpoint governance differs from its pinned room document');
  return { version: 1, lobbyId, ownerId, epoch, sequence, stunUrls: network.stunUrls, store, users, ...(roomDocument ? { roomDocument } : {}) };
}

/** @param {JsonValue} value @returns {SteamCheckpoint} */
function parseSteamCheckpoint(value) { return readCheckpoint(value,parseSteamStore); }

/** Reuse governance proofs while validating every surrounding snapshot. @param {{maxEntries:number,maxBytes:number}} options */
function createSteamStateReader(options) {
  const verifier = createGovernanceVerifier(options);
  /** @type {VerifyJournal} */
  const verifyJournal = (value,descriptor)=>verifier.verify(value,descriptor).journal;
  /** @param {JsonValue} value @returns {RoomStore} */
  function parseStore(value) { return readStore(value,verifyJournal); }
  /** @param {JsonValue} value @returns {SteamCheckpoint} */
  function parseCheckpoint(value) { return readCheckpoint(value,parseStore); }
  return { parseStore,parseCheckpoint };
}

/** Parse the pinned room seed without a top-level circular dependency.
 * @param {JsonValue} value @returns {SteamRoomSeed} */
function parseSteamRoomSeed(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CHECKPOINT_BYTES) throw new RangeError('Room seed input exceeds the 4 MiB JSON limit.');
  const input = object(value, 'Room seed');
  const {governance:journalInput,...documentInput}=input;
  if (Buffer.byteLength(JSON.stringify(documentInput),'utf8') > 1024 * 1024) throw new RangeError('Room seed document input exceeds the 1 MiB JSON limit.');
  const { parseRoomDescriptor, parseRoomDocument } = require('./room-replica.cjs');
  const descriptor = parseRoomDescriptor({ version: 1, roomId: input.roomId, creatorKey: input.creatorKey });
  if (input.document === undefined) throw new TypeError('Room seed document must be explicitly null or a room document.');
  const document = input.document === null ? null : parseRoomDocument(input.document, descriptor);
  const governance = journalInput === undefined ? undefined : parseGovernance(journalInput,descriptor);
  return { roomId: descriptor.roomId, creatorKey: descriptor.creatorKey, document, ...(governance ? {governance} : {}) };
}

/** @param {Buffer} secret @returns {void} */
function validateSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new TypeError('Steam identity secret must be exactly 32 bytes.');
}

/** @param {string} lobbyId @param {string} steamId @param {string} session @returns {string} */
function identityPayload(lobbyId, steamId, session) {
  if (typeof lobbyId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(lobbyId) || BigInt(lobbyId) > MAX_UINT64) throw new TypeError('Steam identity lobbyId must be a canonical positive decimal uint64.');
  stableSteamUserId(steamId);
  if (typeof session !== 'string' || !SESSION_PATTERN.test(session)) throw new TypeError('Steam identity session must be 32 lowercase hexadecimal characters.');
  return JSON.stringify(['deepscord-steam-identity-v1', lobbyId, steamId, session]);
}

/** @param {Buffer} secret @param {string} lobbyId @param {string} steamId @param {string} session @returns {SteamIdentity} */
function signSteamIdentity(secret, lobbyId, steamId, session) {
  validateSecret(secret);
  const payload = identityPayload(lobbyId, steamId, session);
  return { steamId, session, mac: createHmac('sha256', secret).update(payload, 'utf8').digest('hex') };
}

/** @param {JsonValue} value @param {Buffer} secret @param {string} lobbyId @returns {string} */
function verifySteamIdentity(value, secret, lobbyId) {
  validateSecret(secret);
  const input = object(value, 'Steam identity');
  const id = steamId(input.steamId, 'Identity steamId'), session = string(input.session, 'Identity session', 32);
  const payload = identityPayload(lobbyId, id, session);
  const mac = string(input.mac, 'Identity mac', 64);
  if (!/^[a-f0-9]{64}$/.test(mac)) throw new TypeError('Steam identity MAC must be 64 lowercase hexadecimal characters.');
  const expected = createHmac('sha256', secret).update(payload, 'utf8').digest();
  if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) throw new TypeError('Steam identity signature does not match its lobby, Steam ID and session.');
  return stableSteamUserId(id);
}

module.exports = { parseSteamStore, parseSteamUsers, parseSteamCheckpoint, parseSteamRoomSeed, createSteamStateReader, stableSteamUserId, signSteamIdentity, verifySteamIdentity };
