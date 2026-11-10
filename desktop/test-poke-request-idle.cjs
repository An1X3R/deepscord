// @ts-check
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
/** @typedef {import('./poke-request.cjs').RequestState} RequestState */
/** @typedef {import('./poke-request.cjs').PokeDecision} PokeDecision */

/** @returns {Promise<void>} */
async function runNode() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  assert(binary, 'ELECTRON_TEST_BINARY must identify a real Electron runtime');
  const source = path.dirname(path.resolve(binary));
  const destination = fs.mkdtempSync(path.join(path.resolve(__dirname, '..', '.qa-tools'), 'poke-request-idle-'));
  const sourceApp = path.join(source, 'resources', 'app');
  fs.cpSync(source, destination, { recursive: true, filter: file => file !== sourceApp && !file.startsWith(sourceApp + path.sep) && file !== path.join(source, 'resources', 'app.asar') });
  const appDirectory = path.join(destination, 'resources', 'app');
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'poke-request-idle-test', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(appDirectory, 'main.cjs'), `require(${JSON.stringify(__filename)});`);
  /** @type {NodeJS.ProcessEnv} */
  const environment = { ...process.env, DEEPSCORD_REQUEST_IDLE_PROFILE: fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-request-idle-')) };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(destination, path.basename(binary)), [], { env: environment, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Poke request native test exceeded 85000 ms')); }, 85000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(undefined); else reject(new Error(`Poke request native test exited ${code}`)); });
  });
}

/** @param {Electron.BrowserWindow} popup @returns {Promise<void>} */
async function rendered(popup) {
  await popup.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 20))');
}
/** @param {Electron.BrowserWindow} popup @param {PokeDecision} decision @returns {Promise<void>} */
async function decide(popup, decision) {
  await popup.webContents.executeJavaScript(`window.pokeRequest.decide(${JSON.stringify(decision)})`);
}
/** @returns {Promise<void>} */
async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const profile = process.env.DEEPSCORD_REQUEST_IDLE_PROFILE;
  assert(profile); app.setPath('userData', profile);
  await app.whenReady();
  const poke = require('./poke-request.cjs');
  ipcMain.handle('poke-request:decision', poke.acceptPokeDecision);
  const owner = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('data:text/html,<!doctype html><title>Poke request lifecycle</title>');
  await owner.webContents.executeJavaScript('window.decisions=[]; window.deepscord.onScreenPokeDecision(value=>window.decisions.push(value)); undefined');
  const ownerEvents = ['focus', 'blur', 'minimize', 'restore', 'hide', 'show', 'closed'];
  const baseline = ownerEvents.map(event => owner.listenerCount(event));
  /** @type {RequestState} */
  const initial = { sessionId: 'idle-session', requests: [{ userId: 'peer-one', requestId: 'request-one', name: 'Native lifecycle test' }], canApprove: true };
  const empty = { ...initial, requests: [] };
  const firstDecision = { sessionId: initial.sessionId, userId: 'peer-one', requestId: 'request-one', approved: true };
  /** @returns {Electron.BrowserWindow} */
  function popup() { const win = BrowserWindow.getAllWindows().find(entry => entry !== owner); assert(win, 'A real request BrowserWindow must exist'); return win; }
  try {
    await Promise.all([poke.updatePokeRequests(owner.webContents, initial, null), poke.updatePokeRequests(owner.webContents, initial, null)]);
    const first = popup(); await rendered(first);
    assert(first.isVisible()); assert(first.getNativeWindowHandle().byteLength > 0);
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'Concurrent updates must share one popup');
    await first.webContents.executeJavaScript('document.querySelector("[data-testid=poke-native-approve]").click()');
    await delay(100);
    assert.deepEqual(await owner.webContents.executeJavaScript('window.decisions'), [firstDecision]);
    assert(!first.isVisible()); assert(!first.isDestroyed());
    await poke.updatePokeRequests(owner.webContents, initial, null);
    await rendered(first);
    assert.equal(await first.webContents.executeJavaScript('document.querySelectorAll("[data-request-id]").length'), 0, 'Answered requests must remain deduplicated');

    const second = { ...initial, requests: [{ userId: 'peer-two', requestId: 'request-two', name: 'Approval disabled' }], canApprove: false };
    await poke.updatePokeRequests(owner.webContents, second, null); await rendered(first);
    assert.equal(popup(), first, 'A prompt inside the idle grace period must reuse the window');
    assert(first.isVisible());
    assert(await first.webContents.executeJavaScript('document.querySelector("[data-testid=poke-native-approve]").disabled'));
    const secondDecision = { sessionId: initial.sessionId, userId: 'peer-two', requestId: 'request-two', approved: true };
    await assert.rejects(decide(first, secondDecision), /approval is currently unavailable/);
    await first.webContents.executeJavaScript('document.querySelector("[data-testid=poke-native-reject]").click()');
    await delay(100);
    assert.deepEqual(await owner.webContents.executeJavaScript('window.decisions'), [firstDecision, { ...secondDecision, approved: false }]);

    const canceled = { ...initial, requests: [{ userId: 'peer-three', requestId: 'request-three', name: 'Canceled request' }] };
    await poke.updatePokeRequests(owner.webContents, canceled, null);
    await poke.updatePokeRequests(owner.webContents, empty, null);
    assert(!first.isVisible()); assert(!first.isDestroyed());
    await assert.rejects(decide(first, { sessionId: initial.sessionId, userId: 'peer-three', requestId: 'request-three', approved: true }), /expired or was already answered/);
    const idleStarted = Date.now();
    await delay(1000);
    await poke.updatePokeRequests(owner.webContents, empty, null);
    console.log('Native request popup hidden; waiting for the real 30-second idle release');
    await delay(29500);
    assert(first.isDestroyed(), 'Repeated empty updates and owner events must not postpone idle release');
    assert(Date.now() - idleStarted >= 30000);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await poke.updatePokeRequests(owner.webContents, initial, null);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'Releasing the window must retain answered-request deduplication');

    const expiring = { ...initial, requests: [{ userId: 'peer-four', requestId: 'request-four', name: 'Expiring request' }] };
    await Promise.all([poke.updatePokeRequests(owner.webContents, expiring, null), poke.updatePokeRequests(owner.webContents, expiring, null)]);
    const recreated = popup(); await rendered(recreated);
    assert.notEqual(recreated.id, first.id); assert(recreated.isVisible());
    assert.equal(await recreated.webContents.executeJavaScript('document.querySelectorAll("[data-request-id=request-four]").length'), 1);
    console.log('Native request popup recreated; waiting for the real 30-second request expiry');
    await delay(30500);
    assert(!recreated.isVisible()); assert(!recreated.isDestroyed());
    await assert.rejects(decide(recreated, { sessionId: initial.sessionId, userId: 'peer-four', requestId: 'request-four', approved: true }), /expired or was already answered/);
    await poke.updatePokeRequests(owner.webContents, expiring, null);
    assert(!recreated.isVisible(), 'Expired requests must remain deduplicated');
    poke.disposePokeRequests();
    assert(recreated.isDestroyed());
    assert.deepEqual(ownerEvents.map(event => owner.listenerCount(event)), baseline, 'Session disposal must remove all owner listeners');
    await poke.updatePokeRequests(owner.webContents, initial, null);
    const finalPopup = popup(); assert(finalPopup.isVisible(), 'A new session must reset request history');
    owner.destroy();
    assert(finalPopup.isDestroyed(), 'Closing the owner must dispose the popup immediately');
    console.log('Native request lifecycle passed: approval, rejection, cancellation, idle release, recreation, deduplication, expiry and owner cleanup');
  } finally {
    poke.disposePokeRequests(); ipcMain.removeHandler('poke-request:decision');
    if (!owner.isDestroyed()) owner.destroy();
  }
  app.exit(0);
}
if (process.versions.electron) runElectron().catch(error => { console.error(error); require('electron').app.exit(1); });
else runNode().catch(error => { console.error(error); process.exitCode = 1; });
