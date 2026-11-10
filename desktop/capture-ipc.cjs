// @ts-check
'use strict';
const { app, ipcMain, desktopCapturer } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const poke = require('./poke-overlay.cjs');
const pokeRequests = require('./poke-request.cjs');

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{pid:number,name:string,title:string}} ProcessSource */
/** @typedef {{getWindow:()=>Electron.BrowserWindow|null}} CaptureOptions */
/** @typedef {{id:string,pid:number,owner:Electron.WebContents,child:import('node:child_process').ChildProcessWithoutNullStreams,exited:Promise<void>,stopping:boolean}} ActiveCapture */
const execute = promisify(execFile);
const helper = path.join(__dirname, 'native', 'bin', 'process-audio.exe');
/** @type {CaptureOptions|null} */ let options = null;
/** @type {ActiveCapture|null} */ let active = null;
/** @type {Promise<void>|null} */ let starting = null;
/** @type {Map<string,Electron.DesktopCapturerSource>} */ let sources = new Map();
/** @type {Map<number,ProcessSource>} */ let processes = new Map();
/** @type {{owner:number,id:string,expires:number}|null} */ let selected = null;
/** @type {{owner:Electron.WebContents,source:Electron.DesktopCapturerSource,expires:number}|null} */ let confirmedScreen = null;
let generation = 0;

/** @param {Electron.IpcMainInvokeEvent} event @returns {Electron.WebContents} */
function assertOwner(event) {
  const window = options?.getWindow();
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Capture request came from an unauthorized frame');
  const url = new URL(event.sender.getURL());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Capture is only available inside a connected room');
  return event.sender;
}

/** @param {JsonValue} value @returns {ProcessSource[]} */
function parseProcesses(value) {
  if (!Array.isArray(value) || value.length > 2048) throw new TypeError('Invalid native process list');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Number.isSafeInteger(item.pid) || typeof item.pid !== 'number' || item.pid <= 0 || typeof item.name !== 'string' || item.name.length > 512 || typeof item.title !== 'string' || item.title.length > 512) throw new TypeError('Invalid native audio process entry');
    return { pid: item.pid, name: item.name, title: item.title };
  });
}

/** @returns {Promise<ProcessSource[]>} */
async function listProcesses() {
  if (process.platform !== 'win32') throw new Error('按进程伴奏仅支持 Windows 客户端');
  const result = await execute(helper, ['--list'], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  /** @type {JsonValue} */ const parsed = JSON.parse(result.stdout);
  const ownProcesses = new Set(app.getAppMetrics().map((item) => item.pid));
  const entries = parseProcesses(parsed).filter((item) => item.pid !== process.pid && !ownProcesses.has(item.pid));
  processes = new Map(entries.map((item) => [item.pid, item]));
  return entries;
}

/** @param {number} pid @param {'--capture'|'--capture-excluding'} command @param {Electron.WebContents} owner @returns {Promise<{id:string,sampleRate:number,channels:number}>} */
async function startCapture(pid, command, owner) {
  if (process.platform !== 'win32') throw new Error('伴奏采集仅支持 Windows 客户端');
  if (command === '--capture' && (!Number.isSafeInteger(pid) || !processes.has(pid) || pid === process.pid)) throw new TypeError('请刷新列表并选择可用的音频进程');
  if (active || starting) throw new Error('请先停止当前伴奏再选择其他进程');
  const epoch = generation;
  const child = spawn(helper, [command, String(pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const id = randomUUID();
  let finished = false;
  /** @type {(value:void)=>void} */ let finish = () => {};
  const exited = new Promise((resolve) => { finish = resolve; });
  const capture = { id, pid, owner, child, exited, stopping: false };
  active = capture;
  let stderr = '';
  let ready = false;
  /** @type {(value:void)=>void} */ let resolveReady = () => {};
  /** @type {(error:Error)=>void} */ let rejectReady = () => {};
  const pending = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  starting = pending;
  const timer = setTimeout(() => rejectReady(new Error('进程音频采集启动超过 12 秒')), 12000);
  let remainder = Buffer.alloc(0);
  child.stdout.on('data', (data) => {
    const bytes = Buffer.concat([remainder, data]);
    const length = bytes.length - bytes.length % 4;
    remainder = Buffer.from(bytes.subarray(length));
    if (length && !capture.stopping && epoch === generation && !owner.isDestroyed()) owner.send('capture:pcm', { id, pcm: new Uint8Array(bytes.subarray(0, length)).buffer });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => {
    stderr += String(data);
    if (stderr.length > 32768) { rejectReady(new Error('Native capture diagnostics exceeded the size limit')); child.kill(); return; }
    let end = stderr.indexOf('\n');
    while (end !== -1) {
      const line = stderr.slice(0, end); stderr = stderr.slice(end + 1);
      try {
        /** @type {JsonValue} */ const message = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError('Invalid capture diagnostic');
        if (message.event === 'ready') {
          if (message.pid !== pid || message.sampleRate !== 48000 || message.channels !== 2 || message.format !== 's16le') throw new TypeError('Unexpected native audio format');
          ready = true; resolveReady();
        } else if (message.event === 'error' && typeof message.message === 'string') {
          const error = new Error('指定进程音频采集失败：' + message.message);
          rejectReady(error);
          if (ready && !owner.isDestroyed()) owner.send('capture:ended', { id, error: error.message });
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error('Invalid process capture response');
        rejectReady(failure);
        console.error('Process capture diagnostic failed', { pid, message: failure.message });
        child.kill();
      }
      end = stderr.indexOf('\n');
    }
  });
  child.once('error', (error) => rejectReady(error));
  child.once('close', (code) => {
    finished = true;
    if (!ready) rejectReady(new Error(`进程音频采集未启动：退出码=${code}；${stderr}`));
    if (active === capture) active = null;
    if (!capture.stopping && !owner.isDestroyed()) owner.send('capture:ended', { id, error: code === 0 ? null : `伴奏采集进程异常退出：${code}` });
    finish();
  });
  try {
    await pending;
    if (epoch !== generation || finished) throw new Error('进程音频采集已取消');
    return { id, sampleRate: 48000, channels: 2 };
  } catch (error) {
    capture.stopping = true;
    child.stdin.end();
    child.kill();
    await exited;
    throw error;
  } finally {
    clearTimeout(timer);
    if (starting === pending) starting = null;
  }
}

/** @returns {Promise<void>} */
async function stopAllCapture() {
  confirmedScreen = null;
  selected = null;
  sources.clear();
  poke.disposePokeOverlay();
  await stopProcessCapture();
}

/** @returns {Promise<void>} */
async function stopProcessCapture() {
  generation += 1;
  processes.clear();
  const capture = active;
  if (!capture) return;
  capture.stopping = true;
  capture.child.stdin.end();
  const timer = setTimeout(() => capture.child.kill(), 1500);
  try { await capture.exited; } finally { clearTimeout(timer); }
}

/** @param {Electron.Session} session @returns {void} */
function configureCaptureSession(session) {
  session.setDisplayMediaRequestHandler((request, callback) => {
    const window = options?.getWindow();
    const choice = selected;
    selected = null;
    if (!window || request.frame !== window.webContents.mainFrame || !request.userGesture || !choice || choice.owner !== window.webContents.id || choice.expires < Date.now()) { callback(null); return; }
    const source = sources.get(choice.id);
    if (!source) { callback(null); return; }
    callback({ video: source });
    confirmedScreen = { owner: window.webContents, source, expires: Date.now() + 60000 };
  }, { useSystemPicker: false });
}

/** @param {CaptureOptions} settings @returns {void} */
function registerCaptureIpc(settings) {
  options = settings;
  ipcMain.handle('poke:begin', (event, input) => {
    const owner = assertOwner(event);
    const payload = poke.parseBegin(input);
    const capture = confirmedScreen;
    confirmedScreen = null;
    if (!capture || capture.owner !== owner || capture.source.id !== payload.sourceId || capture.expires < Date.now()) throw new Error('屏幕分享确认已失效，请停止并重新分享');
    return poke.beginPokeOverlay(owner, payload, capture.source);
  });
  ipcMain.handle('poke:hit', (event, input) => poke.triggerPokeOverlay(assertOwner(event), poke.parseHit(input)));
  ipcMain.handle('poke:clear', (event, input) => poke.clearPokeOverlay(assertOwner(event), poke.parseSession(input)));
  ipcMain.handle('poke:end', (event, input) => poke.endPokeOverlay(assertOwner(event), poke.parseSession(input)));
  ipcMain.handle('poke:requests', (event, input) => poke.updatePokeRequestsForSession(assertOwner(event), pokeRequests.parseRequestState(input)));
  ipcMain.handle('poke-request:decision', (event, input) => pokeRequests.acceptPokeDecision(event, input));
  ipcMain.handle('capture:sources', async (event) => {
    assertOwner(event);
    const entries = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 256, height: 144 }, fetchWindowIcons: false });
    sources = new Map(entries.map((source) => [source.id, source]));
    return entries.map((source) => ({ id: source.id, name: source.name, kind: source.id.startsWith('screen:') ? 'screen' : 'window', thumbnail: source.thumbnail.toDataURL() }));
  });
  ipcMain.handle('capture:select', (event, id) => {
    const owner = assertOwner(event);
    if (typeof id !== 'string' || !sources.has(id)) throw new TypeError('分享来源已失效，请刷新后重新选择');
    selected = { owner: owner.id, id, expires: Date.now() + 10000 };
  });
  ipcMain.handle('capture:processes', async (event) => { assertOwner(event); return listProcesses(); });
  ipcMain.handle('capture:start-process', (event, pid) => startCapture(pid, '--capture', assertOwner(event)));
  ipcMain.handle('capture:start-global', (event) => startCapture(process.pid, '--capture-excluding', assertOwner(event)));
  ipcMain.handle('capture:stop-process', async (event) => { assertOwner(event); await stopProcessCapture(); });
}

module.exports = { registerCaptureIpc, configureCaptureSession, stopAllCapture };
