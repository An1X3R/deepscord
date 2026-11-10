// @ts-check
'use strict';
const { BrowserWindow, screen } = require('electron');
const path = require('node:path');
const requests = require('./poke-request.cjs');
const nativeBounds = require('./poke-window-bounds.cjs');

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{sessionId:string,sourceId:string}} BeginPoke */
/** @typedef {{sessionId:string,eventId:string,fromUserId:string,nx:number,ny:number,combo:number,pokerName:string}} PokeHit */
/** @typedef {{owner:Electron.WebContents,sessionId:string,displayId:string|null,tracker:import('./poke-window-bounds.cjs').WindowTracker|null,window:Electron.BrowserWindow|null,ready:Promise<void>|null,loaded:boolean,epoch:number,events:Map<string,number>,rates:Map<string,{start:number,count:number}>,total:{start:number,count:number}}} PokeSession */
/** @type {PokeSession|null} */ let current = null;

/** @param {JsonValue} input @returns {Record<string,JsonValue>} */
function object(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Poke payload must be an object');
  return input;
}
/** @param {JsonValue|undefined} value @param {string} field @returns {string} */
function identifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value)) throw new TypeError(`Invalid poke ${field}`);
  return value;
}
/** @param {JsonValue} input @returns {BeginPoke} */
function parseBegin(input) {
  const value = object(input);
  return { sessionId: identifier(value.sessionId, 'sessionId'), sourceId: identifier(value.sourceId, 'sourceId') };
}
/** @param {JsonValue} input @returns {string} */
function parseSession(input) { return identifier(object(input).sessionId, 'sessionId'); }
/** @param {JsonValue} input @returns {PokeHit} */
function parseHit(input) {
  const value = object(input);
  if (typeof value.nx !== 'number' || !Number.isFinite(value.nx) || value.nx < 0 || value.nx > 1 || typeof value.ny !== 'number' || !Number.isFinite(value.ny) || value.ny < 0 || value.ny > 1) throw new TypeError('Poke coordinates must be finite numbers in [0,1]');
  if (typeof value.combo !== 'number' || !Number.isInteger(value.combo) || value.combo < 1 || value.combo > 10) throw new TypeError('Poke combo must be an integer in [1,10]');
  if (typeof value.pokerName !== 'string' || value.pokerName.length > 80 || /[\u0000-\u001f\u007f]/.test(value.pokerName)) throw new TypeError('Poke name must be text of at most 80 characters without control characters');
  return { sessionId: identifier(value.sessionId, 'sessionId'), eventId: identifier(value.eventId, 'eventId'), fromUserId: identifier(value.fromUserId, 'fromUserId'), nx: value.nx, ny: value.ny, combo: value.combo, pokerName: value.pokerName };
}
/** @param {Electron.DesktopCapturerSource} source @returns {Electron.Display|null} */
function sourceDisplay(source) {
  if (!source.id.startsWith('screen:') || !source.display_id) return null;
  return screen.getAllDisplays().find((display) => String(display.id) === source.display_id) || null;
}
/** @returns {void} */
function disposePokeOverlay() {
  requests.disposePokeRequests();
  const state = current;
  current = null;
  state?.tracker?.dispose();
  if (state?.window && !state.window.isDestroyed()) state.window.destroy();
}
/** @param {Electron.WebContents} owner @param {BeginPoke} payload @param {Electron.DesktopCapturerSource} source @returns {Promise<{desktopOverlay:boolean,reason:string|null}>} */
async function beginPokeOverlay(owner, payload, source) {
  disposePokeOverlay();
  const display = sourceDisplay(source);
  const state = /** @type {PokeSession} */ ({ owner, sessionId: payload.sessionId, displayId: display ? String(display.id) : null, tracker: null, window: null, ready: null, loaded: false, epoch: 0, events: new Map(), rates: new Map(), total: { start: 0, count: 0 } });
  current = state;
  if (source.id.startsWith('window:')) {
    try {
      const tracker = await nativeBounds.trackWindow(source.id, bounds => {
        if (current !== state || !state.window || state.window.isDestroyed()) return;
        if (!bounds) { state.window.hide(); return; }
        state.window.setBounds(screen.screenToDipRect(null, bounds));
        if (state.loaded) state.window.showInactive();
      });
      if (current !== state) { tracker.dispose(); throw new Error('Poke session ended while resolving shared window bounds'); }
      state.tracker = tracker;
    } catch (error) { if (current === state) disposePokeOverlay(); throw error; }
  }
  return { desktopOverlay: display !== null || state.tracker !== null, reason: !display && !state.tracker ? '无法确认分享屏幕对应的显示器，请重新选择整个屏幕；指点仍在应用画面内显示' : null };
}
/** @param {PokeSession} state @returns {Electron.Rectangle|null} */
function targetBounds(state) {
  if (state.tracker) {
    const bounds = state.tracker.read();
    return bounds ? screen.screenToDipRect(null, bounds) : null;
  }
  const display = screen.getAllDisplays().find(entry => String(entry.id) === state.displayId);
  if (!display) throw new Error('分享显示器已断开，请停止并重新分享屏幕');
  return display.bounds;
}
/** @param {Electron.WebContents} owner @param {string} sessionId @returns {PokeSession} */
function requireSession(owner, sessionId) {
  if (!current || current.owner !== owner || current.sessionId !== sessionId) throw new Error('Poke session is no longer active');
  return current;
}
/** @param {PokeSession} state @returns {Promise<void>} */
async function ensureWindow(state) {
  if (state.ready) return state.ready;
  const bounds = targetBounds(state);
  if (!bounds) return;
  const win = new BrowserWindow({ ...bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000', skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false, fullscreenable: false, resizable: false, movable: false, webPreferences: { preload: path.join(__dirname, 'poke-overlay-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'poke-overlay', devTools: false } });
  state.window = win;
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setFocusable(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  state.ready = win.loadFile(path.join(__dirname, 'poke-overlay.html')).then(() => {
    if (current !== state || win.isDestroyed()) return;
    state.loaded = true;
    const bounds = targetBounds(state);
    if (bounds) { win.setBounds(bounds); win.showInactive(); }
  });
  return state.ready;
}
/** @param {Electron.WebContents} owner @param {PokeHit} payload @returns {Promise<void>} */
async function triggerPokeOverlay(owner, payload) {
  const receivedAt = performance.now();
  const state = requireSession(owner, payload.sessionId);
  const epoch = state.epoch;
  const now = Date.now();
  for (const [id, time] of state.events) if (now - time > 3000) state.events.delete(id);
  for (const [id, rate] of state.rates) if (now - rate.start >= 1000) state.rates.delete(id);
  if (state.events.has(payload.eventId)) throw new Error('Duplicate poke event');
  const rate = state.rates.get(payload.fromUserId) || { start: now, count: 0 };
  if (now - state.total.start >= 1000) state.total = { start: now, count: 0 };
  if (rate.count >= 12 || state.total.count >= 36 || state.events.size >= 108) throw new Error('Poke overlay rate limit exceeded');
  rate.count += 1; state.total.count += 1;
  state.rates.set(payload.fromUserId, rate); state.events.set(payload.eventId, now);
  if (!state.displayId && !state.tracker) return;
  if (!targetBounds(state)) return;
  await ensureWindow(state);
  if (current !== state || state.epoch !== epoch || performance.now() - receivedAt > 500) return;
  if (!state.window || state.window.isDestroyed()) throw new Error('Poke overlay window closed unexpectedly; restart screen sharing');
  const bounds = targetBounds(state);
  if (!bounds) return;
  state.window.setBounds(bounds);
  state.window.webContents.send('poke-overlay:hit', payload);
}
/** @param {Electron.WebContents} owner @param {string} sessionId @returns {void} */
function clearPokeOverlay(owner, sessionId) {
  const state = requireSession(owner, sessionId);
  state.epoch += 1;
  if (state.window && !state.window.isDestroyed()) state.window.webContents.send('poke-overlay:clear');
}
/** @param {Electron.WebContents} owner @param {string} sessionId @returns {void} */
function endPokeOverlay(owner, sessionId) { requireSession(owner, sessionId); disposePokeOverlay(); }
/** @param {Electron.WebContents} owner @param {import('./poke-request.cjs').RequestState} value @returns {Promise<void>} */
function updatePokeRequestsForSession(owner, value) {
  const state = requireSession(owner, value.sessionId);
  return requests.updatePokeRequests(owner, value, state.displayId);
}

module.exports = { parseBegin, parseSession, parseHit, sourceDisplay, beginPokeOverlay, triggerPokeOverlay, clearPokeOverlay, endPokeOverlay, disposePokeOverlay, updatePokeRequestsForSession };
