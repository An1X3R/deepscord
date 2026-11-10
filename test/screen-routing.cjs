// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} Value */
/** @typedef {import('../public/js/network-protocol.js').JsonObject} ObjectValue */
/** @typedef {{id:string,token:string,signals:Value[],commands:Value[],ready:boolean,child:import('node:child_process').ChildProcess|null,log:import('node:fs').WriteStream|null}} NodeState */
/** @typedef {{node:string,resolve:(value:Value)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}} Pending */
const root = path.resolve(__dirname, '..');
const ids = ['n00', 'n01', 'n02', 'n03', 'n04', 'n05'];
/** @param {Value|undefined} value @returns {ObjectValue} */
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a structured JSON object'); return value; }
/** @param {Value|undefined} value @returns {Value[]} */
function array(value) { if (!Array.isArray(value)) throw new TypeError('Expected a JSON array'); return value; }
/** @param {Value|undefined} value @returns {number} */
function number(value) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Expected a finite number'); return value; }
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new Error(message); }
/** @param {number} ms @returns {Promise<void>} */
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/** @returns {Promise<void>} */
async function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const { installScreenRelay, stopScreenRelay } = require('../desktop/screen-relay-ipc.cjs');
  const id = process.env.SCREEN_ROUTING_ID, token = process.env.SCREEN_ROUTING_TOKEN, origin = process.env.SCREEN_ROUTING_ORIGIN, profile = process.env.SCREEN_ROUTING_PROFILE, clientKind = process.env.SCREEN_ROUTING_CLIENT_KIND;
  if (!id || !ids.includes(id) || !token || !origin || !profile || (clientKind !== 'native' && clientKind !== 'browser')) throw new Error('Explicit isolated routing process configuration is required');
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  /** @type {Electron.BrowserWindow|null} */ let window = null;
  installScreenRelay({ getWindow: () => window });
  await app.whenReady();
  const preferences = { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };
  const webPreferences = clientKind === 'native' ? { ...preferences, preload: path.join(root, 'desktop', 'preload.js') } : preferences;
  window = new BrowserWindow({ show: false, webPreferences });
  window.webContents.setAudioMuted(true);
  window.webContents.on('console-message', (_event, level, message) => { console.log(JSON.stringify({ event: 'renderer-console', id, level, message })); });
  window.webContents.on('render-process-gone', (_event, details) => { console.error(JSON.stringify({ event: 'renderer-gone', id, details })); app.exit(1); });
  app.once('before-quit', () => { void stopScreenRelay(); });
  const stunPort = Number(process.env.SCREEN_ROUTING_STUN_PORT);
  check(Number.isInteger(stunPort) && stunPort >= 0 && stunPort <= 65535, 'Explicit fault-injection STUN port is invalid');
  await window.loadURL(origin + '/test/screen-routing-page.html?id=' + id + '&token=' + token + '&stunPort=' + stunPort);
}

/** @param {string} binary @returns {string} */
function prepareRuntime(binary) {
  check(path.isAbsolute(binary) && fs.existsSync(binary), 'ELECTRON_TEST_BINARY must name an existing absolute Electron executable');
  const source = path.dirname(binary), destination = path.join(root, '.qa-tools', 'screen-routing-runtime');
  const identity = JSON.stringify({ source, entry: __filename });
  const marker = path.join(destination, '.screen-relay-owner');
  if (!fs.existsSync(destination)) {
    fs.cpSync(source, destination, { recursive: true, filter: name => name !== path.join(source, 'resources', 'app.asar') && name !== path.join(source, 'resources', 'app') && !name.startsWith(path.join(source, 'resources', 'app') + path.sep) });
    fs.writeFileSync(marker, identity, { flag: 'wx' });
  } else check(fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === identity, 'Refusing an Electron runtime not owned by this test');
  const appDirectory = path.join(destination, 'resources', 'app'); fs.mkdirSync(appDirectory, { recursive: true });
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'screen-routing-real-integration', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(appDirectory, 'main.cjs'), 'require(' + JSON.stringify(__filename) + ');\n');
  return path.join(destination, path.basename(binary));
}

/** @param {import('node:http').IncomingMessage} request @returns {Promise<Value>} */
async function readBody(request) {
  const chunks = []; let bytes = 0;
  for await (const part of request) { const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length; if (bytes > 1048576) throw new RangeError('Test request exceeded one MiB'); chunks.push(chunk); }
  return /** @type {Value} */ (JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

/** @returns {Promise<void>} */
async function parentMain() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  if (!binary) throw new Error('Set ELECTRON_TEST_BINARY to the explicit isolated Electron runtime source executable');
  const runtime = prepareRuntime(binary);
  const scenario = process.argv[2] ?? 'core';
  check(['core', 'helper-crash-browser-leaf', 'stun-blackhole'].includes(scenario) && process.argv.length <= 3, 'Explicit scenario must be core, helper-crash-browser-leaf or stun-blackhole');
  const discovery = dgram.createSocket('udp4');
  let stunPort = 0, bindingRequests = 0;
  discovery.on('message', packet => { if (packet.length >= 20 && packet.readUInt16BE(0) === 1 && packet.readUInt32BE(4) === 0x2112a442) bindingRequests += 1; });
  const directory = path.join(root, '.qa-tools', 'results', 'screen-routing', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(directory, { recursive: true });
  const protocol = await import(pathToFileURL(path.join(root, 'public/js/network-protocol.js')).href);
  /** @type {Map<string,NodeState>} */ const nodes = new Map(ids.map(id => [id, { id, token: crypto.randomBytes(32).toString('hex'), signals: [], commands: [], ready: false, child: null, log: null }]));
  /** @type {Map<string,Pending>} */ const pending = new Map();
  /** @type {ObjectValue[]} */ const stages = [];
  /** @type {ObjectValue[]} */ const broker = [];
  /** @type {ObjectValue[]} */ const checks = [];
  /** @type {Set<number>} */ const helperPids = new Set();
  /** @type {ObjectValue|null} */ let failure = null;
  /** @type {ObjectValue[]} */ const cleanup = [];
  const start = Date.now();
  const hashFiles = ['public/js/peer-link.js', 'public/js/screen-relay.js', 'public/js/remote-audio.js', 'public/js/screen-plan.js', 'public/js/screen-link.js', 'desktop/screen-relay-ipc.cjs', 'desktop/native/bin/screen-relay.exe', 'test/screen-routing.cjs', 'test/screen-routing-page.js'];
  /** @returns {{[key:string]:string}} */
  function sourceHashes() { return Object.fromEntries(hashFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])); }
  const startHashes = sourceHashes();
  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @returns {Promise<void>} */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const filename = url.pathname === '/test/screen-routing-page.html' || url.pathname === '/test/screen-routing-page.js' || /^\/public\/js\/[a-z0-9-]+\.js$/.test(url.pathname) ? path.join(root, url.pathname.slice(1)) : null;
    if (filename && request.method === 'GET') { response.writeHead(200, { 'Content-Type': filename.endsWith('.html') ? 'text/html' : 'text/javascript', 'Cache-Control': 'no-store' }); response.end(fs.readFileSync(filename)); return; }
    const node = nodes.get(url.searchParams.get('id') ?? '');
    if (!node || url.searchParams.get('token') !== node.token) { response.writeHead(403); response.end('Invalid test process ownership'); return; }
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/poll' && request.method === 'GET') { response.end(JSON.stringify({ signals: node.signals.splice(0), commands: node.commands.splice(0) })); return; }
    if (url.pathname === '/signal' && request.method === 'POST') {
      const body = object(await readBody(request)); check(typeof body.to === 'string' && body.to !== node.id, 'Initial voice signal recipient is invalid');
      const recipient = nodes.get(body.to); check(Boolean(recipient), 'Initial voice signal recipient is not a participant');
      const signal = protocol.parsePeerSignal(body.data, 'direct');
      check(recipient !== undefined && recipient.signals.length < 256, 'Initial voice signal queue exceeded its bound');
      recipient.signals.push({ from: node.id, data: /** @type {Value} */ (signal) });
      broker.push({ from: node.id, to: recipient.id, type: signal.type, at: Date.now() }); response.end('{}'); return;
    }
    if (url.pathname === '/report' && request.method === 'POST') {
      const body = object(await readBody(request)); check(typeof body.requestId === 'string' && typeof body.ok === 'boolean', 'Invalid test result envelope');
      if (body.requestId === 'ready') { check(body.ok, 'Renderer initialization rejected'); node.ready = true; response.end('{}'); return; }
      const operation = pending.get(body.requestId); check(operation !== undefined && operation.node === node.id, 'Unexpected test operation result');
      pending.delete(body.requestId); clearTimeout(operation.timer);
      if (body.ok) operation.resolve(body.payload ?? null); else operation.reject(new Error('Renderer operation failed: ' + node.id + ' ' + JSON.stringify(body.payload)));
      response.end('{}'); return;
    }
    response.writeHead(404); response.end('{}');
  }
  const server = http.createServer((request, response) => { handle(request, response).catch(error => { response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Non-error broker rejection' })); }); });
  /** @param {string} id @param {string} op @returns {Promise<Value>} */
  function command(id, op) {
    const node = nodes.get(id); if (!node) throw new Error('Unknown explicit participant');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Renderer command timed out: ' + id + '/' + op)); }, 15000); pending.set(requestId, { node: id, resolve, reject, timer }); node.commands.push({ requestId, op }); });
  }
  /** @param {string} label @param {string[]} active @returns {Promise<Map<string,ObjectValue>>} */
  async function sample(label, active) {
    const values = await Promise.all(active.map(async id => [id, object(await command(id, 'snapshot'))]));
    /** @type {Map<string,ObjectValue>} */ const result = new Map();
    for (const pair of values) { const id = String(pair[0]), value = object(/** @type {Value} */ (pair[1])); result.set(id, value); const native = value.native ? object(value.native) : null; if (native && typeof native.pid === 'number') helperPids.add(native.pid); }
    stages.push({ label, at: Date.now(), nodes: Object.fromEntries(result) });
    for (const [id, value] of result) check(array(value.errors).length === 0, 'Unexpected renderer errors: ' + id + ' ' + JSON.stringify(value.errors));
    return result;
  }
  /** @param {string} label @param {string[]} active @param {(samples:Map<string,ObjectValue>)=>boolean} predicate @param {number} limit @returns {Promise<Map<string,ObjectValue>>} */
  async function until(label, active, predicate, limit) {
    const end = Date.now() + limit; let result = new Map();
    while (Date.now() < end) { result = await sample(label, active); if (predicate(result)) return result; await delay(500); }
    throw new Error('Real integration condition timed out: ' + label);
  }
  /** @param {ObjectValue} value @returns {Value[]} */
  function routes(value) { const plan = plans(value)[0]; return plan ? array(plan.routes) : []; }
  /** @param {ObjectValue} value @returns {Value[]} */
  function sessions(value) { return value.native ? array(object(value.native).sessions) : []; }
  /** @param {Map<string,ObjectValue>} samples @param {string} id @returns {ObjectValue} */
  function node(samples, id) { const value = samples.get(id); check(value !== undefined, 'Missing participant snapshot'); return value; }
  /** @param {ObjectValue} value @returns {ObjectValue[]} */
  function plans(value) { return array(object(value.controller).plans).map(object); }
  /** @param {ObjectValue} value @returns {boolean} */
  function videoReady(value) { return number(value.displayedFrames) >= 5 && value.width === 640 && value.height === 360 && array(value.screen).some(row => number(object(object(row).stats).framesDecoded) > 0); }
  try {
    if (scenario === 'stun-blackhole') {
      await new Promise((resolve, reject) => { discovery.once('error', reject); discovery.bind(0, '127.0.0.1', () => resolve(undefined)); });
      stunPort = discovery.address().port;
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const address = server.address(); check(address !== null && typeof address !== 'string', 'Test broker has no loopback port');
    for (const state of nodes.values()) {
      state.log = fs.createWriteStream(path.join(directory, state.id + '.log'));
      /** @type {NodeJS.ProcessEnv} */ const env = { ...process.env, SCREEN_ROUTING_ID: state.id, SCREEN_ROUTING_TOKEN: state.token, SCREEN_ROUTING_ORIGIN: 'http://127.0.0.1:' + address.port, SCREEN_ROUTING_PROFILE: path.join(directory, 'profiles', state.id), SCREEN_ROUTING_CLIENT_KIND: scenario !== 'core' && state.id === 'n05' ? 'browser' : 'native', SCREEN_ROUTING_STUN_PORT: String(stunPort) }; delete env.ELECTRON_RUN_AS_NODE;
      state.child = spawn(runtime, [], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); state.child.stdout?.pipe(state.log); state.child.stderr?.pipe(state.log);
      state.child.on('error', error => { failure = { message: error.message, node: state.id }; });
    }
    const readyDeadline = Date.now() + 25000;
    while (![...nodes.values()].every(value => value.ready)) { check(Date.now() < readyDeadline, 'Six real Electron renderers did not initialize'); await delay(100); }
    check(new Set([...nodes.values()].map(value => value.child?.pid)).size === 6, 'Participants must use six separate Electron main processes');
    const voiceA = await until('voice-ready', ids, samples => [...samples.values()].every(value => array(value.voice).length === 5 && array(value.voice).every(row => { const voice = object(row); return voice.state === 'connected' && voice.control === 'open' && number(voice.rms) > 0 && array(voice.inbound).some(rtp => number(object(rtp).emitted) > 0); })), 25000);
    await delay(1200); const voiceB = await sample('voice-growth', ids);
    for (const id of ids) for (const value of array(node(voiceB, id).voice)) { const voice = object(value), before = array(node(voiceA, id).voice).map(object).find(row => row.peerId === voice.peerId); check(before !== undefined, 'Missing voice baseline'); const b = object(array(before.inbound)[0]), a = object(array(voice.inbound)[0]); for (const key of ['bytes', 'packets', 'duration', 'emitted']) check(number(a[key]) > number(b[key]), 'Real Opus counter did not grow: ' + id + '/' + voice.peerId + '/' + key); }
    checks.push({ name: 'thirty-real-opus-directions', passed: true, evidence: 'Nonzero received PCM RMS and increasing bytes, packets, decoded sample duration and jitter-buffer emitted samples; totalAudioEnergy retained raw, zero under main-process audio mute' });
    await command('n00', 'publish');
    await until('share-announced', ids, samples => [...samples.values()].every(value => number(object(value.core).shares) === 1), 5000);
    await Promise.all(ids.slice(1).map(id => command(id, 'watch')));
    const initial = await until('five-decoded-viewers', ids, samples => ids.slice(1).every(id => videoReady(node(samples, id))), 35000);
    const source = node(initial, 'n00'), initialPlan = plans(source)[0]; check(initialPlan !== undefined && array(initialPlan.routes).length === 5, 'Source plan does not cover five viewers');
    check(array(source.screen).length < 5 && array(initialPlan.routes).some(route => object(route).parentId !== 'n00'), 'Expected fewer source PCs and a real one-hop relay branch');
    const helper = object(node(initial, 'n01').native); check(array(helper.sessions).some(row => object(row).role === 'publish' && number(object(row).rtpPackets) > 0), 'Native relay did not receive real RTP');
    check(array(helper.sessions).filter(row => object(row).role === 'subscribe' && number(object(row).wireRtpBytesSent) > 0).length === 4, 'Native relay must send three real remote subscriptions and its local preview');
    check(array(node(initial, 'n01').screen).every(row => number(object(object(row).stats).framesEncoded) === 0), 'Relay owner browser unexpectedly reencoded screen video');
    if (scenario !== 'core') check(node(initial, 'n05').native === null && node(initial, 'n05').bridgePresent === false, 'Browser leaf must have no Electron preload bridge');
    if (scenario === 'stun-blackhole') { check(bindingRequests > 0, 'The real STUN fault socket received no binding request'); checks.push({ name: 'real-blackhole-stun-with-five-decoded-viewers', passed: true, bindingRequests }); }
    checks.push({ name: 'five-viewers-one-hop-native', passed: true, sourceScreenPeerConnections: array(source.screen).length });
    const relayLeft = object(await command('n01', 'leave')); stages.push({ label: 'departed-relay-cleanup', node: 'n01', snapshot: relayLeft });
    check(array(relayLeft.errors).length === 0, 'Departed relay reported cleanup errors: ' + JSON.stringify(relayLeft.errors));
    const active = ids.filter(id => id !== 'n01');
    const recovery = await until('graceful-relay-promotion', active, samples => active.every(id => !array(node(samples, id).peers).includes('n01')) && routes(node(samples, 'n00')).length === 4 && sessions(node(samples, 'n02')).some(row => object(row).role === 'publish' && object(row).state === 'connected') && active.slice(1).every(id => videoReady(node(samples, id))), 30000);
    await delay(1000); const advancing = await sample('recovered-frame-growth', active);
    for (const id of active.slice(1)) check(number(node(advancing, id).displayedFrames) > number(node(recovery, id).displayedFrames), 'Surviving viewer stopped after relay leave: ' + id);
    checks.push({ name: 'actual-data-channel-leave-and-promotion', passed: true });
    await command('n02', 'expect-forgery'); await command('n03', 'forge');
    await until('forged-cross-user-rejected', active, samples => array(node(samples, 'n02').rejections).length === 2, 5000);
    checks.push({ name: 'cross-user-plan-and-offer-rejected', passed: true });
    if (scenario !== 'core') {
      const beforeCrash = await sample('before-real-helper-crash', active), victim = object(node(beforeCrash, 'n02').native), victimPid = number(victim.pid);
      check(victim.running === true && helperPids.has(victimPid), 'Crash target is not an owned real helper process');
      process.kill(victimPid);
      stages.push({ label: 'real-helper-process-killed', id: 'n02', pid: victimPid, at: Date.now() });
      const recovered = await until('helper-crash-voice-alive-recovery', active, samples => active.every(id => array(node(samples, id).voice).length === 4 && array(node(samples, id).voice).every(row => object(row).state === 'connected' && object(row).control === 'open' && number(object(row).rms) > 0)) && active.slice(1).every(id => videoReady(node(samples, id)) && number(node(samples, id).displayedFrames) > number(node(beforeCrash, id).displayedFrames) + 4) && routes(node(samples, 'n00')).every(row => object(row).parentId !== 'n02') && sessions(node(samples, 'n03')).some(row => object(row).role === 'publish' && object(row).state === 'connected' && number(object(row).wireRtpBytesReceived) > 0), 30000);
      check(node(recovered, 'n05').bridgePresent === false, 'Browser leaf acquired an unexpected native bridge');
      checks.push({ name: 'real-helper-crash-with-live-voice-and-browser-leaf', passed: true, killedPid: victimPid });
    }
    await command('n05', 'unwatch');
    await until('unwatch-revoked', active, samples => node(samples, 'n05').videoPresent === false && array(node(samples, 'n05').screen).length === 0 && routes(node(samples, 'n00')).length === 3, 10000);
    await command('n00', 'unpublish');
    await until('unpublish-clean', active, samples => [...samples.values()].every(value => array(value.screen).length === 0 && number(object(value.core).native) === 0 && value.videoPresent === false && (!value.native || array(object(value.native).sessions).every(row => object(row).state === 'closed'))), 10000);
    checks.push({ name: 'unwatch-and-unpublish-revoke-native', passed: true });
    for (const id of active) { const closed = object(await command(id, 'leave')), core = object(closed.core); stages.push({ label: 'leave-clean', node: id, snapshot: closed }); check(array(closed.errors).length === 0, 'Leave reported cleanup errors: ' + id + ' ' + JSON.stringify(closed.errors)); check(core.edges === 0 && core.native === 0 && core.plans === 0 && core.watching === 0 && core.shares === 0 && core.channel === null && core.audioContext === 'closed', 'Leave retained routing or media resources: ' + id); }
    checks.push({ name: 'all-room-resources-closed', passed: true });
  } catch (error) { failure = { message: error instanceof Error ? error.message : 'Non-error integration failure', stack: error instanceof Error ? error.stack ?? '' : '' }; }
  finally {
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error('Integration test cleanup')); } pending.clear();
    for (const state of nodes.values()) { state.child?.stdin?.end(); if (state.child && state.child.exitCode === null) state.child.kill(); }
    await delay(1500);
    for (const state of nodes.values()) { cleanup.push({ node: state.id, pid: state.child?.pid ?? null, exitCode: state.child?.exitCode ?? null, signal: state.child?.signalCode ?? null }); state.log?.end(); }
    for (const pid of helperPids) { let alive = true; try { process.kill(pid, 0); } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error; alive = false; } cleanup.push({ helperPid: pid, alive }); if (alive) { process.kill(pid); failure = failure ?? { message: 'Native helper survived Electron ownership shutdown', pid }; } }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (stunPort > 0) await new Promise(resolve => discovery.close(() => resolve(undefined)));
    const hashes = sourceHashes();
    if (JSON.stringify(startHashes) !== JSON.stringify(hashes)) failure = failure ?? { message: 'Source or native binary changed during this real integration run', startHashes, endHashes: hashes };
    fs.writeFileSync(path.join(directory, 'raw.json'), JSON.stringify({ config: { scenario, nodes: 6, voiceDirections: 30, screenTargetBps: 1000000, sourceUploadBps: 5000000, helperUploadBps: 20000000, stunPort, bindingRequests, transport: 'real WebRTC and production DataChannels; HTTP only initial voice SDP/ICE and test commands' }, durationMs: Date.now() - start, startHashes, hashes, checks, broker, stages, cleanup, failure }, null, 2));
    console.log(JSON.stringify({ event: 'screen-routing-finished', directory, checks: checks.length, durationMs: Date.now() - start, failure }));
  }
  if (failure) process.exitCode = 1;
}
if (process.versions.electron) electronMain().catch(error => { console.error(error); process.exitCode = 1; });
else parentMain().catch(error => { console.error(error); process.exitCode = 1; });
