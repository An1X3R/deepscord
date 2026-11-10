// @ts-check
'use strict';
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{read:()=>Electron.Rectangle|null,dispose:()=>void}} WindowTracker */
/** @param {string} sourceId @returns {string} */
function windowHandle(sourceId) {
  const match = /^window:([1-9][0-9]*):[0-9]+$/.exec(sourceId);
  if (!match || BigInt(match[1]) > 0x7fffffffffffffffn) throw new TypeError('Invalid shared native window source: ' + sourceId);
  return match[1];
}
/** @param {string} line @returns {Electron.Rectangle|null} */
function parseBounds(line) {
  const value = /** @type {JsonValue} */ (JSON.parse(line));
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Native window bounds must be a rectangle or null');
  const { x, y, width, height } = value;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number' || ![x,y,width,height].every(Number.isSafeInteger) || width <= 0 || height <= 0) throw new TypeError('Native window returned invalid bounds: ' + line);
  return { x, y, width, height };
}
/** @param {string} sourceId @param {(bounds:Electron.Rectangle|null)=>void} changed @returns {Promise<WindowTracker>} */
function trackWindow(sourceId, changed) {
  const handle = windowHandle(sourceId);
  if (process.platform !== 'win32' || !process.env.SystemRoot) throw new Error('Native window poke requires Windows');
  const area = sourceId.endsWith(':1') ? 'client' : 'frame';
  const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'poke-window-bounds.ps1'),'-WindowHandle',handle,'-CaptureArea',area,'-ParentProcessId',String(process.pid)], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  const lines = createInterface({ input: child.stdout });
  /** @type {Electron.Rectangle|null} */ let latest = null;
  /** @type {Error|null} */ let failure = null;
  let disposed = false, ready = false, diagnostic = '';
  /** @returns {Electron.Rectangle|null} */
  function captureBounds() {
    if (failure) throw failure;
    return latest;
  }
  return new Promise((resolve, reject) => {
    /** @param {Error} error @returns {void} */
    function fail(error) {
      if (disposed || failure) return;
      failure = error; clearTimeout(timer); child.kill(); changed(null); reject(error);
    }
    const timer = setTimeout(() => fail(new Error('Native window bounds startup timed out: ' + sourceId)), 10000);
    child.stderr.on('data', (/** @type {Buffer} */ data) => { diagnostic = (diagnostic + data.toString('utf8')).slice(-8192); });
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error('Native window bounds helper exited: ' + JSON.stringify({ sourceId, code, diagnostic }))));
    lines.on('line', line => {
      try { latest = parseBounds(line); }
      catch (error) { fail(error instanceof Error ? error : new TypeError(String(error))); return; }
      if (disposed || failure) return;
      changed(captureBounds());
      if (ready) return;
      ready = true; clearTimeout(timer);
      resolve({ read: captureBounds, dispose: () => { disposed = true; clearTimeout(timer); lines.close(); child.kill(); } });
    });
  });
}
module.exports = { windowHandle, parseBounds, trackWindow };
