// @ts-check

/** @typedef {import('./poke-protocol.js').PokeMessage} PokeMessage */
/** @typedef {import('./poke-protocol.js').PokeAdvertisement} PokeAdvertisement */
/** @typedef {{sessionId:string|null,peers:{userId:string,supported:boolean,sessionId:string|null,status:'idle'|'pending'|'approved',requestId:string|null}[],requests:{userId:string,requestId:string}[],authorized:{userId:string}[]}} PokeState */
/** @typedef {{sessionId:string,targetUserId:string,fromUserId:string,eventId:string,nx:number,ny:number,combo:number,boom:boolean}} PokeHit */
/** @typedef {{sessionId:string|null,supported:boolean,watching:boolean,status:'idle'|'pending'|'approved',requestId:string|null,grantId:string|null,seq:number,timer:ReturnType<typeof setTimeout>|null,lastRequest:number}} Remote */
/** @typedef {{requestId:string,timer:ReturnType<typeof setTimeout>}} Request */
/** @typedef {{requestId:string,grantId:string,seq:number,lastHit:number,nx:number,ny:number,combo:number}} Grant */
/** @typedef {{getSelfId:()=>string,send:(id:string,data:PokeMessage)=>boolean,onState:()=>void,onHit:(hit:PokeHit)=>void,onClear:(targetUserId:string)=>void,onError:(error:Error)=>void}} PokeOptions */

/** A session-scoped connector; only the sharing peer authorizes and relays hits.
 * @param {PokeOptions} options */
export function createScreenPoke(options) {
  /** @type {string|null} */ let sessionId = null;
  /** @type {Map<string,Remote>} */ const peers = new Map();
  /** @type {Map<string,Request>} */ const requests = new Map();
  /** @type {Map<string,Grant>} */ const grants = new Map();
  /** @type {Set<string>} */ const viewers = new Set();
  /** @type {Map<string,number>} */ const requestTimes = new Map();
  /** @type {Map<string,number>} */ const received = new Map();
  /** @type {Map<string,number[]>} */ const hitTimes = new Map();
  /** @type {number[]} */ let totalHits = [];
  const stats = { rejected: 0, rateLimited: 0 };

  /** @param {string} userId @param {PokeMessage} message @returns {void} */
  function send(userId, message) {
    if (!options.send(userId, message)) throw new DOMException('指点连接尚未就绪或已断开，请稍后重试', 'NetworkError');
  }
  /** @param {string} userId @param {PokeMessage} message @returns {void} */
  function notify(userId, message) {
    if (!options.send(userId, message)) options.onError(new DOMException('指点状态未能送达对方，已在本机撤销', 'NetworkError'));
  }
  /** @param {Remote} peer @returns {void} */
  function resetRemote(peer) {
    if (peer.timer !== null) clearTimeout(peer.timer);
    peer.timer = null; peer.status = 'idle'; peer.requestId = null; peer.grantId = null; peer.seq = 0;
  }
  /** @param {string} userId @returns {void} */
  function clearRequest(userId) {
    const request = requests.get(userId);
    if (request) clearTimeout(request.timer);
    requests.delete(userId);
  }
  /** @param {string} userId @returns {void} */
  function revoke(userId) {
    const grant = grants.get(userId);
    grants.delete(userId); hitTimes.delete(userId); clearRequest(userId);
    options.onClear(options.getSelfId());
    options.onState();
    if (grant && sessionId) {
      const message = /** @type {PokeMessage} */ ({ action: 'revoke', sessionId, grantId: grant.grantId });
      for (const viewer of viewers) notify(viewer, message);
    }
  }
  function revokeAll() { for (const userId of [...grants.keys()]) revoke(userId); }
  function end() {
    revokeAll();
    for (const userId of requests.keys()) clearRequest(userId);
    viewers.clear(); requestTimes.clear(); hitTimes.clear(); totalHits = [];
    sessionId = null; options.onClear(options.getSelfId()); options.onState();
  }
  /** @returns {string} */
  function start() { end(); sessionId = crypto.randomUUID(); options.onState(); return sessionId; }
  /** @param {string} userId @param {PokeAdvertisement|null} advertisement @returns {void} */
  function advertise(userId, advertisement) {
    const previous = peers.get(userId);
    const nextSession = advertisement?.sessionId ?? null;
    if (previous && previous.sessionId === nextSession && previous.supported === (advertisement !== null)) return;
    const watching = previous?.watching === true && nextSession !== null;
    if (previous) resetRemote(previous);
    peers.set(userId, { supported: advertisement !== null, sessionId: nextSession, watching, status: 'idle', requestId: null, grantId: null, seq: 0, timer: null, lastRequest: -Infinity });
    for (const key of received.keys()) if (key.startsWith(userId + ':')) received.delete(key);
    options.onClear(userId); options.onState();
    if (watching && nextSession) notify(userId, { action: 'watch', sessionId: nextSession, watching: true });
  }
  /** @param {string} userId @returns {void} */
  function watch(userId) {
    const peer = peers.get(userId);
    if (!peer) return;
    peer.watching = true;
    if (peer.supported && peer.sessionId) send(userId, { action: 'watch', sessionId: peer.sessionId, watching: true });
    options.onState();
  }
  /** @param {string} userId @returns {void} */
  function unwatch(userId) {
    const peer = peers.get(userId);
    if (!peer) return;
    const watching = peer.watching;
    peer.watching = false; resetRemote(peer); options.onClear(userId); options.onState();
    if (watching && peer.supported && peer.sessionId) notify(userId, { action: 'watch', sessionId: peer.sessionId, watching: false });
  }
  /** @param {string} userId @returns {void} */
  function request(userId) {
    const peer = peers.get(userId);
    if (!peer?.supported || !peer.sessionId || !peer.watching) throw new DOMException('请观看支持指点的共享画面，双方需更新客户端', 'InvalidStateError');
    if (peer.status !== 'idle') throw new DOMException('指点申请正在处理或已经通过', 'InvalidStateError');
    if (performance.now() - peer.lastRequest < 3000) throw new DOMException('请稍等片刻再申请指点', 'InvalidStateError');
    const requestId = crypto.randomUUID();
    send(userId, { action: 'request', sessionId: peer.sessionId, requestId });
    peer.lastRequest = performance.now(); peer.status = 'pending'; peer.requestId = requestId;
    peer.timer = setTimeout(() => {
      if (peer.requestId !== requestId || peer.status !== 'pending') return;
      const current = peer.sessionId;
      resetRemote(peer); options.onState();
      if (current) notify(userId, { action: 'cancel', sessionId: current, requestId });
    }, 30000);
    options.onState();
  }
  /** @param {string} userId @param {string} requestId @returns {void} */
  function approve(userId, requestId) {
    if (!sessionId || requests.get(userId)?.requestId !== requestId || !viewers.has(userId)) throw new DOMException('指点申请已失效', 'InvalidStateError');
    if (grants.size >= 3 && !grants.has(userId)) throw new DOMException('最多允许三人同时指点，请先收回一人的权限', 'QuotaExceededError');
    const grantId = crypto.randomUUID();
    send(userId, { action: 'response', sessionId, requestId, grantId });
    grants.set(userId, { requestId, grantId, seq: 0, lastHit: -Infinity, nx: 0, ny: 0, combo: 0 });
    clearRequest(userId); options.onState();
  }
  /** @param {string} userId @param {string} requestId @returns {void} */
  function reject(userId, requestId) {
    if (!sessionId || requests.get(userId)?.requestId !== requestId) throw new DOMException('指点申请已失效', 'InvalidStateError');
    clearRequest(userId); options.onState(); send(userId, { action: 'response', sessionId, requestId, grantId: null });
  }
  /** @param {string} userId @param {number} nx @param {number} ny @param {boolean} boom @returns {void} */
  function hit(userId, nx, ny, boom) {
    const peer = peers.get(userId);
    if (!peer?.watching || peer.status !== 'approved' || !peer.sessionId || !peer.grantId) throw new DOMException('指点权限已失效，请重新申请', 'NotAllowedError');
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1 || typeof boom !== 'boolean') throw new TypeError('Invalid screen poke position');
    peer.seq += 1;
    send(userId, { action: 'hit', sessionId: peer.sessionId, grantId: peer.grantId, seq: peer.seq, nx, ny, boom });
  }
  /** @param {string} from @param {Extract<PokeMessage,{action:'event'}>} message @returns {void} */
  function display(from, message) {
    const key = `${from}:${message.grantId}`;
    if (message.seq <= (received.get(key) ?? 0)) { stats.rejected += 1; return; }
    if (received.size >= 128 && !received.has(key)) received.delete(received.keys().next().value ?? '');
    received.set(key, message.seq);
    options.onHit({ sessionId: message.sessionId, targetUserId: from, fromUserId: message.fromUserId, eventId: `${message.grantId}:${message.seq}`, nx: message.nx, ny: message.ny, combo: message.combo, boom: message.boom });
  }
  /** @param {string} from @param {PokeMessage} message @returns {void} */
  function receive(from, message) {
    const peer = peers.get(from);
    if (!peer?.supported) { stats.rejected += 1; return; }
    if (message.action === 'response') {
      if (!peer.watching || peer.sessionId !== message.sessionId || peer.status !== 'pending' || peer.requestId !== message.requestId) { stats.rejected += 1; return; }
      if (peer.timer !== null) clearTimeout(peer.timer);
      peer.timer = null; peer.status = message.grantId ? 'approved' : 'idle'; peer.grantId = message.grantId; peer.requestId = null;
      options.onState(); return;
    }
    if (message.action === 'revoke') {
      if (peer.sessionId !== message.sessionId) return;
      // A tombstone rejects reordered unreliable events after reliable revocation.
      if (received.size >= 128 && !received.has(`${from}:${message.grantId}`)) received.delete(received.keys().next().value ?? '');
      received.set(`${from}:${message.grantId}`, Number.MAX_SAFE_INTEGER);
      if (peer.grantId === message.grantId) resetRemote(peer);
      options.onClear(from); options.onState(); return;
    }
    if (message.action === 'event') {
      if (!peer.watching || peer.sessionId !== message.sessionId) { stats.rejected += 1; return; }
      display(from, message); return;
    }
    if (!sessionId || message.sessionId !== sessionId) { stats.rejected += 1; return; }
    if (message.action === 'watch') {
      if (message.watching) viewers.add(from);
      else { revoke(from); viewers.delete(from); }
      return;
    }
    if (message.action === 'cancel') {
      if (requests.get(from)?.requestId === message.requestId) { clearRequest(from); options.onState(); }
      if (grants.get(from)?.requestId === message.requestId) revoke(from);
      return;
    }
    if (!viewers.has(from)) { stats.rejected += 1; return; }
    if (message.action === 'request') {
      const now = performance.now();
      if (now - (requestTimes.get(from) ?? -Infinity) < 3000 || requests.has(from) || grants.has(from)) { stats.rateLimited += 1; return; }
      requestTimes.set(from, now);
      if (grants.size >= 3) { notify(from, { action: 'response', sessionId, requestId: message.requestId, grantId: null }); return; }
      const requestId = message.requestId;
      const current = sessionId;
      requests.set(from, { requestId, timer: setTimeout(() => {
        if (requests.get(from)?.requestId !== requestId) return;
        clearRequest(from); options.onState(); notify(from, { action: 'response', sessionId: current, requestId, grantId: null });
      }, 30000) });
      options.onState(); return;
    }
    if (message.action !== 'hit') return;
    const grant = grants.get(from);
    if (!grant || grant.grantId !== message.grantId || message.seq <= grant.seq) { stats.rejected += 1; return; }
    const now = performance.now();
    const recent = (hitTimes.get(from) ?? []).filter(time => now - time < 1000);
    totalHits = totalHits.filter(time => now - time < 1000);
    grant.seq = message.seq;
    if (recent.length >= 12 || totalHits.length >= 24) { stats.rateLimited += 1; return; }
    hitTimes.set(from, [...recent, now]); totalHits.push(now);
    const combo = now - grant.lastHit <= 1100 && Math.hypot(message.nx - grant.nx, message.ny - grant.ny) <= 0.08 ? Math.min(10, grant.combo + 1) : 1;
    grant.lastHit = now; grant.nx = message.nx; grant.ny = message.ny; grant.combo = combo;
    const event = /** @type {Extract<PokeMessage,{action:'event'}>} */ ({ action: 'event', sessionId, fromUserId: from, grantId: grant.grantId, seq: message.seq, nx: message.nx, ny: message.ny, boom: message.boom, combo });
    display(options.getSelfId(), event);
    for (const viewer of viewers) options.send(viewer, event);
  }
  /** @param {string} userId @returns {void} */
  function remove(userId) {
    const peer = peers.get(userId); if (peer) resetRemote(peer);
    viewers.delete(userId); revoke(userId); peers.delete(userId); requestTimes.delete(userId);
    options.onClear(userId); options.onState();
  }
  /** @returns {PokeState} */
  function state() {
    return { sessionId, peers: [...peers].map(([userId, peer]) => ({ userId, supported: peer.supported, sessionId: peer.sessionId, status: peer.status, requestId: peer.requestId })), requests: [...requests].map(([userId, request]) => ({ userId, requestId: request.requestId })), authorized: [...grants.keys()].map(userId => ({ userId })) };
  }
  function reset() { end(); for (const peer of peers.values()) resetRemote(peer); peers.clear(); received.clear(); options.onState(); }
  return { start, end, advertise, watch, unwatch, request, approve, reject, revoke, revokeAll, hit, receive, remove, state, reset, stats: () => ({ ...stats }), advertisement: () => /** @type {PokeAdvertisement} */ ({ version: 1, sessionId }) };
}
