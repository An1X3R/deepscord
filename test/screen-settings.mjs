// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectPage, waitForPort } from './cdp.mjs';
import { DEFAULT_SCREEN_PREFERENCES, getScreenPreferences, parseScreenPreferences, screenCaptureTarget, screenEncodingPolicy } from '../public/js/screen-preferences.js';
import { createClientPreferences } from '../desktop/client-preferences.cjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {Awaited<ReturnType<typeof connectPage>>} Page */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} parent @param {string} target @returns {boolean} */
function under(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** @returns {string} */
function prepareRuntime() {
  const source = process.env.ELECTRON_TEST_BINARY;
  assert(source, 'Set ELECTRON_TEST_BINARY to a real Electron executable.');
  const executable = path.resolve(source); assert(fs.statSync(executable).isFile());
  const directory = path.dirname(executable);
  const runtime = path.join(root, '.qa-tools', 'screen-settings-runtime');
  assert(directory !== runtime && !under(directory, runtime) && !under(runtime, directory), 'Runtime source/destination overlap.');
  const marker = path.join(runtime, '.screen-settings-owner.json');
  const identity = JSON.stringify({ owner: 'deepscord-screen-settings', executable, modified: fs.statSync(executable).mtimeMs });
  if (fs.existsSync(runtime)) assert.equal(fs.readFileSync(marker, 'utf8'), identity, 'Existing test runtime ownership differs.');
  else {
    const app = path.join(directory, 'resources', 'app');
    const asar = path.join(directory, 'resources', 'app.asar');
    fs.cpSync(directory, runtime, { recursive: true, filter: (entry) => entry !== app && !under(app, entry) && entry !== asar });
    fs.writeFileSync(marker, identity);
  }
  const entry = path.join(runtime, 'resources', 'app'); fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'deepscord-screen-settings', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(entry, 'main.cjs'), "'use strict';const {app,BrowserWindow}=require('electron');require(" + JSON.stringify(path.join(root, 'desktop', 'main.js')) + ");app.whenReady().then(()=>{const browser=new BrowserWindow({show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});browser.webContents.setAudioMuted(true);return browser.loadURL(process.env.DEEPSCORD_SETTINGS_BROWSER_URL);}).catch(error=>{console.error(error);app.exit(1);});");
  return path.join(runtime, path.basename(executable));
}

/** @returns {Promise<number>} */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
  return port;
}

/** @param {Page} page @returns {Promise<void>} */
async function enterRoom(page) {
  await page.waitFor("!!document.getElementById('welcomeNameInput') || window.echo?.getState().roomReady===true", { timeout: 12000, interval: 100, label: 'actual app welcome or connected identity' });
  if (await page.eval("!!document.getElementById('welcomeNameInput')")) {
    await page.eval("document.getElementById('welcomeNameInput').value='Screen settings';document.getElementById('welcomeEnterBtn').click()");
  }
  await page.waitFor("window.echo?.getState().roomReady===true && !document.getElementById('welcomeNameInput')", { timeout: 15000, interval: 100, label: 'actual app connected without microphone capture' });
}

/** @param {number} debug @param {string} browserUrl @returns {Promise<Page>} */
async function desktopRoomPage(debug, browserUrl) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${debug}/json/list`);
    assert(response.ok, 'Desktop debugger target list failed: ' + response.status);
    /** @type {JsonValue} */ const targets = await response.json();
    assert(Array.isArray(targets), 'Desktop debugger targets must be an array.');
    for (const target of targets) {
      assert(target !== null && typeof target === 'object' && !Array.isArray(target), 'Desktop debugger target must be an object.');
      if (target.type === 'page' && typeof target.url === 'string' && target.url.startsWith('http://127.0.0.1:') && target.url !== browserUrl) return connectPage(debug, target.url);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production desktop room client did not appear: debugger=${debug}, browserUrl=${browserUrl}`);
}

/** @param {Page} page @returns {Promise<void>} */
async function openSettings(page) {
  await page.eval("document.getElementById('railSettingsBtn').click()");
  await page.waitFor("!!document.getElementById('screenTransmissionSettings')", { timeout: 5000, interval: 100, label: 'integrated screen settings' });
  await page.waitFor("getComputedStyle(document.getElementById('modalRoot').lastElementChild).opacity==='1'", { timeout: 5000, interval: 100, label: 'actual modal entry finished' });
  await page.eval("Promise.all(document.getElementById('modalRoot').getAnimations({subtree:true}).map(animation=>animation.finished)).then(()=>true)");
}

/** @param {Page} page @param {string} id @param {string} value @returns {Promise<void>} */
async function changeNumber(page, id, value) {
  await page.eval(`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

/** @param {Page} page @returns {Promise<void>} */
async function saved(page) {
  await page.waitFor("document.getElementById('screenPreferencesStatus').dataset.state==='saved'", { timeout: 10000, interval: 100, label: 'real persistent preference and engine application completed' });
}

/** @param {Page} page @param {string} filename @returns {Promise<void>} */
async function screenshot(page, filename) {
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null;
  try {
    await Promise.race([page.screenshot(filename), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Actual compositor screenshot exceeded 10000ms: ' + filename)), 10000);
    })]);
  } finally { if (timer !== null) clearTimeout(timer); }
}

/** @param {import('node:child_process').ChildProcess} child @returns {Promise<void>} */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owned settings-test child did not exit: pid=${child.pid}`)), 10000);
    child.once('exit', () => { clearTimeout(timer); resolve(undefined); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    if (!child.kill()) { clearTimeout(timer); reject(new Error(`Could not stop owned settings-test child: pid=${child.pid}`)); }
  });
}

assert.deepEqual(getScreenPreferences({}, true), DEFAULT_SCREEN_PREFERENCES);
assert.equal(getScreenPreferences({}, false).relayEnabled, false);
assert.deepEqual(getScreenPreferences({ screenPreferences: { uploadLimitMbps: 20 } }, true), { ...DEFAULT_SCREEN_PREFERENCES, uploadLimitMbps: 20 });
assert.deepEqual(parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, unrelated: 'strip' }), DEFAULT_SCREEN_PREFERENCES);
assert.deepEqual(parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, playbackBufferSeconds: 10 }), DEFAULT_SCREEN_PREFERENCES);
assert.deepEqual(getScreenPreferences({ screenPreferences: { ...DEFAULT_SCREEN_PREFERENCES, playbackBufferSeconds: 10 } }, true), DEFAULT_SCREEN_PREFERENCES);
assert.deepEqual(getScreenPreferences({ screenPreferences: { playbackBufferSeconds: 10 } }, true), DEFAULT_SCREEN_PREFERENCES);
const versionTwo = { version: 2, uploadLimitMbps: 34, relayEnabled: false, screenBitrateMbps: 6.5, screenResolution: 1440, screenFrameRate: 60, playbackBufferSeconds: 10 };
assert.deepEqual(getScreenPreferences({ screenPreferences: versionTwo }, true), {
  version: 3, uploadLimitMbps: 34, relayEnabled: false, screenBitrateMbps: 6.5, screenResolution: 1440, screenFrameRate: 60, screenContentMode: 'motion',
});
assert.equal(Object.hasOwn(getScreenPreferences({ screenPreferences: versionTwo }, true), 'playbackBufferSeconds'), false);
assert.throws(() => parseScreenPreferences(versionTwo), TypeError);
const { screenContentMode: omittedMode, ...missingMode } = DEFAULT_SCREEN_PREFERENCES;
assert.equal(omittedMode, 'motion');
assert.throws(() => parseScreenPreferences(missingMode), TypeError);
for (const screenContentMode of ['', 'text', false, null, 1]) {
  assert.throws(() => parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, screenContentMode }), TypeError);
}
assert.deepEqual(screenEncodingPolicy('motion'), { contentHint: 'motion', degradationPreference: 'maintain-framerate' });
assert.deepEqual(screenEncodingPolicy('detail'), { contentHint: 'detail', degradationPreference: 'maintain-resolution' });
// @ts-expect-error Verify the runtime boundary rejects an invalid mode.
assert.throws(() => screenEncodingPolicy('text'), TypeError);
assert.equal(parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, screenContentMode: 'detail' }).screenContentMode, 'detail');
assert.equal(Object.hasOwn(parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, playbackBufferSeconds: 10 }), 'playbackBufferSeconds'), false);
for (const value of [0, 1001, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
  assert.throws(() => parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, uploadLimitMbps: value }), RangeError);
}
for (const value of [0.29, 40.01, Number.NaN, '2.5', null]) {
  assert.throws(() => parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, screenBitrateMbps: value }), RangeError);
}
assert.throws(() => parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, relayEnabled: 'true' }), TypeError);
assert.throws(() => getScreenPreferences({ screenPreferences: null }, true), TypeError);
assert.deepEqual(getScreenPreferences({ screenPreferences: { uploadLimitMbps: 20, screenBitrateMbps: 8, relayEnabled: true } }, true), { ...DEFAULT_SCREEN_PREFERENCES, uploadLimitMbps: 20, screenBitrateMbps: 8 });
assert.throws(() => getScreenPreferences({ screenPreferences: { version: 3 } }, true), TypeError);
assert.throws(() => getScreenPreferences({ screenPreferences: { ...DEFAULT_SCREEN_PREFERENCES, version: 4 } }, true), TypeError);
assert.throws(() => getScreenPreferences({ screenPreferences: { version: 2 } }, true), RangeError);
for (const screenResolution of [0, 719, 4320, '1080', null]) assert.throws(() => parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, screenResolution }), RangeError);
for (const screenFrameRate of [0, 25, 120, '60', null]) assert.throws(() => parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, screenFrameRate }), RangeError);
for (const screenResolution of /** @type {const} */ ([480, 720, 1080, 1440, 2160])) {
  assert.equal(screenCaptureTarget({ ...DEFAULT_SCREEN_PREFERENCES, screenResolution }).height, screenResolution);
}

const preferenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-preference-migration-'));
const preferenceFile = path.join(preferenceDirectory, 'client-preferences.json');
const clientSettings = { peerVolumes: {}, color: '#7c6cf5', inputDeviceId: 'default', outputDeviceId: 'default', micVolume: 100, outVolume: 100, radioVolume: 10,
  mode: 'vad', pttKey: 'KeyV', vadThreshold: -42, echoCancellation: true, noiseSuppression: true, autoGainControl: true, monitor: false,
  sounds: true, interactionSounds: true, interactionVolume: 20, membersOpen: true, screenPreferences: versionTwo };
try {
  fs.writeFileSync(preferenceFile, JSON.stringify({ version: 1, settings: clientSettings, lastChannel: null }));
  const clientPreferences = createClientPreferences(preferenceDirectory);
  const migrated = clientPreferences.read();
  assert(migrated.settings);
  assert.deepEqual(migrated.settings.screenPreferences, getScreenPreferences({ screenPreferences: versionTwo }, true));
  assert.throws(() => clientPreferences.saveSettings(clientSettings), TypeError, 'Writes require current version preferences.');
  clientPreferences.saveSettings(migrated.settings);
  assert.deepEqual(clientPreferences.read(), migrated);
  fs.writeFileSync(preferenceFile, JSON.stringify({ version: 1, settings: { ...clientSettings, screenPreferences: missingMode }, lastChannel: null }));
  assert.throws(() => clientPreferences.read(), TypeError, 'Corrupt current version preferences must not receive migration defaults.');
} finally {
  fs.unlinkSync(preferenceFile);
  fs.rmdirSync(preferenceDirectory);
}

const executable = prepareRuntime();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-screen-settings-'));
const output = path.join(root, '.qa-tools', 'results', 'screen-settings'); fs.mkdirSync(output, { recursive: true });
const port = await freePort(); const debug = await freePort();
const base = 'http://127.0.0.1:' + port;
const browserUrl = base + '/?screen-settings-browser=1';
const data = path.join(temporary, 'client'); fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ autoConnect: false }));
fs.writeFileSync(path.join(data, 'desktop-settings.json'), JSON.stringify({ muteShortcut: 'Control+Alt+Shift+F9', overlay: { enabled: false, locked: true, x: 24, y: 80, width: 280, height: 300, scale: 1 } }));
const server = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port), HTTPS_PORTS: '0', HTTP_HOST: '127.0.0.1', ECHO_DATA_DIR: path.join(temporary, 'server'), ECHO_MEDIA_POLICY: 'direct', ECHO_NETWORK_MODE: 'server', ECHO_PASSWORD: '' } });
let serverLog = ''; server.stdout.on('data', (chunk) => { serverLog += String(chunk); }); server.stderr.on('data', (chunk) => { serverLog += String(chunk); });
/** @type {import('node:child_process').ChildProcess|null} */ let client = null;
/** @type {Page|null} */ let page = null;
/** @type {Page|null} */ let browser = null;
/** @type {string[]} */ const errors = [];
let clientLog = '';
try {
  const deadline = Date.now() + 12000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try { ready = (await fetch(base + '/api/health')).ok; }
    catch (error) { if (!(error instanceof TypeError)) throw error; console.warn('settings_test_server_pending', { message: error.message }); }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(ready, serverLog);
  /** @type {NodeJS.ProcessEnv} */ const environment = { ...process.env, DEEPSCORD_USER_DATA: data, DEEPSCORD_SETTINGS_BROWSER_URL: browserUrl };
  delete environment.ELECTRON_RUN_AS_NODE;
  client = spawn(executable, [`--remote-debugging-port=${debug}`, '--mute-audio'], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  client.stderr?.on('data', (chunk) => { clientLog += String(chunk); });
  client.stdout?.on('data', (chunk) => { clientLog += String(chunk); });
  await waitForPort(debug, 20000);
  page = await connectPage(debug, pathToFileURL(path.join(root, 'desktop', 'workspace.html')).href);
  await page.waitFor("!!document.getElementById('savedRoomList')", { timeout: 10000, interval: 100, label: 'production desktop workspace' });
  await page.eval(`void window.deepscord.connect(${JSON.stringify(base + '/')})`, { awaitPromise: false, userGesture: true });
  page.close();
  page = await desktopRoomPage(debug, browserUrl);
  await page.send('Runtime.enable', {});
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  page.on('Runtime.exceptionThrown', /** @param {JsonValue} event */ (event) => errors.push(JSON.stringify(event)));
  await enterRoom(page); await openSettings(page);
  const nativeAvailable = await page.eval("typeof window.deepscord?.screenRelayOffer==='function'");
  assert.equal(nativeAvailable, true, 'The actual desktop bridge must expose screenRelayOffer; a browser-only success cannot verify desktop contribution defaults.');
  assert.equal(await page.eval("document.getElementById('screenUploadLimitMbps').value"), '10');
  assert.equal(await page.eval("document.getElementById('screenPlaybackBufferSeconds')===null"), true);
  assert.equal(await page.eval("document.getElementById('screenBitrateMbps').value"), '2.5');
  assert.equal(await page.eval("document.getElementById('screenResolution').value"), '720');
  assert.equal(await page.eval("document.getElementById('screenFrameRate').value"), '30');
  assert.equal(await page.eval("document.getElementById('screenContentMode').value"), 'motion');
  assert.equal(await page.eval("document.getElementById('screenContentMode').getAttribute('aria-describedby')"), 'screenContentModeHint');
  assert.equal(await page.eval("Array.from(document.getElementById('screenContentMode').options,option=>option.textContent).join('|')"), '流畅优先|细节优先');
  assert.equal(await page.eval("document.getElementById('screenRelayEnabled').disabled"), !nativeAvailable);
  assert.equal(await page.eval("document.getElementById('screenRelayEnabled').checked"), nativeAvailable);
  await changeNumber(page, 'screenUploadLimitMbps', '24.5'); await saved(page);
  await changeNumber(page, 'screenBitrateMbps', '1.8'); await saved(page);
  await changeNumber(page, 'screenResolution', '1440'); await saved(page);
  await changeNumber(page, 'screenFrameRate', '60'); await saved(page);
  assert.equal(await page.eval("(()=>{const input=document.getElementById('screenContentMode');input.value='detail';input.dispatchEvent(new Event('change',{bubbles:true}));return input.disabled&&document.getElementById('screenTransmissionSettings').getAttribute('aria-busy')==='true';})()"), true);
  await saved(page);
  assert.equal(await page.eval("document.getElementById('screenContentMode').disabled"), false);
  await page.eval("document.getElementById('screenContentMode').focus()");
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  await saved(page);
  assert.equal(await page.eval("document.getElementById('screenContentMode').value"), 'motion');
  await changeNumber(page, 'screenContentMode', 'detail'); await saved(page);
  assert.match(String(await page.eval("document.getElementById('screenPreferencesStatus').textContent")), /重新分享后生效/);
  const persisted = await page.eval("JSON.parse(localStorage.getItem('echo.settings')).screenPreferences");
  assert.deepEqual(persisted, { ...DEFAULT_SCREEN_PREFERENCES, uploadLimitMbps: 24.5, screenBitrateMbps: 1.8, screenResolution: 1440, screenFrameRate: 60, screenContentMode: 'detail' });
  await changeNumber(page, 'screenUploadLimitMbps', '0');
  assert.equal(await page.eval("document.getElementById('screenPreferencesStatus').dataset.state"), 'error');
  assert.equal(await page.eval("JSON.parse(localStorage.getItem('echo.settings')).screenPreferences.uploadLimitMbps"), 24.5);
  await changeNumber(page, 'screenUploadLimitMbps', '24.5'); await saved(page);
  await page.eval("document.getElementById('screenTransmissionSettings').scrollIntoView({block:'center'})");
  await screenshot(page, path.join(output, 'desktop.png'));
  if (nativeAvailable) {
    await page.eval("document.getElementById('screenRelayEnabled').click()"); await saved(page);
    assert.equal(await page.eval("JSON.parse(localStorage.getItem('echo.settings')).screenPreferences.relayEnabled"), false);
    await page.eval("document.getElementById('screenRelayEnabled').click()"); await saved(page);
  }
  await page.eval("document.getElementById('audioSettingsDone').click()");
  await page.waitFor("!document.getElementById('screenTransmissionSettings')", { timeout: 3000, interval: 100, label: 'settings closed' });
  await openSettings(page);
  assert.equal(await page.eval("document.getElementById('screenUploadLimitMbps').value"), '24.5');
  assert.equal(await page.eval("document.getElementById('screenBitrateMbps').value"), '1.8');
  assert.equal(await page.eval("document.getElementById('screenResolution').value"), '1440');
  assert.equal(await page.eval("document.getElementById('screenFrameRate').value"), '60');
  assert.equal(await page.eval("document.getElementById('screenContentMode').value"), 'detail');
  browser = await connectPage(debug, browserUrl);
  await browser.send('Runtime.enable', {});
  await browser.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  browser.on('Runtime.exceptionThrown', /** @param {JsonValue} event */ (event) => errors.push(JSON.stringify(event)));
  await enterRoom(browser);
  await browser.eval(`(()=>{const settings=JSON.parse(localStorage.getItem('echo.settings'));settings.screenPreferences=${JSON.stringify({ ...versionTwo, relayEnabled: true })};localStorage.setItem('echo.settings',JSON.stringify(settings));})()`);
  await browser.send('Page.reload', { ignoreCache: true });
  await enterRoom(browser); await openSettings(browser);
  assert.equal(await browser.eval("typeof window.deepscord"), 'undefined');
  assert.equal(await browser.eval("document.getElementById('screenContentMode').value"), 'motion');
  assert.equal(await browser.eval("document.getElementById('screenResolution').value"), '1440');
  assert.equal(await browser.eval("document.getElementById('screenFrameRate').value"), '60');
  assert.equal(await browser.eval("document.getElementById('screenBitrateMbps').value"), '6.5');
  assert.equal(await browser.eval("document.getElementById('screenRelayEnabled').disabled"), true);
  assert.equal(await browser.eval("document.getElementById('screenRelayEnabled').checked"), false);
  await changeNumber(browser, 'screenUploadLimitMbps', '18'); await saved(browser);
  assert.equal(await browser.eval("JSON.parse(localStorage.getItem('echo.settings')).screenPreferences.version"), 3);
  assert.equal(await browser.eval("Object.hasOwn(JSON.parse(localStorage.getItem('echo.settings')).screenPreferences,'playbackBufferSeconds')"), false);
  assert.equal(await browser.eval("JSON.parse(localStorage.getItem('echo.settings')).screenPreferences.relayEnabled"), true);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await browser.eval("document.getElementById('screenTransmissionSettings').scrollIntoView({block:'center'})");
  assert.equal(await browser.eval("(()=>{const section=document.getElementById('screenTransmissionSettings');return section.scrollWidth<=section.clientWidth;})()"), true);
  await screenshot(browser, path.join(output, 'browser-narrow.png'));
  assert.deepEqual(errors, [], 'Actual app raised runtime errors: ' + errors.join('\n'));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ nativeAvailable, parserBoundariesChecked: true,
    realDesktopAndBrowser: true, noFakeDevices: true, noVoiceJoinOrCapture: true, persisted, errors, serverLog, clientLog }, null, 2));
} catch (error) {
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), errors, serverLog, clientLog }, null, 2));
  throw error;
} finally {
  page?.close(); browser?.close();
  if (client) await stopChild(client);
  await stopChild(server);
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('deepscord-screen-settings-'));
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(JSON.stringify({ status: 'passed', output }));
