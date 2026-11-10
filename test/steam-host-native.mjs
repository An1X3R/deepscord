// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { connectPage, waitForPort, sleep } from './cdp.mjs';
import steamState from '../lib/steam-state.cjs';
import {createSteamMedia,verifyReopenedSteamMedia} from './steam-host-media-ui.mjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{id:string,roomId:string|null,creatorKey:string|null,document:import('../lib/room-replica.cjs').RoomDocument|null}} PublicEntry */
/** @param {string} file @returns {PublicEntry[]} */
function publicWorkspace(file) {
  /** @type {JsonValue} */ const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(value !== null && typeof value === 'object' && !Array.isArray(value) && value.version === 1 && Array.isArray(value.entries) && value.entries.length <= 128);
  return value.entries.map(entry => {
    assert(entry !== null && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string');
    if (entry.document === null && entry.roomId === null && entry.creatorKey === null) return { id: entry.id, roomId: null, creatorKey: null, document: null };
    const seed = steamState.parseSteamRoomSeed({ roomId: entry.roomId, creatorKey: entry.creatorKey, document: entry.document });
    return { id: entry.id, ...seed };
  });
}

/** @param {string} file @param {number} previousRevision @returns {Promise<PublicEntry>} */
async function waitCommittedRoom(file, previousRevision) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const entry = fs.existsSync(file) ? publicWorkspace(file).find(value => value.document && value.document.revision > previousRevision) : undefined;
    if (entry) return entry;
    await sleep(50);
  }
  throw new Error(`Actual workspace commit did not advance beyond revision ${previousRevision}`);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.DEEPSCORD_ELECTRON_RUNTIME;
assert.ok(source && fs.statSync(source).isFile(), 'Set DEEPSCORD_ELECTRON_RUNTIME to the approved Electron executable');
const directory = path.join(root, '.qa-tools', 'host-continuity', 'steam-host-native', randomUUID());
const runtime = path.join(directory, 'runtime');
const runtimeApp = path.join(runtime, 'resources', 'app');
const userData = path.join(directory, 'user-data');
const logPath = path.join(directory, 'native.log');
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'desktop-settings.json'), JSON.stringify({ muteShortcut: 'Control+Alt+Shift+F23', overlay: { enabled: false, locked: true, x: 24, y: 80, width: 280, height: 300, scale: 1 } }));
/** @param {string} filename @returns {string} */
const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const sourceFiles = ['desktop/steam-client.cjs', 'desktop/steam-room.cjs', 'desktop/steam-admission.cjs', 'desktop/steam-wire.cjs', 'desktop/steam-continuity.cjs', 'server.js', 'lib/steam-state.cjs', 'public/js/app.js'];
const startHashes = Object.fromEntries(sourceFiles.map(filename => [filename, hash(path.join(root, filename))]));
const oldApp = path.join(path.dirname(source), 'resources', 'app');
const oldAsar = path.join(path.dirname(source), 'resources', 'app.asar');
/** @param {string} parent @param {string} value @returns {boolean} */
const under = (parent, value) => value === parent || value.startsWith(parent + path.sep);
fs.cpSync(path.dirname(source), runtime, { recursive: true, filter: filename => !under(oldApp, filename) && filename !== oldAsar });
fs.cpSync(path.join(root, 'desktop'), runtimeApp, { recursive: true });
const serverDirectory = path.join(runtimeApp, 'app-server');
fs.mkdirSync(serverDirectory, { recursive: true });
fs.copyFileSync(path.join(root, 'server.js'), path.join(serverDirectory, 'server.js'));
for (const name of ['lib', 'public']) fs.cpSync(path.join(root, name), path.join(serverDirectory, name), { recursive: true });
const runtimeHashes=Object.fromEntries(sourceFiles.map(filename=>[filename,hash(path.join(runtimeApp,filename.startsWith('desktop/') ? filename.slice('desktop/'.length) : 'app-server/'+filename))]));
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const address = listener.address();
assert.ok(address && typeof address !== 'string');
const port = address.port;
listener.close();
await once(listener, 'close');
/** @type {NodeJS.ProcessEnv} */ const environment = { ...process.env, DEEPSCORD_USER_DATA: userData };
delete environment.ELECTRON_RUN_AS_NODE;
const log = fs.openSync(logPath, 'w');
let child = spawn(path.join(runtime, path.basename(source)), [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env: environment, windowsHide: true, stdio: ['ignore', log, log] });
let exited = once(child, 'exit');
const checks = [];
let page = null;
let failure = null;
let normalExit = false;
/** @type {JsonValue} */let failureDiagnostic=null;
/** @type {import('./steam-host-media-ui.mjs').SteamMediaEvidence|null} */let mediaEvidence=null;
try {
  await waitForPort(port, 15000);
  page = await connectPage(port, 'file:');
  await page.waitFor('location.pathname.endsWith("/workspace.html") && typeof window.deepscord?.createSteam === "function"', { timeout: 10000, interval: 100, label: 'actual persistent workspace main frame ready' });
  const creation = await page.eval('window.deepscord.createSteam({appId:480,stunUrls:[]})', { awaitPromise: true, userGesture: true });
  assert.equal(creation.ok, true, creation.error);
  checks.push('production launcher creates an actual Steam lobby and local migration-capable backend');
  await page.eval('void window.deepscord.enterSteam()', { awaitPromise: false, userGesture: true });
  page.close();
  page = await connectPage(port, 'http://127.0.0.1:');
  await page.waitFor('!!document.getElementById("welcomeNameInput")', { timeout: 15000, interval: 100, label: 'Steam invitation room welcome' });
  await page.eval('document.getElementById("welcomeNameInput").value="Steam continuity host smoke";document.getElementById("welcomeEnterBtn").click()', { awaitPromise: true, userGesture: true });
  await page.waitFor('window.echo && window.echo.getState().roomReady === true', { timeout: 15000, interval: 100, label: 'Steam bridge authenticated hello' });
  const first = await page.eval('window.echo.getState()', { awaitPromise: true, userGesture: true });
  assert.match(first.selfId, /^u_steam_[1-9][0-9]{15,19}$/);
  assert.equal(first.users.length, 1);
  assert.equal(first.users[0].id, first.selfId);
  assert.equal(first.users[0].signalConnected, true);
  checks.push('native bridge hello yields a stable Steam-derived user identity');
  assert.equal(first.mediaPolicy, 'direct');
  assert.equal((await page.eval('window.deepscord.getSteamSession()', { awaitPromise: true, userGesture: true })).role, 'host');
  assert.equal(await page.eval('location.hash', { awaitPromise: true, userGesture: true }), '');
  assert.equal(await page.eval('localStorage.getItem("echo.password")', { awaitPromise: true, userGesture: true }), null);
  checks.push('Steam room identity is admitted without retaining the invitation secret in URL or local storage');
  const initialCount = first.messageCounts['ch-chat'];
  await page.eval('window.echo.actions.selectChannel("ch-chat");window.echo.actions.sendMessage("Steam host continuity native smoke")', { awaitPromise: true, userGesture: true });
  await page.waitFor(`window.echo.getState().messageCounts["ch-chat"] === ${initialCount + 1}`, { timeout: 5000, interval: 100, label: 'Steam bridge chat command round trip' });
  checks.push('real local room command and state broadcast round trip succeeds');
  mediaEvidence=await createSteamMedia(page,directory,userData);
  checks.push('actual transparent AVIF image and signed server sticker upload through production UI into persistent room-scoped storage');
  checks.push('single-account actual Steam room socket and UI report waiting with one durable copy, never synced');
  const workspaceFile = path.join(userData, 'workspace.json');
  const initialCommit = await waitCommittedRoom(workspaceFile, -1);
  assert(initialCommit.document);
  await page.eval('window.__steamHostReloadMarker=true', { awaitPromise: true, userGesture: true });
  await page.send('Page.reload');
  await page.waitFor('!window.__steamHostReloadMarker && window.echo && window.echo.getState().roomReady === true', { timeout: 15000, interval: 100, label: 'same-account page reload hello' });
  const reloaded = await page.eval('window.echo.getState()', { awaitPromise: true, userGesture: true });
  assert.equal(reloaded.selfId, first.selfId);
  assert.equal(reloaded.users.filter(/** @param {{signalConnected:boolean}} user */ user => user.signalConnected).length, 1);
  assert.equal(reloaded.messageCounts['ch-chat'], initialCount + 3);
  checks.push('page refresh preserves the Steam user identity and history without duplicate active users');
  await waitCommittedRoom(workspaceFile, initialCommit.document.revision);
  checks.push('actual creator synchronization commits after page reload before structural editing');
  await page.eval('window.echo.actions.openEditChannel("ch-lobby")', { awaitPromise: true, userGesture: true });
  await page.waitFor('!!document.getElementById("editChannelNameInput") && !!document.getElementById("editChannelLimitInput")', { timeout: 5000, interval: 100, label: 'stable-ID actual channel editor' });
  await page.eval('document.getElementById("editChannelNameInput").value="Persisted Steam";document.getElementById("editChannelLimitInput").value="6";document.getElementById("editChannelSaveBtn").click()', { awaitPromise: true, userGesture: true });
  await page.waitFor('window.echo.getState().servers.some(s=>s.channels.some(c=>c.id==="ch-lobby"&&c.name==="Persisted Steam"&&c.userLimit===6))', { timeout: 8000, interval: 100, label: 'real Steam command commits channel structure' });
  /** @type {PublicEntry|null} */ let saved = null;
  const savedDeadline = Date.now() + 5000;
  while (Date.now() < savedDeadline) {
    saved = publicWorkspace(workspaceFile).find(entry => entry.document?.servers.some(server => server.channels.some(channel => channel.id === 'ch-lobby' && channel.name === 'Persisted Steam' && channel.userLimit === 6))) ?? null;
    if (saved) break;
    await sleep(50);
  }
  assert(saved?.roomId && saved.creatorKey && saved.document);
  const publicSaved = { id: saved.id, roomId: saved.roomId, creatorKey: saved.creatorKey, document: saved.document };
  fs.writeFileSync(path.join(directory, 'saved-public-room.json'), JSON.stringify(publicSaved, null, 2));
  checks.push('actual Steam channel edit reaches the disk workspace with stable room and creator anchors');
  const voice = await page.eval('window.echo.getVoiceStats()', { awaitPromise: true, userGesture: true });
  assert.equal(voice.micReady, false);
  assert.equal(voice.channelId, null);
  checks.push('host admission and refresh use no user microphone or media capture');
  const rooms = path.join(userData, 'steam-rooms');
  assert.equal(fs.readdirSync(rooms).length, 1);
  page.send('Runtime.evaluate', { expression: 'window.deepscord.quit()', userGesture: true }).catch(error => console.warn('Native quit response unavailable', { message: error.message }));
  await Promise.race([exited, sleep(10000).then(() => { if (child.exitCode === null) throw new Error('Owned Steam host client did not quit'); })]);
  assert.equal(fs.readdirSync(rooms).length, 0);
  page.close(); page = null;
  child = spawn(path.join(runtime, path.basename(source)), [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env: environment, windowsHide: true, stdio: ['ignore', log, log] });
  exited = once(child, 'exit');
  await waitForPort(port, 15000); page = await connectPage(port, 'file:');
  await page.waitFor('location.pathname.endsWith("/workspace.html") && typeof window.deepscord?.reopenSavedRoom === "function"', { timeout: 10000, interval: 100, label: 'fresh client reads the persistent workspace' });
  await page.waitFor('!!document.getElementById("workspaceError") && !document.getElementById("workspaceError").hidden && !document.getElementById("reopenSavedRoomBtn").disabled', {timeout:30000,interval:100,label:'closed previous Steam lobby startup restoration finishes before manual reopen'});
  checks.push('closed previous Steam lobby finishes automatic restoration before an explicit saved-room reopen');
  await page.eval('void window.deepscord.reopenSavedRoom(' + JSON.stringify(publicSaved.id) + ')', { awaitPromise: false, userGesture: true });
  page.close(); page = await connectPage(port, 'http://127.0.0.1:');
  await page.waitFor('!!document.getElementById("welcomeNameInput") || window.echo?.getState().roomReady===true', { timeout: 15000, interval: 100, label: 'actual reopened Steam room' });
  if (await page.eval('!!document.getElementById("welcomeNameInput")')) await page.eval('document.getElementById("welcomeNameInput").value="Steam reopened host";document.getElementById("welcomeEnterBtn").click()', { awaitPromise: true, userGesture: true });
  await page.waitFor('window.echo?.getState().roomReady===true && window.echo.getState().servers.some(s=>s.channels.some(c=>c.id==="ch-lobby"&&c.name==="Persisted Steam"&&c.userLimit===6))', { timeout: 15000, interval: 100, label: 'fresh native lobby/backend restores the saved channel tree' });
  const reopenedWorkspace = publicWorkspace(workspaceFile).find(entry => entry.id === publicSaved.id);
  assert(reopenedWorkspace?.document);
  assert.equal(reopenedWorkspace.roomId, publicSaved.roomId); assert.equal(reopenedWorkspace.creatorKey, publicSaved.creatorKey);
  assert.equal(reopenedWorkspace.document.digest, publicSaved.document.digest);
  const reopenedState = await page.eval('window.echo.getState()', { awaitPromise: true, userGesture: true });
  assert.equal(reopenedState.selfId, first.selfId);
  checks.push('full client quit and restart reopen a new real Steam lobby with the same pinned room and edited channel structure');
  await verifyReopenedSteamMedia(page,directory,userData,mediaEvidence);
  checks.push('fixed-room reopen preserves signed emoji catalog and readable durable AVIF bytes used by new image/sticker sends');
  page.send('Runtime.evaluate', { expression: 'window.deepscord.quit()', userGesture: true }).catch(error => console.warn('Native quit response unavailable', { message: error.message }));
  await Promise.race([exited, sleep(10000).then(() => { if (child.exitCode === null) throw new Error('Reopened owned Steam client did not quit'); })]);
  assert.equal(fs.readdirSync(rooms).length, 0);
  normalExit = true;
  checks.push('normal client quit leaves the real Steam lobby and removes its temporary backend directory');
} catch (error) {
  failure = error;
  if(page)try {
    failureDiagnostic=await page.eval('({url:location.href,state:window.echo?.getState(),composer:document.getElementById("mediaComposerPreview")?.outerHTML,toasts:document.getElementById("toastHost")?.textContent})');
    await page.screenshot(path.join(directory,'failure.png'));
  }catch(diagnosticError){console.warn('steam_host_failure_diagnostic_failed',{message:diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)});}
} finally {
  if (page) page.close();
  if (child.exitCode === null && child.signalCode === null) {
    const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    if (killed.status !== 0) console.error('Owned Steam host cleanup failed', { pid: child.pid, status: killed.status, stderr: killed.stderr });
  }
  await exited;
  fs.closeSync(log);
  const endHashes = Object.fromEntries(sourceFiles.map(filename => [filename, hash(path.join(root, filename))]));
  const result = { status: failure ? 'failed' : 'passed', scope: 'single-account actual Steam 480 production host, transparent AVIF image/sticker durable storage and fixed-room restart; cross-account replication is not tested', checks, microphoneUsed: false, normalExit, ownedProcessExited: child.exitCode !== null || child.signalCode !== null, startHashes, runtimeHashes, endHashes, sourceChangedDuringTest: sourceFiles.filter(filename => startHashes[filename] !== endHashes[filename]), logPath, mediaEvidence, failureDiagnostic, ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'steam-host-native-result', status: result.status, checks: checks.length, result: path.join(directory, 'result.json'), sourceChangedDuringTest: result.sourceChangedDuringTest }));
}
if (failure) throw failure;
