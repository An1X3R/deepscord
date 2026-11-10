// @ts-check

/** @typedef {{candidate:string,sdpMid:string|null,sdpMLineIndex:number|null,usernameFragment:string|null}} ScreenIceCandidate */
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */

/** @param {JsonValue} value @param {import('./network-protocol.js').MediaPolicy} policy @returns {ScreenIceCandidate} */
export function parseScreenIce(value, policy) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid screen ICE candidate object');
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = value;
  if (typeof candidate !== 'string' || candidate.length > 4096 || /[\r\n]/.test(candidate) || (candidate !== '' && !candidate.startsWith('candidate:'))) throw new TypeError('Invalid screen ICE candidate text');
  if (policy === 'direct' && /\styp relay(?:\s|$)/.test(candidate)) throw new TypeError('直连屏幕策略拒绝 TURN 候选');
  if (sdpMid !== null && (typeof sdpMid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sdpMid))) throw new TypeError('Invalid screen ICE media identifier');
  if (sdpMLineIndex !== null && sdpMLineIndex !== 0) throw new TypeError('Screen ICE requires the only video section');
  if (usernameFragment !== null && (typeof usernameFragment !== 'string' || !/^[A-Za-z0-9+/_-]{1,256}$/.test(usernameFragment))) throw new TypeError('Invalid screen ICE username fragment');
  if (candidate && sdpMid === null && sdpMLineIndex === null) throw new TypeError('Screen ICE candidate requires a video section');
  return { candidate, sdpMid, sdpMLineIndex, usernameFragment };
}

/** @param {RTCIceCandidate|null} candidate @returns {ScreenIceCandidate} */
export function screenIce(candidate) {
  return candidate === null ? { candidate: '', sdpMid: null, sdpMLineIndex: null, usernameFragment: null } : {
    candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: candidate.usernameFragment,
  };
}

/** @param {ScreenIceCandidate} candidate @param {string} sdp @returns {void} */
export function validateScreenIceDescription(candidate, sdp) {
  const mid = /^a=mid:([^\r\n]+)/m.exec(sdp)?.[1];
  const fragment = /^a=ice-ufrag:([^\r\n]+)/m.exec(sdp)?.[1];
  if (!mid || !fragment) throw new TypeError('Screen SDP is missing its ICE identity');
  if (candidate.sdpMid !== null && candidate.sdpMid !== mid) throw new TypeError('Screen ICE candidate targets a different video section');
  if (candidate.usernameFragment !== null && candidate.usernameFragment !== fragment) throw new TypeError('Screen ICE candidate belongs to a different negotiation');
  const inline = /\sufrag ([^\s]+)/.exec(candidate.candidate)?.[1];
  if (inline !== undefined && inline !== fragment) throw new TypeError('Screen ICE inline username belongs to a different negotiation');
}
