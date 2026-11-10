// @ts-check
'use strict';
const { createHash } = require('node:crypto');
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const { parseSteamCheckpoint, stableSteamUserId,createSteamStateReader } = require('./app-server/lib/steam-state.cjs');
/** @typedef {import('../lib/steam-state.cjs').SteamCheckpoint} SteamCheckpoint */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{t:'checkpoint',checkpoint:SteamCheckpoint}|{t:'ack',epoch:string,sequence:number,digest:string}|{t:'request',epoch:string}|{t:'recover',epoch:string,ownerId:string,requestId:string}|{t:'recovered',requestId:string,checkpoint:SteamCheckpoint}} ReplicaMessage */
const REPLICA_SESSION = '00000000000000000000000000000000';
const MAX_REPLICA_BYTES = 4 * 1024 * 1024;
/** @param {JsonValue} value @returns {string} */
function epoch(value) { if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new TypeError('Invalid Steam authority epoch'); return value; }
/** @param {JsonValue} value @returns {ReplicaMessage} */
function parseReplica(value) {
  return readReplica(value,parseSteamCheckpoint);
}
/** @param {JsonValue} value @param {(value:JsonValue)=>SteamCheckpoint} readCheckpoint @returns {ReplicaMessage} */
function readReplica(value,readCheckpoint) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Steam replica message');
  if (value.t === 'checkpoint') return { t: value.t, checkpoint: readCheckpoint(value.checkpoint) };
  if (value.t === 'recovered') return { t: value.t, requestId: epoch(value.requestId), checkpoint: readCheckpoint(value.checkpoint) };
  if (value.t === 'request') return { t: value.t, epoch: epoch(value.epoch) };
  if (value.t === 'recover') {
    if (typeof value.ownerId !== 'string') throw new TypeError('Steam recovery lacks the prior owner');
    stableSteamUserId(value.ownerId);
    return { t: value.t, epoch: epoch(value.epoch), ownerId: value.ownerId, requestId: epoch(value.requestId) };
  }
  if (value.t === 'ack' && typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence > 0 && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)) return { t: value.t, epoch: epoch(value.epoch), sequence: value.sequence, digest: value.digest };
  throw new TypeError('Unsupported Steam replica message');
}
/** @param {ReplicaMessage} message @returns {Buffer} */
function encodeReplica(message) {
  return compressReplica(parseReplica(/** @type {JsonValue} */ (message)));
}
/** @param {ReplicaMessage} message @returns {Buffer} */
function compressReplica(message) {
  const bytes = Buffer.from(JSON.stringify(message));
  if (bytes.length > MAX_REPLICA_BYTES) throw new RangeError('Steam replica exceeds the 4 MiB limit');
  return deflateRawSync(bytes, { level: 1 });
}
/** Cache only the exact bounded input of the latest checkpoint; returned buffers are independent. */
function createCheckpointEncoder() {
  const reader = createSteamStateReader({ maxEntries:4,maxBytes:8 * 1024 * 1024 });
  /** @type {{key:string,payload:Buffer,digest:string}|null} */
  let previous = null;
  let encodes = 0, hits = 0;
  /** @param {SteamCheckpoint} input @returns {{payload:Buffer,digest:string}} */
  function encode(input) {
    const raw = Buffer.from(JSON.stringify(input));
    if (raw.length > MAX_REPLICA_BYTES) throw new RangeError('Steam checkpoint exceeds the four MiB limit');
    const key = createHash('sha256').update(raw).digest('hex');
    if (previous?.key === key) { hits += 1; return { payload:Buffer.from(previous.payload),digest:previous.digest }; }
    const checkpoint = reader.parseCheckpoint(input);
    const payload = compressReplica({ t:'checkpoint',checkpoint });
    const digest = checkpointDigest(checkpoint);
    previous = { key,payload,digest }; encodes += 1;
    return { payload:Buffer.from(payload),digest };
  }
  return { encode,stats:()=>({ encodes,hits }) };
}
/** @param {Buffer} payload @returns {ReplicaMessage} */
function decodeReplica(payload) {
  return decodeWithReader(payload,parseSteamCheckpoint);
}
/** @param {Buffer} payload @param {(value:JsonValue)=>SteamCheckpoint} readCheckpoint @returns {ReplicaMessage} */
function decodeWithReader(payload,readCheckpoint) {
  if (!payload.length || payload.length > MAX_REPLICA_BYTES) throw new RangeError('Steam replica payload size is invalid');
  const bytes = inflateRawSync(payload, { maxOutputLength: MAX_REPLICA_BYTES });
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new TypeError('Steam replica must contain valid UTF-8');
  return readReplica(/** @type {JsonValue} */ (JSON.parse(text)),readCheckpoint);
}
/** @param {{maxEntries:number,maxBytes:number}} options */
function createReplicaDecoder(options) {
  const reader = createSteamStateReader(options);
  /** @param {Buffer} payload @returns {ReplicaMessage} */
  function decode(payload) { return decodeWithReader(payload,reader.parseCheckpoint); }
  return { decode };
}
/** @param {SteamCheckpoint} checkpoint @returns {string} */
function checkpointDigest(checkpoint) { return createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex'); }
/** @param {SteamCheckpoint|null} previous @param {SteamCheckpoint} next @returns {SteamCheckpoint} */
function newerCheckpoint(previous, next) {
  if (!previous) return next;
  if (previous.lobbyId !== next.lobbyId || previous.ownerId !== next.ownerId || previous.epoch !== next.epoch) throw new Error('Steam checkpoint belongs to another authority');
  if (previous.sequence === next.sequence && checkpointDigest(previous) !== checkpointDigest(next)) throw new Error('Conflicting Steam checkpoints at the same sequence');
  return next.sequence > previous.sequence ? next : previous;
}
module.exports = { REPLICA_SESSION, encodeReplica, decodeReplica, checkpointDigest, newerCheckpoint,createCheckpointEncoder,createReplicaDecoder };
