// @ts-check
'use strict';
const assert = require('node:assert/strict');
const { BrowserWindow, desktopCapturer, screen, session } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const poke = require('./poke-overlay.cjs');
const bounds = require('./poke-window-bounds.cjs');
/** @param {()=>Promise<boolean>} check @param {string} label @returns {Promise<void>} */
async function until(check, label) {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > 3000) throw new Error('Native poke verification timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
/** @returns {Promise<void>} */
async function runWindowPoke() {
  const target = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'test-poke-window-target.ps1')], { windowsHide: true, stdio: ['pipe','pipe','inherit'] });
  const lines = createInterface({ input: target.stdout });
  const handle = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('External capture test window did not appear')), 10000); lines.once('line', line => { clearTimeout(timer); resolve(line); }); target.once('error', reject); });
  const owner = new BrowserWindow({ show: false });
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Window capture owner</title>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  /** @type {import('./poke-window-bounds.cjs').WindowTracker|null} */ let tracker = null;
  try {
    /** @type {Electron.DesktopCapturerSource|undefined} */ let foundSource;
    await until(async () => { const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }); foundSource = sources.find(entry => entry.id.startsWith(`window:${handle}:`)); return foundSource !== undefined; }, 'external window enumerated');
    assert(foundSource); const source = foundSource;
    tracker = await bounds.trackWindow(source.id, () => {});
    const payload = { sessionId: 'window-poke-test', sourceId: source.id };
    const focus = BrowserWindow.getFocusedWindow()?.id ?? null;
    assert.deepEqual(await poke.beginPokeOverlay(owner.webContents, payload, source), { desktopOverlay: true, reason: null });
    const hit = { sessionId: payload.sessionId, eventId: 'window-hit-1', fromUserId: 'window-peer', nx: 0.37, ny: 0.62, combo: 2, pokerName: 'Window poke' };
    await poke.triggerPokeOverlay(owner.webContents, hit);
    const foundOverlay = BrowserWindow.getAllWindows().find(win => win !== owner);
    assert(foundOverlay);
    const overlay = foundOverlay;
    await until(async () => await overlay.webContents.executeJavaScript('document.querySelectorAll(".poke-finger").length === 1'), 'visible finger');
    /** @returns {Electron.Rectangle} */
    function expectedBounds() { const value = tracker?.read(); assert(value); return screen.screenToDipRect(null, value); }
    /** @returns {Promise<boolean>} */
    async function aligned() {
      if (!tracker?.read()) return false;
      const expected = expectedBounds(), actual = overlay.getBounds();
      return Math.abs(expected.x-actual.x) <= 1 && Math.abs(expected.y-actual.y) <= 1 && Math.abs(expected.width-actual.width) <= 1 && Math.abs(expected.height-actual.height) <= 1;
    }
    await until(aligned, 'native visible bounds');
    const placement = await overlay.webContents.executeJavaScript('(() => {const marker=document.querySelector(".poke-marker");return {x:parseFloat(marker.style.left),y:parseFloat(marker.style.top)};})()');
    assert.deepEqual(placement, { x: 37, y: 62 });
    assert.equal(BrowserWindow.getFocusedWindow()?.id ?? null, focus);
    assert(!overlay.isFocusable()); assert(!overlay.isContentProtected());
    const overlayHandle = overlay.getNativeWindowHandle().readBigUInt64LE(0).toString();
    const command = `$ErrorActionPreference='Stop'; Add-Type 'using System;using System.Runtime.InteropServices;public static class Probe {[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]public static extern IntPtr Style(IntPtr h,int n);[DllImport("user32.dll")]public static extern bool GetWindowDisplayAffinity(IntPtr h,out uint a);}';$h=[IntPtr]::new([long]${overlayHandle});$style=[Probe]::Style($h,-20).ToInt64();[uint32]$affinity=0;if(-not [Probe]::GetWindowDisplayAffinity($h,[ref]$affinity)){throw 'Affinity query failed'};if(($style-band 32)-eq 0-or($style-band 134217728)-eq 0-or$affinity-ne 0){throw 'Overlay must be click-through, no-activate and recordable'};'Native window overlay styles verified'`;
    console.log((await promisify(execFile)('powershell.exe', ['-NoProfile','-NonInteractive','-Command',command], { windowsHide: true, timeout: 10000 })).stdout.trim());
    // Verify the actual window-capture dimensions against DWM's visible frame.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({ video: source }));
    await owner.loadURL(`http://127.0.0.1:${address.port}`);
    const frame = await owner.webContents.executeJavaScript(`(async()=>{const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});try{const video=document.createElement('video');video.srcObject=stream;video.muted=true;await video.play();await new Promise(resolve=>video.requestVideoFrameCallback(resolve));return {width:video.videoWidth,height:video.videoHeight};}finally{stream.getTracks().forEach(track=>track.stop());}})()`, true);
    const physical = tracker.read(); assert(physical);
    assert(Math.abs(frame.width-physical.width) <= 2 && Math.abs(frame.height-physical.height) <= 2, JSON.stringify({ frame, physical }));
    const before = expectedBounds();
    target.stdin.write('move\n');
    await until(async () => { const next = expectedBounds(); return next.x !== before.x && next.width !== before.width && await aligned(); }, 'move and resize tracking');
    assert.equal(BrowserWindow.getFocusedWindow()?.id ?? null, focus, 'Tracking must preserve keyboard focus');
    target.stdin.write('minimize\n');
    await until(async () => !overlay.isVisible(), 'minimized target hides marker');
    target.stdin.write('restore\n');
    await until(async () => overlay.isVisible() && await aligned(), 'restored target realigns marker');
    await poke.triggerPokeOverlay(owner.webContents, { ...hit, eventId: 'window-hit-2' });
    const output = path.resolve(__dirname, '../.qa-tools');
    fs.writeFileSync(path.join(output, 'poke-window.png'), (await overlay.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'poke-window-evidence.json'), JSON.stringify({ runtime: process.versions.electron, displays: screen.getAllDisplays().map(display => ({ bounds: display.bounds, scaleFactor: display.scaleFactor })), frame, physical, moved: expectedBounds(), overlay: overlay.getBounds(), placement }, null, 2));
    target.stdin.write('close\n');
    await until(async () => !overlay.isVisible(), 'closed target hides overlay');
    await new Promise(resolve => setTimeout(resolve, 200));
    await assert.rejects(poke.triggerPokeOverlay(owner.webContents, { ...hit, eventId: 'window-hit-3' }), /Native window bounds helper exited/);
    poke.endPokeOverlay(owner.webContents, payload.sessionId);
    assert(overlay.isDestroyed());
    const local = new BrowserWindow({ show: false, width: 720, height: 480, x: 100, y: 100 });
    try {
      await local.loadURL('data:text/html,<body>Local renderer capture target</body>'); local.showInactive();
      const localSource = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })).find(source => source.id === local.getMediaSourceId()); assert(localSource);
      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({ video: localSource }));
      const localFrame = await owner.webContents.executeJavaScript(`(async()=>{const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});try{const video=document.createElement('video');video.srcObject=stream;video.muted=true;await video.play();await new Promise(resolve=>video.requestVideoFrameCallback(resolve));return {width:video.videoWidth,height:video.videoHeight};}finally{stream.getTracks().forEach(track=>track.stop());}})()`, true);
      const localTracker = await bounds.trackWindow(localSource.id, () => {});
      try {
        const client = localTracker.read(); assert(client);
        assert(Math.abs(localFrame.width-client.width) <= 2 && Math.abs(localFrame.height-client.height) <= 2, JSON.stringify({ localFrame, client }));
        const localPayload = { sessionId: 'local-window-test', sourceId: localSource.id };
        assert.equal((await poke.beginPokeOverlay(owner.webContents, localPayload, localSource)).desktopOverlay, true);
        await poke.triggerPokeOverlay(owner.webContents, { ...hit, sessionId: localPayload.sessionId });
        const localOverlay = BrowserWindow.getAllWindows().find(win => win !== owner && win !== local); assert(localOverlay);
        const expected = screen.screenToDipRect(null, client), actual = localOverlay.getBounds();
        assert(Math.abs(actual.x-expected.x)<=1 && Math.abs(actual.y-expected.y)<=1 && Math.abs(actual.width-expected.width)<=1 && Math.abs(actual.height-expected.height)<=1);
        poke.endPokeOverlay(owner.webContents, localPayload.sessionId);
      } finally { localTracker.dispose(); }
    } finally { local.destroy(); }
    const displaySource = (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })).find(source => poke.sourceDisplay(source)); assert(displaySource);
    const displayPayload = { sessionId: 'display-regression', sourceId: displaySource.id };
    assert.equal((await poke.beginPokeOverlay(owner.webContents, displayPayload, displaySource)).desktopOverlay, true);
    await poke.triggerPokeOverlay(owner.webContents, { ...hit, sessionId: displayPayload.sessionId });
    const displayOverlay = BrowserWindow.getAllWindows().find(win => win !== owner); assert(displayOverlay);
    assert.deepEqual(displayOverlay.getBounds(), poke.sourceDisplay(displaySource)?.bounds);
    poke.endPokeOverlay(owner.webContents, displayPayload.sessionId);
    console.log('Window poke passed: external native frame and local Electron client capture crops, real video frames, DIP mapping, markers, move/resize, minimize/restore, click-through/no-activate/recordability, focus preservation, closed-window failure, teardown and whole-display regression.');
  } finally { tracker?.dispose(); poke.disposePokeOverlay(); owner.destroy(); lines.close(); target.kill(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined))); }
}
module.exports = { runWindowPoke };
