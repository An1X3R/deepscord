// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { page, targets, pause } from './security-cdp.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-security-native-'));
const runtime = fs.mkdtempSync(path.join(root, '.qa-tools', 'security-native-'));
const source = process.env.ELECTRON_TEST_BINARY || path.join(root, '.qa-tools/screen-diagnostics-runtime/Deepscord.exe');
const sourceDirectory = path.dirname(source);
const sourceApp = path.join(sourceDirectory, 'resources', 'app');
fs.cpSync(sourceDirectory, runtime, { recursive: true, filter: entry => entry !== sourceApp && !entry.startsWith(sourceApp + path.sep) && entry !== path.join(sourceDirectory, 'resources', 'app.asar') });
const entry = path.join(runtime, 'resources', 'app'); fs.mkdirSync(entry, { recursive: true });
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'deepscord-security-native', version: '1.0.0', main: 'main.cjs' }));
fs.writeFileSync(path.join(entry, 'main.cjs'), `const {app}=require('electron');app.on('browser-window-created',(_event,window)=>{window.webContents.on('did-fail-load',(_event,code,description,url,main)=>console.log('security_load_failure',{code,description,url,main}));window.webContents.on('destroyed',()=>console.log('security_contents_destroyed'));window.webContents.on('render-process-gone',(_event,details)=>console.log('security_renderer_gone',details));});require(${JSON.stringify(path.join(root, 'desktop/main.js'))});`);
const data = path.join(temporary, 'client'); fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ autoConnect: false, trustedHosts: ['127.0.0.1'] }));
fs.writeFileSync(path.join(data, 'desktop-settings.json'), JSON.stringify({ muteShortcut: 'Control+Alt+Shift+F11', overlay: { enabled: false, locked: true, x: 24, y: 80, width: 280, height: 300, scale: 1 } }));
const workspaceUrl = pathToFileURL(path.join(root, 'desktop/workspace.html')).href;
const connectionUrl = pathToFileURL(path.join(root, 'desktop/connections.html')).href;
const consentUrl = pathToFileURL(path.join(root, 'desktop/desktop-consent.html')).href;
/** @type {import('node:child_process').ChildProcess|null} */ let client = null;
let debug = 0;
let applicationRequests = 0;
let foreignRequests = 0;
/** @type {string[]} */ const checks = [];
/** @type {import('./security-cdp.mjs').JsonValue[]} */ const consentLayouts = [];
/** @param {string} label */ function pass(label) { checks.push(label); console.log('PASS ' + label); }
/** @param {string} name @returns {import('node:tls').SecureContextOptions} */
function fixture(name) { return { pfx: fs.readFileSync(path.join(temporary, name + '.pfx')), passphrase: 'fixture-password' }; }
/** @returns {Promise<number>} */
async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object'); server.close(); await once(server, 'close'); return address.port; }
/** @param {https.Server} server @returns {Promise<string>} */
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object'); return `https://127.0.0.1:${address.port}`; }
const foreign = https.createServer((request, response) => { foreignRequests += 1; response.end('foreign'); });
let foreignOrigin = '';
const server = https.createServer((request, response) => {
  applicationRequests += 1;
  if (request.url === '/foreign-redirect') { response.writeHead(302, { Location: foreignOrigin + '/redirect-target' }); response.end(); return; }
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/frame') { response.end('<!doctype html><html><body>Permission iframe</body></html>'); return; }
  response.end(`<!doctype html><html><body><h1 id="securityPage">TLS security probe</h1><iframe id="sameFrame" allow="microphone" src="/frame"></iframe><script>window.securityDocument=crypto.randomUUID();window.securityReady=true;window.micResult='idle';window.requestMicrophone=()=>{window.micResult='pending';navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());window.micResult='granted';},error=>{window.micResult=error.name;});};</script></body></html>`);
});
/** @returns {Promise<void>} */
async function launch() {
  debug = await freePort();
  /** @type {NodeJS.ProcessEnv} */ const env = { ...process.env, DEEPSCORD_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  client = spawn(path.join(runtime, path.basename(source)), [`--remote-debugging-port=${debug}`], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(temporary, 'electron-' + debug + '.log')); client.stdout?.pipe(log); client.stderr?.pipe(log);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.equal(client.exitCode, null, `Electron exited; logs: ${temporary}`);
    try { const response = await fetch(`http://127.0.0.1:${debug}/json/version`, { signal: AbortSignal.timeout(500) }); if (response.ok) return; }
    catch (error) { if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error; }
    await pause(100);
  }
  throw new Error(`Electron debugger unavailable; logs: ${temporary}`);
}
/** @returns {Promise<void>} */
async function stop() { if (!client || client.exitCode !== null) return; const stopped = once(client, 'exit'); client.kill(); await stopped; client = null; }
/** @param {string} origin */
async function connect(origin) {
  const workspace = await page(debug, workspaceUrl);
  await workspace.wait('typeof window.deepscord?.openConnectionPanel === "function"');
  await workspace.evaluate('window.deepscord.openConnectionPanel("join")'); workspace.close();
  const connection = await page(debug, connectionUrl);
  await connection.wait('document.getElementById("connectionBody")?.hidden===false');
  await connection.evaluate(`document.getElementById('serverMethodBtn').click();document.getElementById('serverUrl').value=${JSON.stringify(origin)};document.getElementById('serverConnectBtn').click();true`);
  return connection;
}
/** @param {'consentAccept'|'consentDeny'} id */
async function decide(id) {
  const consent = await page(debug, consentUrl);
  await consent.wait(`document.getElementById('${id}')?.disabled===false`);
  await consent.evaluate(`setTimeout(()=>document.getElementById('${id}').click(),50);true`); consent.close();
}
/** @returns {Promise<void>} */
async function noConsent() { assert.equal((await targets(debug)).some(row => row.url.startsWith(consentUrl)), false); }
/** @param {'certificate'|'microphone'} kind @returns {Promise<void>} */
async function inspectConsent(kind) {
  const consent = await page(debug, consentUrl);
  await consent.wait("document.getElementById('consentAccept')?.disabled===false");
  await consent.evaluate('document.fonts.ready.then(()=>true)');
  const layout = await consent.evaluate(`(()=>{const accept=document.getElementById('consentAccept').getBoundingClientRect(),deny=document.getElementById('consentDeny').getBoundingClientRect(),scroll=document.scrollingElement;return {viewportWidth:innerWidth,viewportHeight:innerHeight,scrollHeight:scroll.scrollHeight,scrollTop:scroll.scrollTop,horizontalOverflow:scroll.scrollWidth>innerWidth,initialButtonsVisible:accept.top>=0&&accept.bottom<=innerHeight&&deny.top>=0&&deny.bottom<=innerHeight,acceptTop:accept.top,acceptBottom:accept.bottom,overflowY:getComputedStyle(scroll).overflowY};})()`);
  /** @param {string} suffix @returns {Promise<void>} */
  async function screenshot(suffix) {
    const result = await consent.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    assert.equal(typeof result.data, 'string');
    assert(typeof result.data === 'string');
    fs.writeFileSync(path.join(temporary, `${kind}-consent-${suffix}.png`), Buffer.from(result.data, 'base64'));
  }
  await screenshot('initial');
  assert.equal(await consent.evaluate("(()=>{const buttons=['consentAccept','consentDeny'].map(id=>document.getElementById(id).getBoundingClientRect());return document.scrollingElement.scrollWidth<=innerWidth&&buttons.every(button=>button.top>=0&&button.bottom<=innerHeight);})()"), true, `${kind} confirmation must show both action buttons initially without horizontal clipping`);
  await consent.evaluate('window.scrollTo(0,document.scrollingElement.scrollHeight);true');
  const scrollResult = await consent.evaluate("(()=>{const button=document.getElementById('consentAccept').getBoundingClientRect();return {scrollTop:document.scrollingElement.scrollTop,buttonsAccessible:button.top>=0&&button.bottom<=innerHeight};})()");
  await screenshot('bottom');
  assert.equal(await consent.evaluate("(()=>{const button=document.getElementById('consentAccept').getBoundingClientRect(),last=document.getElementById('consentDetails').lastElementChild.getBoundingClientRect();return button.bottom<=innerHeight&&last.bottom<=innerHeight;})()"), true, `${kind} confirmation details and actions must remain reachable by scrolling`);
  consentLayouts.push({ kind, layout, scrollResult });
  console.log('CONSENT_LAYOUT ' + JSON.stringify({ kind, layout, scrollResult }));
  consent.close();
}

try {
  assert(process.env.SystemRoot);
  const powershell = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'test/server-trust-certificates.ps1')], { env: { ...process.env, DEEPSCORD_TEST_CERTIFICATES: temporary }, windowsHide: true, stdio: 'inherit' });
  assert.equal((await once(powershell, 'exit'))[0], 0);
  server.setSecureContext(fixture('self-a')); foreign.setSecureContext(fixture('self-b'));
  const origin = await listen(server); foreignOrigin = await listen(foreign);
  await launch();
  let connection = await connect(origin);
  await inspectConsent('certificate');
  await decide('consentDeny');
  await connection.wait('document.getElementById("connectionError")?.hidden===false');
  assert.equal(applicationRequests, 0); assert.equal(fs.existsSync(path.join(data, 'server-trust.json')), false);
  pass('Legacy trustedHosts cannot bypass trusted local TLS confirmation; deny sends no HTTP and saves no pin');
  await connection.evaluate("document.getElementById('serverConnectBtn').click();true");
  await decide('consentAccept'); connection.close();
  let room = await page(debug, origin); await room.wait('window.securityReady===true');
  assert(fs.existsSync(path.join(data, 'server-trust.json')));
  pass('Trusted native certificate acceptance loads the actual HTTPS room');
  assert.equal(await room.evaluate(`fetch(${JSON.stringify(foreignOrigin + '/blocked')}).then(()=>false,()=>true)`), true);
  assert.equal(foreignRequests, 0); pass('Cross-origin application requests are blocked before reaching the foreign TLS server');
  assert.equal(await room.evaluate("navigator.permissions.query({name:'microphone'}).then(value=>value.state)"), 'denied');
  await room.evaluate('window.requestMicrophone();true');
  await inspectConsent('microphone');
  await decide('consentDeny'); await room.wait("window.micResult!=='pending'");
  assert.notEqual(await room.evaluate('window.micResult'), 'granted'); pass('Real getUserMedia(audio) requires native local consent and refusal never grants access');
  await room.evaluate('window.requestMicrophone();true');
  const micConsent = await page(debug, consentUrl); await micConsent.evaluate('setTimeout(()=>window.close(),50);true'); micConsent.close();
  await room.wait("window.micResult!=='pending'"); assert.notEqual(await room.evaluate('window.micResult'), 'granted');
  pass('Closing the native microphone confirmation denies the pending request');
  await room.evaluate('window.requestMicrophone();true');
  const cancelledConsent = await page(debug, consentUrl); await cancelledConsent.wait("document.getElementById('consentAccept')?.disabled===false"); cancelledConsent.close();
  await room.send('Page.navigate', { url: origin + '/navigated' }); await room.wait("window.securityReady===true && location.pathname==='/navigated'"); await noConsent();
  assert.equal(await room.evaluate("navigator.permissions.query({name:'microphone'}).then(value=>value.state)"), 'denied');
  pass('Navigating while microphone consent is pending cancels the confirmation and leaves no grant');
  assert.notEqual(await room.evaluate("navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return 'granted';},error=>error.name)"), 'granted'); await noConsent();
  assert.equal(await room.evaluate("navigator.permissions.query({name:'camera'}).then(value=>value.state)"), 'denied');
  assert.equal(await room.evaluate("navigator.permissions.query({name:'clipboard-read'}).then(value=>value.state)"), 'denied');
  assert.notEqual(await room.evaluate("document.getElementById('sameFrame').contentWindow.navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return 'granted';},error=>error.name)"), 'granted'); await noConsent();
  pass('Camera, clipboard-read, and same-origin iframe microphone access are denied without implicit grant');
  await room.evaluate('window.requestMicrophone();true'); await decide('consentAccept'); await room.wait("window.micResult!=='pending'");
  const mediaResult = await room.evaluate('window.micResult');
  console.log('Real microphone permission result (tracks stopped immediately; no samples read): ' + mediaResult);
  if (mediaResult === 'granted') {
    assert.equal(await room.evaluate("navigator.permissions.query({name:'microphone'}).then(value=>value.state)"), 'granted');
    const documentId = await room.evaluate('window.securityDocument');
    await room.send('Page.reload', {}); await room.wait(`window.securityReady===true && window.securityDocument!==${JSON.stringify(documentId)}`);
    await room.evaluate('window.requestMicrophone();true'); await decide('consentDeny'); await room.wait("window.micResult!=='pending'");
    pass('Successful microphone grant is revoked on refresh and requires a new native confirmation');
  } else pass('Hardware/OS did not open microphone; successful permission lifetime remains hardware-limited');
  await room.send('Page.navigate', { url: origin + '/foreign-redirect' });
  const redirected = await page(debug, workspaceUrl); redirected.close(); room.close();
  assert.equal(foreignRequests, 0); pass('A same-origin HTTP response cannot redirect the desktop to a foreign origin');
  connection = await connect(origin); connection.close(); room = await page(debug, origin); await room.wait('window.securityReady===true');
  server.setSecureContext(fixture('self-b')); server.closeAllConnections();
  const beforeLiveChange = applicationRequests;
  await room.send('Page.navigate', { url: origin + '/changed-live' });
  const rejectedLive = await page(debug, workspaceUrl); rejectedLive.close(); room.close();
  assert.equal(applicationRequests, beforeLiveChange); pass('The actual Electron TLS verifier rejects a changed certificate after the room was already open');
  server.setSecureContext(fixture('self-a'));
  await stop(); await launch();
  connection = await connect(origin); room = await page(debug, origin); await room.wait('window.securityReady===true'); await noConsent(); connection.close();
  pass('Restarted production desktop reuses the persisted exact-origin certificate pin without confirmation');
  room.close(); await stop();
  server.setSecureContext(fixture('self-b')); const before = applicationRequests;
  await launch(); connection = await connect(origin);
  await connection.wait('document.getElementById("connectionError")?.hidden===false');
  assert.match(String(await connection.evaluate('document.getElementById("connectionError").textContent')), /Certificate changed/);
  assert.equal(applicationRequests, before); await noConsent(); connection.close();
  pass('Same-origin certificate replacement is refused before HTTP or page execution and cannot prompt replacement');
  fs.writeFileSync(path.join(temporary, 'report.json'), JSON.stringify({ checks, mediaResult, consentLayouts }, null, 2));
  console.log(`Native security checks: ${checks.length}; report: ${path.join(temporary, 'report.json')}`);
} finally {
  await stop(); server.closeAllConnections(); foreign.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  if (foreign.listening) await new Promise(resolve => foreign.close(resolve));
  console.log(`Isolated security artifacts: ${temporary}; runtime: ${runtime}`);
}
