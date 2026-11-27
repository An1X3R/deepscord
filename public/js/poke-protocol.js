// @ts-check

/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{version:1,sessionId:string|null}} PokeAdvertisement */
/** @typedef {{action:'watch',sessionId:string,watching:boolean}|{action:'request'|'cancel',sessionId:string,requestId:string}|{action:'response',sessionId:string,requestId:string,grantId:string|null}|{action:'revoke',sessionId:string,grantId:string}|{action:'hit',sessionId:string,grantId:string,seq:number,nx:number,ny:number,boom:boolean}|{action:'event',sessionId:string,fromUserId:string,grantId:string,seq:number,nx:number,ny:number,combo:number,boom:boolean,gesture:'point'|'middle'}} PokeMessage */

/** @param {JsonValue|undefined} value @returns {{[key:string]:JsonValue}} */
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid screen poke object');
  return value;
}
/** @param {JsonValue|undefined} value @returns {string} */
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new TypeError('Invalid screen poke identifier');
  return value;
}
/** @param {JsonValue|undefined} value @returns {boolean} */
function boolean(value) { if (typeof value !== 'boolean') throw new TypeError('Invalid screen poke boolean'); return value; }
/** @param {JsonValue|undefined} value @param {number} maximum @returns {number} */
function integer(value, maximum) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError('Invalid screen poke sequence or combo');
  return value;
}
/** @param {JsonValue|undefined} value @returns {number} */
function coordinate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new TypeError('Invalid screen poke coordinate');
  return value;
}
/** @param {JsonValue|undefined} value @returns {PokeAdvertisement} */
export function parsePokeAdvertisement(value) {
  const input = object(value);
  if (input.version !== 1) throw new TypeError('Unsupported screen poke version');
  return { version: 1, sessionId: input.sessionId === null ? null : id(input.sessionId) };
}
/** @param {JsonValue|undefined} value @returns {PokeMessage} */
export function parsePokeMessage(value) {
  const input = object(value);
  const sessionId = id(input.sessionId);
  if (input.action === 'watch') return { action: 'watch', sessionId, watching: boolean(input.watching) };
  if (input.action === 'request' || input.action === 'cancel') return { action: input.action, sessionId, requestId: id(input.requestId) };
  if (input.action === 'response') return { action: 'response', sessionId, requestId: id(input.requestId), grantId: input.grantId === null ? null : id(input.grantId) };
  if (input.action === 'revoke') return { action: 'revoke', sessionId, grantId: id(input.grantId) };
  const point = { nx: coordinate(input.nx), ny: coordinate(input.ny), boom: boolean(input.boom) };
  const grantId = id(input.grantId);
  const seq = integer(input.seq, Number.MAX_SAFE_INTEGER);
  if (input.action === 'hit') return { action: 'hit', sessionId, grantId, seq, ...point };
  if (input.action === 'event' && input.gesture !== undefined && input.gesture !== 'point' && input.gesture !== 'middle') throw new TypeError('Invalid screen poke gesture');
  if (input.action === 'event') return { action: 'event', sessionId, grantId, seq, fromUserId: id(input.fromUserId), combo: integer(input.combo, 10), gesture: input.gesture === 'middle' ? 'middle' : 'point', ...point };
  throw new TypeError('Unsupported screen poke action');
}
