// @ts-check
import { validateOneHop } from './screen-plan.js';
import { parseScreenIce } from './screen-ice.js';
import { MAX_SCREEN_BITRATE_BPS, MAX_SCREEN_WIRE_BPS } from './screen-preferences.js';

/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./network-protocol.js').JsonObject} JsonObject */
/** @typedef {{viewerId:string,parentId:string,routeId:string}} WireRoute */
/** @typedef {{kind:'capacity',version:2,availableBps:number,relay:boolean,reservations:{shareId:string,bps:number}[]}|{kind:'share',version:2,shareId:string|null}|{kind:'progress',version:2,shareId:string,frames:number}|{kind:'watch',version:2,shareId:string,watching:boolean}|{kind:'plan',version:2,sourceId:string,shareId:string,epoch:number,bitrateBps:number,wireBps:number,routes:WireRoute[]}|{kind:'offer'|'answer',version:2,sourceId:string,shareId:string,edgeId:string,negotiationId:string,role:'direct'|'publish'|'subscribe',sdp:string}|{kind:'ice',version:2,sourceId:string,shareId:string,edgeId:string,negotiationId:string,role:'direct'|'publish'|'subscribe',candidate:import('./screen-ice.js').ScreenIceCandidate}|{kind:'fault',version:2,sourceId:string,shareId:string,edgeId:string,message:string}|{kind:'close',version:2,sourceId:string,shareId:string,edgeId:string}|{kind:'rejected',version:2,shareId:string,message:string}} ScreenMessage */
/** @typedef {Extract<ScreenMessage,{kind:'plan'}>} RoutePlan */

/** @param {JsonValue|undefined} value @returns {JsonObject} */
function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid screen message object');
  return value;
}
/** @param {JsonValue|undefined} value @returns {string} */
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(value)) throw new TypeError('Invalid screen session identifier');
  return value;
}
/** @param {JsonValue|undefined} value @param {number} min @param {number} max @returns {number} */
function integer(value, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid screen numeric field');
  return value;
}
/** @param {JsonValue|undefined} value @returns {string} */
function errorText(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 600) throw new TypeError('Invalid screen error message');
  return value;
}
/** @param {JsonValue} raw @param {import('./network-protocol.js').MediaPolicy} policy @returns {ScreenMessage} */
export function parseScreenMessage(raw, policy) {
  const input = record(raw);
  if (input.version !== 2) throw new TypeError('屏幕传输协议不兼容，请双方更新客户端');
  if (input.kind === 'capacity') {
    if (typeof input.relay !== 'boolean') throw new TypeError('Invalid screen relay capability');
    if (!Array.isArray(input.reservations) || input.reservations.length > 100) throw new TypeError('Invalid screen capacity reservations');
    const reservations = input.reservations.map((value) => { const item = record(value); return { shareId: id(item.shareId), bps: integer(item.bps, 0, 1000000000) }; });
    if (new Set(reservations.map((entry) => entry.shareId)).size !== reservations.length) throw new TypeError('Duplicate screen capacity reservation');
    return { kind: 'capacity', version: 2, availableBps: integer(input.availableBps, 0, 1000000000), relay: input.relay, reservations };
  }
  if (input.kind === 'share') return { kind: 'share', version: 2, shareId: input.shareId === null ? null : id(input.shareId) };
  if (input.kind === 'progress') return { kind: 'progress', version: 2, shareId: id(input.shareId), frames: integer(input.frames, 0, Number.MAX_SAFE_INTEGER) };
  if (input.kind === 'watch') {
    if (typeof input.watching !== 'boolean') throw new TypeError('Invalid screen watch request');
    return { kind: 'watch', version: 2, shareId: id(input.shareId), watching: input.watching };
  }
  if (input.kind === 'rejected') return { kind: 'rejected', version: 2, shareId: id(input.shareId), message: errorText(input.message) };
  const sourceId = id(input.sourceId);
  const shareId = id(input.shareId);
  if (input.kind === 'plan') {
    if (!Array.isArray(input.routes) || input.routes.length > 100) throw new TypeError('Invalid screen routes');
    const routes = input.routes.map((value) => {
      const route = record(value);
      return { viewerId: id(route.viewerId), parentId: id(route.parentId), routeId: id(route.routeId) };
    });
    validateOneHop(sourceId, routes);
    if (new Set(routes.map((route) => route.routeId)).size !== routes.length) throw new TypeError('Duplicate screen route identity');
    const bitrateBps = integer(input.bitrateBps, 300000, MAX_SCREEN_BITRATE_BPS);
    const wireBps = integer(input.wireBps, bitrateBps, MAX_SCREEN_WIRE_BPS);
    return { kind: 'plan', version: 2, sourceId, shareId, epoch: integer(input.epoch, 1, 2147483647), bitrateBps, wireBps, routes };
  }
  const edgeId = id(input.edgeId);
  if (input.kind === 'close') return { kind: 'close', version: 2, sourceId, shareId, edgeId };
  if (input.kind === 'fault') return { kind: 'fault', version: 2, sourceId, shareId, edgeId, message: errorText(input.message) };
  if (input.kind !== 'offer' && input.kind !== 'answer' && input.kind !== 'ice') throw new TypeError('Unsupported screen message kind');
  if (input.role !== 'direct' && input.role !== 'publish' && input.role !== 'subscribe') throw new TypeError('Invalid screen edge role');
  const negotiationId = id(input.negotiationId);
  if (input.kind === 'ice') return { kind: 'ice', version: 2, sourceId, shareId, edgeId, negotiationId, role: input.role, candidate: parseScreenIce(input.candidate ?? null, policy) };
  if (typeof input.sdp !== 'string' || input.sdp.length > 65536 || !input.sdp.startsWith('v=0')) throw new TypeError('Invalid screen SDP');
  if (policy === 'direct' && /^a=candidate:.*\styp relay(?:\s|$)/m.test(input.sdp)) throw new TypeError('直连屏幕策略拒绝 TURN 候选');
  const media = input.sdp.match(/^m=\w+/gm) || [];
  if (media.length !== 1 || media[0] !== 'm=video') throw new TypeError('Screen connection must contain exactly one video section');
  return { kind: input.kind, version: 2, sourceId, shareId, edgeId, negotiationId, role: input.role, sdp: input.sdp };
}
