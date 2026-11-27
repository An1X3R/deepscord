// @ts-check
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {createStaticAssets} = require('../desktop/static-assets.cjs');

/** @returns {Promise<number[]>} */
async function probe() {
  const {VoiceEngine} = await import('../public/js/voice.js');
  /** @type {number[]} */ const starts = [];
  /** @type {string[]} */ const errors = [];
  /** @type {import('../public/js/voice.js').VoiceSettings} */
  const settings = {inputDeviceId: 'default', outputDeviceId: 'default', echoCancellation: true,
    noiseSuppression: true, autoGainControl: true, micVolume: 100, outVolume: 0,
    mode: 'vad', vadThreshold: -42, monitor: false};
  const engine = new VoiceEngine({selfId: 'cadence', getSettings: () => settings,
    config: {networkMode: 'direct', mediaPolicy: 'direct', iceTransportPolicy: 'all', iceServers: [], iceExpiresAt: null},
    sendSignal: () => {throw new Error('A local VAD test must not send peer signaling');},
    onEvent: event => {
      if (event.type === 'speaking' && event.speaking) starts.push(performance.now());
      if (event.type === 'error') errors.push(event.message);
    }});
  const context = new AudioContext({sampleRate: 48000});
  await context.resume();
  const oscillator = new OscillatorNode(context, {frequency: 700});
  const amplitude = new GainNode(context, {gain: 0});
  const input = context.createMediaStreamDestination();
  oscillator.connect(amplitude).connect(input);
  oscillator.start();
  /** @param {number} milliseconds @returns {Promise<void>} */
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  /** @type {number[]} */ const delays = [];
  try {
    await engine.ensureMic();
    if (!engine.chain) throw new Error('Physical microphone graph did not initialize');
    engine.chain.replaceSource(input.stream);
    engine.join('cadence-room');
    for (let index = 0; index < 32; index += 1) {
      await wait(380 + index % 32);
      const start = performance.now();
      amplitude.gain.value = index % 2 === 0 ? 0.2 : 0.02;
      await wait(20);
      amplitude.gain.value = 0;
      await wait(100);
      const detected = starts.find(value => value >= start);
      if (detected === undefined) throw new Error('VAD missed a 20 ms sound at phase ' + index);
      delays.push(detected - start);
    }
    if (errors.length) throw new Error(JSON.stringify(errors));
    return delays;
  } finally {
    engine.leave();
    if (engine.ctx) await engine.ctx.close();
    oscillator.stop();
    for (const track of input.stream.getTracks()) track.stop();
    await context.close();
  }
}

/** @returns {Promise<void>} */
async function runElectron() {
  const {app, BrowserWindow, session} = require('electron');
  const directory = process.env.DEEPSCORD_CADENCE_PROFILE;
  assert(directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('deepscord-vad-'));
  app.setPath('userData', directory);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  await app.whenReady();
  const assets = createStaticAssets(path.resolve(__dirname, '../public'));
  const server = http.createServer((request, response) => {
    if (request.url === '/public/probe') {response.end('<!doctype html><title>VAD regression</title>'); return;}
    void assets.serve(response, (request.url || '/').replace(/^\/public/, ''), 'GET').catch(error => {console.error(error); response.destroy(error);});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const partition = session.fromPartition('vad-regression');
  partition.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'media' && contents.getURL().startsWith(origin + '/')));
  partition.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permission === 'media' && requestingOrigin.startsWith(origin));
  const window = new BrowserWindow({show: false, webPreferences: {session: partition, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
  try {
    await window.loadURL(origin + '/public/probe');
    /** @type {number[]} */ const delays = await window.webContents.executeJavaScript('(' + probe.toString() + ')()', true);
    assert.equal(delays.length, 32);
    console.log(JSON.stringify({passed: true, detected: delays.length, pulseMs: 20, minimumOnsetMs: Math.min(...delays), maximumOnsetMs: Math.max(...delays)}));
  } finally {
    window.destroy();
    assets.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve(undefined)));
  }
  app.exit(0);
}

/** @returns {Promise<void>} */
async function runNode() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-vad-'));
  const executable = require('electron');
  assert.equal(typeof executable, 'string');
  /** @type {NodeJS.ProcessEnv} */
  const env = {...process.env, DEEPSCORD_CADENCE_PROFILE: directory};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(String(executable), [__filename], {env, windowsHide: true, stdio: 'inherit'});
  const timer = setTimeout(() => child.kill(), 60000);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve(undefined) : reject(new Error('VAD regression exit ' + code)));
    });
  } finally {
    clearTimeout(timer);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true});
  }
}
(process.versions.electron ? runElectron() : runNode()).catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
