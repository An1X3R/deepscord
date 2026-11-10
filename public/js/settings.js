/* 设置面板：设备选择 / 输入模式 / 音量 / 个人资料 */

import { el, store } from './util.js';
import { icon } from './icons.js';
import { openModal, toast } from './ui.js';
import { prepareAvatar } from './profile.js';
import { createFeatureSettings } from './feature-settings.js';
import { DEFAULT_SCREEN_PREFERENCES, getScreenPreferences } from './screen-preferences.js';
import { createScreenSettings } from './screen-settings.js';
import {parseInterfaceProfile,INTERFACE_PRESETS} from './interface-profile.js';
import { parseTheme } from './customization-protocol.js';
import {developerGuideLink} from './developer-guides.js';
import {resourceManagerLink} from './resource-manager-link.js';
import {parseInterfaceSelection,resolveInterfaceScheme} from './interface-scheme.js';

export const SETTINGS_KEY = 'echo.settings';

export const DEFAULT_SETTINGS = {
  name: '',
  avatar: null,
  peerVolumes: {},
  color: '#7c6cf5',
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  micVolume: 100,
  outVolume: 100,
  radioVolume: 10,
  mode: 'vad',
  pttKey: 'KeyV',
  vadThreshold: -42,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  monitor: false,
  sounds: true,
  interactionSounds: true,
  interactionVolume: 20,
  membersOpen: true,
  screenPreferences: DEFAULT_SCREEN_PREFERENCES,
  interfaceProfile: INTERFACE_PRESETS.industrial,
  interfaceSelection: null,
  localTheme: /** @type {import('./customization-protocol.js').Theme|null} */ (null),
};

/** @typedef {import('./microphone-capture.js').CapturePreferences} CapturePreferences */

export function loadSettings() {
  const saved = store.get(SETTINGS_KEY, {}) || {};
  const radioVolume = saved.radioVolume === undefined ? 10 : saved.radioVolume;
  if (typeof radioVolume !== 'number' || !Number.isFinite(radioVolume) || radioVolume < 0 || radioVolume > 100) throw new RangeError('Radio volume must be between 0 and 100');
  const interfaceSelection=saved.interfaceSelection==null?null:parseInterfaceSelection(saved.interfaceSelection);
  const resolved=interfaceSelection?resolveInterfaceScheme(interfaceSelection.scheme,interfaceSelection.values):null;
  return { ...DEFAULT_SETTINGS, ...saved, radioVolume,interfaceSelection,
    interfaceProfile: resolved?.interfaceProfile ?? (saved.interfaceProfile===undefined?INTERFACE_PRESETS.industrial:parseInterfaceProfile(saved.interfaceProfile)),
    localTheme: resolved ? resolved.theme : saved.localTheme === undefined || saved.localTheme === null ? null : parseTheme(saved.localTheme),
    screenPreferences: getScreenPreferences(saved, true) };
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent('deepscord-settings-changed'));
  if (typeof window.deepscord?.saveClientPreferences === 'function') {
    window.deepscord.saveClientPreferences(settings).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('client_preferences_save_failed', { message });
      toast('设置已应用，但未能保存到本机：' + message, 'error', 5000);
    });
  }
}

const KEY_LABELS = {
  Space: '空格',
  Enter: '回车',
  Escape: 'Esc',
  Backquote: '`',
  ShiftLeft: '左 Shift',
  ShiftRight: '右 Shift',
  ControlLeft: '左 Ctrl',
  ControlRight: '右 Ctrl',
  AltLeft: '左 Alt',
  AltRight: '右 Alt',
  Tab: 'Tab',
  CapsLock: 'Caps',
  Mouse4: '鼠标侧键 1',
  Mouse5: '鼠标侧键 2',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

export function keyLabel(code) {
  if (!code) return '未设置';
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return '小键盘 ' + code.slice(6);
  if (code.startsWith('F') && /^F\d{1,2}$/.test(code)) return code;
  return code;
}

function levelToPercent(level) {
  const db = 20 * Math.log10(level + 1e-7);
  return Math.max(0, Math.min(100, ((db + 70) / 70) * 100));
}

function dbToPercent(db) {
  return Math.max(0, Math.min(100, ((db + 70) / 70) * 100));
}

async function listDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    return { inputs: [], outputs: [] };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const outputs = devices.filter((d) => d.kind === 'audiooutput');
  return { inputs, outputs };
}

function section(title, hint) {
  return el(
    'section',
    { class: 'settings-section' },
    el('h3', {}, title),
    hint ? el('p', { class: 'settings-hint' }, hint) : null
  );
}

function row(label, control, hint) {
  return el(
    'div',
    { class: 'setting-row' },
    el('div', { class: 'setting-label' }, el('span', {}, label), hint ? el('small', {}, hint) : null),
    el('div', { class: 'setting-control' }, control)
  );
}

export function openSettingsPanel({ settings, engine, onIdentityChange, desktopSettings, onDesktopSettingsChange }) {
  const body = el('div', { class: 'settings' });

  /* ---------------- 个人资料 ---------------- */
  const profile = section('个人资料');
  const nameInput = el('input', {
    class: 'input', id: 'profileName',
    value: settings.name || '',
    maxlength: '24',
    placeholder: '你的昵称',
    autocomplete: 'off',
  });
  const colorRow = el('div', { class: 'swatches' });
  const colors = [
    '#7c6cf5', '#4dd4ac', '#ff8a5c', '#4aa8ff', '#f25f8b',
    '#f5c451', '#8f7dff', '#3ecf8e', '#ff6b6b', '#59c7f0',
  ];
  let currentColor = settings.color;
  const swatchButtons = [];
  for (const c of colors) {
    const b = el('button', {
      class: 'swatch' + (c === currentColor ? ' active' : ''),
      title: c,
      style: { background: c },
      type: 'button',
    });
    b.addEventListener('click', () => {
      currentColor = c;
      settings.color = c;
      saveSettings(settings);
      for (const btn of swatchButtons) btn.classList.toggle('active', btn === b);
      onIdentityChange?.(settings);
    });
    swatchButtons.push(b);
    colorRow.appendChild(b);
  }
  let nameTimer = null;
  nameInput.addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      const v = nameInput.value.trim().slice(0, 24);
      if (!v) return;
      settings.name = v;
      saveSettings(settings);
      onIdentityChange?.(settings);
    }, 350);
  });
  profile.appendChild(row('昵称', nameInput, '对其他成员显示的名字'));
  profile.appendChild(row('头像颜色', colorRow));
  const avatarFile = el('input', { type: 'file', id: 'profileAvatarFile', accept: 'image/jpeg,image/png,image/webp' });
  const avatarPreview = el('img', { id: 'profileAvatarPreview', width: '64', height: '64', alt: '个人头像', style: { objectFit: 'cover' } });
  avatarPreview.hidden = !settings.avatar;
  if (settings.avatar) avatarPreview.src = settings.avatar;
  avatarFile.addEventListener('change', async () => {
    const file = avatarFile.files?.[0];
    if (!file) return;
    try {
      const avatar = await prepareAvatar(file);
      settings.avatar = avatar;
      avatarPreview.src = avatar;
      avatarPreview.hidden = false;
      saveSettings(settings);
      onIdentityChange(settings);
    } catch (error) { toast('头像设置失败：' + (error instanceof Error ? error.message : String(error)), 'error', 5000); }
  });
  const clearAvatar = el('button', { type: 'button', class: 'btn ghost small', id: 'profileAvatarClear' }, '使用文字头像');
  clearAvatar.addEventListener('click', () => { settings.avatar = null; avatarPreview.removeAttribute('src'); avatarPreview.hidden = true; saveSettings(settings); onIdentityChange(settings); });
  profile.appendChild(row('固定头像', el('div', { class: 'profile-avatar-controls' }, avatarPreview, avatarFile, clearAvatar), '保存在本机，加入房间时自动同步；压缩为96×96，不超过12KB。'));
  body.appendChild(profile);

  const nativeScreenRelayAvailable = typeof window.deepscord?.screenRelayOffer === 'function';
  body.appendChild(createScreenSettings(getScreenPreferences(settings, true), nativeScreenRelayAvailable,
    async (preferences) => {
      const next = { ...settings, screenPreferences: preferences };
      saveSettings(next);
      settings.screenPreferences = preferences;
      await engine.updateScreenPreferences();
    }, (error) => toast(error.message, 'error', 5000)));

  /* ---------------- 语音设备 ---------------- */
  const deviceSec = section('语音设备', '说话前先在浏览器允许麦克风权限；局域网访问需要 HTTPS。');
  const inputSelect = el('select', { class: 'select', id: 'audioInputDevice' });
  const outputSelect = el('select', { class: 'select', id: 'audioOutputDevice' });
  const refreshBtn = el('button', { class: 'btn ghost small', type: 'button' }, '刷新设备');
  const testBtn = el('button', { class: 'btn ghost small', type: 'button', id: 'audioTestMic' }, '测试麦克风');
  const captureStatus = el('p', { class: 'settings-hint', id: 'audioCaptureStatus', role: 'status', 'aria-live': 'polite' });
  let captureRevision = 0;
  let outputRevision = 0;
  let appliedOutputDeviceId = settings.outputDeviceId;
  /** @returns {CapturePreferences} */
  const currentCapturePreferences = () => ({
    inputDeviceId: settings.inputDeviceId,
    echoCancellation: settings.echoCancellation !== false,
    noiseSuppression: settings.noiseSuppression !== false,
    autoGainControl: settings.autoGainControl !== false,
  });
  const initialCapturePreferences = engine.getCaptureInfo().applied;
  let lastSuccessfulCapturePreferences = initialCapturePreferences
    ? { ...initialCapturePreferences }
    : currentCapturePreferences();

  function renderCaptureStatus() {
    const info = engine.getCaptureInfo();
    let text;
    if (info.pending) {
      text = '麦克风设置应用中…';
    } else if (info.error) {
      text = info.actual
        ? `应用失败，保留${info.actual.deviceLabel || '当前输入'}：${info.error}`
        : `采集失败：没有可用麦克风。${info.error}`;
    } else if (!info.actual) {
      text = '待开麦；实际增强状态将在采集后显示。';
    } else {
      const actual = info.actual;
      const values = [
        ['回声消除', actual.echoCancellation],
        ['噪声抑制', actual.noiseSuppression],
        ['自动增益', actual.autoGainControl],
      ];
      text = values.some(([, value]) => typeof value !== 'boolean')
        ? `当前输入：${actual.deviceLabel || '麦克风'}；增强实际状态待确认。`
        : `当前输入：${actual.deviceLabel || '麦克风'}；实际状态：${values.map(([label, value]) => `${label}${value ? '开' : '关'}`).join(' · ')}。`;
    }
    if (captureStatus.textContent !== text) captureStatus.textContent = text;
  }

  /**
   * @param {Partial<CapturePreferences>} patch
   * @returns {Promise<void>}
   */
  async function applyCaptureChange(patch) {
    const revision = ++captureRevision;
    Object.assign(settings, patch);
    renderCaptureStatus();
    try {
      const operation = engine.applySettings(patch);
      renderCaptureStatus();
      await operation;
      if (revision !== captureRevision) return;
      lastSuccessfulCapturePreferences = currentCapturePreferences();
      saveSettings(settings);
      renderCaptureStatus();
      if ('inputDeviceId' in patch) toast('麦克风切换已应用', 'success', 1800);
    } catch (error) {
      if (revision !== captureRevision) return;
      const applied = engine.getCaptureInfo().applied;
      const restore = applied ? { ...applied } : { ...lastSuccessfulCapturePreferences };
      Object.assign(settings, restore);
      inputSelect.value = restore.inputDeviceId;
      for (const [key, id] of /** @type {const} */ ([
        ['echoCancellation', 'audioEchoCancellation'],
        ['noiseSuppression', 'audioNoiseSuppression'],
        ['autoGainControl', 'audioAutoGainControl'],
      ])) {
        const checkbox = document.getElementById(id);
        if (checkbox instanceof HTMLInputElement) checkbox.checked = restore[key];
      }
      saveSettings(settings);
      renderCaptureStatus();
      toast('麦克风设置未应用：' + (error.message || error), 'error', 5000);
    }
  }

  function fillDevices(inputs, outputs) {
    inputSelect.innerHTML = '';
    inputSelect.appendChild(el('option', { value: 'default' }, '系统默认麦克风'));
    inputs.forEach((d, i) => {
      inputSelect.appendChild(
        el('option', { value: d.deviceId }, d.label || `麦克风 ${i + 1}`)
      );
    });
    inputSelect.value = settings.inputDeviceId;
    if (inputSelect.value !== settings.inputDeviceId) {
      inputSelect.appendChild(el('option', { value: settings.inputDeviceId }, '设备当前不可用'));
      inputSelect.value = settings.inputDeviceId;
    }

    outputSelect.innerHTML = '';
    outputSelect.appendChild(el('option', { value: 'default' }, '系统默认扬声器'));
    outputs.forEach((d, i) => {
      outputSelect.appendChild(
        el('option', { value: d.deviceId }, d.label || `扬声器 ${i + 1}`)
      );
    });
    outputSelect.value = settings.outputDeviceId;
    if (outputSelect.value !== settings.outputDeviceId) {
      outputSelect.appendChild(el('option', { value: settings.outputDeviceId }, '设备当前不可用'));
      outputSelect.value = settings.outputDeviceId;
    }
    const hasLabels = inputs.some((d) => d.label);
    refreshBtn.textContent = hasLabels ? '刷新设备' : '刷新设备（需先授权麦克风）';
  }

  async function refreshDevices() {
    try {
      const { inputs, outputs } = await listDevices();
      fillDevices(inputs, outputs);
    } catch (err) {
      toast('无法读取音频设备列表：' + (err.message || err), 'error');
    }
  }

  inputSelect.addEventListener('change', async () => {
    await applyCaptureChange({ inputDeviceId: inputSelect.value });
  });
  outputSelect.addEventListener('change', async () => {
    const revision = ++outputRevision;
    const previous = appliedOutputDeviceId;
    settings.outputDeviceId = outputSelect.value;
    try {
      await engine.applySettings({ outputDeviceId: settings.outputDeviceId });
      if (revision !== outputRevision) return;
      appliedOutputDeviceId = settings.outputDeviceId;
      saveSettings(settings);
      toast('扬声器切换已应用', 'success', 1800);
    } catch (error) {
      if (revision !== outputRevision) return;
      settings.outputDeviceId = previous;
      outputSelect.value = previous;
      try {
        await engine.applySettings({ outputDeviceId: previous });
      } catch (rollbackError) {
        toast(`扬声器切换失败：${error.message || error}；恢复旧设备也失败：${rollbackError.message || rollbackError}`, 'error', 6000);
        return;
      }
      toast('扬声器切换失败：' + (error.message || error), 'error', 5000);
    }
  });
  refreshBtn.addEventListener('click', refreshDevices);
  testBtn.addEventListener('click', async () => {
    try {
      await engine.ensureMic();
      toast('麦克风已就绪，对着话筒说话看看电平条', 'success');
      renderCaptureStatus();
      await refreshDevices();
    } catch (err) {
      toast('麦克风打开失败：' + (err.message || err), 'error', 5000);
      renderCaptureStatus();
    }
  });

  deviceSec.appendChild(row('麦克风', inputSelect));
  deviceSec.appendChild(row('扬声器', outputSelect));
  deviceSec.appendChild(
    el('div', { class: 'setting-row compact' }, el('div', { class: 'setting-label' }), el('div', { class: 'setting-control inline' }, refreshBtn, testBtn))
  );

  // 麦克风监听（自听）：把处理后的麦克风声音回放到本机
  const monitorCb = el('input', { type: 'checkbox', id: 'audioMonitor' });
  monitorCb.checked = settings.monitor === true;
  monitorCb.addEventListener('change', async () => {
    const enabled = monitorCb.checked;
    if (enabled) {
      try {
        await engine.ensureMic();
      } catch (err) {
        monitorCb.checked = false;
        settings.monitor = false;
        saveSettings(settings);
        toast('麦克风打开失败：' + (err.message || err), 'error', 5000);
        return;
      }
    }
    const previous = settings.monitor;
    settings.monitor = enabled;
    try {
      await engine.applySettings({ monitor: enabled });
      saveSettings(settings);
    } catch (error) {
      settings.monitor = previous;
      monitorCb.checked = previous;
      toast('麦克风监听设置失败：' + (error.message || error), 'error', 5000);
      return;
    }
    toast(
      enabled ? '麦克风监听已开启：建议戴耳机，外放可能啸叫' : '麦克风监听已关闭',
      enabled ? 'success' : 'info',
      2800
    );
    await refreshDevices();
  });
  deviceSec.appendChild(
    row(
      '监听麦克风',
      monitorCb,
      '监听发送门控前的声音；闭听时暂停，麦克风静音时仍可自听测试。戴耳机时开启，外放可能啸叫'
    )
  );
  body.appendChild(deviceSec);

  /* ---------------- 音量 ---------------- */
  const volSec = section('音量', '切换麦克风增强时会短暂静音，不会退出通话。');
  const micVolValue = el('span', { class: 'value-badge' }, `${settings.micVolume}%`);
  const micVol = el('input', {
    type: 'range', min: '0', max: '200', step: '1', value: String(settings.micVolume), class: 'slider',
  });
  micVol.addEventListener('input', async () => {
    settings.micVolume = Number(micVol.value);
    micVolValue.textContent = `${settings.micVolume}%`;
    saveSettings(settings);
    try {
      await engine.applySettings({ micVolume: settings.micVolume });
    } catch (error) {
      toast('麦克风音量应用失败：' + (error.message || error), 'error', 5000);
    }
  });

  const outVolValue = el('span', { class: 'value-badge' }, `${settings.outVolume}%`);
  const outVol = el('input', {
    type: 'range', min: '0', max: '100', step: '1', value: String(settings.outVolume), class: 'slider',
  });
  outVol.addEventListener('input', async () => {
    settings.outVolume = Number(outVol.value);
    outVolValue.textContent = `${settings.outVolume}%`;
    saveSettings(settings);
    try {
      await engine.applySettings({ outVolume: settings.outVolume });
    } catch (error) {
      toast('扬声器音量应用失败：' + (error.message || error), 'error', 5000);
    }
  });
  volSec.appendChild(row('麦克风音量', el('div', { class: 'slider-wrap' }, micVol, micVolValue), '100%为原始电平；超过100%可能失真'));
  volSec.appendChild(row('扬声器音量', el('div', { class: 'slider-wrap' }, outVol, outVolValue)));

  const checkboxes = [
    ['echoCancellation', '回声消除', '适合外放时减少回声'],
    ['noiseSuppression', '噪声抑制', '降低稳定噪声可能改变音色；关闭可比较原声'],
    ['autoGainControl', '自动增益', '自动平衡说话电平'],
  ];
  for (const [key, label, hint] of checkboxes) {
    const inputId = { echoCancellation: 'audioEchoCancellation', noiseSuppression: 'audioNoiseSuppression', autoGainControl: 'audioAutoGainControl' }[key];
    const cb = el('input', { type: 'checkbox', id: inputId });
    cb.checked = settings[key] !== false;
    cb.addEventListener('change', async () => {
      await applyCaptureChange({ [key]: cb.checked });
    });
    volSec.appendChild(row(label, cb, hint));
  }
  volSec.appendChild(captureStatus);
  renderCaptureStatus();
  body.appendChild(volSec);

  /* ---------------- 输入模式 ---------------- */
  const modeSec = section('输入模式', '「语音感应」安静时自动静音；「按键说话」按住按键才发送。');
  const modes = el('div', { class: 'segmented' });
  const vadBtn = el('button', { type: 'button', class: 'seg' + (settings.mode !== 'ptt' ? ' active' : '') }, '语音感应');
  const pttBtn = el('button', { type: 'button', class: 'seg' + (settings.mode === 'ptt' ? ' active' : '') }, '按键说话');
  const setMode = async (mode) => {
    const previous = settings.mode;
    settings.mode = mode;
    try {
      await engine.applySettings({ mode });
      saveSettings(settings);
      vadBtn.classList.toggle('active', mode !== 'ptt');
      pttBtn.classList.toggle('active', mode === 'ptt');
      pttRow.style.display = mode === 'ptt' ? '' : 'none';
      vadRow.style.display = mode === 'ptt' ? 'none' : '';
    } catch (error) {
      settings.mode = previous;
      toast('输入模式应用失败：' + (error.message || error), 'error', 5000);
    }
  };
  vadBtn.addEventListener('click', async () => { await setMode('vad'); });
  pttBtn.addEventListener('click', async () => { await setMode('ptt'); });
  modes.appendChild(vadBtn);
  modes.appendChild(pttBtn);

  const meterFill = el('div', { class: 'meter-fill' });
  const meterThr = el('div', { class: 'meter-thr' });
  const meter = el('div', { class: 'meter' }, meterFill, meterThr);
  const thrValue = el('span', { class: 'value-badge' }, `${settings.vadThreshold} dB`);
  const thrSlider = el('input', {
    type: 'range', min: '-70', max: '-20', step: '1', value: String(settings.vadThreshold), class: 'slider',
  });
  const updateThr = () => {
    thrValue.textContent = `${settings.vadThreshold} dB`;
    meterThr.style.left = dbToPercent(settings.vadThreshold) + '%';
  };
  thrSlider.addEventListener('input', () => {
    settings.vadThreshold = Number(thrSlider.value);
    updateThr();
    saveSettings(settings);
  });
  updateThr();

  const vadRow = row('感应灵敏度', el('div', { class: 'slider-wrap' }, thrSlider, thrValue));
  vadRow.title = '向左更灵敏（更容易触发），向右更迟钝';
  const pttKeyBtn = el('button', { class: 'btn ghost key-capture', type: 'button' }, keyLabel(settings.pttKey));
  const pttRow = row('说话按键', pttKeyBtn, '点击后按下要使用的按键');
  pttRow.style.display = settings.mode === 'ptt' ? '' : 'none';

  modeSec.appendChild(modes);
  modeSec.appendChild(row('当前输入', meter));
  modeSec.appendChild(vadRow);
  modeSec.appendChild(pttRow);
  body.appendChild(modeSec);

  /* PTT 按键捕获 */
  let capturing = false;
  const stopCapture = () => {
    if (!capturing) return;
    capturing = false;
    window.removeEventListener('keydown', captureKey, true);
    window.removeEventListener('mousedown', captureMouse, true);
    pttKeyBtn.classList.remove('capturing');
    pttKeyBtn.textContent = keyLabel(settings.pttKey);
  };
  const captureKey = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.code === 'Escape') {
      stopCapture();
      return;
    }
    settings.pttKey = ev.code;
    saveSettings(settings);
    stopCapture();
    toast(`说话按键已设为 ${keyLabel(ev.code)}`, 'success', 2000);
  };
  const captureMouse = (ev) => {
    if (ev.button !== 3 && ev.button !== 4) return;
    ev.preventDefault();
    ev.stopPropagation();
    settings.pttKey = ev.button === 3 ? 'Mouse4' : 'Mouse5';
    saveSettings(settings);
    stopCapture();
    toast(`说话按键已设为 ${keyLabel(settings.pttKey)}`, 'success', 2000);
  };
  pttKeyBtn.addEventListener('click', () => {
    if (capturing) {
      stopCapture();
      return;
    }
    capturing = true;
    pttKeyBtn.classList.add('capturing');
    pttKeyBtn.textContent = '请按键…';
    window.addEventListener('keydown', captureKey, true);
    window.addEventListener('mousedown', captureMouse, true);
  });

  /* ---------------- 通知 ---------------- */
  const miscSec = section('其他');
  const soundCb = el('input', { type: 'checkbox', id: 'sounds' });
  soundCb.checked = settings.sounds !== false;
  soundCb.addEventListener('change', () => {
    settings.sounds = soundCb.checked;
    saveSettings(settings);
  });
  miscSec.appendChild(row('提示音', soundCb, '加入、离开频道及互动时播放音效'));
  const interactionCb = el('input', { type: 'checkbox', id: 'interactionSounds' });
  interactionCb.checked = settings.interactionSounds;
  interactionCb.addEventListener('change', () => {
    settings.interactionSounds = interactionCb.checked;
    saveSettings(settings);
  });
  miscSec.appendChild(row('互动音效', interactionCb, '炸弹和便便的音效；同时受提示音开关控制'));
  const interactionValue = el('span', { class: 'value-badge' }, `${settings.interactionVolume}%`);
  const interactionVolume = el('input', {
    type: 'range', id: 'interactionVolume', min: '0', max: '100', step: '1',
    value: String(settings.interactionVolume), class: 'slider', 'aria-label': '互动音量',
  });
  interactionVolume.addEventListener('input', () => {
    settings.interactionVolume = Number(interactionVolume.value);
    interactionValue.textContent = `${settings.interactionVolume}%`;
    saveSettings(settings);
  });
  miscSec.appendChild(row('互动音量', el('div', { class: 'slider-wrap' }, interactionVolume, interactionValue), '默认 20%；收到的互动提醒独立于语音扬声器静音和音量'));
  miscSec.appendChild(
    el(
      'div',
      { class: 'about' },
      el('div', { class: 'about-row' }, 'Deepscord · 语音频道'),
      el('div', { class: 'about-row dim' }, '语音、伴奏与画面共享 · v1.0.0')
    )
  );
  body.appendChild(miscSec);
  const guides=section('自定义开发');
  const directoryBridge=typeof window.deepscord?.openCustomizationDirectory==='function'?window.deepscord:null;
  const reportDirectoryError=error=>toast(error.message,'error');
  guides.append(resourceManagerLink(typeof window.deepscord?.openResourceManager==='function'?window.deepscord:null,reportDirectoryError));
  guides.append(developerGuideLink('interfaces',directoryBridge,reportDirectoryError),developerGuideLink('interactions',directoryBridge,reportDirectoryError));body.append(guides);

  if (desktopSettings && onDesktopSettingsChange) body.appendChild(createFeatureSettings(desktopSettings, onDesktopSettingsChange, (error) => toast(error.message, 'error', 5000)));

  const doneBtn = el('button', { class: 'btn primary', id: 'audioSettingsDone' }, '完成');
  const modal = openModal({
    title: '设置',
    body,
    footer: [doneBtn],
    width: 620,
    onClose: () => {
      stopCapture();
      clearInterval(meterTimer);
    },
  });
  doneBtn.addEventListener('click', () => modal.close());

  // 电平表刷新
  const meterTimer = setInterval(() => {
    renderCaptureStatus();
    if (!meter.isConnected) return;
    meterFill.style.width = levelToPercent(engine.getLocalLevel()) + '%';
    meterFill.classList.toggle('hot', engine.getLocalLevel() > 0.35);
  }, 100);

  refreshDevices();
  return modal;
}
