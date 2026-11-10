// @ts-check

/** @typedef {{sessionId:string,userId:string,requestId:string,approved:boolean}} PokeDecision */
/** @typedef {{sessionId:string,requests:{userId:string,requestId:string,name:string}[],canApprove:boolean}} PokeRequests */
/** @typedef {{beginScreenPokeSession:(value:{sessionId:string,sourceId:string})=>Promise<{desktopOverlay:boolean,reason:string|null}>,triggerScreenPokeOverlay:(value:{sessionId:string,eventId:string,fromUserId:string,nx:number,ny:number,combo:number,pokerName:string})=>Promise<void>,clearScreenPokeOverlay:(value:{sessionId:string})=>Promise<void>,endScreenPokeSession:(value:{sessionId:string})=>Promise<void>,updateScreenPokeRequests?:(value:PokeRequests)=>Promise<void>,onScreenPokeDecision?:(callback:(decision:PokeDecision)=>void)=>(()=>void)}} PokeBridge */
/** @typedef {{getSession:()=>string|null,getState:()=>import('./screen-poke.js').PokeState,getName:(id:string)=>string,respond:(decision:PokeDecision)=>void,reportError:(error:Error)=>void,notify:(message:string)=>void}} DesktopPokeOptions */

/** Serialize native lifecycle operations so an old clear cannot erase a new share.
 * @param {DesktopPokeOptions} options */
export function createDesktopPoke(options) {
  /** @type {string|null} */ let active = null;
  let queue = Promise.resolve();
  /** @type {string|null} */ let requestSignature = null;
  /** @returns {PokeBridge|null} */
  function bridge() {
    const value = /** @type {Window & {deepscord?:PokeBridge}} */ (window).deepscord;
    return value && typeof value.beginScreenPokeSession === 'function' ? value : null;
  }
  const unsubscribe = bridge()?.onScreenPokeDecision?.(decision => {
    const state = options.getState();
    if (!decision || typeof decision.approved !== 'boolean' || decision.sessionId !== state.sessionId || !state.requests.some(item => item.userId === decision.userId && item.requestId === decision.requestId)) return;
    options.respond(decision);
  });
  if (unsubscribe) window.addEventListener('beforeunload', unsubscribe, { once: true });
  /** @param {PokeBridge} desktop @param {string} sessionId @returns {Promise<void>} */
  async function publishRequests(desktop, sessionId) {
    if (!desktop.updateScreenPokeRequests || active !== sessionId || options.getSession() !== sessionId) return;
    const state = options.getState();
    const payload = { sessionId, canApprove: state.authorized.length < 3, requests: state.requests.map(item => ({ ...item, name: options.getName(item.userId) })) };
    const signature = JSON.stringify(payload);
    if (signature === requestSignature) return;
    await desktop.updateScreenPokeRequests(payload);
    requestSignature = signature;
  }
  /** @param {()=>Promise<void>} operation @returns {Promise<void>} */
  function schedule(operation) {
    const result = queue.then(operation);
    queue = result.catch(error => options.reportError(error instanceof Error ? error : new Error(String(error))));
    return result;
  }
  /** @param {string} sessionId @param {string} sourceId @returns {Promise<void>} */
  function begin(sessionId, sourceId) {
    const result = queue.then(async () => {
      const desktop = bridge();
      if (!desktop || options.getSession() !== sessionId) return;
      const result = await desktop.beginScreenPokeSession({ sessionId, sourceId });
      active = sessionId; requestSignature = null;
      if (options.getSession() !== sessionId) { await desktop.endScreenPokeSession({ sessionId }); active = null; return; }
      if (result.reason) options.notify(result.reason);
      await publishRequests(desktop, sessionId);
    });
    queue = result.catch(error => { console.warn('Desktop poke initialization failed', { sessionId, sourceId, message: error instanceof Error ? error.message : String(error) }); });
    return result;
  }
  /** @returns {void} */
  function sync() {
    if (active === null) return;
    if (active === options.getSession()) {
      const sessionId = active;
      void schedule(async () => { const desktop = bridge(); if (desktop) await publishRequests(desktop, sessionId); });
      return;
    }
    const sessionId = active; active = null;
    void schedule(async () => { const desktop = bridge(); if (desktop) await desktop.endScreenPokeSession({ sessionId }); });
  }
  /** @returns {void} */
  function clear() {
    const sessionId = active;
    if (!sessionId) return;
    void schedule(async () => { const desktop = bridge(); if (desktop && active === sessionId) await desktop.clearScreenPokeOverlay({ sessionId }); });
  }
  /** @param {import('./screen-poke.js').PokeHit} hit @returns {void} */
  function show(hit) {
    const receivedAt = performance.now();
    if (active !== hit.sessionId) return;
    void schedule(async () => {
      if (active !== hit.sessionId || options.getSession() !== hit.sessionId || performance.now() - receivedAt > 500) return;
      const desktop = bridge();
      if (desktop) await desktop.triggerScreenPokeOverlay({ sessionId: hit.sessionId, eventId: hit.eventId, fromUserId: hit.fromUserId, nx: hit.nx, ny: hit.ny, combo: hit.combo, pokerName: options.getName(hit.fromUserId) });
    });
  }
  return { begin, sync, clear, show };
}
