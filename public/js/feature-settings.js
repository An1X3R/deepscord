// @ts-check
import { captureShortcut } from './shortcut-capture.js';

/** @typedef {{enabled:boolean,locked:boolean,x:number,y:number,width:number,height:number,scale:number,showRadio:boolean,showScreen:boolean}} OverlaySettings */
/** @typedef {{muteShortcut:string,deafenShortcut:string,overlay:OverlaySettings}} DesktopSettings */

/** @param {DesktopSettings} settings @param {(settings:DesktopSettings)=>Promise<void>} onSave @param {(error:Error)=>void} reportError @returns {HTMLElement} */
export function createFeatureSettings(settings, onSave, reportError) {
  const section = document.createElement('section');
  section.className = 'settings-section feature-settings';
  section.dataset.testid = 'desktop-feature-settings';
  const heading = document.createElement('h3'); heading.textContent = '全局按键与语音覆盖层';
  const description = document.createElement('p'); description.className = 'setting-hint'; description.textContent = '全局静音与闭音在其他应用中也有效。点击快捷键框后按下单键或组合键，Escape 取消；本版不支持清空。单键也会在打字时触发静音。按住说话使用语音设置中的单键，连接语音后在后台也有效，不拦截游戏输入。覆盖层显示同频道成员与发言状态。';
  const form = document.createElement('form'); form.className = 'feature-settings-form';
  /** @param {string} label @param {HTMLInputElement} input */
  function field(label, input) {
    const row = document.createElement('label'); row.className = 'feature-setting-field';
    const text = document.createElement('span'); text.textContent = label;
    row.append(text, input); form.append(row);
  }
  const shortcut = document.createElement('input'); shortcut.type = 'text'; shortcut.value = settings.muteShortcut;
  shortcut.dataset.testid = 'global-mute-shortcut'; shortcut.placeholder = '点击后按下单键或组合键'; shortcut.maxLength = 80;
  shortcut.readOnly = true; shortcut.setAttribute('aria-label', '全局静音快捷键，点击录入');
  field('全局静音快捷键', shortcut);
  const deafen = document.createElement('input'); deafen.type = 'text'; deafen.value = settings.deafenShortcut;
  deafen.dataset.testid = 'global-deafen-shortcut'; deafen.readOnly = true; deafen.maxLength = 80; deafen.setAttribute('aria-label', '全局闭音快捷键，点击录入');
  field('全局闭音快捷键', deafen);
  /** @param {'enabled'|'locked'|'showRadio'|'showScreen'} key @param {string} label @returns {HTMLInputElement} */
  function checkbox(key, label) {
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = settings.overlay[key]; input.dataset.testid = `overlay-${key}`;
    field(label, input); return input;
  }
  const enabled = checkbox('enabled', '开启语音覆盖层');
  const showRadio = checkbox('showRadio', '覆盖层显示当前电台曲目');
  const showScreen = checkbox('showScreen', '覆盖层显示成员投屏标识');
  const scale = document.createElement('input'); scale.type = 'range'; scale.className = 'slider'; scale.style.width = '160px'; scale.min = '0.6'; scale.max = '2'; scale.step = '0.05'; scale.value = String(settings.overlay.scale); scale.dataset.testid = 'overlay-scale';
  field('覆盖层内容缩放', scale);
  const adjust = document.createElement('button'); adjust.type = 'button'; adjust.className = 'btn ghost'; adjust.textContent = '调整覆盖层位置与大小'; adjust.dataset.testid = 'overlay-adjust';
  form.append(adjust);
  /** @returns {Promise<DesktopSettings>} */
  async function latestSettings() {
    const bridge = /** @type {Window & {deepscord?:{getDesktopSettings:()=>Promise<DesktopSettings>}}} */ (window).deepscord;
    if (!bridge) throw new Error('覆盖层调整需要桌面客户端');
    return bridge.getDesktopSettings();
  }
  adjust.addEventListener('click', () => {
    adjust.disabled = true;
    void latestSettings().then(current => onSave({ ...current, overlay:{ ...current.overlay,enabled:true,locked:false } })).then(() => {
      enabled.checked = true;
      status.textContent = '拖动浮层顶部移动，拖动右下角调整大小；完成后点击浮层内的“完成调整”';
    }).catch(error => reportError(error instanceof Error ? error : new TypeError(String(error)))).finally(() => { adjust.disabled = false; });
  });
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn primary'; submit.textContent = '应用桌面设置'; submit.dataset.testid = 'desktop-settings-save';
  const status = document.createElement('p'); status.className = 'feature-settings-status'; status.setAttribute('role', 'status'); status.dataset.testid = 'desktop-settings-status';
  form.append(submit, status); section.append(heading, description, form);
  let capturing = false;
  /** @param {HTMLInputElement} control @returns {Promise<void>} */
  async function recordShortcut(control) {
    if (capturing) return;
    const bridge = /** @type {Window & {deepscord?:Partial<import('./shortcut-capture.js').ShortcutCaptureBridge>}} */ (window).deepscord;
    if (typeof bridge?.beginShortcutCapture !== 'function' || typeof bridge.endShortcutCapture !== 'function') throw new DOMException('当前桌面客户端不支持键盘录入，请更新客户端', 'NotSupportedError');
    const begin = bridge.beginShortcutCapture, end = bridge.endShortcutCapture;
    capturing = true; submit.disabled = true; control.classList.add('capturing'); control.setAttribute('aria-busy', 'true');
    try {
      const value = await captureShortcut(control, { beginShortcutCapture:()=>begin(), endShortcutCapture:id=>end(id) }, message => { status.textContent = message; });
      if (value) { control.value = value; status.textContent = '快捷键已录入；点击“应用桌面设置”后生效'; }
      else status.textContent = '录入已取消，原快捷键保持不变';
    } finally { capturing = false; submit.disabled = false; control.classList.remove('capturing'); control.removeAttribute('aria-busy'); }
  }
  for (const control of [shortcut,deafen]) {
    control.addEventListener('click', () => { void recordShortcut(control).catch(error => { status.textContent = '快捷键录入失败：' + (error instanceof Error ? error.message : String(error)); reportError(error instanceof Error ? error : new TypeError(String(error))); }); });
    control.addEventListener('keydown', event => { if (!capturing && (event.code === 'Enter' || event.code === 'Space')) { event.preventDefault(); control.click(); } });
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (capturing) return;
    if (!form.reportValidity()) return;
    submit.disabled = true; status.textContent = '正在应用…';
    void latestSettings().then(current => onSave({ ...current,muteShortcut:shortcut.value.trim(),deafenShortcut:deafen.value.trim(),overlay:{ ...current.overlay,enabled:enabled.checked,locked:true,scale:Number(scale.value),showRadio:showRadio.checked,showScreen:showScreen.checked } })).then(() => { status.textContent = '桌面设置已应用'; }).catch((error) => {
      status.textContent = '设置未应用，请检查错误信息后重试。';
      reportError(error instanceof Error ? error : new TypeError(String(error)));
    }).finally(() => { submit.disabled = false; });
  });
  return section;
}
