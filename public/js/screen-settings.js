// @ts-check

import { parseScreenPreferences } from './screen-preferences.js';

/** @typedef {import('./screen-preferences.js').ScreenPreferences} ScreenPreferences */
/** @typedef {import('./screen-preferences.js').ScreenContentMode} ScreenContentMode */

/** @param {string} id @param {string} label @param {string} hint @param {HTMLInputElement|HTMLSelectElement} input @returns {HTMLDivElement} */
function field(id, label, hint, input) {
  const row = document.createElement('div'); row.className = 'screen-setting-row';
  const copy = document.createElement('div'); copy.className = 'screen-setting-copy';
  const caption = document.createElement('label'); caption.htmlFor = input.id; caption.textContent = label;
  const description = document.createElement('p'); description.id = id; description.textContent = hint;
  input.setAttribute('aria-describedby', id);
  copy.append(caption, description); row.append(copy, input);
  return row;
}

/** @param {string} id @param {number} value @param {number} min @param {number} max @param {string} label @returns {HTMLInputElement} */
function numberInput(id, value, min, max, label) {
  const input = document.createElement('input');
  input.id = id; input.dataset.testid = id; input.className = 'input'; input.type = 'number';
  input.required = true; input.min = String(min); input.max = String(max); input.step = 'any';
  input.value = String(value); input.inputMode = 'decimal'; input.setAttribute('aria-label', label);
  return input;
}

/** @param {string} id @param {number} value @param {number[]} choices @param {string} unit @param {string} label @returns {HTMLSelectElement} */
function selectInput(id, value, choices, unit, label) {
  const input = document.createElement('select');
  input.id = id; input.dataset.testid = id; input.className = 'input'; input.required = true;
  input.setAttribute('aria-label', label);
  for (const choice of choices) {
    const option = document.createElement('option'); option.value = String(choice); option.textContent = String(choice) + unit;
    input.append(option);
  }
  input.value = String(value);
  return input;
}

/** @param {ScreenContentMode} value @returns {HTMLSelectElement} */
function contentModeInput(value) {
  const input = document.createElement('select');
  input.id = 'screenContentMode'; input.dataset.testid = input.id; input.className = 'input'; input.required = true;
  input.setAttribute('aria-label', '屏幕内容模式');
  /** @type {{value:ScreenContentMode,label:string}[]} */
  const choices = [{ value: 'motion', label: '流畅优先' }, { value: 'detail', label: '细节优先' }];
  for (const choice of choices) {
    const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label;
    input.append(option);
  }
  input.value = value;
  return input;
}

/** @param {ScreenPreferences} preferences @param {boolean} nativeAvailable @param {(preferences:ScreenPreferences)=>Promise<void>} onSave @param {(error:Error)=>void} reportError @returns {HTMLElement} */
export function createScreenSettings(preferences, nativeAvailable, onSave, reportError) {
  const configured = parseScreenPreferences(preferences);
  const section = document.createElement('section'); section.className = 'settings-section screen-settings';
  section.id = 'screenTransmissionSettings'; section.dataset.testid = 'screen-transmission-settings';
  const heading = document.createElement('h3'); heading.id = 'screenTransmissionHeading'; heading.textContent = '屏幕传输';
  section.setAttribute('aria-labelledby', heading.id);
  const description = document.createElement('p'); description.className = 'settings-hint screen-settings-intro';
  description.textContent = '设置你愿意提供的上传容量。语音会预留带宽，实际拥塞也可能降低可用额度。';
  const upload = numberInput('screenUploadLimitMbps', configured.uploadLimitMbps, 1, 1000, '屏幕上传上限，Mbps');
  const bitrate = numberInput('screenBitrateMbps', configured.screenBitrateMbps, 0.3, 40, '目标画面码率，Mbps');
  const resolution = selectInput('screenResolution', configured.screenResolution, [480, 720, 1080, 1440, 2160], 'p', '屏幕分辨率上限');
  const frameRate = selectInput('screenFrameRate', configured.screenFrameRate, [15, 24, 30, 60], ' FPS', '屏幕帧率上限');
  const contentMode = contentModeInput(configured.screenContentMode);
  const relay = document.createElement('input'); relay.id = 'screenRelayEnabled'; relay.dataset.testid = relay.id;
  relay.type = 'checkbox'; relay.checked = nativeAvailable && configured.relayEnabled; relay.disabled = !nativeAvailable;
  const status = document.createElement('p'); status.id = 'screenPreferencesStatus'; status.dataset.testid = status.id;
  status.className = 'screen-settings-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.textContent = '有效修改会自动保存；分辨率、帧率和内容模式在重新分享后生效。';
  section.append(heading, description,
    field('screenUploadCapacityHint', '上传容量上限 · Mbps', '1–1000 Mbps；由你指定，不代表已测得带宽，也不会自动测速。', upload),
    field('screenTargetResolutionHint', '分辨率上限', '保持来源比例，最大 2160p；修改后需要重新分享。较小来源不会变清晰。', resolution),
    field('screenTargetFrameRateHint', '帧率上限', '15–60 FPS；修改后需要重新分享。实际帧率取决于来源、硬件和网络。', frameRate),
    field('screenContentModeHint', '内容模式', '流畅优先适合动态画面，低码率时可能降低实际分辨率；细节优先适合文字，低码率时可能降低实际帧率。修改后需要重新分享。', contentMode),
    field('screenTargetBitrateHint', '目标画面码率 · Mbps', '0.3–40 Mbps；立即调整编码预算，实际码率受上传容量和网络限制。', bitrate),
    field('screenRelayAvailabilityHint', '贡献上传帮助转发', nativeAvailable
      ? '允许桌面端用剩余额度转发一跳屏幕画面，帮助分享者减少重复上传。'
      : '当前客户端没有原生屏幕中继能力，无法贡献上传；已保存的桌面端偏好会保留。', relay), status);
  let pending = false;

  /** @returns {Promise<void>} */
  async function save() {
    if (pending) return;
    const valid = [upload, bitrate, resolution, frameRate, contentMode].every((input) => {
      const accepted = input.checkValidity(); input.setAttribute('aria-invalid', String(!accepted)); return accepted;
    });
    if (!valid) { status.dataset.state = 'error'; status.textContent = '上传上限需为 1–1000 Mbps，目标码率需为 0.3–40 Mbps；请修正后保存。'; return; }
    const next = parseScreenPreferences({ version: 3, uploadLimitMbps: upload.valueAsNumber,
      screenBitrateMbps: bitrate.valueAsNumber, screenResolution: Number(resolution.value), screenFrameRate: Number(frameRate.value), screenContentMode: contentMode.value, relayEnabled: nativeAvailable ? relay.checked : configured.relayEnabled });
    pending = true; for (const input of [upload, bitrate, relay, resolution, frameRate, contentMode]) input.disabled = true;
    section.setAttribute('aria-busy', 'true'); status.dataset.state = 'pending'; status.textContent = '正在保存…';
    try {
      await onSave(next);
      status.dataset.state = 'saved'; status.textContent = '偏好已保存。码率和上传额度按新预算调整；分辨率、帧率和内容模式在重新分享后生效。';
    } catch (failure) {
      const error = failure instanceof Error ? failure : new TypeError(String(failure));
      status.dataset.state = 'error'; status.textContent = '设置未完成：' + error.message;
      reportError(error);
    } finally {
      pending = false; for (const input of [upload, bitrate, resolution, frameRate, contentMode]) input.disabled = false; relay.disabled = !nativeAvailable;
      section.setAttribute('aria-busy', 'false');
    }
  }
  for (const input of [upload, bitrate, relay, resolution, frameRate, contentMode]) input.addEventListener('change', () => { void save(); });
  return section;
}
