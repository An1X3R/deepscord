// @ts-check
'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

/** @typedef {{appId: number, lobbyId: string, token: string}} SteamInvitation */
/** @typedef {'open' | 'opened' | 'data' | 'close' | 'error' | 'replica'|'media'|'bulk'} SteamMessageKind */
/** @typedef {{session: string, kind: SteamMessageKind, index: number, count: number, data: Buffer}} DecodedPacket */
/** @typedef {string | number | boolean | null | JsonValue[] | {[key: string]: JsonValue}} JsonValue */

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_PACKET_BYTES = 32 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024;
const MAX_CHUNK_COUNT = 256;
const MAX_UINT32 = 0xffffffff;
const MAX_UINT64 = (1n << 64n) - 1n;
const MESSAGE_KINDS = new Set(['open', 'opened', 'data', 'close', 'error', 'replica','media','bulk']);

class SteamWireError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SteamWireError';
  }
}

/** @param {number} appId */
function validateAppId(appId) {
  if (!Number.isInteger(appId) || appId < 1 || appId > MAX_UINT32) {
    throw new SteamWireError('Steam app ID must be a positive uint32 integer.');
  }
}

/** @param {string} lobbyId */
function validateLobbyId(lobbyId) {
  if (typeof lobbyId !== 'string' || lobbyId.length > 20 || !/^[1-9][0-9]*$/.test(lobbyId)) {
    throw new SteamWireError('Steam lobby ID must be a canonical positive decimal uint64.');
  }
  if (BigInt(lobbyId) > MAX_UINT64) {
    throw new SteamWireError('Steam lobby ID exceeds the uint64 range.');
  }
}

/** @param {string} token @returns {Buffer} */
function decodeToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new SteamWireError('Steam invite token must be canonical unpadded base64url for 32 bytes.');
  }
  const decoded = Buffer.from(token, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== token) {
    throw new SteamWireError('Steam invite token must be canonical unpadded base64url for 32 bytes.');
  }
  return decoded;
}

/** @param {SteamInvitation} invitation @returns {Buffer} */
function validateInvitation(invitation) {
  if (invitation === null || typeof invitation !== 'object') {
    throw new SteamWireError('Steam invitation must be an object.');
  }
  validateAppId(invitation.appId);
  validateLobbyId(invitation.lobbyId);
  return decodeToken(invitation.token);
}

/** @param {string} value @returns {SteamInvitation} */
function parseSteamInvite(value) {
  if (typeof value !== 'string') {
    throw new SteamWireError('Steam invite must be a string URL.');
  }
  if (value.length > 4096) {
    throw new SteamWireError('Steam invite URL exceeds the 4096-character limit.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SteamWireError('Steam invite URL is malformed.');
  }
  const authority = /^deepscord:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (url.protocol !== 'deepscord:' || url.hostname !== 'steam' || authority?.toLowerCase() !== 'steam' || url.pathname !== '' ||
      url.port !== '' || url.username !== '' || url.password !== '') {
    throw new SteamWireError('Steam invite must use deepscord://steam without a path, port, or user info.');
  }
  const appIds = url.searchParams.getAll('appid');
  const lobbyIds = url.searchParams.getAll('lobby');
  const tokens = new URLSearchParams(url.hash.slice(1)).getAll('token');
  if (appIds.length !== 1 || lobbyIds.length !== 1 || tokens.length !== 1) {
    throw new SteamWireError('Steam invite must contain exactly one appid, lobby, and token field.');
  }
  if (!/^[0-9]+$/.test(appIds[0])) {
    throw new SteamWireError('Steam invite appid must be a positive uint32 integer.');
  }
  const appId = Number(appIds[0]);
  const invitation = { appId, lobbyId: lobbyIds[0], token: tokens[0] };
  validateInvitation(invitation);
  return invitation;
}

/** @param {SteamInvitation} invitation @returns {string} */
function steamInvite(invitation) {
  validateInvitation(invitation);
  return `deepscord://steam?appid=${invitation.appId}&lobby=${invitation.lobbyId}#token=${invitation.token}`;
}

/** @param {string} session */
function validateSession(session) {
  if (typeof session !== 'string' || !/^[a-f0-9]{32}$/.test(session)) {
    throw new SteamWireError('Steam session ID must be 32 lowercase hexadecimal characters.');
  }
}

/** @param {SteamMessageKind} kind */
function validateKind(kind) {
  if (typeof kind !== 'string' || !MESSAGE_KINDS.has(kind)) {
    throw new SteamWireError('Steam message kind is unsupported.');
  }
}

/** @param {string} value @returns {value is SteamMessageKind} */
function isSteamMessageKind(value) {
  return value === 'open' || value === 'opened' || value === 'data' || value === 'close' || value === 'error' || value === 'replica' || value==='media' || value==='bulk';
}

/** @param {Buffer} key @param {string} lobby @param {string} session @param {SteamMessageKind} kind @param {number} index @param {number} count @param {string} data @returns {string} */
function signPacket(key, lobby, session, kind, index, count, data) {
  const canonical = JSON.stringify([1, lobby, session, kind, index, count, data]);
  return createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
}

/** @param {SteamInvitation} invitation @param {string} session @param {SteamMessageKind} kind @param {Buffer} payload @returns {Buffer[]} */
function encodeMessage(invitation, session, kind, payload) {
  const key = validateInvitation(invitation);
  validateSession(session);
  validateKind(kind);
  if (!Buffer.isBuffer(payload)) {
    throw new SteamWireError('Steam message payload must be a Buffer.');
  }
  if (payload.length > MAX_MESSAGE_BYTES) {
    throw new SteamWireError('Steam message payload exceeds the 4 MiB limit.');
  }
  const count = Math.max(1, Math.ceil(payload.length / MAX_CHUNK_BYTES));
  const packets = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = payload.subarray(index * MAX_CHUNK_BYTES, Math.min((index + 1) * MAX_CHUNK_BYTES, payload.length));
    const data = chunk.toString('base64');
    const mac = signPacket(key, invitation.lobbyId, session, kind, index, count, data);
    const packet = Buffer.from(JSON.stringify({
      v: 1,
      lobby: invitation.lobbyId,
      session,
      kind,
      index,
      count,
      data,
      mac,
    }), 'utf8');
    if (packet.length > MAX_PACKET_BYTES) {
      throw new SteamWireError('Encoded Steam packet exceeds the 32 KiB limit.');
    }
    packets.push(packet);
  }
  return packets;
}

/** @param {Buffer} packet @returns {{[key: string]: JsonValue}} */
function parsePacketJson(packet) {
  if (!Buffer.isBuffer(packet) || packet.length === 0) {
    throw new SteamWireError('Steam packet must be a nonempty Buffer.');
  }
  if (packet.length > MAX_PACKET_BYTES) {
    throw new SteamWireError('Steam packet exceeds the 32 KiB limit.');
  }
  const text = packet.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(packet)) {
    throw new SteamWireError('Steam packet must contain valid UTF-8 JSON.');
  }
  /** @type {JsonValue} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SteamWireError('Steam packet contains malformed JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SteamWireError('Steam packet JSON must be an object.');
  }
  return parsed;
}

/** @param {{[key: string]: JsonValue}} value @returns {DecodedPacket} */
function validatePacketSchema(value) {
  if (value.v !== 1 || typeof value.lobby !== 'string' || typeof value.session !== 'string' ||
      typeof value.kind !== 'string' || typeof value.index !== 'number' || typeof value.count !== 'number' ||
      typeof value.data !== 'string' || typeof value.mac !== 'string') {
    throw new SteamWireError('Steam packet is missing required fields or has invalid field types.');
  }
  validateLobbyId(value.lobby);
  validateSession(value.session);
  if (typeof value.kind !== 'string' || !isSteamMessageKind(value.kind)) {
    throw new SteamWireError('Steam packet message kind is unsupported.');
  }
  const kind = value.kind;
  if (!Number.isInteger(value.index) || !Number.isInteger(value.count) || value.count < 1 ||
      value.count > MAX_CHUNK_COUNT || value.index < 0 || value.index >= value.count) {
    throw new SteamWireError('Steam packet index or count is outside the valid range.');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
    throw new SteamWireError('Steam packet data must be canonical base64.');
  }
  const data = Buffer.from(value.data, 'base64');
  if (data.length > MAX_CHUNK_BYTES || data.toString('base64') !== value.data ||
      (value.count > 1 && data.length === 0)) {
    throw new SteamWireError('Steam packet data has an invalid size or base64 encoding.');
  }
  if (!/^[a-f0-9]{64}$/.test(value.mac)) {
    throw new SteamWireError('Steam packet MAC must be 64 lowercase hexadecimal characters.');
  }
  return {
    session: value.session,
    kind,
    index: value.index,
    count: value.count,
    data,
  };
}

/** @param {SteamInvitation} invitation @param {Buffer} packet @returns {DecodedPacket} */
function decodePacket(invitation, packet) {
  const key = validateInvitation(invitation);
  const value = parsePacketJson(packet);
  const decoded = validatePacketSchema(value);
  const lobby = value.lobby;
  const kind = value.kind;
  const data = value.data;
  const mac = value.mac;
  if (typeof lobby !== 'string' || lobby !== invitation.lobbyId) {
    throw new SteamWireError('Steam packet lobby does not match the invitation.');
  }
  if (typeof kind !== 'string' || !isSteamMessageKind(kind) || typeof data !== 'string' || typeof mac !== 'string') {
    throw new SteamWireError('Steam packet is missing required authentication fields.');
  }
  const expectedMac = Buffer.from(signPacket(key, lobby, decoded.session, kind, decoded.index, decoded.count, data), 'hex');
  const providedMac = Buffer.from(mac, 'hex');
  if (!timingSafeEqual(expectedMac, providedMac)) {
    throw new SteamWireError('Steam packet authentication failed.');
  }
  return decoded;
}

module.exports = {
  MAX_MESSAGE_BYTES,
  MAX_PACKET_BYTES,
  SteamWireError,
  parseSteamInvite,
  steamInvite,
  encodeMessage,
  decodePacket,
};
