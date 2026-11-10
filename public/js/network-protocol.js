// @ts-check
import { parseScreenMessage } from './screen-protocol.js';
import { parsePokeAdvertisement, parsePokeMessage } from './poke-protocol.js';
import { parseInteractionAdvertisement, parseInteractionMessage } from './interaction-protocol.js';

/** @typedef {'direct'|'relay-allowed'|'relay-only'} MediaPolicy */
/** @typedef {{mode:'peer-relay'}|{mode:'sfu',url:string}} ScreenConfig */
/** @typedef {{networkMode:'server'|'direct',mediaPolicy:MediaPolicy,iceTransportPolicy:RTCIceTransportPolicy,iceServers:RTCIceServer[],iceExpiresAt:number|null,screen?:ScreenConfig}} NetworkConfig */
/** @typedef {{type:'offer'|'answer',sdp:RTCSessionDescriptionInit}|{type:'ice',candidate:RTCIceCandidateInit}} PeerSignal */
/** @typedef {{type:'leave'}|{type:'restart'}|{type:'state',muted:boolean,deafened:boolean}|{type:'media',screen:boolean,accompaniment:boolean,poke?:import('./poke-protocol.js').PokeAdvertisement,interaction?:import('./interaction-protocol.js').InteractionAdvertisement|null}|{type:'watch',watching:boolean}|{type:'signal',data:PeerSignal}|{type:'screen',data:import('./screen-protocol.js').ScreenMessage}|{type:'poke',data:import('./poke-protocol.js').PokeMessage}|{type:'interaction',data:import('./interaction-protocol.js').InteractionMessage}} PeerControl */
/** @typedef {null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue}} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */

/** @param {JsonValue} value @returns {JsonObject} */
export function objectValue(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a network message object');
  return value;
}

/** @param {JsonValue|undefined} value @param {number} limit @returns {string} */
function stringValue(value, limit) {
  if (typeof value !== 'string' || value.length > limit) throw new TypeError('Invalid network string field');
  return value;
}

/** @param {JsonValue} value @returns {{networkMode:'server'|'direct',mediaPolicy:MediaPolicy,iceTransportPolicy:RTCIceTransportPolicy,requirePassword:boolean}} */
export function parsePublicConfig(value) {
  const input = objectValue(value);
  if (input.networkMode !== 'server' && input.networkMode !== 'direct') throw new TypeError('服务器版本不支持联网模式，请升级服务器');
  if (input.mediaPolicy !== 'direct' && input.mediaPolicy !== 'relay-allowed' && input.mediaPolicy !== 'relay-only') throw new TypeError('服务器语音策略无效');
  const transport = input.mediaPolicy === 'relay-only' ? 'relay' : 'all';
  if (input.iceTransportPolicy !== transport || typeof input.requirePassword !== 'boolean') throw new TypeError('服务器公开配置无效');
  return { networkMode: input.networkMode, mediaPolicy: input.mediaPolicy, iceTransportPolicy: transport, requirePassword: input.requirePassword };
}

/** @param {JsonValue} value @returns {NetworkConfig} */
export function parseNetworkConfig(value) {
  const input = objectValue(value);
  const mode = input.networkMode;
  const policy = input.mediaPolicy;
  if (mode !== 'server' && mode !== 'direct') throw new TypeError('服务器未提供有效的联网模式，请升级服务器');
  if (policy !== 'direct' && policy !== 'relay-allowed' && policy !== 'relay-only') throw new TypeError('服务器语音传输策略无效');
  if (input.iceTransportPolicy !== (policy === 'relay-only' ? 'relay' : 'all')) throw new TypeError('服务器 ICE 策略不一致');
  if (!Array.isArray(input.iceServers) || input.iceServers.length > 32) throw new TypeError('服务器 ICE 配置无效');
  const iceServers = input.iceServers.map((entry) => {
    const item = objectValue(entry);
    const urls = stringValue(item.urls, 2048);
    if (!/^(stun|stuns|turn|turns):[^\s]+$/.test(urls)) throw new TypeError('ICE 地址无效');
    if (policy === 'direct' && /^turns?:/.test(urls)) throw new TypeError('直连模式禁止中继');
    /** @type {RTCIceServer} */
    const server = { urls };
    if (/^turns?:/.test(urls)) {
      server.username = stringValue(item.username, 256);
      server.credential = stringValue(item.credential, 256);
      if (!server.username || !server.credential) throw new TypeError('中继凭据缺失');
    }
    return server;
  });
  if (mode === 'direct' && (policy !== 'direct' || iceServers.length !== 0)) throw new TypeError('独立直连禁止第三方服务');
  const hasTurn = iceServers.some((entry) => typeof entry.urls === 'string' && /^turns?:/.test(entry.urls));
  if (policy !== 'direct' && !hasTurn) throw new TypeError('中继策略缺少中继服务器');
  const expiry = input.iceExpiresAt;
  if (expiry !== null && (typeof expiry !== 'number' || !Number.isSafeInteger(expiry) || expiry <= 0)) throw new TypeError('中继凭据有效期无效');
  if (hasTurn && expiry === null) throw new TypeError('中继凭据有效期缺失');
  /** @type {ScreenConfig} */ let screen = { mode: 'peer-relay' };
  if (input.screen !== undefined) {
    const item = objectValue(input.screen);
    if (item.mode === 'sfu') {
      const url = stringValue(item.url, 2048);
      const endpoint = new URL(url);
      if (mode !== 'server' || (endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) || endpoint.pathname !== '/screen-sfu' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new TypeError('Invalid screen SFU configuration');
      screen = { mode: 'sfu', url };
    } else if (item.mode !== 'peer-relay') throw new TypeError('Unsupported screen transport mode');
  }
  return { networkMode: mode, mediaPolicy: policy, iceTransportPolicy: policy === 'relay-only' ? 'relay' : 'all', iceServers, iceExpiresAt: expiry, screen };
}

/** @param {JsonValue} value @param {MediaPolicy} policy @returns {PeerSignal} */
export function parsePeerSignal(value, policy) {
  const input = objectValue(value);
  if (input.type === 'ice') {
    const item = objectValue(input.candidate === undefined ? null : input.candidate);
    const candidate = stringValue(item.candidate, 4096);
    if (policy === 'direct' && /\styp relay(?:\s|$)/.test(candidate)) throw new TypeError('直连策略拒绝中继候选地址');
    if (item.sdpMid !== null && (typeof item.sdpMid !== 'string' || item.sdpMid.length > 64)) throw new TypeError('Invalid ICE sdpMid');
    if (item.sdpMLineIndex !== null && (typeof item.sdpMLineIndex !== 'number' || !Number.isInteger(item.sdpMLineIndex) || item.sdpMLineIndex < 0 || item.sdpMLineIndex > 64)) throw new TypeError('Invalid ICE line index');
    const fragment = item.usernameFragment;
    if (fragment !== undefined && fragment !== null && (typeof fragment !== 'string' || fragment.length > 256)) throw new TypeError('Invalid ICE username fragment');
    return { type: 'ice', candidate: { candidate, sdpMid: item.sdpMid, sdpMLineIndex: item.sdpMLineIndex, ...(fragment === undefined ? {} : { usernameFragment: fragment }) } };
  }
  if (input.type !== 'offer' && input.type !== 'answer') throw new TypeError('Unsupported peer signal');
  const item = objectValue(input.sdp === undefined ? null : input.sdp);
  if (item.type !== input.type) throw new TypeError('Mismatched SDP type');
  const sdp = stringValue(item.sdp, 131072);
  if (!sdp.startsWith('v=0')) throw new TypeError('Invalid SDP');
  if (policy === 'direct' && /^a=candidate:.*\styp relay(?:\s|$)/m.test(sdp)) throw new TypeError('直连策略拒绝中继会话');
  return { type: input.type, sdp: { type: input.type, sdp } };
}

/** @param {string} text @param {MediaPolicy} policy @returns {PeerControl} */
export function parsePeerControl(text, policy) {
  if (text.length > 140000) throw new TypeError('Peer control message exceeds limit');
  /** @type {JsonValue} */
  const parsed = JSON.parse(text);
  const input = objectValue(parsed);
  if (input.type === 'leave') return { type: 'leave' };
  if (input.type === 'restart') return { type: 'restart' };
  if (input.type === 'state' && typeof input.muted === 'boolean' && typeof input.deafened === 'boolean') {
    return { type: 'state', muted: input.muted, deafened: input.deafened };
  }
  if (input.type === 'media' && typeof input.screen === 'boolean' && typeof input.accompaniment === 'boolean') return { type: 'media', screen: input.screen, accompaniment: input.accompaniment, ...(input.poke === undefined ? {} : { poke: parsePokeAdvertisement(input.poke) }), ...(input.interaction === undefined ? {} : { interaction: parseInteractionAdvertisement(input.interaction) }) };
  if (input.type === 'interaction') { if (text.length > 1024) throw new RangeError('Interaction exceeds limit'); return { type: 'interaction', data: parseInteractionMessage(input.data) }; }
  if (input.type === 'poke') { if (text.length > 2048) throw new RangeError('Screen poke exceeds limit'); return { type: 'poke', data: parsePokeMessage(input.data) }; }
  if (input.type === 'watch' && typeof input.watching === 'boolean') return { type: 'watch', watching: input.watching };
  if (input.type === 'signal') return { type: 'signal', data: parsePeerSignal(input.data === undefined ? null : input.data, policy) };
  if (input.type === 'screen') return { type: 'screen', data: parseScreenMessage(input.data === undefined ? null : input.data, policy) };
  throw new TypeError('Invalid peer control message');
}
