// @ts-check

/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {480|720|1080|1440|2160} ScreenResolution */
/** @typedef {15|24|30|60} ScreenFrameRate */
/** @typedef {'motion'|'detail'} ScreenContentMode */
/** @typedef {{version:3,uploadLimitMbps:number,relayEnabled:boolean,screenBitrateMbps:number,screenResolution:ScreenResolution,screenFrameRate:ScreenFrameRate,screenContentMode:ScreenContentMode}} ScreenPreferences */
/** @typedef {{screenPreferences?:JsonValue}} ScreenPreferenceSettings */

/** @type {Readonly<ScreenPreferences>} */
export const DEFAULT_SCREEN_PREFERENCES = Object.freeze({ version: 3, uploadLimitMbps: 10, relayEnabled: true, screenBitrateMbps: 2.5, screenResolution: 720, screenFrameRate: 30, screenContentMode: 'motion' });

export const MAX_SCREEN_BITRATE_BPS = 40_000_000;
export const MAX_SCREEN_WIRE_BPS = 48_000_000;

/** @param {ScreenContentMode} mode @returns {{contentHint:ScreenContentMode,degradationPreference:'maintain-framerate'|'maintain-resolution'}} */
export function screenEncodingPolicy(mode) {
  if (mode !== 'motion' && mode !== 'detail') throw new TypeError('屏幕内容模式必须为 motion 或 detail');
  return { contentHint: mode, degradationPreference: mode === 'motion' ? 'maintain-framerate' : 'maintain-resolution' };
}

/** @param {ScreenPreferences} preferences @returns {{width:number,height:number,frameRate:ScreenFrameRate}} */
export function screenCaptureTarget(preferences) {
  const parsed = parseScreenPreferences(preferences);
  const widths = { 480: 854, 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 };
  return { width: widths[parsed.screenResolution], height: parsed.screenResolution, frameRate: parsed.screenFrameRate };
}

/** Validate explicit settings and strip unrelated properties.
 * @param {JsonValue} value @returns {ScreenPreferences} */
export function parseScreenPreferences(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('屏幕传输偏好必须是一个对象');
  const { version, uploadLimitMbps, relayEnabled, screenBitrateMbps, screenResolution, screenFrameRate, screenContentMode } = value;
  if (version !== 3) throw new TypeError('屏幕传输偏好版本必须为 3');
  if (screenContentMode !== 'motion' && screenContentMode !== 'detail') throw new TypeError('屏幕内容模式必须为 motion 或 detail');
  if (typeof uploadLimitMbps !== 'number' || !Number.isFinite(uploadLimitMbps) || uploadLimitMbps < 1 || uploadLimitMbps > 1000) throw new RangeError('屏幕上传上限必须为 1–1000 Mbps 的有限数值');
  if (typeof relayEnabled !== 'boolean') throw new TypeError('贡献上传必须明确设为开启或关闭');
  if (typeof screenBitrateMbps !== 'number' || !Number.isFinite(screenBitrateMbps) || screenBitrateMbps < 0.3 || screenBitrateMbps > MAX_SCREEN_BITRATE_BPS / 1000000) throw new RangeError('目标画面码率必须为 0.3–40 Mbps 的有限数值');
  if (screenResolution !== 480 && screenResolution !== 720 && screenResolution !== 1080 && screenResolution !== 1440 && screenResolution !== 2160) throw new RangeError('屏幕分辨率必须为 480p、720p、1080p、1440p 或 2160p');
  if (screenFrameRate !== 15 && screenFrameRate !== 24 && screenFrameRate !== 30 && screenFrameRate !== 60) throw new RangeError('屏幕帧率必须为 15、24、30 或 60 FPS');
  // Retired playbackBufferSeconds values are stripped during settings migration.
  return { version, uploadLimitMbps, relayEnabled, screenBitrateMbps, screenResolution, screenFrameRate, screenContentMode };
}

/** Read configured capacity, never a measured bandwidth estimate.
 * @param {ScreenPreferenceSettings} settings @param {boolean} nativeAvailable @returns {ScreenPreferences} */
export function getScreenPreferences(settings, nativeAvailable) {
  if (typeof nativeAvailable !== 'boolean') throw new TypeError('原生屏幕中继可用性必须明确提供');
  const value = settings.screenPreferences;
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new TypeError('屏幕传输偏好必须是一个对象');
  // Only the unversioned legacy format receives the former defaults during migration.
  const configured = value === undefined ? { ...DEFAULT_SCREEN_PREFERENCES }
    : value.version === undefined ? parseScreenPreferences({ ...DEFAULT_SCREEN_PREFERENCES, ...value, version: 3, screenResolution: 720, screenFrameRate: 30, screenContentMode: 'motion' })
      : value.version === 2 ? parseScreenPreferences({ ...value, version: 3, screenContentMode: 'motion' })
        : parseScreenPreferences(value);
  return { ...configured, relayEnabled: nativeAvailable && configured.relayEnabled };
}
