// @ts-check
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

/** @returns {Promise<void>} */
async function runNode() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  assert(binary, 'ELECTRON_TEST_BINARY must identify a real Electron executable');
  const source = path.dirname(path.resolve(binary));
  const destination = path.join(root, '.qa-tools', 'global-shortcut-runtime');
  const marker = path.join(destination, '.global-shortcut-runtime');
  if (fs.existsSync(destination)) assert.equal(fs.readFileSync(marker, 'utf8'), source);
  else {
    const sourceApp = path.join(source, 'resources', 'app');
    assert(!destination.startsWith(source + path.sep), 'Test runtime must be outside the source runtime');
    fs.cpSync(source, destination, { recursive:true,filter:(file) => file !== sourceApp && !file.startsWith(sourceApp + path.sep) && file !== path.join(source, 'resources', 'app.asar') });
    fs.writeFileSync(marker, source);
  }
  const appDirectory = path.join(destination, 'resources', 'app');
  fs.mkdirSync(appDirectory, { recursive:true });
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({ name:'deepscord-keyboard-probe',version:'1.0.0',main:'main.cjs' }));
  fs.writeFileSync(path.join(appDirectory, 'main.cjs'), `require(${JSON.stringify(__filename)});`);
  /** @type {NodeJS.ProcessEnv} */
  const environment = { ...process.env,DEEPSCORD_SHORTCUT_TEST_DATA:fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-keyprobe-')) };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(destination, path.basename(binary)), [], { env:environment,windowsHide:false,stdio:'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native keyboard probe exceeded 20000 ms')); }, 20000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(undefined); else reject(new Error(`Keyboard probe exited ${code}`)); });
  });
}

/** @returns {Promise<void>} */
async function pressShortcut() {
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+{F11}')"], { windowsHide:true,stdio:'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => { if (code === 0) resolve(undefined); else reject(new Error(`Keyboard injection exited ${code}`)); });
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/** @returns {Promise<void>} */
async function runElectron() {
  const { app,BrowserWindow,globalShortcut } = require('electron');
  const { createDesktopFeatures } = require('./desktop-features.cjs');
  const directory = process.env.DEEPSCORD_SHORTCUT_TEST_DATA;
  assert(directory);
  app.setPath('userData', directory);
  await app.whenReady();
  const window = new BrowserWindow({ show:true,title:'Controlled keyboard probe',webPreferences:{ preload:path.join(__dirname, 'preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false } });
  const features = createDesktopFeatures({ getWindow:() => window,userData:directory });
  try {
    await window.loadFile(path.join(__dirname, 'desktop-test-page.html'));
    window.show(); window.focus();
    features.saveSettings({ ...features.getSettings(),muteShortcut:'Control+Shift+F11' });
    await window.webContents.executeJavaScript('window.shortcutCount=0; window.unsubscribeShortcut=window.deepscord.onMuteShortcut(()=>{window.shortcutCount+=1}); void 0;');
    assert(window.isFocused(), 'The first probe must own foreground focus');
    assert(globalShortcut.isRegistered('Control+Shift+F11'));
    await pressShortcut();
    assert.equal(await window.webContents.executeJavaScript('window.shortcutCount'), 1, 'Foreground shortcut must deliver exactly one event');
    window.hide();
    assert(!window.isVisible());
    await pressShortcut();
    assert.equal(await window.webContents.executeJavaScript('window.shortcutCount'), 2, 'Hidden-window shortcut must deliver exactly one additional event');
    await window.webContents.executeJavaScript('window.unsubscribeShortcut()');
    console.log('Real global shortcut passed: one foreground event and one hidden-window event through the OS accelerator and production preload.');
  } finally {
    features.dispose();
    assert(!globalShortcut.isRegistered('Control+Shift+F11'));
    window.destroy();
  }
  app.exit(0);
}

if (process.versions.electron) runElectron().catch((error) => { console.error(error); require('electron').app.exit(1); });
else runNode().catch((error) => { console.error(error); process.exitCode = 1; });
