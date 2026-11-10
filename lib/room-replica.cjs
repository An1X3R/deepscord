// @ts-check
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseSteamStore } = require('./steam-state.cjs');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./steam-state.cjs').RoomServer} RoomServer */
/** @typedef {{version:1,roomId:string,creatorKey:string}} RoomDescriptor */
/** @typedef {{version:1,roomId:string,creatorKey:string,revision:number,servers:RoomServer[],digest:string}} RoomDocument */
/** @typedef {{roundId:string,memberKey:string,document:RoomDocument,signature:string,fresh:boolean}} RoomVote */
/** @param {JsonValue|undefined} value @param {string} field @returns {{[key:string]:JsonValue}} */
function object(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(field + ' must be a JSON object'); return value; }
/** @param {JsonValue|undefined} value @param {string} field @returns {string} */
function uuid(value, field) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new TypeError(field + ' must be a canonical lowercase UUID'); return value; }
/** @param {JsonValue|undefined} value @param {string} field @returns {Buffer} */
function base64(value, field) { if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new TypeError(field + ' must be canonical base64'); const data = Buffer.from(value, 'base64'); if (data.toString('base64') !== value) throw new TypeError(field + ' must be canonical base64'); return data; }
/** @param {JsonValue|undefined} value @returns {string} */
function publicKey(value) {
  const data = base64(value, 'Room member public key');
  const key = crypto.createPublicKey({ key:data, format:'der', type:'spki' });
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({ format:'der', type:'spki' }).equals(data)) throw new TypeError('Room public key must be a canonical Ed25519 SPKI key');
  return data.toString('base64');
}
/** @param {JsonValue} value @returns {RoomDescriptor} */
function parseRoomDescriptor(value) { const raw = object(value, 'Room descriptor'); if (raw.version !== 1) throw new TypeError('Room descriptor version must be 1'); return { version:1, roomId:uuid(raw.roomId, 'Room ID'), creatorKey:publicKey(raw.creatorKey) }; }
/** @param {JsonValue} value @returns {RoomServer[]} */
function canonicalServers(value) { return parseSteamStore({ version:1, servers:value, messages:{} }).servers; }
/** @param {RoomServer[]} servers @returns {string} */
function serversDigest(servers) { return crypto.createHash('sha256').update(JSON.stringify(canonicalServers(servers))).digest('hex'); }
/** Match the field order shipped in the initial radio release. Input must already be validated. @param {RoomServer[]} servers @returns {string} */
function radioPreviewDigest(servers) {
  const preview = servers.map(server=>({...server,channels:server.channels.map(channel=>({id:channel.id,name:channel.name,userLimit:channel.userLimit,type:channel.type,...(channel.type==='radio' ? {radio:channel.radio} : {})}))}));
  return crypto.createHash('sha256').update(JSON.stringify(preview)).digest('hex');
}
/** @param {RoomDescriptor} descriptor @param {number} revision @param {RoomServer[]} servers @returns {RoomDocument} */
function createRoomDocument(descriptor, revision, servers) {
  const anchor = parseRoomDescriptor(descriptor);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('Room document revision must be a nonnegative safe integer');
  const normalized = canonicalServers(servers);
  return { ...anchor, revision, servers:normalized, digest:serversDigest(normalized) };
}
/** @param {JsonValue} value @param {RoomDescriptor} descriptor @returns {RoomDocument} */
function parseRoomDocument(value, descriptor) {
  const raw = object(value, 'Room document'), anchor = parseRoomDescriptor(raw);
  if (anchor.roomId !== descriptor.roomId || anchor.creatorKey !== descriptor.creatorKey) throw new TypeError('Room document does not match the pinned room ID and creator public key');
  if (typeof raw.revision !== 'number') throw new TypeError('Room document revision must be numeric');
  const result = createRoomDocument(anchor, raw.revision, canonicalServers(raw.servers));
  if (raw.digest !== result.digest) {
    if (raw.digest !== radioPreviewDigest(result.servers)) throw new TypeError('Room document digest does not match its canonical channel structure');
    // Preserve the verified digest because existing vote signatures bind to it.
    return {...result,digest:raw.digest};
  }
  return result;
}
/** @param {string} roundId @param {string} memberKey @param {RoomDocument} document @param {boolean} fresh @returns {string} */
function roomVotePayload(roundId, memberKey, document, fresh) {
  uuid(roundId, 'Room round ID'); publicKey(memberKey);
  if (typeof fresh !== 'boolean') throw new TypeError('Room vote fresh must be boolean');
  return JSON.stringify(['deepscord-room-vote-v1', roundId, memberKey, document.digest, document.roomId, document.revision, fresh]);
}
/** @param {JsonValue} value @param {RoomDescriptor} descriptor @param {string} roundId @returns {RoomVote} */
function verifyRoomVote(value, descriptor, roundId) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1048576) throw new RangeError('Room vote exceeds its one MiB JSON limit');
  const raw = object(value, 'Room vote');
  if (raw.roundId !== roundId) throw new TypeError('Room vote belongs to a stale or different collection round');
  const memberKey = publicKey(raw.memberKey), document = parseRoomDocument(raw.document, descriptor);
  if (typeof raw.fresh !== 'boolean') throw new TypeError('Room vote fresh must be boolean');
  const signature = base64(raw.signature, 'Room vote signature');
  if (signature.length !== 64 || !crypto.verify(null, Buffer.from(roomVotePayload(roundId, memberKey, document, raw.fresh)), { key:Buffer.from(memberKey, 'base64'), format:'der', type:'spki' }, signature)) throw new TypeError('Room vote Ed25519 signature is invalid');
  return { roundId, memberKey, document, signature:signature.toString('base64'), fresh:raw.fresh };
}
/** @param {string} file @returns {JsonValue} */
function readRoomJson(file) {
  if (fs.statSync(file).size > 1048576) throw new RangeError('Room identity file exceeds one MiB: ' + file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new SyntaxError('Invalid room identity JSON at ' + file + ': ' + error.message, { cause:error }); throw error; }
}

/** Open an on-disk room identity; the document is authoritative over a stale store snapshot. @param {{dataDir:string,environment:NodeJS.ProcessEnv,servers:RoomServer[]}} options */
function openRoomReplica(options) {
  const location = path.join(options.dataDir, 'room-identity.json');
  const entries = [options.environment.ECHO_ROOM_ID, options.environment.ECHO_ROOM_CREATOR_KEY, options.environment.ECHO_ROOM_SEED_PATH];
  if (entries.some(value=>value !== undefined) && !entries.every(value=>value !== undefined)) throw new TypeError('ECHO_ROOM_ID, ECHO_ROOM_CREATOR_KEY and ECHO_ROOM_SEED_PATH must all be provided together');
  const supplied = entries.every(value=>value !== undefined);
  /** @type {RoomDescriptor|null} */ let expected = null;
  /** @type {RoomDocument|null} */ let seed = null;
  if (supplied) {
    const roomId = entries[0], creatorKey = entries[1];
    if (typeof roomId !== 'string' || typeof creatorKey !== 'string') throw new TypeError('Explicit room identity fields are required');
    expected = parseRoomDescriptor({ version:1, roomId, creatorKey });
    const seedPath = entries[2]; if (!seedPath || !path.isAbsolute(seedPath)) throw new TypeError('Room seed path must be absolute');
    const input = readRoomJson(seedPath);
    seed = input === null ? createRoomDocument(expected, 0, options.servers) : parseRoomDocument(input, expected);
  }
  /** @type {RoomDescriptor} */ let descriptor;
  /** @type {RoomDocument} */ let document;
  /** @type {string|null} */ let privateKey = null;
  if (fs.existsSync(location)) {
    const raw = object(readRoomJson(location), 'Persistent room identity');
    descriptor = parseRoomDescriptor(raw);
    if (expected && (expected.roomId !== descriptor.roomId || expected.creatorKey !== descriptor.creatorKey)) throw new TypeError('Persistent room identity differs from the configured pinned room descriptor');
    document = parseRoomDocument(raw.document, descriptor);
    if (raw.authorityPrivateKey !== null) {
      const data = base64(raw.authorityPrivateKey, 'Room authority private key');
      const key = crypto.createPrivateKey({ key:data, format:'der', type:'pkcs8' });
      if (key.asymmetricKeyType !== 'ed25519' || crypto.createPublicKey(key).export({ format:'der', type:'spki' }).toString('base64') !== descriptor.creatorKey) throw new TypeError('Persistent room authority private key does not match its creator key');
      privateKey = data.toString('base64');
    }
    if (supplied && privateKey) throw new TypeError('Client-created rooms cannot reuse an independent server authority private key');
  } else if (expected && seed) { descriptor = expected; document = seed; }
  else {
    const pair = crypto.generateKeyPairSync('ed25519');
    descriptor = { version:1, roomId:crypto.randomUUID(), creatorKey:pair.publicKey.export({ format:'der', type:'spki' }).toString('base64') };
    privateKey = pair.privateKey.export({ format:'der', type:'pkcs8' }).toString('base64');
    document = createRoomDocument(descriptor, 0, options.servers);
  }
  /** @param {RoomDocument} next @returns {RoomDocument} */
  function persist(next) {
    const parsed = parseRoomDocument(next, descriptor);
    fs.mkdirSync(options.dataDir, { recursive:true });
    fs.writeFileSync(location + '.tmp', JSON.stringify({ ...descriptor, document:parsed, authorityPrivateKey:privateKey }, null, 2), { encoding:'utf8', mode:0o600 });
    fs.renameSync(location + '.tmp', location); document = parsed;
    return structuredClone(document);
  }
  if (!fs.existsSync(location)) persist(document);
  /** @param {string} payload @returns {string} */
  function signAuthority(payload) {
    if (privateKey === null) throw new Error('This room does not own the independent server authority key');
    return crypto.sign(null,Buffer.from(payload),{ key:Buffer.from(privateKey,'base64'),format:'der',type:'pkcs8' }).toString('base64');
  }
  return { descriptor:structuredClone(descriptor), authority:privateKey !== null, getDocument:()=>structuredClone(document), persist, signAuthority };
}
module.exports = { parseRoomDescriptor, canonicalServers, serversDigest, createRoomDocument, parseRoomDocument, roomVotePayload, verifyRoomVote, openRoomReplica };
