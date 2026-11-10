// @ts-check
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');

/** @typedef {{type:string,muted?:boolean,deafened?:boolean}} Control */
/** @typedef {{scope:string,candidateType:string,protocol:string,relayProtocol:string}} CandidateSummary */
/** @typedef {{id:string,muted:boolean,enabled:boolean,readyState:string}} TrackSnapshot */
/** @typedef {{id:string,localUfrag:string,state:string,connectionState:string,signalingState:string,iceConnectionState:string,iceGatheringState:string,controlState:string,ready:boolean,route:string,bytes:number,energy:number,controls:Control[],left:boolean,candidates:CandidateSummary[],remoteTracks:TrackSnapshot[],receiverTracks:TrackSnapshot[],inboundTotalAudioEnergy:number,inboundAudioLevel:number,inboundTotalSamplesDuration:number,inboundPackets:number,playback:{present:boolean,paused:boolean,readyState:number,currentTime:number,started:boolean}}} PeerSnapshot */
/** @typedef {{id:string,iceCandidateErrors:{code:number,text:string,url:string}[],errors:string[],refreshCount:number,iceExpiresAt:number|null,audioContextState:string,audioContextTime:number,sampleRate:number,localOscillatorEnergy:number,sourceTrack:{enabled:boolean,muted:boolean,readyState:string},pendingSignals:number,peers:PeerSnapshot[]}} Snapshot */
/** @typedef {{process:import('node:child_process').ChildProcess,port:number,password:string,directory:string}} Backend */
const root = path.resolve(__dirname, '..');
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-peer-media-'));
app.setPath('userData', path.join(testDirectory, 'browser'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// The real TURN fixture binds loopback; Chromium excludes this test interface by default.
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
/** @type {BrowserWindow[]} */ let windows = [];
/** @type {Backend|null} */ let backend = null;
/** @type {string[]} */ const browserErrors = [];
/** @type {Snapshot[]} */ let latestSnapshots = [];
/** @type {http.Server|null} */ let fixture = null;
let fixturePort = 0;
let finishing = false;
app.on('window-all-closed', () => {});

/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
/** @param {http.Server} server @returns {Promise<number>} */
function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') { reject(new Error('Missing loopback address')); return; } resolve(address.port); }); });
}
/** @returns {Promise<number>} */
async function availablePort() { const server = http.createServer(); const port = await listen(server); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined))); return port; }
/** @param {string} label @param {()=>Promise<boolean>} probe @param {number} timeout @returns {Promise<void>} */
async function until(label, probe, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (browserErrors.length) throw new Error(JSON.stringify({ label, browserErrors })); if (await probe()) return; await delay(150); }
  throw new Error(JSON.stringify({ message: 'Native integration timeout', label, timeout, browserErrors }));
}
/** @param {'direct'|'relay-only'} policy @returns {Promise<Backend>} */
async function startBackend(policy) {
  const port = await availablePort();
  const directory = fs.mkdtempSync(path.join(testDirectory, 'backend-'));
  const password = randomBytes(32).toString('base64url');
  const instanceId = randomUUID();
  const environment = { ...process.env };
  for (const key of ['STUN_URL', 'STUN_URLS', 'TURN_URL', 'TURN_URLS', 'TURN_SECRET', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'TURN_TTL_SECONDS', 'ECHO_TLS_PFX_PATH', 'ECHO_TLS_PFX_PASSWORD']) delete environment[key];
  Object.assign(environment, { ELECTRON_RUN_AS_NODE: '1', HTTP_HOST: '127.0.0.1', PORT: String(port), HTTPS_PORTS: '0', ECHO_DATA_DIR: directory, ECHO_PASSWORD: password, ECHO_INSTANCE_ID: instanceId, ECHO_NETWORK_MODE: policy === 'direct' ? 'direct' : 'server', ECHO_MEDIA_POLICY: policy });
  if (policy === 'relay-only') Object.assign(environment, { TURN_URL: process.env.PEER_TEST_TURN_URL, TURN_SECRET: process.env.PEER_TEST_TURN_SECRET, TURN_TTL_SECONDS: '60' });
  const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2048); });
  child.once('error', (error) => browserErrors.push(error.message));
  const value = { process: child, port, password, directory };
  backend = value;
  await until('authenticated test backend readiness', async () => {
    if (child.exitCode !== null) throw new Error(JSON.stringify({ message: 'Backend exited', code: child.exitCode, stderr }));
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); const health = await response.json(); return health !== null && typeof health === 'object' && health.instanceId === instanceId; }
    catch (error) { if (error instanceof TypeError) return false; throw error; }
  }, 10000);
  return value;
}
/** @param {Backend} value @returns {Promise<void>} */
async function stopBackend(value) {
  if (value.process.exitCode !== null || value.process.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned signaling process did not exit')), 5000);
    value.process.once('exit', () => { clearTimeout(timer); resolve(undefined); });
    if (!value.process.kill()) { clearTimeout(timer); reject(new Error('Could not stop owned signaling process')); }
  });
}
/** @param {BrowserWindow} win @param {string} expression @returns {Promise<Snapshot>} */
async function snapshot(win, expression) {
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null;
  try {
    return await Promise.race([win.webContents.executeJavaScript(expression, true), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer snapshot exceeded 2500 ms')), 2500); })]);
  } finally { if (timer) clearTimeout(timer); }
}
/** @returns {Promise<Snapshot[]>} */
async function snapshots() { const result = await Promise.all(windows.map((win) => snapshot(win, 'window.peerMediaTest.snapshot()'))); latestSnapshots = result; for (const entry of result) assert.deepEqual(entry.errors, [], 'Unexpected browser or PeerLink error'); return result; }
/** @param {number} count @param {'direct'|'relay-only'} policy @returns {Promise<void>} */
async function scenario(count, policy) {
  latestSnapshots = [];
  const value = await startBackend(policy);
  /** @type {string[]} */ const ids = [];
  for (let index = 0; index < count; index += 1) {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'peer-media-' + randomUUID() } });
    windows.push(win);
    win.webContents.on('render-process-gone', (_event, details) => { if (!finishing) browserErrors.push('Renderer exited: ' + details.reason); });
    win.webContents.on('console-message', (event) => { if (event.level === 'error') browserErrors.push(event.message); });
    await win.loadURL(`http://127.0.0.1:${fixturePort}/test/peer-media-page.html`);
    await until('fixture module loaded', async () => win.webContents.executeJavaScript('Boolean(window.peerMediaTest)', true), 10000);
    const id = await win.webContents.executeJavaScript(`window.peerMediaTest.start(${JSON.stringify({ url: `ws://127.0.0.1:${value.port}/ws`, password: value.password, name: 'media-' + index })})`, true);
    assert.equal(typeof id, 'string'); ids.push(id);
  }
  await Promise.all(windows.map((win) => win.webContents.executeJavaScript(`window.peerMediaTest.connectPeers(${JSON.stringify(ids)})`, true)));
  const route = policy === 'relay-only' ? 'relay' : 'direct';
  await until('all native audio links and selected ICE routes', async () => (await snapshots()).every((entry) => entry.localOscillatorEnergy > 0.005 && entry.peers.length === count - 1 && entry.peers.every((peer) => peer.ready && peer.state === 'connected' && peer.route === route && peer.bytes > 0 && peer.energy > 0.005 && peer.playback.started)), count === 10 ? 60000 : 30000);
  if (policy === 'relay-only') {
    const original = await snapshots();
    assert(original.every((entry) => entry.iceExpiresAt !== null && entry.peers.every((peer) => peer.localUfrag.length > 0)));
    await delay(1200);
    await Promise.all(windows.map((win) => win.webContents.executeJavaScript('window.peerMediaTest.refreshNetwork()', true)));
    await until('TURN credential refresh restarts every native ICE transport and restores relay PCM', async () => (await snapshots()).every((entry, index) => entry.refreshCount > original[index].refreshCount && entry.iceExpiresAt !== null && entry.iceExpiresAt > (original[index].iceExpiresAt || 0) && entry.peers.every((peer) => {
      const previous = original[index].peers.find((candidate) => candidate.id === peer.id);
      return Boolean(previous && peer.localUfrag !== previous.localUfrag && peer.localUfrag.length > 0 && peer.connectionState === 'connected' && peer.signalingState === 'stable' && peer.route === 'relay' && peer.energy > 0.005 && peer.bytes > previous.bytes);
    })), 30000);
    console.log(JSON.stringify({ status: 'passed', scenario: 'relay-credential-refresh', participants: count, ttlSeconds: 60, nativeIceUfragChanged: true, selectedRoute: 'relay', decodedPcm: true }));
  }
  const before = await snapshots();
  await Promise.all(windows.map((win) => win.webContents.executeJavaScript('window.peerMediaTest.prepareOutage()', true)));
  await stopBackend(value); backend = null;
  await delay(1800);
  const after = await snapshots();
  for (let index = 0; index < count; index += 1) for (const peer of after[index].peers) { const earlier = before[index].peers.find((entry) => entry.id === peer.id); assert(earlier); assert(peer.bytes > earlier.bytes, 'Inbound audio stopped when real signaling process exited'); assert(peer.energy > 0.005, 'Decoded PCM vanished after signaling outage'); assert.equal(peer.route, route); }
  await windows[0].webContents.executeJavaScript('window.peerMediaTest.sendState({muted:true,deafened:false})', true);
  await until('native mute control while signaling is offline', async () => (await snapshots()).slice(1).every((entry) => entry.peers.find((peer) => peer.id === ids[0])?.controls.some((control) => control.type === 'state' && control.muted === true)), 10000);
  await until('muted source produces decoded silence', async () => (await snapshots()).slice(1).every((entry) => { const source = entry.peers.find((peer) => peer.id === ids[0]); return Boolean(source && source.energy < 0.001); }), 10000);
  await windows[0].webContents.executeJavaScript('window.peerMediaTest.sendState({muted:false,deafened:false})', true);
  await until('native unmute control while signaling is offline', async () => (await snapshots()).slice(1).every((entry) => entry.peers.find((peer) => peer.id === ids[0])?.controls.some((control) => control.type === 'state' && control.muted === false)), 10000);
  await until('unmuted source restores decoded PCM', async () => (await snapshots()).slice(1).every((entry) => { const source = entry.peers.find((peer) => peer.id === ids[0]); return Boolean(source && source.energy > 0.005); }), 10000);
  await windows[0].webContents.executeJavaScript('window.peerMediaTest.sendLeave()', true);
  await until('native explicit leave while signaling is offline', async () => (await snapshots()).slice(1).every((entry) => entry.peers.find((peer) => peer.id === ids[0])?.left === true), 10000);
  console.log(JSON.stringify({ status: 'passed', scenario: policy, participants: count, pairs: count * (count - 1) / 2, route, decodedPcm: true, signalingProcessStopped: true, offlineAudioContinues: true, offlineMuteAndLeave: true }));
  await Promise.all(windows.map((win) => win.webContents.executeJavaScript('window.peerMediaTest.announceClose()', true)));
  await until('all remaining native DataChannels acknowledge teardown leave', async () => (await snapshots()).every((entry) => entry.peers.every((peer) => peer.left || peer.controlState === 'closed')), 10000);
  await Promise.all(windows.map((win) => win.webContents.executeJavaScript('window.peerMediaTest.close()', true)));
  for (const win of windows) win.destroy();
  windows = [];
}

app.whenReady().then(async () => {
  fixture = http.createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const allowed = new Map([['/test/peer-media-page.html', 'text/html'], ['/test/peer-media-page.js', 'text/javascript'], ['/public/js/peer-link.js', 'text/javascript'], ['/public/js/peer-stats.js', 'text/javascript'], ['/public/js/network-protocol.js', 'text/javascript'], ['/public/js/poke-protocol.js', 'text/javascript'], ['/public/js/media-description.js', 'text/javascript'], ['/public/js/screen-protocol.js', 'text/javascript'], ['/public/js/screen-ice.js', 'text/javascript'], ['/public/js/screen-plan.js', 'text/javascript']]);
    allowed.set('/public/js/screen-preferences.js', 'text/javascript');
    const contentType = allowed.get(pathname);
    if (!contentType) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', contentType);
    response.end(fs.readFileSync(path.join(root, pathname)));
  });
  fixturePort = await listen(fixture);
  await scenario(2, 'direct');
  await scenario(10, 'direct');
  if (process.env.PEER_TEST_TURN_URL && process.env.PEER_TEST_TURN_SECRET) await scenario(2, 'relay-only');
  else if (process.env.PEER_TEST_TURN_URL || process.env.PEER_TEST_TURN_SECRET) throw new Error('PEER_TEST_TURN_URL and PEER_TEST_TURN_SECRET must be supplied together');
  else console.log(JSON.stringify({ status: 'skipped', scenario: 'relay-only', reason: 'Set PEER_TEST_TURN_URL and PEER_TEST_TURN_SECRET to a real reachable TURN service' }));
}).then(() => finish(0), (error) => { console.error(JSON.stringify({ status: 'failed', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : '', diagnostics: path.join(testDirectory, 'diagnostics.json') })); return finish(1); });

/** @param {number} code @returns {Promise<void>} */
async function finish(code) {
  if (finishing) return;
  finishing = true;
  const target = path.resolve(testDirectory);
  try {
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('deepscord-peer-media-')) throw new Error('Unexpected owned test directory');
    fs.writeFileSync(path.join(target, 'diagnostics.json'), JSON.stringify({ browserErrors, snapshots: latestSnapshots }, null, 2));
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    const results = await Promise.allSettled([
      backend ? stopBackend(backend) : Promise.resolve(),
      fixture ? new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture HTTP shutdown exceeded 2500 ms')), 2500);
        fixture?.close((error) => { clearTimeout(timer); error ? reject(error) : resolve(undefined); });
        fixture?.closeAllConnections();
      }) : Promise.resolve(),
    ]);
    for (const result of results) if (result.status === 'rejected') { code = 1; console.error(JSON.stringify({ status: 'cleanup-failed', message: result.reason instanceof Error ? result.reason.message : String(result.reason) })); }
  } catch (error) {
    code = 1;
    console.error(JSON.stringify({ status: 'cleanup-failed', message: error instanceof Error ? error.message : String(error) }));
  } finally {
    console.log(JSON.stringify({ status: 'cleanup-required-after-exit', testDirectory: target, processId: process.pid, diagnostics: path.join(target, 'diagnostics.json'), exitCode: code }));
    app.exit(code);
  }
}
