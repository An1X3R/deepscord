// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
const root = path.resolve(__dirname, '..');
const files = ['test/screen-media-settings-page.html', 'test/screen-media-settings-page.js', 'public/js/desktop-capture.js', 'public/js/screen-preferences.js', 'public/js/screen-link.js', 'public/js/screen-ice.js', 'public/js/screen-diagnostics.js'];
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new Error(message); }
/** @param {string} filename @returns {string} */
function hash(filename) { return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }

/** @returns {Promise<void>} */
async function electronMain() {
  const { app, BrowserWindow, session } = require('electron');
  const { registerCaptureIpc, configureCaptureSession, stopAllCapture } = require('../desktop/capture-ipc.cjs');
  const origin = process.env.SCREEN_MEDIA_ORIGIN, output = process.env.SCREEN_MEDIA_OUTPUT;
  check(origin !== undefined && output !== undefined, 'Explicit screen media integration configuration is required');
  app.setPath('userData', path.join(output, 'profile'));
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  await app.whenReady();
  const target = new BrowserWindow({ show: true, width: 1920, height: 1080, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await target.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>Deepscord Screen Media Target</title><canvas id="pattern" width="1920" height="1080"></canvas><script>const c=document.getElementById("pattern"),p=c.getContext("2d");let n=0;function draw(){p.fillStyle=n++%2?"#cc5522":"#2266cc";p.fillRect(0,0,1920,1080);p.fillStyle="white";p.fillRect(n*11%1800,0,100,1080);requestAnimationFrame(draw)}draw()</script>'));
  target.show();
  const windowId = target.getNativeWindowHandle().readBigUInt64LE().toString();
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'desktop', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setAudioMuted(true); target.webContents.setAudioMuted(true);
  registerCaptureIpc({ getWindow: () => window }); configureCaptureSession(session.defaultSession);
  /** @type {JsonValue[]} */ const results = [];
  try {
    await window.loadURL(origin + '/test/screen-media-settings-page.html');
    const profiles = [
      { source: 'window', height: 480, fps: 15, bitrate: 1.5, mode: 'motion' },
      { source: 'window', height: 1080, fps: 24, bitrate: 12, mode: 'detail' },
      { source: 'canvas', height: 720, fps: 30, bitrate: 2.5, mode: 'detail' },
      { source: 'canvas', height: 720, fps: 60, bitrate: 40, mode: 'motion' },
      { source: 'canvas', height: 2160, fps: 60, bitrate: 40, mode: 'motion' },
    ];
    for (const profile of profiles) {
      const preferences = { version: 3, uploadLimitMbps: 100, relayEnabled: true, screenBitrateMbps: profile.bitrate, screenResolution: profile.height, screenFrameRate: profile.fps, screenContentMode: profile.mode };
      const sourceId = profile.source === 'window' ? /** @type {string} */ (await window.webContents.executeJavaScript('window.selectScreenMediaWindow(' + JSON.stringify(windowId) + ')')) : null;
      const expression = 'window.runScreenMediaCase(' + JSON.stringify(profile.source) + ',' + JSON.stringify(preferences) + ',' + JSON.stringify(sourceId) + ').catch(error=>{throw new Error(JSON.stringify({name:error.name,message:error.message,stack:error.stack}))})';
      results.push(/** @type {JsonValue} */ (await window.webContents.executeJavaScript(expression, true)));
      fs.writeFileSync(path.join(output, 'raw.json'), JSON.stringify({ versions: process.versions, results }, null, 2));
    }
    /** @type {JsonValue[]} */ const cadence = [];
    for (const height of [480, 1080]) for (const mode of ['detail', 'motion']) {
      const preferences = { version: 3, uploadLimitMbps: 1000, relayEnabled: false, screenBitrateMbps: 0.3, screenResolution: height, screenFrameRate: 60, screenContentMode: mode };
      const sourceId = await window.webContents.executeJavaScript('window.selectScreenMediaWindow(' + JSON.stringify(windowId) + ')');
      cadence.push(/** @type {JsonValue} */ (await window.webContents.executeJavaScript('window.runScreenCadenceCase(' + JSON.stringify(preferences) + ',' + JSON.stringify(sourceId) + ')', true)));
      fs.writeFileSync(path.join(output, 'cadence.json'), JSON.stringify({ versions: process.versions, scope: 'Real Windows capture of a continuously animated window and production VP8 over loopback. No cross-device network or sustained 60 FPS guarantee.', cadence }, null, 2));
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, realWindowCapture: true, realCanvasVideo: true, productionCaptureIpcAndPreload: true, productionScreenLink: true, microphoneCaptured: false, fakeDevices: false, methodology: 'Requested dimensions and frame rate are upper bounds. Capture settings, actual decoded advancement and retained encoder caps are checked. This does not promise sustained 4K60 or an observed wire bitrate equal to maxBitrate.', results }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ results, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }, null, 2));
    throw error;
  } finally { await stopAllCapture(); window.destroy(); target.destroy(); }
  app.exit(0);
}

/** @returns {Promise<void>} */
async function parentMain() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  check(binary !== undefined && path.isAbsolute(binary) && fs.existsSync(binary), 'Set ELECTRON_TEST_BINARY to an actual Electron executable');
  const source = path.dirname(binary), runtime = path.join(root, '.qa-tools', 'screen-media-settings-runtime');
  const identity = JSON.stringify({ owner: __filename, binary: hash(binary), source });
  const marker = path.join(runtime, '.screen-media-owner');
  if (!fs.existsSync(runtime)) {
    const app = path.join(source, 'resources', 'app');
    fs.cpSync(source, runtime, { recursive: true, filter: filename => filename !== app && !filename.startsWith(app + path.sep) && filename !== path.join(source, 'resources', 'app.asar') });
    fs.writeFileSync(marker, identity, { flag: 'wx' });
  } else check(fs.readFileSync(marker, 'utf8') === identity, 'Existing screen media runtime identity differs');
  const entry = path.join(runtime, 'resources', 'app'); fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'real-screen-media-settings', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(entry, 'main.cjs'), 'require(' + JSON.stringify(__filename) + ');');
  const output = path.join(root, '.qa-tools', 'results', 'screen-media-settings', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(output, { recursive: true });
  const sourceHashes = Object.fromEntries([...files, 'desktop/capture-ipc.cjs', 'desktop/preload.js'].map(filename => [filename, hash(path.join(root, filename))]));
  fs.writeFileSync(path.join(output, 'source-hashes.json'), JSON.stringify(sourceHashes, null, 2));
  const server = http.createServer((request, response) => {
    const filename = (request.url ?? '').slice(1);
    if (!files.includes(filename)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': filename.endsWith('.html') ? 'text/html' : 'text/javascript', 'cache-control': 'no-store' }); response.end(fs.readFileSync(path.join(root, filename)));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); check(address !== null && typeof address !== 'string', 'HTTP listener did not bind');
  /** @type {NodeJS.ProcessEnv} */ const environment = { ...process.env, SCREEN_MEDIA_ORIGIN: 'http://127.0.0.1:' + address.port, SCREEN_MEDIA_OUTPUT: output }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(runtime, path.basename(binary)), [], { cwd: root, env: environment, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', part => { log += String(part); }); child.stderr.on('data', part => { log += String(part); });
  /** @type {number|null} */ let exitCode = null;
  try {
    exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Screen media settings integration exceeded 180000ms')); }, 180000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    check(exitCode === 0, 'Actual screen media settings integration failed: ' + output);
    check(JSON.stringify(sourceHashes) === JSON.stringify(Object.fromEntries(Object.keys(sourceHashes).map(filename => [filename, hash(path.join(root, filename))]))), 'Production capture or transport source changed during integration');
    console.log(JSON.stringify({ event: 'screen-media-settings-completed', output, exitCode }));
  } finally {
    fs.writeFileSync(path.join(output, 'electron.log'), log);
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined)));
    fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify({ childPid: child.pid ?? null, exitCode }, null, 2));
  }
}
if (process.versions.electron) electronMain().catch(error => { console.error(error); require('electron').app.exit(1); });
else parentMain().catch(error => { console.error(error); process.exitCode = 1; });
