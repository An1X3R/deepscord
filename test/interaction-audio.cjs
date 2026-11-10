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
  const origin = process.env.INTERACTION_AUDIO_ORIGIN, output = process.env.INTERACTION_AUDIO_OUTPUT;
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
  /** @type {{paramType:string,defaultValue:number}[]} */ const parameters = [];
  /** @type {string[]} */ const disconnected = [];
  /** @type {string[]} */ const destroyedContexts = [];
  /** @type {string[]} */ const closedContexts = [];
  window.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'WebAudio.audioNodeCreated') nodes.push(params.node);
    if (method === 'WebAudio.contextCreated') contexts.push(params.context);
    if (method === 'WebAudio.audioParamCreated') parameters.push(params.param);
    if (method === 'WebAudio.nodesDisconnected') disconnected.push(params.sourceId);
    if (method === 'WebAudio.contextWillBeDestroyed') destroyedContexts.push(params.contextId);
    if (method === 'WebAudio.contextChanged' && params.context.contextState === 'closed') closedContexts.push(params.context.contextId);
  });
  /** @param {string} expression @returns {Promise<import('../public/js/network-protocol.js').JsonValue>} */
  const run = async expression => {
    trace(expression);
    const result = await window.webContents.executeJavaScript(expression, true);
    await new Promise(resolve => setTimeout(resolve, 75));
    return result;
  };
  const sourceCount = () => nodes.filter(node => node.nodeType === 'AudioBufferSource').length;
  try {
    await window.loadURL(origin + '/test/interaction-audio-page.html');
    trace('page-loaded');
    await window.webContents.debugger.sendCommand('WebAudio.enable');
    await run('interactionAudioTest.outsider()');
    check(contexts.slice().length === 0, 'Uninvolved observer created an audio context');
    await run('interactionAudioTest.cancelled()');
    check(sourceCount() === 0, 'Cancelled pending decode started an audio source');
    await run('interactionAudioTest.memberCancelled()');
    check(sourceCount() === 0, 'Member departure did not cancel pending playback');
    await run('interactionAudioTest.cancelledPreferences()');
    check(sourceCount() === 0, 'Reenabling preferences revived a pending sender or receiver');
    await run('interactionAudioTest.actor()');
    check(sourceCount() === 1, 'Actor did not create exactly one real MP3 audio source');
    await run('interactionAudioTest.receiver()');
    check(sourceCount() === 2, 'Receiver did not create exactly one real MP3 audio source');
    await run('interactionAudioTest.burst()');
    check(sourceCount() === 4, 'Burst failed the four-source concurrency bound');
    const realTime = await window.webContents.debugger.sendCommand('WebAudio.getRealtimeData', { contextId: contexts[0].contextId });
    await new Promise(resolve => setTimeout(resolve, 1050));
    await run('interactionAudioTest.deafened()');
    check(sourceCount() === 5, 'Voice deafening must preserve recipient audio and suppress sender audio');
    await run('interactionAudioTest.zeroOutput()');
    check(sourceCount() === 6, 'Zero voice output must preserve recipient audio and suppress sender audio');
    await run('interactionAudioTest.zeroPeer()');
    check(sourceCount() === 7, 'Zero peer voice volume suppressed recipient interaction audio');
    await new Promise(resolve => setTimeout(resolve, 1050));
    await run('interactionAudioTest.allAssets()');
    check(sourceCount() === 9, 'All five supplied MP3 variants did not decode and play');
    await run('interactionAudioTest.silentSettings()');
    check(sourceCount() === 9, 'Disabled or zero interaction volume started audio');
    await new Promise(resolve => setTimeout(resolve, 1050));
    await run('interactionAudioTest.custom()');
    check(sourceCount() === 10, 'Custom sound must play exactly once for its participant; stale, silent and observer effects must stay silent');
    await new Promise(resolve => setTimeout(resolve, 1050));
    const sinkError = await run('interactionAudioTest.invalidSink()');
    check(sinkError === 'NotFoundError', 'Invalid sink did not propagate its original failure');
    check(sourceCount() === 10, 'Missing output device leaked audio to the default destination');
    const invalidEvent = await run('interactionAudioTest.invalidEvent()');
    await run('interactionAudioTest.prepareIdle()');
    const idleStarted = Date.now();
    await new Promise(resolve => setTimeout(resolve, 30500));
    const idleWaitMs = Date.now() - idleStarted;
    await window.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
    await run('undefined');
    check(closedContexts.includes(contexts[0].contextId), 'Idle interaction AudioContext was not closed after 30 seconds: ' + JSON.stringify({ closedContexts, destroyedContexts }));
    check(nodes.filter(node => node.nodeType === 'AudioBufferSource').every(node => disconnected.includes(node.nodeId)), 'Stopped interaction sources retained their output connections');
    await run('interactionAudioTest.actor()');
    check(contexts.length === 2 && sourceCount() === 11, 'Interaction playback did not rebuild a real audio graph after idle release');
    const playbackDeadline = Date.now() + 15000;
    const resumedSource = nodes.filter(node => node.nodeType === 'AudioBufferSource').at(-1); check(resumedSource !== undefined, 'Resumed interaction source is missing');
    while (!disconnected.includes(resumedSource.nodeId)) {
      check(Date.now() < playbackDeadline, 'Naturally ended interaction source retained its output connection');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await run('interactionAudioTest.actor()');
    check(sourceCount() === 12, 'Sender playback did not establish a real source before output mute');
    const mutedSource = nodes.filter(node => node.nodeType === 'AudioBufferSource').at(-1); check(mutedSource !== undefined, 'Sender source before output mute is missing');
    check(!disconnected.includes(mutedSource.nodeId), 'Sender source already ended before output mute');
    check(!closedContexts.includes(contexts[1].contextId), 'Sender context already closed before output mute');
    await run('interactionAudioTest.mutePlayingSender()');
    check(disconnected.includes(mutedSource.nodeId), 'Output mute did not stop and disconnect the active sender source');
    const mutedIdleStarted = Date.now();
    await new Promise(resolve => setTimeout(resolve, 30500));
    const mutedIdleWaitMs = Date.now() - mutedIdleStarted;
    check(closedContexts.includes(contexts[1].contextId), 'Stopping the last sender through refresh did not close its idle context');
    await run('interactionAudioTest.receiver()');
    check(contexts.slice().length === 3 && sourceCount() === 13, 'Receiver playback did not rebuild its graph while voice output remained muted');
    await run('interactionAudioTest.close()');
    check(sourceCount() === 13, 'Closed player started a sound');
    check(!nodes.some(node => /MediaStream/.test(node.nodeType)), 'Local effects graph created a media stream node');
    check(nodes.some(node => node.nodeType === 'DynamicsCompressor') && nodes.some(node => node.nodeType === 'WaveShaper'), 'Local graph lacks peak protection');
    const errors = await run('interactionAudioTest.errors');
    check(JSON.stringify(errors) === '[]', 'Unexpected internal audio failures: ' + JSON.stringify(errors));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, versions: process.versions, nodes, parameters, contexts, disconnected, realTime, sinkError, invalidEvent, closedContexts, destroyedContexts, idleWaitMs, mutedIdleWaitMs, mutedSourceId: mutedSource.nodeId, microphoneCaptured: false, audibleHardwareVerified: false }, null, 2));
  } finally { window.destroy(); }
  app.exit(0);
}

/** @returns {Promise<void>} */
async function parentMain() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  check(binary !== undefined && path.isAbsolute(binary) && fs.existsSync(binary), 'Set ELECTRON_TEST_BINARY to an actual Electron executable');
  const runtime = path.join(root, '.qa-tools', 'interaction-audio-runtime');
  const source = path.dirname(binary), owner = JSON.stringify({ source, entry: __filename });
  const marker = path.join(runtime, '.interaction-audio-owner');
  if (!fs.existsSync(runtime)) {
    const packaged = path.join(source, 'resources', 'app');
    fs.cpSync(source, runtime, { recursive: true, filter: filename => filename !== packaged && !filename.startsWith(packaged + path.sep) && filename !== path.join(source, 'resources', 'app.asar') });
    fs.writeFileSync(marker, owner, { flag: 'wx' });
  } else check(fs.readFileSync(marker, 'utf8') === owner, 'Existing audio runtime has a different owner');
  const entry = path.join(runtime, 'resources', 'app'); fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'interaction-audio-test', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(entry, 'main.cjs'), 'require(' + JSON.stringify(__filename) + ');');
  const output = path.join(root, '.qa-tools', 'results', 'interaction-audio', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(output, { recursive: true });
  const files = ['test/interaction-audio-page.html', 'test/interaction-audio-page.js', 'public/js/interaction-audio.js', 'public/js/audio-idle.js', ...['bomb-1.mp3','bomb-2.mp3','bomb-3.mp3','bomb-4.mp3','poop.mp3'].map(name => 'public/assets/interactions/' + name)];
  let audioRequests = 0;
  const server = http.createServer((request, response) => {
    const filename = (request.url ?? '').slice(1);
    if (!files.includes(filename)) { response.writeHead(404); response.end(); return; }
    const send = () => { response.writeHead(200, { 'content-type': filename.endsWith('.mp3') ? 'audio/mpeg' : filename.endsWith('.html') ? 'text/html' : 'text/javascript', 'cache-control': 'no-store' }); response.end(fs.readFileSync(path.join(root, filename))); };
    if (filename.endsWith('.mp3')) { audioRequests += 1; setTimeout(send, 100); } else send();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); check(address !== null && typeof address !== 'string', 'Audio test server did not bind');
  /** @type {NodeJS.ProcessEnv} */ const environment = { ...process.env, INTERACTION_AUDIO_ORIGIN: 'http://127.0.0.1:' + address.port, INTERACTION_AUDIO_OUTPUT: output }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(runtime, path.basename(binary)), [], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', data => { log += String(data); }); child.stderr.on('data', data => { log += String(data); });
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Real audio integration exceeded 120000ms')); }, 120000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    check(code === 0, 'Audio integration failed: ' + output + '\n' + log);
    check(audioRequests === 8, 'Five initial MP3 assets, two post-idle reloads and the canceled close-time decode must be fetched; actual requests=' + audioRequests);
    console.log(JSON.stringify({ event: 'interaction-audio-passed', output, audioRequests }));
  } finally {
    fs.writeFileSync(path.join(output, 'electron.log'), log);
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined)));
  }
}
if (process.versions.electron) electronMain().catch(error => { console.error(error); require('electron').app.exit(1); });
else parentMain().catch(error => { console.error(error); process.exitCode = 1; });
