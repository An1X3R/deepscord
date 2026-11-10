// @ts-check
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sources = ['desktop/desktop-features.cjs','desktop/desktop-schema.cjs','desktop/preload.js','public/js/shortcut-capture.js','public/js/feature-settings.js'];
/** @param {string} file @returns {string} */
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
/** @param {Electron.BrowserWindow} window @param {string} expression @returns {Promise<void>} */
async function wait(window, expression) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await window.webContents.executeJavaScript(expression)) return; await delay(40); }
  throw new Error('Shortcut integration state timed out: ' + expression);
}
/** @param {string} keys @returns {Promise<void>} */
async function press(keys) {
  assert(/^[A-Za-z0-9^%+{}]+$/.test(keys), 'Only explicit OS test key sequences are allowed');
  await new Promise((resolve, reject) => {
    assert(process.env.SystemRoot, 'Actual Windows SystemRoot is required');
    const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(shell, ['-NoProfile','-NonInteractive','-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('" + keys + "')"], { windowsHide:true, stdio:'pipe' });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(undefined) : reject(new Error('Actual OS key injection failed: ' + stderr)));
  });
  await delay(250);
}
/** @returns {Promise<void>} */
async function electronMain() {
  const { app, BrowserWindow, globalShortcut } = require('electron');
  const output = process.env.SHORTCUT_OUTPUT, origin = process.env.SHORTCUT_ORIGIN;
  assert(output && origin, 'Explicit owned output and origin required');
  const profile = path.join(output, 'profile'); app.setPath('userData', profile);
  fs.mkdirSync(profile, { recursive:true });
  const { initialSettings } = require('../desktop/desktop-schema.cjs');
  fs.writeFileSync(path.join(profile, 'desktop-settings.json'), JSON.stringify({ ...initialSettings(), muteShortcut:'Control+Shift+F11' }));
  await app.whenReady();
  const window = new BrowserWindow({ show:false, width:960, height:800, webPreferences:{ preload:path.join(root, 'desktop/preload.js'), contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  const features = require('../desktop/desktop-features.cjs').createDesktopFeatures({ getWindow:()=>window, userData:profile });
  /** @type {string[]} */ const checks = [];
  /** @param {string} message @returns {void} */
  function check(message) { checks.push(message); console.log(JSON.stringify({ event:'shortcut_check', message })); }
  /** @returns {Promise<void>} */
  async function begin() {
    window.show(); window.focus(); assert(window.isFocused(), 'Actual OS keyboard capture requires foreground focus');
    await window.webContents.executeJavaScript("document.querySelector('[data-testid=global-mute-shortcut]').click()");
    await wait(window, "document.querySelector('[data-testid=global-mute-shortcut]').getAttribute('aria-busy')==='true'");
    await delay(100);
    assert(!features.getShortcutStatus().registered, 'The old OS accelerator must be suspended before key capture');
  }
  /** @returns {Promise<void>} */
  async function finished() { await wait(window, "!document.querySelector('[data-testid=global-mute-shortcut]').hasAttribute('aria-busy')"); }
  try {
    await window.loadURL(origin); await wait(window, 'window.shortcutReady===true');
    window.show(); window.focus(); await press('^+{F11}');
    assert.equal((await window.webContents.executeJavaScript('window.shortcutEvidence()')).mutes, 1);
    await begin(); await press('^+{F11}'); await finished();
    assert.equal((await window.webContents.executeJavaScript('window.shortcutEvidence()')).mutes, 1);
    assert(globalShortcut.isRegistered('Control+Shift+F11'));
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-testid=global-mute-shortcut]').value"), 'Control+Shift+F11');
    check('Actual OS old shortcut is captured without muting and restored after key release');
    await begin(); await press('^%{F10}'); await finished();
    await window.webContents.executeJavaScript("document.querySelector('[data-testid=desktop-settings-save]').click()");
    await wait(window, "document.querySelector('[data-testid=desktop-settings-status]').textContent==='桌面设置已应用'");
    assert.equal(features.getSettings().muteShortcut, 'Control+Alt+F10');
    assert(!globalShortcut.isRegistered('Control+Shift+F11')); assert(globalShortcut.isRegistered('Control+Alt+F10'));
    await press('^%{F10}');
    assert.equal((await window.webContents.executeJavaScript('window.shortcutEvidence()')).mutes, 2);
    check('Actual OS modifier combination persists through real settings IPC and activates the replacement');
    await begin(); await press('k'); await finished();
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-testid=global-mute-shortcut]').value"), 'K');
    await window.webContents.executeJavaScript("document.querySelector('[data-testid=desktop-settings-save]').click()");
    await wait(window, "document.querySelector('[data-testid=desktop-settings-status]').textContent==='桌面设置已应用'");
    assert(globalShortcut.isRegistered('K'));
    await press('k');
    assert.equal((await window.webContents.executeJavaScript('window.shortcutEvidence()')).mutes, 3);
    check('Single K is captured, persisted and activated by a real OS keypress');
    await begin(); await press('{F9}'); await finished();
    await window.webContents.executeJavaScript("document.querySelector('[data-testid=desktop-settings-save]').click()");
    await wait(window, "document.querySelector('[data-testid=desktop-settings-status]').textContent==='桌面设置已应用'");
    assert(globalShortcut.isRegistered('F9')); assert(!globalShortcut.isRegistered('K'));
    await press('{F9}');
    assert.equal((await window.webContents.executeJavaScript('window.shortcutEvidence()')).mutes, 4);
    features.saveSettings({ ...features.getSettings(),muteShortcut:'Control+Alt+F10' });
    await window.webContents.executeJavaScript("document.querySelector('[data-testid=global-mute-shortcut]').value='Control+Alt+F10'");
    assert(!globalShortcut.isRegistered('F9'));
    check('Single F9 activates natively and replacing it releases both temporary single-key registrations');
    await begin(); await press('{DELETE}');
    await wait(window, "document.querySelector('[data-testid=desktop-settings-status]').textContent.includes('不支持清空')");
    assert.match(await window.webContents.executeJavaScript("document.querySelector('[data-testid=desktop-settings-status]').textContent"), /不支持清空/);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-testid=global-mute-shortcut]').value"), 'Control+Alt+F10');
    await press('{ESC}'); await finished(); assert(globalShortcut.isRegistered('Control+Alt+F10'));
    check('Delete explicitly retains the prior value; Escape cancels and restores the OS registration');
    await begin(); await press('^%+{F12}'); await finished();
    assert(globalShortcut.register('Control+Alt+Shift+F12', ()=>{}), 'Conflict injection must own a real OS registration');
    await window.webContents.executeJavaScript("document.querySelector('[data-testid=desktop-settings-save]').click()");
    await wait(window, 'window.shortcutEvidence().errors.length===1');
    assert.equal(features.getSettings().muteShortcut, 'Control+Alt+F10'); assert(globalShortcut.isRegistered('Control+Alt+F10'));
    assert.match((await window.webContents.executeJavaScript('window.shortcutEvidence()')).errors[0], /previous shortcut remains active/);
    globalShortcut.unregister('Control+Alt+Shift+F12');
    check('A real competing accelerator rejects replacement and preserves the saved and active previous shortcut');
    await begin(); window.hide(); await finished(); assert(globalShortcut.isRegistered('Control+Alt+F10'));
    check('Actual application blur cancels capture and restores the saved shortcut');
    await begin();
    assert(globalShortcut.register('Control+Alt+F10', ()=>{}), 'Restoration conflict must occupy the actual suspended accelerator');
    await press('{ESC}'); await finished();
    await wait(window, 'window.shortcutEvidence().errors.length===2');
    assert.equal(features.getShortcutStatus().registered, false);
    assert.match(features.getShortcutStatus().error || '', /unavailable/);
    assert.equal(features.getSettings().muteShortcut, 'Control+Alt+F10');
    globalShortcut.unregister('Control+Alt+F10');
    features.saveSettings(features.getSettings());
    check('A real accelerator conflict during restoration reports failure and never claims the shortcut was restored');
    await begin(); await delay(20500); await finished();
    assert(globalShortcut.isRegistered('Control+Alt+F10'));
    assert.match((await window.webContents.executeJavaScript('window.shortcutEvidence()')).errors[2], /20 秒/);
    check('The real idle capture timeout reports its cause and restores the previous accelerator');
    fs.writeFileSync(path.join(output, 'settings.png'), (await window.webContents.capturePage()).toPNG());
    await begin(); await window.webContents.executeJavaScript("document.querySelector('[data-testid=desktop-feature-settings]').remove()");
    await wait(window, 'window.deepscord.getShortcutStatus().then(status=>status.registered)');
    assert(globalShortcut.isRegistered('Control+Alt+F10'));
    check('Removing the settings UI releases the actual desktop capture lease');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ status:'passed', checks, evidence:await window.webContents.executeJavaScript('window.shortcutEvidence()'), settings:features.getSettings() }, null, 2));
  } catch (error) { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ status:'failed', checks, state:await window.webContents.executeJavaScript("({evidence:window.shortcutEvidence?.(),status:document.querySelector('[data-testid=desktop-settings-status]')?.textContent,focused:document.hasFocus()})"), failure:error instanceof Error ? { message:error.message, stack:error.stack } : String(error) }, null, 2)); throw error; }
  finally { features.dispose(); assert(!globalShortcut.isRegistered('Control+Alt+F10')); window.destroy(); }
  app.exit(0);
}
/** @returns {Promise<void>} */
async function parentMain() {
  const binary = process.env.ELECTRON_TEST_BINARY;
  assert(binary && path.isAbsolute(binary) && fs.existsSync(binary), 'Explicit real ELECTRON_TEST_BINARY required');
  const source = path.dirname(binary), runtime = path.join(root, '.qa-tools/global-shortcut-capture-runtime'), marker = path.join(runtime, '.owner.json');
  const identity = JSON.stringify({ entry:__filename, binary, sha256:hash(binary) });
  if (!fs.existsSync(runtime)) { const app = path.join(source, 'resources/app'); assert(!runtime.startsWith(source + path.sep)); fs.cpSync(source, runtime, { recursive:true, filter:file=>file !== app && !file.startsWith(app + path.sep) && file !== path.join(source, 'resources/app.asar') }); fs.writeFileSync(marker, identity, { flag:'wx' }); }
  else assert.equal(fs.readFileSync(marker, 'utf8'), identity, 'Owned runtime identity differs');
  const app = path.join(runtime, 'resources/app'); fs.mkdirSync(app, { recursive:true }); fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name:'shortcut-capture-test', version:'1.0.0', main:'main.cjs' })); fs.writeFileSync(path.join(app, 'main.cjs'), 'require(' + JSON.stringify(__filename) + ');\n');
  const output = path.join(root, '.qa-tools/results/global-shortcut', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')); fs.mkdirSync(output, { recursive:true });
  const before = sources.map(file=>({ file, sha256:hash(path.join(root, file)) })); fs.writeFileSync(path.join(output, 'source-hashes.json'), JSON.stringify(before, null, 2));
  const allowed = ['test/global-shortcut-page.html','test/global-shortcut-page.js','public/js/feature-settings.js','public/js/shortcut-capture.js','public/app.css'];
  const server = http.createServer((request, response)=>{ const url = new URL(request.url || '/', 'http://127.0.0.1'); const relative = url.pathname === '/' ? allowed[0] : url.pathname.slice(1); if (!allowed.includes(relative)) { response.writeHead(404); response.end(); return; } response.writeHead(200, { 'content-type':relative.endsWith('.html')?'text/html':relative.endsWith('.css')?'text/css':'text/javascript', 'cache-control':'no-store' }); response.end(fs.readFileSync(path.join(root, relative))); });
  await new Promise((resolve, reject)=>{ server.once('error', reject); server.listen(0, '127.0.0.1', ()=>resolve(undefined)); });
  const address = server.address(); assert(address && typeof address !== 'string');
  /** @type {NodeJS.ProcessEnv} */ const environment = { ...process.env, SHORTCUT_OUTPUT:output, SHORTCUT_ORIGIN:'http://127.0.0.1:' + address.port }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(runtime, path.basename(binary)), [], { windowsHide:true, env:environment, stdio:['ignore','pipe','pipe'] });
  let log = ''; child.stdout.on('data', chunk=>{ log += String(chunk); process.stdout.write(chunk); }); child.stderr.on('data', chunk=>{ log += String(chunk); });
  try {
    const code = await new Promise((resolve, reject)=>{ const timer = setTimeout(()=>{ child.kill(); reject(new Error('Actual OS shortcut integration exceeded 60000ms')); }, 60000); child.once('error', error=>{ clearTimeout(timer); reject(error); }); child.once('exit', code=>{ clearTimeout(timer); resolve(code); }); });
    assert.equal(code, 0, 'Actual keyboard integration failed: ' + output);
    assert.deepEqual(sources.map(file=>({ file, sha256:hash(path.join(root, file)) })), before, 'Production sources changed during actual test');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); server.close(); fs.writeFileSync(path.join(output, 'electron.log'), log); await fs.promises.rm(path.join(output, 'profile'), { recursive:true, force:true, maxRetries:6, retryDelay:200 }); fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify({ pid:child.pid, exitCode:child.exitCode, signal:child.signalCode, profileExists:fs.existsSync(path.join(output, 'profile')) }, null, 2)); console.log(JSON.stringify({ event:'shortcut_finished', output })); }
}
if (process.versions.electron) electronMain().catch(error=>{ console.error(error); require('electron').app.exit(1); });
else parentMain().catch(error=>{ console.error(error); process.exitCode = 1; });
