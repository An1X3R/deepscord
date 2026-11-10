// @ts-check
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');

/** @param {string} parent @param {string} target @returns {boolean} */
function under(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** @returns {string} */
function prepareRuntime() {
  const configured = process.env.ELECTRON_TEST_BINARY;
  assert(configured, 'Set ELECTRON_TEST_BINARY to a real Electron executable');
  const executable = path.resolve(configured);
  assert(fs.statSync(executable).isFile(), 'Electron executable is not a file');
  const source = path.dirname(executable);
  const destination = path.join(root, '.qa-tools', 'feature-media-runtime');
  assert(!under(source, destination) && !under(destination, source) && source !== destination, 'Runtime source and destination overlap');
  const identity = JSON.stringify({ owner: 'deepscord-feature-media', source: executable, modified: fs.statSync(executable).mtimeMs });
  const marker = path.join(destination, '.feature-media-runtime.json');
  if (fs.existsSync(destination)) assert.equal(fs.readFileSync(marker, 'utf8'), identity, 'Existing runtime ownership/source differs');
  else {
    const sourceApp = path.join(source, 'resources', 'app');
    const sourceAsar = path.join(source, 'resources', 'app.asar');
    fs.cpSync(source, destination, { recursive: true, filter: (value) => value !== sourceApp && !under(sourceApp, value) && value !== sourceAsar });
    fs.writeFileSync(marker, identity);
  }
  const entry = path.join(destination, 'resources', 'app');
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'deepscord-feature-media', version: '1.0.0', main: 'main.js' }));
  fs.writeFileSync(path.join(entry, 'main.js'), "'use strict';\nrequire(" + JSON.stringify(__filename) + ');\n');
  return path.join(destination, path.basename(executable));
}

/** @param {string} executable @param {string} directory @returns {Promise<void>} */
async function launch(executable, directory) {
  /** @type {NodeJS.ProcessEnv} */
  const environment = { ...process.env, DEEPSCORD_FEATURE_MEDIA_TEMP: directory };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { cwd: root, env: environment, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native feature media exceeded 90000 ms')); }, 90000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(undefined);
      else reject(new Error(`Native feature media exited with code ${code}, signal ${signal}`));
    });
  });
}

/** @returns {Promise<void>} */
async function runNode() {
  const executable = prepareRuntime();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-feature-media-'));
  try { await launch(executable, directory); }
  finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), 'Cleanup escaped temporary directory');
    assert(path.basename(resolved).startsWith('deepscord-feature-media-'), 'Cleanup prefix mismatch');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

/** @param {http.Server} server @returns {Promise<void>} */
async function stopServer(server) {
  await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve(undefined)); server.closeAllConnections(); });
}
/** @param {http.Server} server @returns {Promise<number>} */
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); assert(address && typeof address !== 'string', 'Loopback address unavailable'); return address.port;
}
/** @returns {Promise<void>} */
async function runElectron() {
  const { app, BrowserWindow } = require('electron');
  const directory = process.env.DEEPSCORD_FEATURE_MEDIA_TEMP;
  assert(directory && path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('deepscord-feature-media-'), 'Owned temporary profile missing');
  app.setPath('userData', path.join(directory, 'profile'));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  /** @type {import('electron').BrowserWindow|null} */ let win = null;
  /** @type {http.Server|null} */ let broker = null;
  /** @type {http.Server|null} */ let fixture = null;
  let code = 1;
  const results = path.join(root, '.qa-tools', 'results'); fs.mkdirSync(results, { recursive: true });
  const resultPath = path.join(results, 'feature-media-' + randomUUID() + '.json');
  try {
    await app.whenReady();
    assert(!app.commandLine.hasSwitch('use-fake-device-for-media-stream'), 'Fake capture devices are forbidden');
    /** @type {Map<string,string[]>} */ const queues = new Map([['/a', []], ['/b', []]]);
    broker = http.createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      const queue = queues.get(request.url || '');
      if (!queue) { response.writeHead(404); response.end(); return; }
      if (request.method === 'GET') { const messages = queue.splice(0); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(messages)); return; }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += String(chunk); if (body.length > 1000000) request.destroy(new RangeError('Signal exceeds fixture limit')); });
      request.on('end', () => { queue.push(body); response.end('queued'); });
    });
    const brokerPort = await listen(broker);
    const allowed = new Map([
      ['/test/feature-media-page.html', 'text/html'], ['/test/feature-media-page.js', 'text/javascript'],
      ['/public/js/peer-link.js', 'text/javascript'], ['/public/js/peer-stats.js', 'text/javascript'],
      ['/public/js/network-protocol.js', 'text/javascript'], ['/public/js/remote-audio.js', 'text/javascript'],
      ['/public/js/poke-protocol.js', 'text/javascript'],
      ['/public/js/screen-preferences.js', 'text/javascript'],
      ['/public/js/screen-protocol.js', 'text/javascript'], ['/public/js/screen-plan.js', 'text/javascript'], ['/public/js/screen-ice.js', 'text/javascript'],
      ['/public/js/media-description.js', 'text/javascript'],
    ]);
    fixture = http.createServer((request, response) => {
      const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      if (pathname === '/stop-signaling' && request.method === 'POST') {
        const closing = broker; broker = null;
        if (!closing) { response.writeHead(409); response.end(); return; }
        stopServer(closing).then(() => response.end('closed'), (error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : String(error)); }); return;
      }
      const mime = allowed.get(pathname);
      if (!mime) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', mime); response.end(fs.readFileSync(path.join(root, pathname)));
    });
    const port = await listen(fixture);
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await win.loadURL('http://127.0.0.1:' + port + '/test/feature-media-page.html');
    /** @type {import('./feature-media-page.js').FeatureReport} */
    const report = await win.webContents.executeJavaScript('window.featureMedia.run(' + JSON.stringify({ brokerUrl: 'http://127.0.0.1:' + brokerPort, stopUrl: '/stop-signaling' }) + ')', true);
    const runtime = { electron: process.versions.electron, chrome: process.versions.chrome, generatedRealAudio: true, generatedRealCanvasVideo: true, fakeDevices: false };
    fs.writeFileSync(resultPath, JSON.stringify({ runtime, report }, null, 2));
    console.log(JSON.stringify({ runtime, report: { checks: report.checks, errors: report.errors, failure: report.failure }, resultPath }));
    assert.equal(report.failure, null, 'Native feature media failed; see ' + resultPath);
    assert.deepEqual(report.errors, [], 'Peer errors occurred'); code = 0;
  } catch (error) { console.error(JSON.stringify({ status: 'failed', message: error instanceof Error ? error.message : String(error), resultPath })); }
  finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (broker) await stopServer(broker);
    if (fixture) await stopServer(fixture);
    app.exit(code);
  }
}
if (process.versions.electron) runElectron().catch((error) => { console.error(error); process.exit(1); });
else runNode().catch((error) => { console.error(error); process.exitCode = 1; });
