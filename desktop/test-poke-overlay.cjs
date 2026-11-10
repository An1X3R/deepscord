// @ts-check
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createServer } = require('node:http');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');

/** @returns {Promise<void>} */
async function runNode() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  assert(binary, 'ELECTRON_TEST_BINARY must identify a real Electron runtime');
  const source = path.dirname(path.resolve(binary));
  const destination = path.join(root, '.qa-tools', process.env.DEEPSCORD_POKE_WINDOW_ONLY === '1' ? 'poke-window-runtime' : 'poke-overlay-runtime');
  const sourcePath = source.toLowerCase();
  const destinationPath = destination.toLowerCase();
  assert(sourcePath !== destinationPath && !destinationPath.startsWith(sourcePath + path.sep) && !sourcePath.startsWith(destinationPath + path.sep), 'Runtime source and destination must be separate directory trees');
  const marker = path.join(destination, '.poke-overlay-runtime');
  if (fs.existsSync(destination)) assert.equal(fs.readFileSync(marker, 'utf8'), source);
  else {
    const sourceApp = path.join(source, 'resources', 'app');
    fs.cpSync(source, destination, { recursive: true, filter: (file) => file !== sourceApp && !file.startsWith(sourceApp + path.sep) && file !== path.join(source, 'resources', 'app.asar') });
    fs.writeFileSync(marker, source);
  }
  const appDirectory = path.join(destination, 'resources', 'app');
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'poke-overlay-test', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(appDirectory, 'main.cjs'), `require(${JSON.stringify(__filename)});`);
  /** @type {NodeJS.ProcessEnv} */
  const environment = { ...process.env, DEEPSCORD_POKE_TEST_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-poke-')) };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(destination, path.basename(binary)), [], { env: environment, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Poke integration exceeded 55000 ms')); }, 55000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(undefined); else reject(new Error(`Poke integration exited ${code}`)); });
  });
}

/** @returns {Promise<void>} */
async function runElectron() {
  const { app, BrowserWindow, screen, desktopCapturer } = require('electron');
  const directory = process.env.DEEPSCORD_POKE_TEST_DATA;
  assert(directory); app.setPath('userData', directory);
  await app.whenReady();
  if (process.env.DEEPSCORD_POKE_WINDOW_ONLY === '1') {
    await require('./test-poke-window.cjs').runWindowPoke();
    app.exit(0); return;
  }
  const poke = require('./poke-overlay.cjs');
  const main = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Poke IPC test</title>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  try {
    const entries = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = entries.find((entry) => poke.sourceDisplay(entry));
    assert(source, 'A real desktop source with a matched display is required');
    const payload = { sessionId: 'session-one', sourceId: source.id };
    const hit = { sessionId: payload.sessionId, eventId: 'event-1', fromUserId: 'peer-one', nx: 0.4, ny: 0.3, combo: 5, pokerName: 'Native poke test' };
    assert.throws(() => poke.parseHit({ ...hit, nx: 2 }), /coordinates/);
    assert.throws(() => poke.parseHit({ ...hit, combo: 11 }), /combo/);
    assert.throws(() => poke.parseHit({ ...hit, pokerName: '\u0000' }), /name/);
    assert.deepEqual(poke.parseBegin({ ...payload, extra: 'removed' }), payload);
    assert.equal(poke.sourceDisplay({ ...source, display_id: '' }), null);
    assert.equal(poke.sourceDisplay({ ...source, id: 'window:1:0' }), null);
    assert.equal(poke.sourceDisplay({ ...source, display_id: 'not-a-display' }), null);
    await assert.rejects(poke.beginPokeOverlay(main.webContents, payload, { ...source, id: 'window:1:0' }), /Native window bounds helper exited/);
    assert.equal((await poke.beginPokeOverlay(main.webContents, payload, source)).desktopOverlay, true);
    await poke.triggerPokeOverlay(main.webContents, hit);
    const overlay = BrowserWindow.getAllWindows().find((entry) => entry !== main);
    assert(overlay);
    assert(!overlay.isContentProtected()); assert(!overlay.isFocusable()); assert(overlay.isAlwaysOnTop());
    assert.deepEqual(overlay.getBounds(), screen.getAllDisplays().find((entry) => String(entry.id) === source.display_id)?.bounds);
    if (process.platform === 'win32') {
      const handle = overlay.getNativeWindowHandle().readBigUInt64LE(0).toString();
      const command = `$ErrorActionPreference='Stop'; Add-Type 'using System; using System.Runtime.InteropServices; public static class PokeWindowProbe { [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr Style(IntPtr h,int n); [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h,out uint a); }'; $h=[IntPtr]::new([long]${handle}); $s=[PokeWindowProbe]::Style($h,-20).ToInt64(); [uint32]$a=0; if(-not [PokeWindowProbe]::GetWindowDisplayAffinity($h,[ref]$a)){throw 'Affinity query failed'}; if(($s -band 32)-eq 0){throw 'Mouse click-through missing'}; if(($s -band 134217728)-eq 0){throw 'No-activate missing'}; if($a -ne 0){throw "Unexpected capture exclusion: $a"}; 'Native WS_EX_TRANSPARENT, WS_EX_NOACTIVATE and WDA_NONE verified'`;
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000 });
      console.log(result.stdout.trim());
    }
    for (let index = 2; index <= 5; index += 1) await poke.triggerPokeOverlay(main.webContents, { ...hit, eventId: `event-${index}`, fromUserId: `peer-${index}` });
    await overlay.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
    assert.equal(await overlay.webContents.executeJavaScript('document.querySelectorAll(".poke-marker").length'), 3);
    assert.equal(await overlay.webContents.executeJavaScript('new Set([...document.querySelectorAll(".poke-marker")].map(marker => marker.style.getPropertyValue("--poke-identity"))).size'), 3);
    assert.equal(await overlay.webContents.executeJavaScript('document.querySelector(".poke-finger").textContent'), '👆');
    assert.equal(await overlay.webContents.executeJavaScript('document.querySelectorAll("svg").length'), 0);
    assert.deepEqual(await overlay.webContents.executeJavaScript('(() => { const style = getComputedStyle(document.querySelector(".poke-finger")); return {font:style.fontSize,width:style.width,height:style.height}; })()'), { font: '32px', width: '36px', height: '40px' });
    assert(await overlay.webContents.executeJavaScript('(() => { const style = getComputedStyle(document.querySelector(".poke-finger")); const matrix = new DOMMatrixReadOnly(style.transform); return Math.hypot(matrix.a,matrix.b) <= 1.201; })()'));
    assert(await overlay.webContents.executeJavaScript('(() => { const marker = document.querySelector(".poke-marker").getBoundingClientRect(); const target = document.querySelector(".poke-target").getBoundingClientRect(); return Math.abs(target.x + target.width/2 - marker.x) < .1 && Math.abs(target.y + target.height/2 - marker.y) < .1; })()'));
    assert.equal(await overlay.webContents.executeJavaScript('typeof require'), 'undefined');
    assert.equal(await overlay.webContents.executeJavaScript('typeof window.deepscord'), 'undefined');
    fs.writeFileSync(path.join(root, '.qa-tools', 'poke-overlay.png'), (await overlay.webContents.capturePage()).toPNG());
    poke.clearPokeOverlay(main.webContents, payload.sessionId);
    await overlay.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
    assert.equal(await overlay.webContents.executeJavaScript('document.querySelectorAll(".poke-marker").length'), 0);
    assert.throws(() => poke.endPokeOverlay(main.webContents, 'old-session'), /active/);
    assert(!overlay.isDestroyed());
    poke.endPokeOverlay(main.webContents, payload.sessionId); assert(overlay.isDestroyed());
    await assert.rejects(poke.triggerPokeOverlay(main.webContents, hit), /active/);
    const capture = require('./capture-ipc.cjs');
    capture.registerCaptureIpc({ getWindow: () => main }); capture.configureCaptureSession(main.webContents.session);
    await main.loadURL(`http://127.0.0.1:${address.port}`);
    await assert.rejects(main.webContents.executeJavaScript(`window.deepscord.beginScreenPokeSession(${JSON.stringify(payload)})`), /确认已失效/);
    const stranger = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    try {
      await stranger.loadURL(`http://127.0.0.1:${address.port}`);
      await assert.rejects(stranger.webContents.executeJavaScript('window.deepscord.listCaptureSources()'), /unauthorized/);
    } finally { stranger.destroy(); }
    const acquired = await main.webContents.executeJavaScript(`(async () => { const sources = await window.deepscord.listCaptureSources(); const source = sources.find(item => item.id === ${JSON.stringify(source.id)}); await window.deepscord.selectCaptureSource(source.id); window.testCapture = await navigator.mediaDevices.getDisplayMedia({audio:false,video:true}); return window.deepscord.beginScreenPokeSession(${JSON.stringify(payload)}); })()`, true);
    assert.equal(acquired.desktopOverlay, true);
    await main.webContents.executeJavaScript(`window.deepscord.triggerScreenPokeOverlay(${JSON.stringify(hit)})`);
    const ipcOverlay = BrowserWindow.getAllWindows().find((entry) => entry !== main); assert(ipcOverlay);
    const requests = { sessionId: payload.sessionId, requests: [{ userId: 'peer-a', requestId: 'request-a', name: '指点申请者' }, { userId: 'peer-b', requestId: 'request-b', name: '<img src=x>' }], canApprove: true };
    await main.webContents.executeJavaScript('window.nativeDecisions=[]; window.nativeDecisionPromise=new Promise(resolve=>{window.testDecisionUnsubscribe=window.deepscord.onScreenPokeDecision(value=>{window.nativeDecisions.push(value);resolve(value)})}); undefined');
    const focusedBefore = BrowserWindow.getFocusedWindow()?.id ?? null;
    await main.webContents.executeJavaScript(`window.deepscord.updateScreenPokeRequests(${JSON.stringify(requests)})`);
    const popup = BrowserWindow.getAllWindows().find((entry) => entry !== main && entry !== ipcOverlay); assert(popup);
    await popup.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert(popup.isVisible()); assert(popup.isFocusable()); assert(popup.isAlwaysOnTop()); assert(!popup.isContentProtected());
    assert.equal(BrowserWindow.getFocusedWindow()?.id ?? null, focusedBefore, 'Showing a request must preserve keyboard focus');
    if (process.platform === 'win32') {
      const handle = popup.getNativeWindowHandle().readBigUInt64LE(0).toString();
      const command = `$ErrorActionPreference='Stop'; Add-Type 'using System; using System.Runtime.InteropServices; public static class RequestWindowProbe { [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h,out uint a); }'; [uint32]$a=0; if(-not [RequestWindowProbe]::GetWindowDisplayAffinity([IntPtr]::new([long]${handle}),[ref]$a)){throw 'Request affinity query failed'}; if($a -ne 0){throw "Unexpected request capture exclusion: $a"}; 'Native request WDA_NONE verified'`;
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile','-NonInteractive','-Command',command], { windowsHide:true,timeout:10000 });
      console.log(result.stdout.trim());
    }

    const popupBounds = popup.getBounds();
    const workArea = screen.getAllDisplays().find((entry) => String(entry.id) === source.display_id)?.workArea; assert(workArea);
    assert(popupBounds.x >= workArea.x && popupBounds.y >= workArea.y && popupBounds.x + popupBounds.width <= workArea.x + workArea.width && popupBounds.y + popupBounds.height <= workArea.y + workArea.height);
    // Windows may round frameless shadow bounds at fractional display scales.
    assert(Math.abs(popupBounds.x + popupBounds.width - (workArea.x + workArea.width - 16)) <= 2);
    assert(Math.abs(popupBounds.y + popupBounds.height - (workArea.y + workArea.height - 16)) <= 2);
    assert.equal(await popup.webContents.executeJavaScript('document.querySelectorAll(".request").length'), 2);
    assert.equal(await popup.webContents.executeJavaScript('document.querySelectorAll("img").length'), 0);
    assert.equal(await popup.webContents.executeJavaScript('typeof require'), 'undefined');
    assert.equal(await popup.webContents.executeJavaScript('typeof window.deepscord'), 'undefined');
    fs.writeFileSync(path.join(root, '.qa-tools', 'poke-request.png'), (await popup.webContents.capturePage()).toPNG());
    const attacker = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'poke-request-preload.js'), contextIsolation: true, nodeIntegration: false } });
    const decision = { sessionId: payload.sessionId, userId: 'peer-a', requestId: 'request-a', approved: true };
    try {
      await attacker.loadURL(`http://127.0.0.1:${address.port}`);
      await assert.rejects(attacker.webContents.executeJavaScript(`window.pokeRequest.decide(${JSON.stringify(decision)})`), /unauthorized frame/);
    } finally { attacker.destroy(); }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owner focus event did not arrive')), 2000);
      main.once('focus', () => { clearTimeout(timer); resolve(undefined); });
      main.show(); main.focus();
    });
    assert(main.isFocused()); assert(popup.isVisible(), 'Foreground owner must retain the single native prompt');
    main.hide(); assert(popup.isVisible());
    await popup.webContents.executeJavaScript('document.querySelector("[data-testid=poke-native-approve]").click()');
    assert.deepEqual(await main.webContents.executeJavaScript('window.nativeDecisionPromise'), decision);
    assert.deepEqual(await main.webContents.executeJavaScript('window.nativeDecisions'), [decision]);
    await assert.rejects(popup.webContents.executeJavaScript(`window.pokeRequest.decide(${JSON.stringify(decision)})`), /expired or was already answered/);
    await main.webContents.executeJavaScript(`window.deepscord.updateScreenPokeRequests(${JSON.stringify(requests)})`);
    await popup.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal(await popup.webContents.executeJavaScript('document.querySelectorAll(".request").length'), 1, 'A stale owner update must not resurrect an answered request');
    poke.clearPokeOverlay(main.webContents, payload.sessionId); assert(popup.isVisible(), 'Clearing markers must preserve pending requests');
    await popup.webContents.executeJavaScript('window.testPendingButton=document.querySelector("[data-testid=poke-native-approve]"); window.testPendingButton.focus(); undefined');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await main.webContents.executeJavaScript(`window.deepscord.updateScreenPokeRequests(${JSON.stringify(requests)})`);
    assert(await popup.webContents.executeJavaScript('window.testPendingButton === document.querySelector("[data-testid=poke-native-approve]") && document.activeElement === window.testPendingButton'), 'Identical updates must retain the keyboard-focused button');
    console.log('Checking native request expiry at the original 30-second deadline.');
    await popup.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setTimeout(()=>{observer.disconnect();reject(new Error("Native popup did not expire after 30 seconds"))},31000);const observer=new MutationObserver(()=>{if(!document.querySelector(".request")){observer.disconnect();clearTimeout(timer);resolve(true)}});observer.observe(document.getElementById("requests"),{childList:true})})');
    assert(!popup.isVisible(), 'Expired requests must hide even if the owner stops updating');
    await main.webContents.executeJavaScript(`window.deepscord.updateScreenPokeRequests(${JSON.stringify(requests)})`);
    assert.equal(await popup.webContents.executeJavaScript('document.querySelectorAll(".request").length'), 0, 'Expired request tokens must not be republished');
    await assert.rejects(popup.webContents.executeJavaScript(`window.pokeRequest.decide(${JSON.stringify({ ...decision, userId: 'peer-b', requestId: 'request-b' })})`), /expired or was already answered/);
    await main.webContents.executeJavaScript('window.deepscord.stopProcessAudio()');
    assert(!ipcOverlay.isDestroyed(), 'Stopping process audio must preserve active screen poke');
    await assert.rejects(main.webContents.executeJavaScript(`window.deepscord.beginScreenPokeSession(${JSON.stringify(payload)})`), /确认已失效/);
    await assert.rejects(main.webContents.executeJavaScript('window.deepscord.endScreenPokeSession({sessionId:"old-session"})'), /no longer active/);
    assert(!ipcOverlay.isDestroyed());
    await main.webContents.executeJavaScript(`window.deepscord.endScreenPokeSession({sessionId:${JSON.stringify(payload.sessionId)}})`);
    assert(ipcOverlay.isDestroyed());
    assert(popup.isDestroyed());
    await main.webContents.executeJavaScript('window.testCapture.getTracks().forEach(track => track.stop())');
    await capture.stopAllCapture();
    console.log('Poke desktop passed: real display capture and IPC, owner rejection, single-use capture confirmation, DIP bounds, native click-through/no-activate/recordable overlays, compact emoji, isolated renderer, bounded markers, background popup focus/work-area/decision/spoof protection and original 30-second expiry, clear/session teardown, independent process-audio stop.');
  } finally { poke.disposePokeOverlay(); main.destroy(); await new Promise((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(undefined); })); }
  app.exit(0);
}
if (process.versions.electron) runElectron().catch((error) => { console.error(error); require('electron').app.exit(1); });
else runNode().catch((error) => { console.error(error); process.exitCode = 1; });
