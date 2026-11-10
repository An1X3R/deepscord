// @ts-check
'use strict';
const { BrowserWindow, screen } = require('electron');
const path = require('node:path');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{userId:string,requestId:string,name:string}} PokeRequest */
/** @typedef {{sessionId:string,requests:PokeRequest[],canApprove:boolean}} RequestState */
/** @typedef {{sessionId:string,userId:string,requestId:string,approved:boolean}} PokeDecision */
/** @typedef {{owner:Electron.WebContents,ownerWindow:Electron.BrowserWindow,displayId:string|null,value:RequestState,answered:Set<string>,received:Map<string,number>,timer:ReturnType<typeof setTimeout>|null,idleTimer:ReturnType<typeof setTimeout>|null,window:Electron.BrowserWindow|null,ready:Promise<void>|null,loaded:boolean,refresh:()=>void}} RequestSession */
/** @type {RequestSession|null} */ let activeRequests = null;
/** @param {JsonValue} input @returns {Record<string,JsonValue>} */
function requestObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Poke request payload must be an object');
  return input;
}
/** @param {JsonValue|undefined} value @param {string} field @returns {string} */
function requestIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value)) throw new TypeError(`Invalid poke request ${field}`);
  return value;
}
/** @param {JsonValue} input @returns {RequestState} */
function parseRequestState(input) {
  const value = requestObject(input);
  if (!Array.isArray(value.requests) || value.requests.length > 32 || typeof value.canApprove !== 'boolean') throw new TypeError('Poke requests require at most 32 entries and an explicit approval state');
  const requests = value.requests.map((entry) => {
    const request = requestObject(entry);
    if (typeof request.name !== 'string' || request.name.length > 80 || /[\u0000-\u001f\u007f]/.test(request.name)) throw new TypeError('Poke request name must contain at most 80 characters without control characters');
    return { userId: requestIdentifier(request.userId, 'userId'), requestId: requestIdentifier(request.requestId, 'requestId'), name: request.name };
  });
  if (new Set(requests.map((entry) => entry.userId)).size !== requests.length || new Set(requests.map((entry) => entry.requestId)).size !== requests.length) throw new TypeError('Duplicate poke requester or request identifier');
  return { sessionId: requestIdentifier(value.sessionId, 'sessionId'), requests, canApprove: value.canApprove };
}
/** @param {JsonValue} input @returns {PokeDecision} */
function parseDecision(input) {
  const value = requestObject(input);
  if (typeof value.approved !== 'boolean') throw new TypeError('Poke decision must explicitly approve or reject');
  return { sessionId: requestIdentifier(value.sessionId, 'sessionId'), userId: requestIdentifier(value.userId, 'userId'), requestId: requestIdentifier(value.requestId, 'requestId'), approved: value.approved };
}
/** @param {RequestSession} state @returns {Electron.Rectangle} */
function requestBounds(state) {
  const display = screen.getAllDisplays().find((entry) => String(entry.id) === state.displayId) || screen.getDisplayMatching(state.ownerWindow.getBounds());
  const area = display.workArea;
  const inset = Math.min(16, Math.floor(Math.min(area.width, area.height) / 10));
  const width = Math.min(348, area.width - inset * 2);
  const height = Math.min(600, 8 + state.value.requests.length * 160, area.height - inset * 2);
  return { x: area.x + area.width - width - inset, y: area.y + area.height - height - inset, width, height };
}
/** @returns {void} */
function disposePokeRequests() {
  const state = activeRequests; activeRequests = null;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.ownerWindow.removeListener('focus', state.refresh).removeListener('blur', state.refresh).removeListener('minimize', state.refresh).removeListener('restore', state.refresh).removeListener('hide', state.refresh).removeListener('show', state.refresh).removeListener('closed', state.refresh);
  if (state.window && !state.window.isDestroyed()) state.window.destroy();
}
/** @param {RequestSession} state @returns {void} */
function refreshRequests(state) {
  if (activeRequests !== state) return;
  if (state.ownerWindow.isDestroyed() || state.owner.isDestroyed()) { disposePokeRequests(); return; }
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  const now = Date.now();
  for (const [id, expires] of state.received) if (expires <= now) state.answered.add(id);
  state.value = { ...state.value, requests: state.value.requests.filter((entry) => !state.answered.has(entry.requestId)) };
  const deadlines = state.value.requests.map((entry) => state.received.get(entry.requestId)).filter((value) => value !== undefined);
  if (deadlines.length) state.timer = setTimeout(state.refresh, Math.max(1, Math.min(...deadlines) - now));
  if (state.value.requests.length && state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  if (!state.value.requests.length && state.window && !state.idleTimer) {
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (activeRequests !== state || state.value.requests.length) return;
      const idleWindow = state.window;
      state.window = null; state.loaded = false; state.ready = null;
      if (idleWindow && !idleWindow.isDestroyed()) idleWindow.destroy();
    }, 30000);
  }
  const win = state.window;
  if (!win || win.isDestroyed() || !state.loaded) return;
  if (!state.value.requests.length) win.hide();
  win.webContents.send('poke-request:state', state.value);
  const bounds = requestBounds(state), actual = win.getBounds();
  if (actual.x !== bounds.x || actual.y !== bounds.y || actual.width !== bounds.width || actual.height !== bounds.height) win.setBounds(bounds);
  if (state.value.requests.length) { if (!win.isVisible()) win.showInactive(); }
  else if (win.isVisible()) win.hide();
}
/** @param {RequestSession} state @param {RequestState} value @returns {void} */
function receiveRequests(state, value) {
  const fresh = value.requests.filter((entry) => !state.received.has(entry.requestId));
  if (state.received.size + fresh.length > 512) throw new Error('Poke request limit reached; restart screen sharing');
  const expires = Date.now() + 30000;
  for (const entry of fresh) state.received.set(entry.requestId, expires);
  state.value = { ...value, requests: value.requests.filter((entry) => !state.answered.has(entry.requestId)) };
}
/** @param {Electron.WebContents} owner @param {RequestState} value @param {string|null} displayId @returns {Promise<void>} */
async function updatePokeRequests(owner, value, displayId) {
  if (activeRequests && (activeRequests.owner !== owner || activeRequests.value.sessionId !== value.sessionId)) disposePokeRequests();
  const state = activeRequests;
  if (state) { receiveRequests(state, value); refreshRequests(state); await ensureRequestWindow(state); return; }
  if (!value.requests.length) return;
  const ownerWindow = BrowserWindow.fromWebContents(owner);
  if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error('Poke request owner window is unavailable');
  /** @type {RequestSession} */
  const created = { owner, ownerWindow, value, displayId, answered: new Set(), received: new Map(), timer: null, idleTimer: null, window: null, ready: null, loaded: false, refresh: () => refreshRequests(created) };
  receiveRequests(created, value);
  activeRequests = created;
  ownerWindow.on('focus', created.refresh).on('blur', created.refresh).on('minimize', created.refresh).on('restore', created.refresh).on('hide', created.refresh).on('show', created.refresh);
  ownerWindow.once('closed', created.refresh);
  refreshRequests(created);
  await ensureRequestWindow(created);
}
/** @param {RequestSession} created @returns {Promise<void>} */
async function ensureRequestWindow(created) {
  if (activeRequests !== created || !created.value.requests.length) return;
  if (created.ready) return created.ready;
  const win = new BrowserWindow({ ...requestBounds(created), show: false, frame: false, transparent: true, backgroundColor: '#00000000', skipTaskbar: true, alwaysOnTop: true, focusable: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: true, webPreferences: { preload: path.join(__dirname, 'poke-request-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'poke-request', devTools: false } });
  created.window = win;
  refreshRequests(created);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  created.ready = win.loadFile(path.join(__dirname, 'poke-request.html')).then(() => {
    if (activeRequests !== created || win.isDestroyed()) return;
    created.loaded = true; refreshRequests(created);
  }).catch((error) => { if (activeRequests === created) disposePokeRequests(); throw error; });
  return created.ready;
}
/** @param {Electron.IpcMainInvokeEvent} event @param {JsonValue} input @returns {void} */
function acceptPokeDecision(event, input) {
  const state = activeRequests;
  const win = state?.window;
  if (!state || !win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Poke decision came from an unauthorized frame');
  const decision = parseDecision(input);
  refreshRequests(state);
  if (decision.sessionId !== state.value.sessionId || !state.value.requests.some((entry) => entry.userId === decision.userId && entry.requestId === decision.requestId)) throw new Error('Poke request has expired or was already answered');
  if (decision.approved && !state.value.canApprove) throw new Error('Poke approval is currently unavailable');
  if (state.answered.size >= 512) throw new Error('Poke request decision limit reached; restart screen sharing');
  state.answered.add(decision.requestId);
  state.value = { ...state.value, requests: state.value.requests.filter((entry) => entry.requestId !== decision.requestId) };
  refreshRequests(state);
  if (state.owner.isDestroyed()) throw new Error('Poke request owner disconnected');
  state.owner.send('poke:decision', decision);
}
module.exports = { parseRequestState, parseDecision, updatePokeRequests, acceptPokeDecision, disposePokeRequests };
