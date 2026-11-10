import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { connectPage, waitForPort } from '../test/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.ELECTRON_TEST_BINARY;
assert(source, 'ELECTRON_TEST_BINARY is required');
const directory = fs.mkdtempSync(path.join(root, '.qa-tools', 'capture-integration-'));
const runtime = path.join(directory, 'runtime');
const sourceApp = path.join(path.dirname(source), 'resources', 'app');
fs.cpSync(path.dirname(source), runtime, { recursive:true,filter:(entry) => entry !== sourceApp && !entry.startsWith(sourceApp + path.sep) && entry !== path.join(path.dirname(source), 'resources', 'app.asar') });
const runtimeApp = path.join(runtime, 'resources', 'app');
fs.mkdirSync(runtimeApp, { recursive:true });
fs.writeFileSync(path.join(runtimeApp, 'package.json'), JSON.stringify({ name:'deepscord-capture-probe',version:'1.0.0',main:'main.cjs' }));
fs.writeFileSync(path.join(runtimeApp, 'main.cjs'), `require(${JSON.stringify(path.join(root, 'desktop', 'main.js'))});`);
const routes = new Map([
  ['/', ['desktop/capture-integration-page.html','text/html']],
  ['/probe.js', ['desktop/capture-integration-page.js','text/javascript']],
  ['/analysis.js', ['desktop/capture-analysis-worklet.js','text/javascript']],
  ['/public/js/desktop-capture.js', ['public/js/desktop-capture.js','text/javascript']],
  ['/public/js/process-audio-worklet.js', ['public/js/process-audio-worklet.js','text/javascript']],
]);
const server = http.createServer((request, response) => {
  const route = routes.get(request.url || '/');
  if (!route) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type':route[1],'Cache-Control':'no-store' });
  response.end(fs.readFileSync(path.join(root, route[0])));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address(); assert(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const debugAddress = listener.address(); assert(debugAddress && typeof debugAddress !== 'string');
const port = debugAddress.port; listener.close(); await once(listener, 'close');
execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root, 'desktop', 'build-test-tone.ps1')], { stdio:'inherit' });
/** @param {number} frequency */
async function tone(frequency) {
  const child = spawn(path.join(root, '.qa-tools', 'process-capture', 'tone.exe'), [String(frequency)], { windowsHide:true,stdio:'pipe' });
  await Promise.race([once(child.stdout, 'data'),once(child, 'error').then(([error]) => { throw error; })]);
  assert(child.pid);
  return child;
}
const first = await tone(431);
const second = await tone(997);
const visual = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root, 'desktop', 'capture-window-test.ps1')], { windowsHide:false,stdio:'pipe' });
await Promise.race([once(visual.stdout, 'data'),once(visual, 'error').then(([error]) => { throw error; })]);
/** @type {NodeJS.ProcessEnv} */ const environment = { ...process.env,DEEPSCORD_USER_DATA:path.join(directory, 'user-data') };
delete environment.ELECTRON_RUN_AS_NODE;
const log = fs.openSync(path.join(directory, 'native.log'), 'w');
const child = spawn(path.join(runtime, path.basename(source)), [`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'], { env:environment,windowsHide:false,stdio:['ignore',log,log] });
const exited = once(child, 'exit');
/** @returns {number} */
function ownedHelpers() {
  const count = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', "$items = @(Get-CimInstance Win32_Process -Filter \"Name='process-audio.exe'\" | Where-Object { $_.ParentProcessId -eq " + child.pid + " }); $items.Count"], { encoding:'utf8',windowsHide:true });
  return Number(count.trim());
}
const timer = setTimeout(() => child.kill(), 50000);
let page = null;
/** @type {object[]} */ const evidence = [];
/** @param {number} selected @param {number} excluded */
async function spectrum(selected, excluded) {
  assert(page);
  await page.waitFor('window.captureProbe.status().measurements.length >= 4', { timeout:8000,interval:100,label:'real MediaStream audio samples' });
  const state = await page.eval('window.captureProbe.status()', { awaitPromise:true,userGesture:false });
  assert.deepEqual(state.errors, []);
  const samples = state.measurements.slice(1);
  const amplitudes = samples.map((sample) => sample[`amplitude${selected}`]);
  const unwanted = samples.map((sample) => sample[`amplitude${excluded}`]);
  const amplitude = amplitudes.reduce((a, b) => a + b, 0) / amplitudes.length;
  const excludedAmplitude = unwanted.reduce((a, b) => a + b, 0) / unwanted.length;
  const rejectionDb = 20 * Math.log10(amplitude / Math.max(excludedAmplitude, 1e-12));
  assert(amplitude > 0.001, `MediaStream lacks selected ${selected} Hz: ${amplitude}`);
  assert(rejectionDb > 30, `MediaStream includes excluded ${excluded} Hz: ${rejectionDb} dB rejection`);
  assert(samples.every((sample) => sample.channels === 2 && sample.sampleRate === 48000));
  const result = { selected,excluded,amplitude,excludedAmplitude,rejectionDb,windows:samples.length,tracks:state.tracks };
  evidence.push(result);
  console.log('real_audio_stream', JSON.stringify(result));
}
try {
  await waitForPort(port, 12000);
  page = await connectPage(port, 'file:');
  await page.waitFor('document.readyState === "complete" && typeof window.deepscord?.connect === "function"', { timeout:10000,interval:50,label:'production launcher ready' });
  await page.eval(`void window.deepscord.connect(${JSON.stringify(origin)})`, { awaitPromise:false,userGesture:true });
  page.close(); page = await connectPage(port, origin);
  await page.waitFor('!!window.captureProbe', { timeout:10000,interval:100,label:'HTTP owner capture page' });
  const processes = await page.eval('window.captureProbe.listAudioProcesses()', { awaitPromise:true,userGesture:true });
  assert(processes.some((entry) => entry.pid === first.pid)); assert(processes.some((entry) => entry.pid === second.pid));
  const started = await page.eval(`window.captureProbe.startAudio(${first.pid})`, { awaitPromise:true,userGesture:true });
  assert.equal(started.tracks[0].kind, 'audio'); assert.equal(started.tracks[0].readyState, 'live');
  assert.equal(ownedHelpers(), 1, 'Active capture must own exactly one real helper');
  await spectrum(431, 997);
  assert.deepEqual(await page.eval('window.captureProbe.stopAudio()', { awaitPromise:true,userGesture:true }), ['ended']);
  assert.equal(ownedHelpers(), 0, 'Explicit stop must reap the helper before returning');
  await page.eval('window.captureProbe.listAudioProcesses()', { awaitPromise:true,userGesture:true });
  await page.eval(`window.captureProbe.startAudio(${second.pid})`, { awaitPromise:true,userGesture:true });
  await spectrum(997, 431);
  second.kill();
  await page.waitFor('window.captureProbe.status().ended === 1', { timeout:5000,interval:50,label:'target exit ends renderer capture' });
  const ended = await page.eval('window.captureProbe.status()', { awaitPromise:true,userGesture:false });
  assert.equal(ended.tracks[0].readyState, 'ended'); assert.deepEqual(ended.errors, []);
  assert.equal(ownedHelpers(), 0, 'Target exit must reap the helper');
  await page.eval('window.captureProbe.stopAudio()', { awaitPromise:true,userGesture:true });
  const sources = await page.eval('window.captureProbe.listScreenSources()', { awaitPromise:true,userGesture:true });
  console.log('controlled_source_diagnostics', { count:sources.length,matching:sources.filter((entry) => /Deepscord|capture acceptance/i.test(entry.name)).map((entry) => ({ id:entry.id,name:entry.name,kind:entry.kind })),title:await page.eval('document.title', { awaitPromise:false,userGesture:false }) });
  const controlled = sources.find((entry) => entry.kind === 'window' && entry.name === 'Deepscord capture acceptance window');
  assert(controlled, 'Controlled test window must be available; do not select an unrelated window');
  await page.eval(`window.captureProbe.startVideo(${JSON.stringify(controlled.id)})`, { awaitPromise:true,userGesture:true });
  await page.waitFor('window.captureProbe.status().videoFrames >= 4', { timeout:8000,interval:100,label:'real selected-window video frames' });
  const video = await page.eval('window.captureProbe.status()', { awaitPromise:true,userGesture:false });
  assert(video.videoWidth > 100 && video.videoHeight > 100);
  const redDistance = Math.abs(video.videoPixel[0] - 216) + Math.abs(video.videoPixel[1] - 36) + Math.abs(video.videoPixel[2] - 49);
  const blueDistance = Math.abs(video.videoPixel[0] - 36) + Math.abs(video.videoPixel[1] - 89) + Math.abs(video.videoPixel[2] - 216);
  assert(Math.min(redDistance, blueDistance) < 70, `Video must contain the actual controlled window color: ${video.videoPixel}`);
  assert.deepEqual(await page.eval('window.captureProbe.stopVideo()', { awaitPromise:true,userGesture:true }), ['ended']);
  evidence.push({ window:controlled.name,frames:video.videoFrames,width:video.videoWidth,height:video.videoHeight,pixel:video.videoPixel });
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(evidence, null, 2));
  console.log('real_window_capture', JSON.stringify(evidence.at(-1)));
  await page.eval('window.captureProbe.listAudioProcesses()', { awaitPromise:true,userGesture:true });
  await page.eval(`window.captureProbe.startAudio(${first.pid})`, { awaitPromise:true,userGesture:true });
  assert.equal(ownedHelpers(), 1, 'Quit test must begin with a live native helper');
  page.send('Runtime.evaluate', { expression:'window.deepscord.quit()',userGesture:false }).catch((error) => console.log('quit_response_closed', { message:error.message }));
  const [code] = await exited; assert.equal(code, 0);
  assert.equal(ownedHelpers(), 0, 'Owned helper must not survive Electron quit');
  console.log('Real desktop capture integration passed. Evidence:', directory);
} finally {
  clearTimeout(timer); first.kill(); second.kill(); visual.kill();
  if (page) page.close();
  if (child.exitCode === null) child.kill();
  await exited; fs.closeSync(log);
  server.close();
}
