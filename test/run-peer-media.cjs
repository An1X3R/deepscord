// @ts-check
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

/** @typedef {null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue}} JsonValue */
/** @typedef {{directory:string,processId:number,exitCode:number}} Cleanup */
/** @typedef {{code:number|null,signal:NodeJS.Signals|null,timedOut:boolean,cleanup:Cleanup|null}} Result */
const root = path.resolve(__dirname, '..');
const tools = path.join(root, '.qa-tools');
const runtime = path.join(tools, 'peer-native-runtime');
const results = path.join(tools, 'results');
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const logPath = path.join(results, 'peer-media-' + runId + '.log');
const diagnosticPath = path.join(results, 'peer-media-' + runId + '.diagnostics.json');

/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function requireCondition(condition, message) { if (!condition) throw new Error(message); }
/** @param {string} parent @param {string} value @returns {boolean} */
function within(parent, value) { const relative = path.relative(path.resolve(parent), path.resolve(value)); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); }

/** @returns {string} */
function electronBinary() {
  if (process.env.ELECTRON_TEST_BINARY) {
    const configured = path.resolve(process.env.ELECTRON_TEST_BINARY);
    requireCondition(fs.existsSync(configured) && fs.statSync(configured).isFile(), 'ELECTRON_TEST_BINARY does not name an executable file: ' + configured);
    return configured;
  }
  try {
    const installed = require('electron');
    requireCondition(typeof installed === 'string' && fs.existsSync(installed) && fs.statSync(installed).isFile(), 'Installed Electron package has no runtime executable');
    return installed;
  } catch (error) {
    throw new Error('Electron runtime unavailable; install the project dependency or set ELECTRON_TEST_BINARY. ' + (error instanceof Error ? error.message : String(error)));
  }
}

/** @param {string} executable @returns {string} */
function prepareRuntime(executable) {
  requireCondition(path.dirname(runtime) === path.resolve(tools), 'Runtime destination escaped the QA directory');
  const source = path.dirname(executable);
  requireCondition(!within(source, runtime) && !within(runtime, source) && source !== runtime, 'Electron source and isolated runtime must be separate directories');
  const sourceStat = fs.statSync(executable);
  const identity = { owner: 'deepscord-peer-media-runner', source: executable, size: sourceStat.size, modified: sourceStat.mtimeMs };
  const markerPath = path.join(runtime, '.peer-media-runtime.json');
  let cached = false;
  if (fs.existsSync(runtime)) {
    requireCondition(fs.existsSync(markerPath), 'Refusing to replace an unowned runtime directory: ' + runtime);
    /** @type {JsonValue} */ const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    requireCondition(marker !== null && typeof marker === 'object' && !Array.isArray(marker) && marker.owner === identity.owner, 'Runtime ownership marker is invalid');
    cached = JSON.stringify(marker) === JSON.stringify(identity) && fs.existsSync(path.join(runtime, path.basename(executable)));
    if (!cached) fs.rmSync(runtime, { recursive: true, force: true });
  }
  if (!cached) {
    const sourceApp = path.join(source, 'resources', 'app');
    const sourceAsar = path.join(source, 'resources', 'app.asar');
    fs.cpSync(source, runtime, { recursive: true, filter: (value) => path.resolve(value) !== sourceApp && !within(sourceApp, value) && path.resolve(value) !== sourceAsar });
    fs.writeFileSync(markerPath, JSON.stringify(identity));
  }
  const entry = path.join(runtime, 'resources', 'app');
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'deepscord-peer-media-test', version: '1.0.0', main: 'main.js' }));
  fs.writeFileSync(path.join(entry, 'main.js'), "'use strict';\nrequire(" + JSON.stringify(path.join(root, 'test', 'peer-media.cjs')) + ');\n');
  return path.join(runtime, path.basename(executable));
}

/** @param {string} line @param {number} childId @returns {Cleanup|null} */
function handleLine(line, childId) {
  if (!line.startsWith('{') || line.length > 65536) return null;
  /** @type {JsonValue} */ let message;
  try { message = JSON.parse(line); } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.status !== 'string') return null;
  if (message.status === 'cleanup-required-after-exit') {
    requireCondition(typeof message.testDirectory === 'string' && message.processId === childId && typeof message.exitCode === 'number' && Number.isInteger(message.exitCode), 'Invalid cleanup event from native runner');
    const directory = path.resolve(message.testDirectory);
    requireCondition(path.dirname(directory) === path.resolve(os.tmpdir()) && /^deepscord-peer-media-[a-zA-Z0-9]+$/.test(path.basename(directory)), 'Cleanup directory is outside the owned test prefix');
    return { directory, processId: childId, exitCode: message.exitCode };
  }
  /** @type {{[key:string]:JsonValue}} */ const summary = { status: message.status };
  for (const key of ['scenario', 'participants', 'pairs', 'route', 'ttlSeconds', 'nativeIceUfragChanged', 'selectedRoute', 'decodedPcm', 'offlineAudioContinues', 'offlineMuteAndLeave']) if (message[key] !== undefined) summary[key] = message[key];
  for (const key of ['message', 'reason']) if (typeof message[key] === 'string') summary[key] = message[key].slice(0, 400);
  console.log(JSON.stringify(summary));
  return null;
}

/** @param {string} executable @param {number} logDescriptor @returns {Promise<Result>} */
function run(executable, logDescriptor) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    /** @type {Cleanup|null} */ let cleanup = null;
    /** @type {Error|null} */ let parsingFailure = null;
    /** @type {ReturnType<typeof setTimeout>|null} */ let terminationTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(JSON.stringify({ status: 'timeout', milliseconds: 180000, processId: child.pid }));
      child.kill();
      terminationTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        child.stdout.removeAllListeners('data'); child.stderr.removeAllListeners('data');
        child.stdout.destroy(); child.stderr.destroy();
        resolve({ code: child.exitCode, signal: child.signalCode, timedOut: true, cleanup });
      }, 5000);
    }, 180000);
    for (const stream of [child.stdout, child.stderr]) {
      let buffered = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        fs.writeSync(logDescriptor, String(chunk));
        buffered += String(chunk);
        let boundary = buffered.indexOf('\n');
        while (boundary >= 0) {
          const line = buffered.slice(0, boundary).trim(); buffered = buffered.slice(boundary + 1);
          try { const event = handleLine(line, child.pid || -1); if (event) cleanup = event; }
          catch (error) { parsingFailure = error instanceof Error ? error : new Error('Invalid native test event'); child.kill(); }
          boundary = buffered.indexOf('\n');
        }
        if (buffered.length > 65536) buffered = buffered.slice(-65536);
      });
    }
    child.once('error', (error) => { clearTimeout(timer); if (terminationTimer) clearTimeout(terminationTimer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); if (terminationTimer) clearTimeout(terminationTimer);
      if (parsingFailure) reject(parsingFailure); else resolve({ code, signal, timedOut, cleanup });
    });
  });
}

/** @param {Cleanup} event @returns {void} */
function preserveAndClean(event) {
  const directory = path.resolve(event.directory);
  requireCondition(path.dirname(directory) === path.resolve(os.tmpdir()) && /^deepscord-peer-media-[a-zA-Z0-9]+$/.test(path.basename(directory)), 'Refusing to remove an unowned test directory');
  requireCondition(fs.realpathSync(path.dirname(directory)) === fs.realpathSync(os.tmpdir()) && fs.realpathSync(directory) === directory, 'Refusing cleanup through a redirected test directory');
  const diagnostic = path.join(directory, 'diagnostics.json');
  requireCondition(fs.existsSync(diagnostic), 'Native runner did not produce diagnostics.json; retained test directory: ' + directory);
  fs.copyFileSync(diagnostic, diagnosticPath);
  fs.rmSync(directory, { recursive: true, force: true });
}

/** @returns {Promise<void>} */
async function main() {
  fs.mkdirSync(results, { recursive: true });
  const lockPath = path.join(tools, 'peer-native-runtime.lock');
  const lock = fs.openSync(lockPath, 'wx');
  let logDescriptor = -1;
  try {
    const executable = prepareRuntime(electronBinary());
    logDescriptor = fs.openSync(logPath, 'wx');
    const result = await run(executable, logDescriptor);
    if (result.cleanup) preserveAndClean(result.cleanup);
    requireCondition(!result.timedOut, 'Native test exceeded 180 seconds; see ' + logPath);
    requireCondition(result.cleanup !== null, 'Native runner exited without a cleanup event; see ' + logPath);
    requireCondition(result.code === 0 && result.cleanup.exitCode === 0, 'Native test failed with code ' + result.code + ', signal ' + result.signal + '; see ' + logPath);
    console.log(JSON.stringify({ status: 'passed', runner: 'peer-media', log: logPath, diagnostics: diagnosticPath, temporaryDataRemoved: true }));
  } finally {
    if (logDescriptor !== -1) fs.closeSync(logDescriptor);
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

main().catch((error) => { console.error(JSON.stringify({ status: 'failed', runner: 'peer-media', message: error instanceof Error ? error.message : String(error), log: logPath })); process.exitCode = 1; });
