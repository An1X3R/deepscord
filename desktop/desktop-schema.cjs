// @ts-check
'use strict';

/** @typedef {null | boolean | number | string | JsonValue[] | {[key:string]:JsonValue}} JsonValue */
/** @typedef {{enabled:boolean,locked:boolean,x:number,y:number,width:number,height:number,scale:number}} OverlaySettings */
/** @typedef {{muteShortcut:string,overlay:OverlaySettings}} DesktopSettings */
/** @typedef {{id:string,name:string,avatar:string|null,color:string,speaking:boolean,muted:boolean}} OverlayMember */
/** @typedef {{connected:boolean,members:OverlayMember[]}} VoiceOverlay */

/** @returns {DesktopSettings} */
function initialSettings() {
  return { muteShortcut: 'Control+Shift+M', overlay: { enabled:false, locked:true, x:24, y:80, width:280, height:300, scale:1 } };
}
/** @param {JsonValue} value @param {string} field @returns {{[key:string]:JsonValue}} */
function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}
/** @param {JsonValue} value @param {string} field @returns {boolean} */
function boolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`);
  return value;
}
/** @param {JsonValue} value @param {string} field @param {number} min @param {number} max @returns {number} */
function number(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new RangeError(`${field} must be between ${min} and ${max}`);
  return value;
}
/** @param {JsonValue} value @param {string} field @param {number} max @returns {string} */
function string(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${field} must be nonempty text of at most ${max} characters`);
  return value;
}
/** @param {JsonValue} value @returns {string} */
function muteAccelerator(value) {
  const accelerator = string(value, 'muteShortcut', 80);
  const parts = accelerator.split('+');
  const key = parts.pop();
  if (!key || !/^(?:[A-Z0-9,./;'\[\]\\`=\-]|F(?:[1-9]|1[0-9]|2[0-4])|Plus|Space|Enter|Return|Tab|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Up|Down|Left|Right|Escape|Capslock|Numlock)$/i.test(key)) throw new TypeError('muteShortcut requires a supported letter, digit, function or navigation key');
  if (new Set(parts.map(part => part.toLowerCase())).size !== parts.length || parts.some(part => !/^(?:Control|Ctrl|Alt|Option|Shift|Super|Meta|Command|Cmd|CommandOrControl|CmdOrCtrl)$/i.test(part))) throw new TypeError('muteShortcut contains invalid or repeated modifiers');
  return accelerator;
}
/** @param {JsonValue} value @returns {DesktopSettings} */
function desktopSettings(value) {
  const raw = record(value, 'desktop settings');
  const overlay = record(raw.overlay, 'overlay');
  return { muteShortcut:muteAccelerator(raw.muteShortcut), overlay: {
    enabled:boolean(overlay.enabled, 'overlay.enabled'), locked:boolean(overlay.locked, 'overlay.locked'),
    x:Math.round(number(overlay.x, 'overlay.x', -1000000, 1000000)), y:Math.round(number(overlay.y, 'overlay.y', -1000000, 1000000)),
    width:Math.round(number(overlay.width, 'overlay.width', 180, 1200)), height:Math.round(number(overlay.height, 'overlay.height', 90, 1600)),
    scale:number(overlay.scale, 'overlay.scale', 0.6, 2),
  } };
}
/** @param {JsonValue} value @returns {VoiceOverlay} */
function voiceOverlay(value) {
  const raw = record(value, 'voice overlay');
  if (!Array.isArray(raw.members) || raw.members.length > 64) throw new TypeError('members must be a list of at most 64 participants');
  const members = raw.members.map((entry) => {
    const member = record(entry, 'member');
    const avatar = member.avatar === null ? null : string(member.avatar, 'member.avatar', 1500000);
    if (avatar !== null && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) throw new TypeError('Overlay avatars must be PNG, JPEG or WebP data images');
    const color = string(member.color, 'member.color', 7);
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new TypeError('member.color must be a six-digit hex color');
    return { id:string(member.id, 'member.id', 128), name:string(member.name, 'member.name', 80), avatar, color,
      speaking:boolean(member.speaking, 'member.speaking'), muted:boolean(member.muted, 'member.muted') };
  });
  if (new Set(members.map((member) => member.id)).size !== members.length) throw new TypeError('Overlay member IDs must be unique');
  return { connected:boolean(raw.connected, 'connected'), members };
}

module.exports = { initialSettings, desktopSettings, voiceOverlay };
