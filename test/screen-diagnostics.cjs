// @ts-check
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/network-protocol.js').JsonObject} JsonObject */
const root = path.resolve(__dirname, '..');
const sources = ['public/js/media-ui.js', 'public/js/poke-ui.js', 'public/js/poke-visual.js', 'public/js/screen-diagnostics.js', 'public/js/screen-link.js', 'public/js/screen-ice.js', 'public/js/screen-preferences.js', 'public/app.css', 'desktop/screen-diagnostics.cjs', 'desktop/preload.js'];
/** @param {string} file @returns {string} */
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
/** @returns {{[file:string]:string}} */
function hashes() { return Object.fromEntries(sources.map(file => [file, hash(path.join(root, file))])); }
/** @param {JsonValue|undefined} value @returns {JsonObject} */
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected structured actual diagnostic JSON'); return value; }
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new Error(message); }
/** @param {(input:JsonValue)=>JsonObject} parse @param {JsonObject} report @returns {void} */
function validateReport(parse, report) {
  check(report.schemaVersion === 2 && typeof report.startedAtUtc === 'string', 'Actual collection omitted UTC schema metadata');
  check(object(report.capture).contentHint === 'motion', 'Actual capture content hint was lost');
  check(object(report.capture).frameCounterMethod === 'track-processor-clone' && object(report.capture).observerStatus === 'frames-observed', 'Actual capture clone observer metadata missing');
  check(object(report.preferences).screenContentMode === 'motion', 'Requested sharing mode was lost');
  check(Array.isArray(report.samples) && report.samples.length === 5, 'Expected five actual samples');
  const samples = report.samples.map(object);
  for (const sample of samples) {
    check(typeof sample.timestampUtc === 'string' && Date.parse(sample.timestampUtc) >= Date.parse(report.startedAtUtc), 'Actual sample lacks a common UTC timestamp');
    check(Array.isArray(sample.rtp), 'Actual sample omitted RTP inventory');
  }
  const last = samples[4]; check(Array.isArray(last.rtp), 'Actual final sample omitted RTP inventory');
  const rows = last.rtp.map(object), send = rows.find(row => row.direction === 'send'), receive = rows.find(row => row.direction === 'receive');
  check(send !== undefined && receive !== undefined, 'Actual sender/receiver statistics missing');
  for (const key of ['sourceFrames', 'targetBitrate', 'framesSent', 'packetsSent', 'timestampMs', 'sourceTimestampMs', 'candidatePairTimestampMs', 'availableOutgoingBitrate']) check(typeof send[key] === 'number' && send[key] > 0, 'Actual sender metric missing: ' + key);
  for (const key of ['packetsReceived', 'jitterSeconds', 'packetsLost', 'nackCount', 'pliCount', 'firCount']) check(typeof receive[key] === 'number', 'Actual receiver metric missing: ' + key);
  check(send.qualityLimitationReason !== null && typeof send.qualityLimitationReason === 'string' && send.qualityLimitationDurations !== null, 'Actual encoder limitation metrics missing');
  const changed = { ...report, capture: { ...object(report.capture), deviceId: 'private-device' }, token: 'private-token', samples: samples.map(sample => ({ ...sample, rtp: Array.isArray(sample.rtp) ? sample.rtp.map(value => ({ ...object(value), packetsLost: -1, address: '192.0.2.1', sdp: 'private-sdp' })) : [] })) };
  const stripped = parse(changed), serialized = JSON.stringify(stripped);
  check(!serialized.includes('private-') && !serialized.includes('192.0.2.1') && serialized.includes('"packetsLost":-1'), 'Allowlist lost signed packet loss or retained private data');
  check(parse({ ...report, schemaVersion: 1 }).schemaVersion === 1, 'Existing v1 reports no longer parse');
  const noFrames = parse({ ...report, capture: { ...object(report.capture), observerStatus: 'no-frames-observed' }, samples: samples.map(sample => ({ ...sample, capture: { ...object(sample.capture), frames: 0 } })) });
  check(object(noFrames.capture).observerStatus === 'no-frames-observed', 'A quiet clone observer was treated as a production failure');
  const noFramesSamples = noFrames.samples; check(Array.isArray(noFramesSamples), 'Missing parsed clone samples');
  check(JSON.stringify(object(noFramesSamples[4]).rtp) === JSON.stringify(samples[4].rtp), 'Clone observer status replaced production RTP counters');
  for (const status of ['unsupported', 'not-applicable']) {
    const unavailable = parse({ ...report, capture: { ...object(report.capture), status, frameCounterMethod: 'none', observerStatus: status }, samples: samples.map(sample => ({ ...sample, capture: { ...object(sample.capture), frames: null } })) });
    check(object(unavailable.capture).observerStatus === status, 'Unavailable observer status was lost');
  }
  check(object(parse({ ...report, preferences: null })).preferences === null, 'Receiver-only preferences should remain null');
  for (const input of [{ ...report, capture: { ...object(report.capture), frameCounterMethod: 'none' } }, { ...report, capture: { ...object(report.capture), observerStatus: 'no-frames-observed' } }, { ...report, startedAtUtc: '2026-02-31T00:00:00.000Z' }, { ...report, samples: [...report.samples, ...report.samples] }, { ...report, preferences: { ...object(report.preferences), screenFrameRate: 999 } }, { ...report, samples: samples.map(sample => ({ ...sample, rtp: [{ ...send, packetsSent: 0.5 }] })) }]) {
    let rejected = false;
    try { parse(input); } catch (error) { check(error instanceof TypeError || error instanceof RangeError, 'Unexpected malformed diagnostic error type'); rejected = true; }
    check(rejected, 'Malformed diagnostic report was accepted');
  }
}
/** @returns {Promise<void>} */
async function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const origin = process.env.CONTINUITY_ORIGIN, output = process.env.CONTINUITY_OUTPUT;
  if (!origin || !output) throw new Error('Explicit isolated continuity origin and output required');
  app.setPath('userData', path.join(output, 'profile'));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); app.commandLine.appendSwitch('allow-loopback-in-peer-connection'); app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 980, height: 640, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, preload: path.join(app.getAppPath(), 'preload.js') } });
  const { registerScreenDiagnostics } = require(path.join(app.getAppPath(), 'screen-diagnostics.cjs'));
  registerScreenDiagnostics({ getWindow: () => window, assertOwner: (/** @type {Electron.IpcMainInvokeEvent} */ event) => { if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Diagnostic test rejected a foreign frame'); } });
  window.webContents.setAudioMuted(true);
  window.webContents.on('console-message', event => console.log(JSON.stringify({ event: 'renderer', message: event.message, level: event.level })));
  try {
    await window.loadURL(origin);
    window.showInactive();
    const operation = process.env.SCREEN_DIAGNOSTICS_OPERATION;
    if (operation !== undefined && operation !== 'collect') throw new TypeError('Unsupported diagnostic test operation');
    const data = /** @type {JsonObject} */ (await window.webContents.executeJavaScript(operation === 'collect' ? 'window.runCollectedDiagnostics()' : 'window.runDiagnostics()'));
    if (operation === 'collect') fs.writeFileSync(path.join(output, 'export.json'), JSON.stringify(object(data.report), null, 2));
    fs.writeFileSync(path.join(output, 'preview.png'), (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'raw.json'), JSON.stringify({ versions: process.versions, data }, null, 2)); app.exit(0);
  } catch (error) { fs.writeFileSync(path.join(output, 'raw.json'), JSON.stringify({ failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2)); app.exit(1); }
}
/** @returns {Promise<void>} */
async function parentMain() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  if (!binary || !path.isAbsolute(binary) || !fs.existsSync(binary)) throw new Error('Explicit existing ELECTRON_TEST_BINARY required');
  const source = path.dirname(binary), runtime = path.join(root, '.qa-tools', 'screen-diagnostics-runtime'), marker = path.join(runtime, '.owner.json');
  const identity = JSON.stringify({ source, executableSha256: hash(binary), entry: __filename });
  if (!fs.existsSync(runtime)) { const app = path.join(source, 'resources', 'app'); fs.cpSync(source, runtime, { recursive: true, filter: file => file !== app && !file.startsWith(app + path.sep) && file !== path.join(source, 'resources', 'app.asar') }); fs.writeFileSync(marker, identity, { flag: 'wx' }); }
  else if (fs.readFileSync(marker, 'utf8') !== identity) throw new Error('Refusing a continuity runtime owned by another task or binary');
  const app = path.join(runtime, 'resources', 'app'); fs.mkdirSync(app, { recursive: true }); fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'host-continuity', version: '1.0.0', main: 'main.cjs' })); fs.writeFileSync(path.join(app, 'main.cjs'), 'require(' + JSON.stringify(__filename) + ');\n');
  for (const file of ['preload.js', 'screen-diagnostics.cjs']) fs.copyFileSync(path.join(root, 'desktop', file), path.join(app, file));
  const schemaDirectory = path.join(app, 'app-server', 'public', 'js'); fs.mkdirSync(schemaDirectory, { recursive: true }); for (const file of ['screen-diagnostics.js', 'screen-preferences.js']) fs.copyFileSync(path.join(root, 'public', 'js', file), path.join(schemaDirectory, file));
  const output = path.join(root, '.qa-tools', 'results', 'screen-diagnostics', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')); fs.mkdirSync(output, { recursive: true });
  console.log(JSON.stringify({ event: process.env.SCREEN_DIAGNOSTICS_OPERATION === 'collect' ? 'real-electron-collection' : 'real-native-save-required', saveTo: path.join(output, 'export.json') }));
  const before = hashes(); fs.writeFileSync(path.join(output, 'source-hashes.json'), JSON.stringify(before, null, 2));
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const file = url.pathname === '/' ? path.join(root, 'test', 'screen-diagnostics-page.html') : url.pathname === '/test/screen-diagnostics-page.js' || sources.includes(url.pathname.slice(1)) ? path.join(root, url.pathname.slice(1)) : null;
    if (!file) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', 'cache-control': 'no-store' }); response.end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned HTTP server did not bind');
  /** @type {NodeJS.ProcessEnv} */ const environment = { ...process.env, CONTINUITY_ORIGIN: 'http://127.0.0.1:' + address.port, CONTINUITY_OUTPUT: output }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(runtime, path.basename(binary)), [], { cwd: root, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += String(chunk); }); child.stderr.on('data', chunk => { log += String(chunk); });
  try {
    const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Native diagnostic export test exceeded 150000ms')); }, 150000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
    if (code !== 0) throw new Error('Actual continuity experiment failed: ' + output);
    const reportFile = path.join(output, 'export.json');
    if (fs.statSync(reportFile).size > 1048576) throw new RangeError('Actual diagnostic fixture exceeds the one MiB read limit');
    const saved = object(/** @type {JsonValue} */ (JSON.parse(fs.readFileSync(reportFile, 'utf8'))));
    const schema = await import(require('node:url').pathToFileURL(path.join(root, 'public', 'js', 'screen-diagnostics.js')).href);
    const parsed = /** @type {{parseScreenDiagnosticReport:(value:import('../public/js/network-protocol.js').JsonValue)=>import('../public/js/network-protocol.js').JsonObject}} */ (schema).parseScreenDiagnosticReport(saved);
    const environment = process.env.SCREEN_DIAGNOSTICS_OPERATION === 'collect' ? {} : object(saved.environment);
    if (!Array.isArray(parsed.samples) || parsed.samples.length !== 5 || (process.env.SCREEN_DIAGNOSTICS_OPERATION !== 'collect' && (!environment.gpu || !environment.runtime || !environment.system))) throw new Error('Real exported JSON omitted diagnostic samples or environment');
    validateReport(/** @type {(value:JsonValue)=>JsonObject} */ (schema.parseScreenDiagnosticReport), parsed);
    if (Object.hasOwn(schema.parseScreenDiagnosticReport({ ...saved, token: 'must-be-stripped' }), 'token')) throw new Error('Export schema retained an unrelated private field');
    if (JSON.stringify(hashes()) !== JSON.stringify(before)) throw new Error('Audited source changed during continuity experiment');
    console.log(JSON.stringify({ event: 'screen-diagnostics-completed', output, code, samples: parsed.samples.length }));
  } finally {
    fs.writeFileSync(path.join(output, 'electron.log'), log); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const profile = path.join(output, 'profile'); if (path.relative(output, profile) !== 'profile') throw new Error('Profile cleanup escaped owned result directory');
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify({ pid: child.pid ?? null, exitCode: child.exitCode, signal: child.signalCode, profileExists: fs.existsSync(profile) }, null, 2));
  }
}
(process.versions.electron ? electronMain() : parentMain()).catch(error => { console.error(error); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1; });
