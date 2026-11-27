// @ts-check
'use strict';
const { BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { createGlobalPTT,parsePTTConfig } = require('./global-ptt.cjs');
const { initialSettings, desktopSettings, voiceOverlay, voiceOverlayDelta } = require('./desktop-schema.cjs');
/** @typedef {import('./desktop-schema.cjs').DesktopSettings} DesktopSettings */
/** @typedef {import('./desktop-schema.cjs').VoiceOverlay} VoiceOverlay */
/** @typedef {import('./desktop-schema.cjs').JsonValue} JsonValue */

/** @param {{getWindow:()=>Electron.BrowserWindow|null,userData:string}} options */
function createDesktopFeatures(options) {
  const settingsPath = path.join(options.userData, 'desktop-settings.json');
  const overlayUrl = pathToFileURL(path.join(__dirname, 'voice-overlay.html')).href;
  /** @type {DesktopSettings} */
  let settings = initialSettings();
  if (fs.existsSync(settingsPath)) settings = desktopSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  settings = { ...settings, overlay:{ ...settings.overlay, locked:true } };
  /** @type {Electron.BrowserWindow|null} */
  let overlayWindow = null;
  /** @type {boolean|null} */
  let appliedOverlayLock = null;
  /** @type {VoiceOverlay} */
  let voice = { connected:false, members:[] };
  let registered = '';
  let registeredDeafen = '';
  const ptt = createGlobalPTT({ onState:state => {
    const main = options.getWindow();
    if (main && !main.isDestroyed()) main.webContents.send('desktop:ptt-state', state);
  } });
  /** @type {string|null} */
  let shortcutError = null;
  let applyingBounds = false;
  let disposed = false;
  /** @type {{id:string,previous:string,previousDeafen:string,window:Electron.BrowserWindow,timer:NodeJS.Timeout}|null} */
  let captureLease = null;
  let completedCapture = '';
  /** @type {import('./global-ptt.cjs').PTTConfig|null} */
  let pttConfig = null;

  /** @param {DesktopSettings} value @returns {DesktopSettings} */
  function reachable(value) {
    const bounds = value.overlay;
    const display = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(bounds.width, display.width);
    const height = Math.min(bounds.height, display.height);
    return { ...value, overlay:{ ...bounds, width, height,
      x:Math.max(display.x, Math.min(bounds.x, display.x + display.width - width)),
      y:Math.max(display.y, Math.min(bounds.y, display.y + display.height - height)) } };
  }
  /** @param {DesktopSettings} value @returns {void} */
  function persist(value) {
    fs.mkdirSync(options.userData, { recursive:true });
    fs.writeFileSync(settingsPath + '.tmp', JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(settingsPath + '.tmp', settingsPath);
  }
  /** @returns {void} */
  function sendMute() {
    if (captureLease) return;
    const main = options.getWindow();
    if (main && !main.isDestroyed()) main.webContents.send('desktop:mute-shortcut');
  }
  /** @returns {void} */
  function sendDeafen() {
    if (captureLease) return;
    const main = options.getWindow();
    if (main && !main.isDestroyed()) main.webContents.send('desktop:deafen-shortcut');
  }
  /** @param {string} mute @param {string} deafen @returns {void} */
  function registerPair(mute, deafen) {
    if (mute === registered && deafen === registeredDeafen) return;
    const previous = registered, previousDeafen = registeredDeafen;
    if (previous) globalShortcut.unregister(previous);
    if (previousDeafen) globalShortcut.unregister(previousDeafen);
    registered = ''; registeredDeafen = '';
    try {
      if (!globalShortcut.register(mute, sendMute)) throw new Error(`Global mute shortcut "${mute}" is unavailable; ${previous ? 'the previous shortcut remains active' : 'choose another shortcut in settings'}`);
      registered = mute;
      if (!globalShortcut.register(deafen, sendDeafen)) throw new Error(`Global deafen shortcut "${deafen}" is unavailable; choose another shortcut in settings`);
      registeredDeafen = deafen;
    } catch (error) {
      if (registered) globalShortcut.unregister(registered);
      if (registeredDeafen) globalShortcut.unregister(registeredDeafen);
      registered = ''; registeredDeafen = '';
      if (previous && globalShortcut.register(previous, sendMute)) registered = previous;
      if (previousDeafen && globalShortcut.register(previousDeafen, sendDeafen)) registeredDeafen = previousDeafen;
      if (registered !== previous || registeredDeafen !== previousDeafen) console.error('global_shortcut_rollback_failed', { mute:previous,deafen:previousDeafen });
      throw error;
    }
  }
  /** @returns {void} */
  function restoreShortcut() {
    const lease = captureLease;
    if (!lease) return;
    captureLease = null; completedCapture = lease.id; clearTimeout(lease.timer);
    lease.window.removeListener('blur', cancelCapture);
    lease.window.removeListener('closed', cancelCapture);
    lease.window.webContents.removeListener('did-start-navigation', cancelCapture);
    lease.window.webContents.removeListener('render-process-gone', cancelCapture);
    if (!lease.previous || disposed) return;
    try { registerPair(lease.previous, lease.previousDeafen); shortcutError = null; if (pttConfig) ptt.update(pttConfig); }
    catch (error) { shortcutError = error instanceof Error ? error.message : 'Global shortcut restoration failed with a non-error'; throw error; }
  }
  /** @returns {void} */
  function cancelCapture() {
    try { restoreShortcut(); }
    catch (error) { console.error('global_mute_shortcut_restore_failed', { accelerator:settings.muteShortcut, message:error instanceof Error ? error.message : String(error) }); }
  }
  /** @returns {{id:string}} */
  function beginShortcutCapture() {
    if (disposed) throw new Error('Desktop features have been disposed');
    if (captureLease) throw new Error('Global shortcut capture is already active');
    const window = options.getWindow();
    if (!window || window.isDestroyed() || !window.isFocused()) throw new Error('Shortcut capture requires the focused application window');
    const previous = registered, previousDeafen = registeredDeafen, id = randomUUID();
    if (previous) globalShortcut.unregister(previous);
    if (previousDeafen) globalShortcut.unregister(previousDeafen);
    registered = ''; registeredDeafen = '';
    ptt.stop();
    captureLease = { id, previous, previousDeafen, window, timer:setTimeout(cancelCapture, 30000) };
    window.on('blur', cancelCapture);
    window.on('closed', cancelCapture);
    window.webContents.on('did-start-navigation', cancelCapture);
    window.webContents.on('render-process-gone', cancelCapture);
    return { id };
  }
  /** @param {JsonValue} id @returns {void} */
  function endShortcutCapture(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new TypeError('Shortcut capture requires a valid session ID');
    if (!captureLease && id === completedCapture) {
      if (shortcutError) throw new Error(shortcutError);
      return;
    }
    if (!captureLease || captureLease.id !== id) throw new Error('Shortcut capture session does not match the active recording');
    restoreShortcut();
  }
  /** @returns {void} */
  function publish() {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send('overlay:state', { voice, settings:settings.overlay });
  }
  /** @returns {void} */
  function closeOverlay() {
    if (overlayWindow) { const previous = overlayWindow; overlayWindow = null; appliedOverlayLock = null; previous.destroy(); }
  }
  /** @returns {void} */
  function saveBounds() {
    if (!overlayWindow || applyingBounds || settings.overlay.locked) return;
    const bounds = overlayWindow.getBounds();
    const next = reachable({ ...settings, overlay:{ ...settings.overlay, ...bounds } });
    persist(next);
    settings = next;
    const main = options.getWindow();
    if (main && !main.isDestroyed()) main.webContents.send('desktop:settings-changed', settings);
  }
  /** @returns {void} */
  function renderOverlay() {
    if (disposed || (!voice.connected && settings.overlay.locked) || !settings.overlay.enabled) { closeOverlay(); return; }
    settings = reachable(settings);
    const bounds = settings.overlay;
    if (!overlayWindow) {
      overlayWindow = new BrowserWindow({ x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height,
        minWidth:180,minHeight:90,maxWidth:1200,maxHeight:1600, frame:false,transparent:true,backgroundColor:'#00000000',
        show:false,skipTaskbar:true,alwaysOnTop:true,hasShadow:false,focusable:!bounds.locked,
        webPreferences:{ preload:path.join(__dirname, 'overlay-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'voice-overlay' } });
      overlayWindow.setAlwaysOnTop(true, 'floating');
      overlayWindow.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
      overlayWindow.webContents.on('will-navigate', (event) => event.preventDefault());
      overlayWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      overlayWindow.webContents.on('did-finish-load', () => { publish(); if (overlayWindow) overlayWindow.showInactive(); });
      overlayWindow.on('moved', saveBounds);
      overlayWindow.on('resized', saveBounds);
      overlayWindow.loadURL(overlayUrl).catch((error) => { console.error('voice_overlay_load_failed', { message:error.message }); closeOverlay(); });
    }
    applyingBounds = true;
    if (appliedOverlayLock !== bounds.locked) {
      overlayWindow.setResizable(!bounds.locked);
      overlayWindow.setMovable(!bounds.locked);
      overlayWindow.setFocusable(!bounds.locked);
      overlayWindow.setIgnoreMouseEvents(bounds.locked);
      appliedOverlayLock = bounds.locked;
    }
    const actual = overlayWindow.getBounds();
    if (actual.x !== bounds.x || actual.y !== bounds.y || actual.width !== bounds.width || actual.height !== bounds.height) {
      overlayWindow.setBounds({ x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height });
    }
    applyingBounds = false;
    publish();
  }
  /** @param {Electron.IpcMainInvokeEvent} event @returns {void} */
  function authorize(event) {
    const main = options.getWindow();
    if (!main || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) throw new Error('Desktop controls require the active main window');
    const url = new URL(event.senderFrame.url);
    if (!['https:', 'http:', 'file:'].includes(url.protocol)) throw new Error('Desktop controls require a supported application page');
  }
  /** @param {JsonValue} input @returns {DesktopSettings} */
  function saveSettings(input) {
    if (captureLease) throw new Error('Finish or cancel shortcut capture before saving desktop settings');
    const next = reachable(desktopSettings(input));
    const previous = settings;
    try { registerPair(next.muteShortcut, next.deafenShortcut); }
    catch (error) { if (error instanceof Error) shortcutError = error.message; throw error; }
    try { persist(next); }
    catch (error) { registerPair(previous.muteShortcut, previous.deafenShortcut); throw error; }
    shortcutError = null;
    settings = next;
    if (!settings.overlay.enabled) voice = {connected:false,members:[]};
    renderOverlay();
    const main = options.getWindow();
    if (main && !main.isDestroyed()) main.webContents.send('desktop:settings-changed', settings);
    return structuredClone(settings);
  }
  /** @param {JsonValue} input @returns {void} */
  function updateVoice(input) { voice = voiceOverlay(input); renderOverlay(); }
  /** @param {JsonValue} input @returns {void} */
  function updateVoiceDelta(input) {
    if (!settings.overlay.enabled) return;
    const delta = voiceOverlayDelta(input,voice);
    const connectedChanged = voice.connected !== delta.connected;
    voice = {...delta,members:voice.members.map((member,index)=>({...member,...delta.members[index]}))};
    if (connectedChanged || !overlayWindow || overlayWindow.isDestroyed()) renderOverlay();
    else overlayWindow.webContents.send('overlay:delta',delta);
  }
  /** @returns {void} */
  function resetVoice() { pttConfig = null; ptt.stop(); voice = { connected:false,members:[] }; closeOverlay(); }
  /** @returns {DesktopSettings} */
  function getSettings() { return structuredClone(settings); }
  /** @returns {{registered:boolean,error:string|null}} */
  function getShortcutStatus() { return { registered:registered !== '' && registeredDeafen !== '', error:shortcutError }; }
  /** @returns {void} */
  function displaysChanged() { settings = reachable(settings); persist(settings); renderOverlay(); }
  /** @returns {void} */
  function dispose() {
    disposed = true;
    restoreShortcut();
    resetVoice();
    ptt.dispose();
    if (registeredDeafen) globalShortcut.unregister(registeredDeafen);
    if (registered) globalShortcut.unregister(registered);
    for (const channel of ['desktop:ptt:update','desktop:settings:get','desktop:settings:set','desktop:overlay:update','desktop:overlay:delta','desktop:shortcut:status','desktop:shortcut:capture-begin','desktop:shortcut:capture-end','overlay:adjustment:finish','overlay:adjustment:resize']) ipcMain.removeHandler(channel);
    screen.removeListener('display-removed', displaysChanged);
    screen.removeListener('display-metrics-changed', displaysChanged);
  }

  settings = reachable(settings);
  try { registerPair(settings.muteShortcut, settings.deafenShortcut); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    shortcutError = error.message;
    console.error('global_mute_shortcut_unavailable', { accelerator:settings.muteShortcut,message:error.message });
  }
  /** @param {Electron.IpcMainInvokeEvent} event @returns {void} */
  function authorizeAdjustment(event) {
    if (!overlayWindow || event.sender !== overlayWindow.webContents || event.senderFrame !== overlayWindow.webContents.mainFrame || settings.overlay.locked) throw new Error('Overlay adjustment requires the active adjustment window');
  }
  ipcMain.handle('overlay:adjustment:finish', (event) => {
    authorizeAdjustment(event);
    saveBounds();
    saveSettings({ ...settings, overlay:{ ...settings.overlay, locked:true } });
    const main = options.getWindow();
    if (main && !main.isDestroyed()) main.webContents.send('desktop:settings-changed', settings);
  });
  ipcMain.handle('overlay:adjustment:resize', (event, /** @type {JsonValue} */ input) => {
    authorizeAdjustment(event);
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.width !== 'number' || typeof input.height !== 'number' || !Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 180 || input.width > 1200 || input.height < 90 || input.height > 1600) throw new TypeError('Overlay resize requires integer width 180–1200 and height 90–1600');
    if (!overlayWindow) throw new Error('Overlay adjustment window closed');
    overlayWindow.setSize(input.width, input.height);
    saveBounds();
  });
  ipcMain.handle('desktop:ptt:update', (event, /** @type {JsonValue} */ input) => { authorize(event);
    try { pttConfig = parsePTTConfig(input); }
    catch (error) { pttConfig = null; ptt.stop(); throw error; }
    if (captureLease) return;
    ptt.update(pttConfig); });
  ipcMain.handle('desktop:settings:get', (event) => { authorize(event); return getSettings(); });
  ipcMain.handle('desktop:shortcut:status', (event) => { authorize(event); return getShortcutStatus(); });
  ipcMain.handle('desktop:shortcut:capture-begin', (event) => { authorize(event); return beginShortcutCapture(); });
  ipcMain.handle('desktop:shortcut:capture-end', (event, /** @type {JsonValue} */ id) => { authorize(event); endShortcutCapture(id); });
  ipcMain.handle('desktop:settings:set', (event, /** @type {JsonValue} */ input) => { authorize(event); return saveSettings(input); });
  ipcMain.handle('desktop:overlay:update', (event, /** @type {JsonValue} */ input) => { authorize(event); if(settings.overlay.enabled)updateVoice(input); });
  ipcMain.handle('desktop:overlay:delta', (event, /** @type {JsonValue} */ input) => { authorize(event); updateVoiceDelta(input); });
  screen.on('display-removed', displaysChanged);
  screen.on('display-metrics-changed', displaysChanged);
  return { getSettings, getShortcutStatus, saveSettings, updateVoice, updateVoiceDelta, resetVoice, dispose };
}
module.exports = { createDesktopFeatures };
