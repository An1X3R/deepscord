// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new Error(message); }

/** @returns {Promise<void>} */
async function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const origin = process.env.POKE_AUDIO_ORIGIN, output = process.env.POKE_AUDIO_OUTPUT;
  check(origin !== undefined && output !== undefined, 'Explicit audio test origin and output are required');
  /** @param {string} stage @returns {void} */
  const trace = stage => fs.appendFileSync(path.join(output, 'stages.log'), stage + '\n');
  trace('electron-started');
  app.setPath('userData', path.join(output, 'profile'));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  await app.whenReady();
  trace('app-ready');
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setAudioMuted(true);
  window.webContents.debugger.attach('1.3');
  /** @type {{nodeType:string,nodeId:string}[]} */ const nodes = [];
  /** @type {{contextId:string}[]} */ const contexts = [];
  /** @type {string[]} */ const disconnected = [];
  /** @type {string[]} */ const destroyedContexts = [];
  /** @type {string[]} */ const closedContexts = [];
  window.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'WebAudio.audioNodeCreated') nodes.push(params.node);
    if (method === 'WebAudio.contextCreated') contexts.push(params.context);
    if (method === 'WebAudio.nodesDisconnected') disconnected.push(params.sourceId);
    if (method === 'WebAudio.contextWillBeDestroyed') destroyedContexts.push(params.contextId);
    if (method === 'WebAudio.contextChanged' && params.context.contextState === 'closed') closedContexts.push(params.context.contextId);
  });
  /** @param {string} expression @returns {Promise<object>} */
  const run = async expression => {
    trace(expression);
    const result = await window.webContents.executeJavaScript(expression, true);
    await new Promise(resolve => setTimeout(resolve, 75));
    return result;
  };
  const sourceCount = () => nodes.filter(node => node.nodeType === 'AudioBufferSource').length;
  try {
    await window.loadURL(origin + '/test/poke-audio-page.html');
    trace('page-loaded');
    await window.webContents.debugger.sendCommand('WebAudio.enable');
    await run('pokeAudioTest.silent()');
    check(contexts.slice().length === 0, 'Non-boom hit created an audio context');
    await run('pokeAudioTest.cancelled()');
    check(sourceCount() === 0, 'Cancelled pending decode started an audio source');
    await run('pokeAudioTest.play()');
    check(sourceCount() === 1, 'Real boom did not create exactly one audio source: ' + JSON.stringify(nodes));
    await run('pokeAudioTest.burst()');
    check(sourceCount() === 3, 'Burst exceeded the three-source concurrency bound');
    const realTime = await window.webContents.debugger.sendCommand('WebAudio.getRealtimeData', { contextId: contexts[0].contextId });
    await run('pokeAudioTest.deafened()');
    check(sourceCount() === 3, 'Deafened receiver started a sound');
    await run('pokeAudioTest.rateLimited()');
    check(sourceCount() === 4, 'Aggregate four-per-second limit failed after stop/restart');
    const sinkError = await run('pokeAudioTest.invalidSink()');
    check(sourceCount() === 4, 'Missing output device leaked audio to the default destination');
    const saved = await run('pokeAudioTest.persisted()');
    await run('pokeAudioTest.prepareIdle()');
    const idleStarted = Date.now();
    await new Promise(resolve => setTimeout(resolve, 30500));
    const idleWaitMs = Date.now() - idleStarted;
    await window.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
    await run('undefined');
    check(closedContexts.includes(contexts[0].contextId), 'Idle poke AudioContext was not closed after 30 seconds: ' + JSON.stringify({ closedContexts, destroyedContexts }));
    check(nodes.filter(node => node.nodeType === 'AudioBufferSource').every(node => disconnected.includes(node.nodeId)), 'Stopped poke sources retained their output connections');
    await run('pokeAudioTest.play()');
    check(contexts.length === 2 && sourceCount() === 5, 'Poke playback did not rebuild a real audio graph after idle release');
    const playbackDeadline = Date.now() + 15000;
    const resumedSource = nodes.filter(node => node.nodeType === 'AudioBufferSource').at(-1); check(resumedSource !== undefined, 'Resumed poke source is missing');
    while (!disconnected.includes(resumedSource.nodeId)) {
      check(Date.now() < playbackDeadline, 'Naturally ended poke source retained its output connection');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await run('pokeAudioTest.close()');
    check(sourceCount() === 5, 'Closed player started a sound');
    check(!nodes.some(node => /MediaStream/.test(node.nodeType)), 'Local effects graph created a media stream node');
    const errors = await run('pokeAudioTest.errors');
    check(JSON.stringify(errors) === '[]', 'Unexpected internal audio failures: ' + JSON.stringify(errors));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, versions: process.versions, nodes, contexts, disconnected, realTime, sinkError, saved, closedContexts, destroyedContexts, idleWaitMs, microphoneCaptured: false, audibleHardwareVerified: false }, null, 2));
  } finally { window.destroy(); }
  app.exit(0);
}

/** @returns {Promise<void>} */
async function parentMain() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  check(binary !== undefined && path.isAbsolute(binary) && fs.existsSync(binary), 'Set ELECTRON_TEST_BINARY to an actual Electron executable');
  const runtime = path.join(root, '.qa-tools', 'poke-audio-runtime');
  const source = path.dirname(binary), owner = JSON.stringify({ source, entry: __filename });
  const marker = path.join(runtime, '.poke-audio-owner');
  if (!fs.existsSync(runtime)) {
    const packaged = path.join(source, 'resources', 'app');
    fs.cpSync(source, runtime, { recursive: true, filter: filename => filename !== packaged && !filename.startsWith(packaged + path.sep) && filename !== path.join(source, 'resources', 'app.asar') });
    fs.writeFileSync(marker, owner, { flag: 'wx' });
  } else check(fs.readFileSync(marker, 'utf8') === owner, 'Existing audio runtime has a different owner');
  const entry = path.join(runtime, 'resources', 'app'); fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'poke-audio-test', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(entry, 'main.cjs'), 'require(' + JSON.stringify(__filename) + ');');
  const output = path.join(root, '.qa-tools', 'results', 'poke-audio', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(output, { recursive: true });
  const files = ['test/poke-audio-page.html', 'test/poke-audio-page.js', 'public/js/poke-audio.js', 'public/js/audio-idle.js', 'public/assets/vine-boom.wav'];
  let audioRequests = 0;
  const server = http.createServer((request, response) => {
    const filename = (request.url ?? '').slice(1);
    if (!files.includes(filename)) { response.writeHead(404); response.end(); return; }
    const send = () => { response.writeHead(200, { 'content-type': filename.endsWith('.wav') ? 'audio/wav' : filename.endsWith('.html') ? 'text/html' : 'text/javascript', 'cache-control': 'no-store' }); response.end(fs.readFileSync(path.join(root, filename))); };
    if (filename.endsWith('.wav')) { audioRequests += 1; setTimeout(send, 200); } else send();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); check(address !== null && typeof address !== 'string', 'Audio test server did not bind');
  /** @type {NodeJS.ProcessEnv} */ const environment = { ...process.env, POKE_AUDIO_ORIGIN: 'http://127.0.0.1:' + address.port, POKE_AUDIO_OUTPUT: output }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(runtime, path.basename(binary)), [], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', data => { log += String(data); }); child.stderr.on('data', data => { log += String(data); });
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Real audio integration exceeded 120000ms')); }, 120000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    check(code === 0, 'Audio integration failed: ' + output + '\n' + log);
    check(audioRequests === 2, 'Audio asset must be fetched once per context lifetime; actual requests=' + audioRequests);
    console.log(JSON.stringify({ event: 'poke-audio-passed', output, audioRequests }));
  } finally {
    fs.writeFileSync(path.join(output, 'electron.log'), log);
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined)));
  }
}
if (process.versions.electron) electronMain().catch(error => { console.error(error); require('electron').app.exit(1); });
else parentMain().catch(error => { console.error(error); process.exitCode = 1; });
