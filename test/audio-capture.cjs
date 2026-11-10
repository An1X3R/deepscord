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
  const destination = path.join(root, '.qa-tools', 'audio-capture-runtime');
  assert(!under(source, destination) && !under(destination, source) && source !== destination, 'Runtime source and destination overlap');
  const identity = JSON.stringify({ owner: 'deepscord-audio-capture', source: executable, modified: fs.statSync(executable).mtimeMs });
  const marker = path.join(destination, '.audio-capture-runtime.json');
  if (fs.existsSync(destination)) assert.equal(fs.readFileSync(marker, 'utf8'), identity, 'Existing runtime ownership/source differs');
  else {
    const sourceApp = path.join(source, 'resources', 'app');
    const sourceAsar = path.join(source, 'resources', 'app.asar');
    fs.cpSync(source, destination, { recursive: true, filter: (value) => value !== sourceApp && !under(sourceApp, value) && value !== sourceAsar });
    fs.writeFileSync(marker, identity);
  }
  const entry = path.join(destination, 'resources', 'app');
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'deepscord-audio-capture', version: '1.0.0', main: 'main.js' }));
  fs.writeFileSync(path.join(entry, 'main.js'), "'use strict';\nrequire(" + JSON.stringify(__filename) + ');\n');
  return path.join(destination, path.basename(executable));
}

/** @param {string} executable @param {string} directory @returns {Promise<void>} */
async function launch(executable, directory) {
  /** @type {NodeJS.ProcessEnv} */
  const environment = { ...process.env, DEEPSCORD_AUDIO_CAPTURE_TEMP: directory };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { cwd: root, env: environment, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Physical capture probe exceeded 45000 ms')); }, 45000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(undefined);
      else reject(new Error(`Physical capture probe exited with code ${code}, signal ${signal}`));
    });
  });
}

/** @returns {Promise<void>} */
async function runNode() {
  const executable = prepareRuntime();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-audio-capture-'));
  try { await launch(executable, directory); }
  finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), 'Cleanup escaped temporary directory');
    assert(path.basename(resolved).startsWith('deepscord-audio-capture-'), 'Cleanup prefix mismatch');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

/** @returns {Promise<void>} */
async function runElectron() {
  const { app, BrowserWindow, session } = require('electron');
  const directory = process.env.DEEPSCORD_AUDIO_CAPTURE_TEMP;
  assert(directory && path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('deepscord-audio-capture-'), 'Owned user data path missing');
  app.setPath('userData', path.join(directory, 'profile'));
  const results = path.join(root, '.qa-tools', 'results');
  fs.mkdirSync(results, { recursive: true });
  const resultPath = path.join(results, 'audio-capture-' + randomUUID() + '.json');
  /** @type {import('electron').BrowserWindow|null} */
  let win = null;
  /** @type {http.Server|null} */
  let fixture = null;
  let exitCode = 1;
  try {
    await app.whenReady();
    assert(!app.commandLine.hasSwitch('use-fake-device-for-media-stream') && !app.commandLine.hasSwitch('use-file-for-fake-audio-capture'), 'Fake media switches are forbidden');
    fixture = http.createServer((request, response) => {
      const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      const allowed = new Map([['/test/audio-capture-page.html', 'text/html'], ['/test/audio-capture-page.js', 'text/javascript'], ['/public/js/microphone-capture.js', 'text/javascript'], ['/public/js/microphone-graph.js', 'text/javascript']]);
      const contentType = allowed.get(pathname);
      if (!contentType) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', contentType);
      response.end(fs.readFileSync(path.join(root, pathname)));
    });
    await new Promise((resolve, reject) => { fixture?.once('error', reject); fixture?.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const address = fixture.address();
    assert(address && typeof address !== 'string', 'Fixture address missing');
    const origin = 'http://127.0.0.1:' + address.port;
    const ses = session.fromPartition('audio-capture-' + randomUUID());
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(permission === 'media' && new URL(contents.getURL()).origin === origin && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
    });
    ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      return Boolean(permission === 'media' && (requestingOrigin === origin || requestingOrigin === origin + '/') && details.mediaType !== 'video');
    });
    win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const runtime = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, argv: process.argv, commandLine: app.commandLine.getSwitchValue('enable-features'), disableFeatures: app.commandLine.getSwitchValue('disable-features'), physicalMedia: true };
    console.log(JSON.stringify({ stage: 'runtime', ...runtime }));
    await win.loadURL(origin + '/test/audio-capture-page.html');
    /** @type {import('./audio-capture-page.js').CaptureReport} */
    const capture = await win.webContents.executeJavaScript("window.audioCaptureProbe.run('default')", true);
    const defaultInput = capture.devices.find((device) => device.deviceId === 'default');
    const physical = capture.devices.find((device) => device.groupId === defaultInput?.groupId && device.deviceId !== 'default' && device.deviceId !== 'communications');
    assert(physical, 'Default audio input has no concrete physical device identity');
    /** @type {import('./audio-capture-page.js').ApplyReport} */
    const apply = await win.webContents.executeJavaScript('window.audioCaptureApply.run(' + JSON.stringify(physical.deviceId) + ')', true);
    /** @type {import('./audio-capture-page.js').ExclusiveGraphReport} */
    const exclusiveGraph = await win.webContents.executeJavaScript('window.audioCaptureExclusiveGraph.run(' + JSON.stringify(physical.deviceId) + ')', true);
    /** @type {import('./audio-capture-page.js').ConnectorReport} */
    const connectorDefault = await win.webContents.executeJavaScript("window.audioCaptureConnector.run('default')", true);
    /** @type {import('./audio-capture-page.js').ConnectorReport} */
    const connector = await win.webContents.executeJavaScript('window.audioCaptureConnector.run(' + JSON.stringify(physical.deviceId) + ')', true);
    /** @type {import('./audio-capture-page.js').SignalReport} */
    const signal = await win.webContents.executeJavaScript('window.audioCaptureSignal.run()', true);
    fs.writeFileSync(resultPath, JSON.stringify({ runtime, capture, apply, exclusiveGraph, connectorDefault, connector, signal }, null, 2));
    console.log(JSON.stringify({ stage: 'generated-real-webaudio-signal', ...signal }));
    console.log(JSON.stringify({ stage: 'exclusiveGraph', failure: exclusiveGraph.failure, stopped: exclusiveGraph.stopped, stableTrack: new Set(exclusiveGraph.destinationTrackIds).size === 1, matches: exclusiveGraph.observations.map((observation) => observation.matches) }));
    console.log(JSON.stringify({ stage: 'applyConstraints', ...apply }));
    for (const observation of capture.observations) console.log(JSON.stringify({ stage: 'capture', ...observation }));
    assert(capture.stopped, 'Physical microphone tracks were not all stopped');
    assert.equal(capture.failure, null, 'Capture failed: ' + JSON.stringify(capture.failure));
    assert(capture.observations.every((observation) => observation.matches), 'Exact processing constraints do not match track settings; see ' + resultPath);
    console.log(JSON.stringify({ stage: 'connector', ...connector }));
    console.log(JSON.stringify({ stage: 'connector-default', ...connectorDefault }));
    for (const result of [connectorDefault, connector]) {
      assert.equal(result.failure, null, 'Connector regression failed: ' + JSON.stringify(result.failure));
      assert(result.stopped && result.checks.every((check) => check.passed), 'Connector check failed; see ' + resultPath);
    }
    assert(exclusiveGraph.stopped && exclusiveGraph.failure === null && exclusiveGraph.observations.every((observation) => observation.matches) && new Set(exclusiveGraph.destinationTrackIds).size === 1, 'Exclusive input switching failed; see ' + resultPath);
    assert(signal.stopped && signal.stableDestination && signal.gateSilenceRms < 0.000001 && signal.measurements.every((measurement) => measurement.passed), 'Real WebAudio gain/gate measurement failed; see ' + resultPath);
    exitCode = 0;
    console.log(JSON.stringify({ stage: 'passed', resultPath, stopped: capture.stopped, observations: capture.observations.length }));
  } catch (error) {
    console.error(JSON.stringify({ stage: 'failed', message: error instanceof Error ? error.message : String(error), resultPath }));
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (fixture) {
      const active = fixture;
      await new Promise((resolve, reject) => { active.close((error) => error ? reject(error) : resolve(undefined)); active.closeAllConnections(); });
    }
    app.exit(exitCode);
  }
}

if (process.versions.electron) runElectron().catch((error) => { console.error(error); process.exit(1); });
else runNode().catch((error) => { console.error(error); process.exitCode = 1; });
