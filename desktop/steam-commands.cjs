// @ts-check
'use strict';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/network-protocol.js').PeerSignal} PeerSignal */
/** @typedef {{[key: string]: JsonValue}} JsonObject */
/** @typedef {(value: JsonValue, policy: 'direct') => PeerSignal} ParseSignal */

const MAX_JSON_BYTES = 150000;
const MAX_ROOM_SYNC_BYTES = 1024 * 1024;
const MAX_IDENTITY_BYTES = 3 * 1024 * 1024;
const { validateAvatar, validateProfileId } = require('./app-server/lib/profile-avatar.cjs');
const { parseRoomDescriptor, verifyRoomVote } = require('./app-server/lib/room-replica.cjs');
const { parseGovernance, parseGovernanceCommand } = require('./app-server/lib/server-governance.cjs');
const {parseMediaRequest,parseAttachment,parseReactionSelection,mediaId}=require('./app-server/public/js/chat-protocol.js');
/** @type {typeof import('../public/js/content-protocol.js')} */
const {parseContentMessage,parseContentPolicy,contentKeyId}=require('./app-server/public/js/content-protocol.js');
const {parseRadioSelection,parseRadioConfig,parseRadioStation}=require('./app-server/public/js/radio-protocol.js');
const MAX_NAME_LENGTH = 24;
const MAX_CHANNEL_NAME_LENGTH = 20;
const MAX_TEXT_LENGTH = 2000;
const MAX_ID_LENGTH = 80;
const MAX_RESUME_TOKEN_LENGTH = 256;

/** @param {JsonValue} value @returns {JsonObject} */
function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Steam client command must be a JSON object.');
  }
  return value;
}

/** @param {JsonObject} input @param {string} field @param {number} maxLength @returns {string} */
function requiredString(input, field, maxLength) {
  const value = input[field];
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new TypeError(`Steam client command field '${field}' must be a string no longer than ${maxLength} characters.`);
  }
  return value;
}

/** @param {JsonObject} input @param {string} field @returns {string} */
function requiredIdentifier(input, field) {
  const value = requiredString(input, field, MAX_ID_LENGTH);
  if (value.length === 0) {
    throw new TypeError(`Steam client command field '${field}' must be a nonempty identifier.`);
  }
  return value;
}

/** @param {JsonObject} input @param {string} field @param {number} maxLength @returns {string | undefined} */
function optionalString(input, field, maxLength) {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new TypeError(`Steam client command field '${field}' must be a string no longer than ${maxLength} characters.`);
  }
  return value;
}

/** @param {JsonObject} input @param {string} field @returns {boolean | undefined} */
function optionalBoolean(input, field) {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new TypeError(`Steam client command field '${field}' must be a boolean.`);
  }
  return value;
}

/** @param {JsonObject} input @param {string} field @returns {number} */
function requiredTimestamp(input, field) {
  const value = input[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Steam client command field '${field}' must be a nonnegative safe integer.`);
  }
  return value;
}

/** @param {JsonObject} input @param {string} field @returns {number | undefined} */
function optionalUserLimit(input, field) {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new TypeError(`Steam client command field '${field}' must be an integer from 0 to 100.`);
  }
  return value;
}

/** @param {JsonObject} input @returns {string} */
function requiredRoundId(input) {
  const roundId = requiredString(input, 'roundId', 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(roundId)) throw new TypeError('Room synchronization roundId must be a canonical lowercase UUID.');
  return roundId;
}

/** @param {JsonValue} value @returns {import('../public/js/chat-protocol.js').Attachment} */
function encryptedAttachment(value){
  const attachment=parseAttachment(value);
  if(attachment.encrypted!==true)throw new TypeError('Encrypted Steam messages require encrypted attachments');
  return {...attachment,name:'encrypted.avif'};
}

/** @param {JsonObject} input @returns {JsonObject} */
function contentCommand(input){
  const requestId=mediaId(input.requestId,'Content request'),op=input.op;
  if(op==='begin')return {t:'contentRequest',requestId,op,keyId:contentKeyId(input.keyId)};
  const migrationId=mediaId(input.migrationId,'Content migration');
  if(op==='cancel')return {t:'contentRequest',requestId,op,migrationId};
  if(op==='read'){
    const index=requiredTimestamp(input,'index');
    if(index>=144000)throw new RangeError('Steam history migration index exceeds its bounded inventory');
    return {t:'contentRequest',requestId,op,migrationId,index};
  }
  if(op==='replace'){
    if(input.sealed===undefined)throw new TypeError('Steam history replacement requires an encrypted message');
    return {t:'contentRequest',requestId,op,migrationId,channelId:mediaId(input.channelId,'Content channel'),messageId:mediaId(input.messageId,'Content message'),sealed:parseContentMessage(input.sealed),...(input.attachment===undefined?{}:{attachment:encryptedAttachment(input.attachment)})};
  }
  if(op==='commit'){
    if(input.policy===undefined)throw new TypeError('Steam history activation requires a signed content policy');
    return {t:'contentRequest',requestId,op,migrationId,policy:parseContentPolicy(input.policy)};
  }
  throw new TypeError('Unsupported Steam history encryption operation');
}

/** @param {JsonObject} input @returns {JsonObject} */
function cleanCommand(input) {
  const type = input.t;
  if (typeof type !== 'string') throw new TypeError('Steam client command field \'t\' must be a string.');
  switch (type) {
    case 'identityProof': {
      const nonce=requiredString(input,'nonce',64);
      if (!/^[a-f0-9]{64}$/.test(nonce)) throw new TypeError('Identity nonce must be 64 lowercase hexadecimal characters.');
      const memberKey=requiredString(input,'memberKey',256);
      parseRoomDescriptor({version:1,roomId:'00000000-0000-4000-8000-000000000000',creatorKey:memberKey});
      const signature=requiredString(input,'signature',88);
      if (Buffer.from(signature,'base64').length!==64 || Buffer.from(signature,'base64').toString('base64')!==signature) throw new TypeError('Identity signature must be canonical Ed25519 base64.');
      const governance=input.governance===undefined ? undefined : parseGovernance(input.governance,parseRoomDescriptor(input.governance));
      return {t:type,nonce,memberKey,signature,...(governance ? {governance} : {})};
    }
    case 'governanceChange': {
      const event=requireObject(input.event);
      const revision=requiredTimestamp(event,'revision');
      if (revision<1) throw new TypeError('Governance revision must be positive.');
      const previousDigest=requiredString(event,'previousDigest',64);
      if (!/^[a-f0-9]{64}$/.test(previousDigest)) throw new TypeError('Governance digest must be 64 lowercase hexadecimal characters.');
      const actorKey=requiredString(event,'actorKey',256);
      parseRoomDescriptor({version:1,roomId:'00000000-0000-4000-8000-000000000000',creatorKey:actorKey});
      const signature=requiredString(event,'signature',88);
      if (Buffer.from(signature,'base64').length!==64 || Buffer.from(signature,'base64').toString('base64')!==signature) throw new TypeError('Governance signature must be canonical Ed25519 base64.');
      if (event.command===undefined) throw new TypeError('Governance event requires command.');
      return {t:type,event:{revision,previousDigest,actorKey,signature,command:parseGovernanceCommand(event.command)},...(input.requestId===undefined ? {} : {requestId:requiredIdentifier(input,'requestId')})};
    }
    case 'claimOwner': return {t:type,token:requiredString(input,'token',256)};
    case 'updateDomain': return {t:type,domainId:requiredIdentifier(input,'domainId'),name:requiredString(input,'name',MAX_CHANNEL_NAME_LENGTH)};
    case 'deleteMessage': return {t:type,channelId:requiredIdentifier(input,'channelId'),messageId:requiredIdentifier(input,'messageId')};
    case 'disconnectVoice': return {t:type,userId:requiredIdentifier(input,'userId')};
    case 'roomSyncVote': {
      const document = requireObject(input.document);
      const descriptor = parseRoomDescriptor({ version: document.version, roomId: document.roomId, creatorKey: document.creatorKey });
      // The backend additionally binds this valid proof to its current descriptor and round.
      const vote = verifyRoomVote(input, descriptor, requiredRoundId(input));
      return { t: type, ...vote };
    }
    case 'roomSyncChoose': {
      const digest = requiredString(input, 'digest', 64);
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('Room synchronization digest must be 64 lowercase hexadecimal characters.');
      return { t: type, roundId: requiredRoundId(input), digest };
    }
    case 'hello': {
      const name = requiredString(input, 'name', MAX_NAME_LENGTH);
      const color = requiredString(input, 'color', 7);
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new TypeError('Steam client hello color must be a six-digit hexadecimal color.');
      const password = requiredString(input, 'password', 256);
      const resumable = optionalBoolean(input, 'resumable');
      const resumeToken = optionalString(input, 'resumeToken', MAX_RESUME_TOKEN_LENGTH);
      const profileId = input.profileId === undefined ? undefined : validateProfileId(input.profileId);
      const avatar = input.avatar === undefined ? undefined : validateAvatar(input.avatar);
      if (resumeToken === '') throw new TypeError('Steam client resumeToken must be nonempty when provided.');
      if(input.contentVersion!==undefined&&input.contentVersion!==1)throw new TypeError('Steam content protocol version must be 1 when provided');
      return {
        t: 'hello', name, color, password,
        ...(resumable === undefined ? {} : { resumable }),
        ...(resumeToken === undefined ? {} : { resumeToken }),
        ...(profileId === undefined ? {} : { profileId }),
        ...(avatar === undefined ? {} : { avatar }),
        ...(input.contentVersion===undefined ? {} : {contentVersion:1}),
      };
    }
    case 'ping':
      return { t: 'ping', ts: requiredTimestamp(input, 'ts') };
    case 'rename': {
      const name = requiredString(input, 'name', MAX_NAME_LENGTH);
      const color = input.color;
      const profileId = input.profileId === undefined ? undefined : validateProfileId(input.profileId);
      const avatar = input.avatar === undefined ? undefined : validateAvatar(input.avatar);
      if (color !== undefined && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color))) {
        throw new TypeError('Steam client rename color must be a six-digit hexadecimal color.');
      }
      return { t: 'rename', name,
        ...(color === undefined ? {} : { color }),
        ...(profileId === undefined ? {} : { profileId }),
        ...(avatar === undefined ? {} : { avatar }),
      };
    }
    case 'joinVoice': {
      const channelId = requiredIdentifier(input, 'channelId');
      const muted = optionalBoolean(input, 'muted');
      const deafened = optionalBoolean(input, 'deafened');
      return {
        t: 'joinVoice', channelId,
        ...(muted === undefined ? {} : { muted }),
        ...(deafened === undefined ? {} : { deafened }),
      };
    }
    case 'leaveVoice':
    case 'refreshNetwork':
      return { t: type };
    case 'micState': {
      const muted = optionalBoolean(input, 'muted');
      const deafened = optionalBoolean(input, 'deafened');
      if (muted === undefined && deafened === undefined) {
        throw new TypeError('Steam client micState requires muted or deafened state.');
      }
      return {
        t: 'micState',
        ...(muted === undefined ? {} : { muted }),
        ...(deafened === undefined ? {} : { deafened }),
      };
    }
    case 'signal':
      return {
        t: 'signal',
        to: requiredIdentifier(input, 'to'),
        data: input.data,
      };
    case 'mediaRequest': return {t:type,...parseMediaRequest(input)};
    case 'contentRequest': return contentCommand(input);
    case 'setVoiceMute': {if(typeof input.muted!=='boolean')throw new TypeError('Voice moderation requires explicit mute state');return {t:type,userId:requiredIdentifier(input,'userId'),muted:input.muted};}
    case 'setReaction': {
      const target={t:type,requestId:requiredIdentifier(input,'requestId'),channelId:requiredIdentifier(input,'channelId'),messageId:requiredIdentifier(input,'messageId')};
      if(input.sealed!==undefined){if(input.selection!==undefined||input.active!==undefined)throw new TypeError('Encrypted reactions cannot contain plaintext choices');return {...target,sealed:parseContentMessage(input.sealed)};}
      if(typeof input.active!=='boolean' || input.selection===undefined)throw new TypeError('Reaction requires explicit active state and selection');
      return{...target,active:input.active,selection:parseReactionSelection(input.selection)};
    }
    case 'chat': {
      const text=requiredString(input,'text',MAX_TEXT_LENGTH),sealed=input.sealed===undefined?null:parseContentMessage(input.sealed);
      if(sealed&&(text!==''||input.requestId===undefined))throw new TypeError('Encrypted Steam chat requires an explicit request ID and empty outer text');
      return {
        t: 'chat',
        channelId: requiredIdentifier(input, 'channelId'),
        text,
        ...(sealed?{sealed}:{}),
        ...(input.attachment===undefined ? {} : {attachment:sealed?encryptedAttachment(input.attachment):parseAttachment(input.attachment)}),
        ...(input.requestId===undefined ? {} : {requestId:sealed ? mediaId(input.requestId,'Encrypted chat request') : requiredIdentifier(input,'requestId')}),
      };
    }
    case 'radioChange': return {t:type,requestId:mediaId(input.requestId,'Radio request ID'),channelId:mediaId(input.channelId,'Radio channel ID'),radio:parseRadioConfig(input.radio)};
    case 'radioPropose': return {t:type,requestId:mediaId(input.requestId,'Radio request ID'),channelId:mediaId(input.channelId,'Radio channel ID'),station:parseRadioStation(input.station)};
    case 'radioApprove': return {t:type,requestId:mediaId(input.requestId,'Radio request ID'),channelId:mediaId(input.channelId,'Radio channel ID'),voteId:mediaId(input.voteId,'Radio vote ID')};
    case 'createChannel': {
      const channelType = input.type;
      if (channelType !== 'voice' && channelType !== 'text' && channelType !== 'radio') {
        throw new TypeError('Steam client createChannel type must be voice, text or radio.');
      }
      const userLimit = optionalUserLimit(input, 'userLimit');
      return {
        t: 'createChannel',
        serverId: requiredIdentifier(input, 'serverId'),
        type: channelType,
        ...(channelType==='radio'?{radio:parseRadioSelection(input.radio)}:{}),
        name: requiredString(input, 'name', MAX_CHANNEL_NAME_LENGTH),
        ...(userLimit === undefined ? {} : { userLimit }),
      };
    }
    case 'updateChannel': {
      const name = optionalString(input, 'name', MAX_CHANNEL_NAME_LENGTH);
      const userLimit = optionalUserLimit(input, 'userLimit');
      if (name === undefined && userLimit === undefined) {
        throw new TypeError('Steam client updateChannel requires name or userLimit.');
      }
      return {
        t: 'updateChannel',
        channelId: requiredIdentifier(input, 'channelId'),
        ...(name === undefined ? {} : { name }),
        ...(userLimit === undefined ? {} : { userLimit }),
      };
    }
    case 'deleteChannel':
      return { t: 'deleteChannel', channelId: requiredIdentifier(input, 'channelId') };
    case 'createServer':
      return { t: 'createServer', name: requiredString(input, 'name', MAX_CHANNEL_NAME_LENGTH) };
    case 'deleteServer':
      return { t: 'deleteServer', serverId: requiredIdentifier(input, 'serverId') };
    default:
      throw new TypeError(`Unsupported Steam client command type '${type}'.`);
  }
}

/** @param {string} text @param {ParseSignal} parseSignal @returns {string} */
function cleanClientCommand(text, parseSignal) {
  if (typeof text !== 'string') throw new TypeError('Steam client command must be a JSON string.');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_IDENTITY_BYTES) {
    throw new RangeError('Steam client command exceeds the 3 MiB transport limit.');
  }
  if (typeof parseSignal !== 'function') throw new TypeError('Steam signal parser must be a function.');
  /** @type {JsonValue} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (bytes > MAX_JSON_BYTES) throw new RangeError('Steam client command exceeds the 150000-byte limit.');
    throw new TypeError('Steam client command contains malformed JSON.');
  }
  const input = requireObject(parsed);
  const contentCommit=input.t==='contentRequest'&&input.op==='commit';
  const encryptedCommand=(input.t==='chat'||input.t==='contentRequest'&&input.op==='replace')&&input.sealed!==undefined;
  if (bytes > MAX_ROOM_SYNC_BYTES && input.t !== 'identityProof' && !contentCommit) throw new RangeError('Steam room synchronization exceeds the 1048576-byte limit.');
  if (bytes > MAX_JSON_BYTES && !['roomSyncVote','roomSyncChoose','identityProof'].includes(String(input.t)) && !contentCommit && !encryptedCommand) throw new RangeError('Steam client command exceeds the 150000-byte limit.');
  const command = cleanCommand(input);
  if (command.t === 'signal') {
    const data = command.data;
    const to = command.to;
    if (data === undefined || typeof to !== 'string') {
      throw new TypeError('Steam client signal command is missing its destination or payload.');
    }
    return JSON.stringify({ t: 'signal', to, data: parseSignal(data, 'direct') });
  }
  return JSON.stringify(command);
}

module.exports = { cleanClientCommand };
