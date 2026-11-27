// @ts-check
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { initialSettings, desktopSettings, voiceOverlay } = require('./desktop-schema.cjs');
const root = path.resolve(__dirname, '..');

/** @returns {Promise<void>} */
async function runNode() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  assert(binary, 'ELECTRON_TEST_BINARY must identify a real Electron runtime');
  const source = path.dirname(path.resolve(binary));
  const destination = path.join(root, '.qa-tools', 'desktop-features-runtime');
  const marker = path.join(destination, '.desktop-features-runtime');
  if (fs.existsSync(destination)) assert.equal(fs.readFileSync(marker, 'utf8'), source);
  else {
    const sourceApp = path.join(source, 'resources', 'app');
    assert(!destination.startsWith(source + path.sep), 'Runtime destination must be outside the source runtime');
    fs.cpSync(source, destination, { recursive:true, filter:(file) => file !== sourceApp && !file.startsWith(sourceApp + path.sep) && file !== path.join(source, 'resources', 'app.asar') });
    fs.writeFileSync(marker, source);
  }
  const appDirectory = path.join(destination, 'resources', 'app');
  fs.mkdirSync(appDirectory, { recursive:true });
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({ name:'deepscord-desktop-probe',version:'1.0.0',main:'main.cjs' }));
  fs.writeFileSync(path.join(appDirectory, 'main.cjs'), `require(${JSON.stringify(__filename)});`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-desktop-'));
  /** @type {NodeJS.ProcessEnv} */
  const environment = { ...process.env, DEEPSCORD_DESKTOP_TEST_DATA:directory };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(destination, path.basename(binary)), [], { env:environment,windowsHide:true,stdio:'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Desktop integration exceeded 45000 ms')); }, 45000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(undefined); else reject(new Error(`Desktop integration exited ${code}`)); });
  });
}

/** @returns {Promise<void>} */
async function runElectron() {
  const { app, BrowserWindow, globalShortcut, screen } = require('electron');
  const { createDesktopFeatures } = require('./desktop-features.cjs');
  const directory = process.env.DEEPSCORD_DESKTOP_TEST_DATA;
  assert(directory);
  app.setPath('userData', directory);
  await app.whenReady();
  const main = new BrowserWindow({ show:false,webPreferences:{ preload:path.join(__dirname, 'preload.js'),contextIsolation:true,nodeIntegration:false } });
  await main.loadFile(path.join(__dirname, 'desktop-test-page.html'));
  const defaults = { ...initialSettings(),deafenShortcut:'Control+Alt+Shift+F9' };
  const testShortcut = 'Control+Alt+Shift+F10';
  fs.writeFileSync(path.join(directory, 'desktop-settings.json'), JSON.stringify({ ...defaults,muteShortcut:testShortcut }));
  const features = createDesktopFeatures({ getWindow:() => main,userData:directory });
  try {
    assert.equal(defaults.muteShortcut, 'Control+Shift+M');
    assert.equal(initialSettings().deafenShortcut, 'Control+Shift+D');
    assert(globalShortcut.isRegistered(defaults.deafenShortcut));
    const legacy = { muteShortcut:defaults.muteShortcut,overlay:{ enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1 } };
    assert.deepEqual(desktopSettings(legacy), initialSettings());
    assert.throws(() => desktopSettings({ ...defaults,deafenShortcut:'ctrl+shift+m' }), /different/);
    assert.deepEqual(desktopSettings(defaults), defaults);
    assert(globalShortcut.isRegistered(testShortcut));
    const throughIpc = await main.webContents.executeJavaScript('window.deepscord.getDesktopSettings()');
    assert.deepEqual(throughIpc, features.getSettings());
    for (const key of ['K','7','F9','Home','PageDown']) assert.equal(desktopSettings({ ...defaults,muteShortcut:key }).muteShortcut,key);
    for (const key of ['Control','Shift','Alt','Super','Control+Shift']) assert.throws(()=>desktopSettings({ ...defaults,muteShortcut:key }),/supported/);
    assert.throws(() => desktopSettings({ ...defaults, overlay:{ ...defaults.overlay, scale:0 } }), /scale/);
    assert.throws(() => voiceOverlay({ connected:true,members:[{ id:'bad' }] }), /avatar/);
    const occupied = 'Control+Alt+Shift+F12';
    assert(globalShortcut.register(occupied, () => {}), 'Probe accelerator is occupied outside this process');
    assert.throws(() => features.saveSettings({ ...defaults,muteShortcut:occupied }), /previous shortcut remains active/);
    assert(globalShortcut.isRegistered(testShortcut));
    assert.equal(features.getSettings().muteShortcut, testShortcut);
    globalShortcut.unregister(occupied);
    const deafenOccupied = 'Control+Alt+Shift+F8';
    assert(globalShortcut.register(deafenOccupied, () => {}));
    assert.throws(() => features.saveSettings({ ...defaults,muteShortcut:testShortcut,deafenShortcut:deafenOccupied }), /deafen/);
    assert(globalShortcut.isRegistered(testShortcut));
    assert(globalShortcut.isRegistered(defaults.deafenShortcut));
    globalShortcut.unregister(deafenOccupied);
    const chosen = 'Control+Shift+F11';
    const changed = features.saveSettings({ ...defaults,muteShortcut:chosen,extra:'stripped',overlay:{ ...defaults.overlay,enabled:true,locked:false,x:-99999,y:99999 } });
    assert(!globalShortcut.isRegistered(testShortcut));
    assert(globalShortcut.isRegistered(chosen));
    const area = screen.getDisplayMatching(changed.overlay).workArea;
    assert(changed.overlay.x >= area.x && changed.overlay.y >= area.y);
    assert(!('extra' in changed));
    features.saveSettings({ ...features.getSettings(),overlay:{ ...features.getSettings().overlay,showRadio:true } });
    const avatar='data:image/jpeg;base64,'+fs.readFileSync(path.join(root,'test/fixtures/avatar-96.jpg')).toString('base64');
    features.updateVoice({ connected:true,radioTitle:'本地电台 · 测试曲目',members:[{ id:'one',screen:true,name:'清晰的人声',avatar,color:'#7ccfbd',speaking:true,muted:false },{ id:'two',name:'Muted',avatar:null,color:'#e0dbcd',speaking:false,muted:true }] });
    const overlay = BrowserWindow.getAllWindows().find((window) => window !== main);
    assert(overlay);
    overlay.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('overlay_renderer_error', { message:event.message }); });
    overlay.webContents.on('preload-error', (_event, file, error) => console.error('overlay_preload_failed', { file,message:error.message }));
    if (overlay.webContents.isLoading()) await new Promise((resolve) => overlay.webContents.once('did-finish-load', () => resolve(undefined)));
    await overlay.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await overlay.webContents.executeJavaScript('document.querySelectorAll("#members > li").length'), 2);
    assert.equal(await overlay.webContents.executeJavaScript('document.querySelector("#members > li.speaking").dataset.memberId'), 'one');
    assert.equal(await overlay.webContents.executeJavaScript('typeof window.deepscord'), 'undefined');
    assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("radio-title").textContent'), '本地电台 · 测试曲目');
    assert.equal(await overlay.webContents.executeJavaScript('document.querySelectorAll(".screen-badge:not([hidden])").length'), 1);
    await overlay.webContents.executeJavaScript('window.retainedRow=document.querySelector("#members > li");window.retainedAvatar=window.retainedRow.firstElementChild;');
    features.updateVoiceDelta({connected:true,radioTitle:'Changed title',members:[{id:'one',speaking:false,muted:false,screen:false},{id:'two',speaking:true,muted:false,screen:true}]});
    await overlay.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal(await overlay.webContents.executeJavaScript('window.retainedRow===document.querySelector("#members > li") && window.retainedAvatar===window.retainedRow.firstElementChild'),true);
    assert.equal(await overlay.webContents.executeJavaScript('document.querySelector("#members > li.speaking").dataset.memberId'),'two');
    assert.throws(()=>features.updateVoiceDelta({connected:true,radioTitle:null,members:[]}),/snapshot/);
    fs.writeFileSync(path.join(root, '.qa-tools', 'desktop-overlay-expanded.png'), (await overlay.webContents.capturePage()).toPNG());
    assert.equal(await overlay.webContents.executeJavaScript('typeof window.voiceOverlay.onState'), 'function');
    assert(overlay.isVisible());
    assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("resize-grip").hidden'), false);
    await overlay.webContents.executeJavaScript('window.voiceOverlay.resize({width:350,height:260})');
    assert(Math.abs(overlay.getBounds().width - 350) <= 1, 'Native DPI rounding must remain within one pixel');
    main.hide();
    assert(overlay.isVisible(), 'Tray hide must retain the active overlay');
    overlay.setBounds({ x:area.x + 30,y:area.y + 40,width:320,height:240 });
    overlay.emit('moved');
    overlay.emit('resized');
    const actualWidth = overlay.getBounds().width;
    assert.equal(features.getSettings().overlay.width, actualWidth);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'desktop-settings.json'), 'utf8')).overlay.width, actualWidth);
    await overlay.webContents.executeJavaScript('window.voiceOverlay.finishAdjustment()');
    assert.equal(features.getSettings().overlay.locked,true);
    assert.equal(await overlay.webContents.executeJavaScript('getComputedStyle(document.getElementById("overlay")).backgroundColor'), 'rgba(0, 0, 0, 0)');
    assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("edit-hint").hidden'),true);
    features.saveSettings({ ...features.getSettings(),overlay:{ ...features.getSettings().overlay,scale:1.25 } });
    assert.equal(overlay.isContentProtected(),false);
    assert.equal(overlay.isFocusable(),false);
    main.show(); main.focus();
    await main.webContents.executeJavaScript('document.body.innerHTML = "<input id=focus-probe>"; document.getElementById("focus-probe").focus()');
    const capture = await main.webContents.executeJavaScript('window.deepscord.beginShortcutCapture()');
    assert(!globalShortcut.isRegistered(chosen));
    assert(!globalShortcut.isRegistered(defaults.deafenShortcut));
    await main.webContents.executeJavaScript(`window.deepscord.endShortcutCapture(${JSON.stringify(capture.id)})`);
    assert(globalShortcut.isRegistered(chosen));
    assert(globalShortcut.isRegistered(defaults.deafenShortcut));
    for (let tick = 0; tick < 12; tick += 1) {
      features.updateVoice({ connected:true,members:[{ id:'one',name:'Speaker',avatar:null,color:'#87d8ce',speaking:tick % 2 === 0,muted:false }] });
      await new Promise(resolve => setTimeout(resolve,100));
      assert(main.isFocused(), 'Voice status updates must retain main-window focus');
      assert.equal(await main.webContents.executeJavaScript('document.activeElement.id'), 'focus-probe');
    }
    assert(!overlay.isResizable());
    assert(!overlay.isMovable());
    assert.equal(await overlay.webContents.executeJavaScript('typeof require'), 'undefined');
    const snapshot = await overlay.webContents.capturePage();
    fs.writeFileSync(path.join(root, '.qa-tools', 'desktop-overlay.png'), snapshot.toPNG());
    features.resetVoice();
    assert(overlay.isDestroyed());
    features.dispose();
    assert(!globalShortcut.isRegistered(chosen));
    const reloaded = createDesktopFeatures({ getWindow:() => main,userData:directory });
    assert.equal(reloaded.getSettings().overlay.width, features.getSettings().overlay.width);
    assert.equal(reloaded.getSettings().muteShortcut, chosen);
    reloaded.dispose();
    assert(globalShortcut.register(chosen, () => {}));
    const unavailable = createDesktopFeatures({ getWindow:() => main,userData:directory });
    assert.equal(unavailable.getShortcutStatus().registered, false);
    assert.match(unavailable.getShortcutStatus().error || '', /choose another shortcut/);
    assert.equal((await main.webContents.executeJavaScript('window.deepscord.getShortcutStatus()')).registered, false);
    assert.equal((await main.webContents.executeJavaScript('window.deepscord.getDesktopSettings()')).muteShortcut, chosen);
    unavailable.saveSettings({ ...unavailable.getSettings(),muteShortcut:testShortcut });
    assert.deepEqual(unavailable.getShortcutStatus(), { registered:true,error:null });
    unavailable.dispose();
    globalShortcut.unregister(chosen);
    console.log('Desktop integration passed: real IPC, shortcut conflicts/replacement, persistence, reachable bounds, isolated overlay, speaking/muted rows, tray retention, lock/resize, teardown.');
  } finally { features.dispose(); globalShortcut.unregisterAll(); main.destroy(); }
  app.exit(0);
}

if (process.versions.electron) runElectron().catch((error) => { console.error(error); require('electron').app.exit(1); });
else runNode().catch((error) => { console.error(error); process.exitCode = 1; });
