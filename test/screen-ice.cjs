// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} Value */
const root = path.resolve(__dirname, '..');
const files = ['test/screen-ice.cjs', 'test/screen-ice-page.html', 'test/screen-ice-page.js', 'public/js/screen-link.js', 'public/js/screen-ice.js', 'public/js/screen-relay.js', 'public/js/screen-plan.js', 'public/js/screen-protocol.js', 'public/js/screen-preferences.js', 'public/js/network-protocol.js', 'public/js/poke-protocol.js'];
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new Error(message); }
/** @param {string} file @returns {string} */
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
/** @returns {{[file:string]:string}} */
function sourceHashes() { return Object.fromEntries(files.map(file => [file, hash(path.join(root, file))])); }

/** @returns {Promise<void>} */
async function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const origin = process.env.SCREEN_ICE_ORIGIN, result = process.env.SCREEN_ICE_RESULT, profile = process.env.SCREEN_ICE_PROFILE, port = Number(process.env.SCREEN_ICE_PORT);
  check(Boolean(origin && result && profile) && Number.isInteger(port) && port > 0 && port < 65536, 'Explicit isolated screen ICE configuration is required');
  check(origin !== undefined && result !== undefined && profile !== undefined, 'Missing owned process paths');
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.webContents.setAudioMuted(true);
  window.webContents.on('console-message', (_event, level, message) => console.log(JSON.stringify({ event: 'screen-ice-renderer', level, message })));
  window.webContents.on('render-process-gone', (_event, details) => { fs.writeFileSync(result, JSON.stringify({ failure: details }, null, 2)); app.exit(1); });
  try {
    await window.loadURL(origin + '/test/screen-ice-page.html');
    const data = /** @type {Value} */ (await window.webContents.executeJavaScript('window.runScreenIce(' + port + ')'));
    fs.writeFileSync(result, JSON.stringify({ versions: process.versions, data }, null, 2)); app.exit(0);
  } catch (error) {
    fs.writeFileSync(result, JSON.stringify({ failure: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }, null, 2)); app.exit(1);
  }
}

/** @param {string} binary @returns {string} */
function prepareRuntime(binary) {
  check(path.isAbsolute(binary) && fs.existsSync(binary), 'ELECTRON_TEST_BINARY must name an existing absolute Electron executable');
  const source = path.dirname(binary), destination = path.join(root, '.qa-tools', 'screen-ice-runtime');
  const owner = JSON.stringify({ source, executableSha256: hash(binary), entry: __filename });
  const marker = path.join(destination, '.screen-ice-owner');
  if (!fs.existsSync(destination)) {
    const app = path.join(source, 'resources', 'app');
    fs.cpSync(source, destination, { recursive: true, filter: file => file !== app && !file.startsWith(app + path.sep) && file !== path.join(source, 'resources', 'app.asar') });
    fs.writeFileSync(marker, owner, { flag: 'wx' });
  } else check(fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === owner, 'Refusing an Electron runtime not owned by this test or from a changed binary');
  const app = path.join(destination, 'resources', 'app'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'screen-ice-real-integration', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(app, 'main.cjs'), 'require(' + JSON.stringify(__filename) + ');\n');
  return path.join(destination, path.basename(binary));
}

/** @returns {Promise<void>} */
async function parentMain() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  check(binary !== undefined, 'Set ELECTRON_TEST_BINARY to the explicit real Electron executable');
  const runtime = prepareRuntime(binary);
  const output = path.join(root, '.qa-tools', 'results', 'screen-ice', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(output, { recursive: true });
  const hashes = sourceHashes(); fs.writeFileSync(path.join(output, 'source-hashes.json'), JSON.stringify({ executable: hash(binary), files: hashes }, null, 2));
  const blackhole = dgram.createSocket('udp4');
  /** @type {{atMs:number,remoteAddress:string,remotePort:number,bytes:number,stunBindingRequest:boolean}[]} */ const packets = [];
  const started = Date.now();
  // This is an actual UDP endpoint which deliberately drops every STUN request.
  blackhole.on('message', (message, remote) => packets.push({ atMs: Date.now() - started, remoteAddress: remote.address, remotePort: remote.port, bytes: message.length, stunBindingRequest: message.length >= 20 && message.readUInt16BE(0) === 1 && message.readUInt32BE(4) === 0x2112a442 }));
  await new Promise((resolve, reject) => { blackhole.once('error', reject); blackhole.bind(0, '127.0.0.1', () => resolve(undefined)); });
  const stunPort = blackhole.address().port;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const filename = files.includes(url.pathname.slice(1)) && url.pathname !== '/test/screen-ice.cjs' ? path.join(root, url.pathname.slice(1)) : null;
    if (!filename) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, { 'content-type': filename.endsWith('.html') ? 'text/html' : 'text/javascript', 'cache-control': 'no-store' }); response.end(fs.readFileSync(filename));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); check(address !== null && typeof address !== 'string', 'Owned HTTP listener did not bind');
  const profile = path.join(output, 'profile'), result = path.join(output, 'raw.json');
  /** @type {NodeJS.ProcessEnv} */ const environment = { ...process.env, SCREEN_ICE_ORIGIN: 'http://127.0.0.1:' + address.port, SCREEN_ICE_PORT: String(stunPort), SCREEN_ICE_RESULT: result, SCREEN_ICE_PROFILE: profile }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(runtime, [], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', part => { log += String(part); }); child.stderr.on('data', part => { log += String(part); });
  /** @type {number|null} */ let exitCode = null;
  try {
    exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Real screen ICE integration exceeded 60000ms; see ' + result)); }, 60000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    check(exitCode === 0, 'Real screen ICE integration failed, exit=' + exitCode + '; see ' + result);
    check(packets.some(packet => packet.stunBindingRequest), 'Blackhole control received no actual STUN Binding request');
    check(JSON.stringify(sourceHashes()) === JSON.stringify(hashes), 'Production source changed while the current-source test was running');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, exitCode, currentProductionSources: true, sourceHashes: hashes, actualStunRequests: packets.filter(packet => packet.stunBindingRequest).length, responsesSent: 0 }, null, 2));
    console.log(JSON.stringify({ event: 'screen-ice-completed', output, exitCode, actualStunRequests: packets.filter(packet => packet.stunBindingRequest).length }));
  } finally {
    fs.writeFileSync(path.join(output, 'electron.log'), log);
    fs.writeFileSync(path.join(output, 'network-fault.json'), JSON.stringify({ binding: '127.0.0.1:' + stunPort, responsesSent: 0, packets }, null, 2));
    blackhole.close(); server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined)));
    check(path.relative(output, profile) === 'profile', 'Profile cleanup escaped this test run');
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify({ childPid: child.pid ?? null, exitCode, profileExists: fs.existsSync(profile) }, null, 2));
  }
}
if (process.versions.electron) electronMain().catch(error => { console.error(error); require('electron').app.exit(1); });
else parentMain().catch(error => { console.error(error); process.exitCode = 1; });
