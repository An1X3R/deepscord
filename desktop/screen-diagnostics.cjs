// @ts-check
'use strict';
const { app, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/network-protocol.js').JsonObject} JsonObject */
/** @typedef {{getWindow:()=>Electron.BrowserWindow|null,assertOwner:(event:Electron.IpcMainInvokeEvent)=>void}} DiagnosticIpcOptions */
/** @param {JsonValue|undefined} value @param {string} field @returns {JsonObject} */
function object(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid GPU diagnostic object: ' + field); return value; }
/** @param {JsonValue|undefined} value @returns {string|null} */
function text(value) { if (value === undefined || value === null) return null; if (typeof value !== 'string' || value.length > 512 || /[\r\n\0]/.test(value)) throw new TypeError('Invalid GPU diagnostic text'); return value; }
/** @param {JsonValue|undefined} value @returns {number|null} */
function number(value) { if (value === undefined || value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Invalid GPU diagnostic number'); return value; }
/** @param {JsonValue|undefined} value @returns {boolean|null} */
function boolean(value) { if (value === undefined || value === null) return null; if (typeof value !== 'boolean') throw new TypeError('Invalid GPU diagnostic boolean'); return value; }
/** @param {JsonValue} input @returns {JsonObject} */
function gpuInfo(input) {
  const raw = object(input, 'report'), aux = object(raw.auxAttributes, 'attributes');
  if (!Array.isArray(raw.gpuDevice) || raw.gpuDevice.length > 64) throw new TypeError('Invalid GPU diagnostic adapter list');
  const adapters = raw.gpuDevice.map(value => { const item = object(value, 'adapter'); return { vendorId: number(item.vendorId), deviceId: number(item.deviceId), deviceString: text(item.deviceString), driverVersion: text(item.driverVersion), active: boolean(item.active) }; });
  /** @type {JsonObject} */ const attributes = {};
  for (const key of ['glRenderer', 'glVendor', 'glVersion', 'glImplementationParts', 'skiaBackendType']) attributes[key] = text(aux[key]);
  for (const key of ['directComposition', 'supportsOverlays', 'supportsD3dSharedImages', 'inProcessGpu']) attributes[key] = boolean(aux[key]);
  return { adapters, attributes };
}
/** @returns {Promise<JsonObject>} */
async function environment() {
  const cpus = os.cpus();
  /** @type {JsonObject} */ const features = {};
  for (const [key, value] of Object.entries(app.getGPUFeatureStatus())) features[key] = text(value);
  return { runtime: { application: app.getVersion(), electron: process.versions.electron ?? null, chromium: process.versions.chrome ?? null, node: process.versions.node, v8: process.versions.v8 }, system: { platform: process.platform, arch: process.arch, release: os.release(), logicalProcessors: cpus.length, cpuModel: cpus[0]?.model ?? null, totalMemoryBytes: os.totalmem() }, gpu: { hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(), features, ...gpuInfo(/** @type {JsonValue} */ (await app.getGPUInfo('complete'))) } };
}

/** @param {DiagnosticIpcOptions} options @returns {void} */
function registerScreenDiagnostics(options) {
  let active = false;
  ipcMain.handle('screen-diagnostics:export', async (event, /** @type {JsonValue} */ input) => {
    options.assertOwner(event);
    const window = options.getWindow();
    if (!window || window.isDestroyed()) throw new Error('屏幕诊断导出失败：客户端窗口已经关闭');
    if (active) throw new Error('屏幕诊断导出已在进行，请等待当前操作完成');
    const serialized = JSON.stringify(input);
    if (typeof serialized !== 'string') throw new TypeError('Screen diagnostic export requires a JSON report');
    if (Buffer.byteLength(serialized, 'utf8') > 1048576) throw new RangeError('Screen diagnostic payload exceeds one MiB');
    active = true;
    try {
      const schema = await import(pathToFileURL(path.join(__dirname, 'app-server', 'public', 'js', 'screen-diagnostics.js')).href);
      const report = /** @type {{parseScreenDiagnosticReport:(value:JsonValue)=>JsonObject}} */ (schema).parseScreenDiagnosticReport(input);
      const machine = await environment();
      options.assertOwner(event);
      const choice = await dialog.showSaveDialog(window, { title: '导出屏幕诊断', defaultPath: 'Deepscord-screen-diagnostics.json', filters: [{ name: 'JSON 诊断', extensions: ['json'] }] });
      if (choice.canceled) return { status: 'cancelled' };
      if (!choice.filePath || !path.isAbsolute(choice.filePath)) throw new TypeError('屏幕诊断导出失败：没有返回有效的保存路径');
      await fs.writeFile(choice.filePath, JSON.stringify({ ...report, environment: machine }, null, 2) + '\n', { encoding: 'utf8' });
      return { status: 'saved' };
    } catch (error) {
      const failure = error instanceof Error ? error : new TypeError('Screen diagnostic export rejected with a non-error');
      throw new Error('屏幕诊断导出失败：' + failure.message, { cause: failure });
    } finally { active = false; }
  });
}
module.exports = { registerScreenDiagnostics };
