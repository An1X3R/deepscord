// @ts-check
'use strict';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{id: string, name: string, color: string, avatar: string|null}} Profile */
const MAX_AVATAR_BYTES = 12 * 1024;
const MAX_AVATAR_LENGTH = 23 + Math.ceil(MAX_AVATAR_BYTES / 3) * 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {JsonValue|undefined} value @returns {string} */
function validateProfileId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('Profile id must be a UUID v4.');
  return value.toLowerCase();
}

/** @param {JsonValue|undefined} value @returns {string|null} */
function validateAvatar(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_AVATAR_LENGTH || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new TypeError('Avatar must be a JPEG data URL no larger than 12 KiB.');
  }
  const encoded = value.slice(23);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_AVATAR_BYTES || bytes.toString('base64') !== encoded || bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    throw new TypeError('Avatar JPEG encoding or byte limit is invalid.');
  }
  let offset = 2;
  let foundFrame = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new TypeError('Avatar JPEG marker is invalid.');
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new TypeError('Avatar JPEG segment is truncated.');
    if (marker === 0xc0 || marker === 0xc2) {
      if (foundFrame || length < 8) throw new TypeError('Avatar JPEG frame is invalid.');
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > 96 || height > 96) throw new TypeError('Avatar JPEG dimensions must be from 1 to 96 pixels.');
      foundFrame = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      throw new TypeError('Avatar JPEG must use baseline or progressive encoding.');
    }
    if (marker === 0xda) {
      if (!foundFrame || offset + length >= bytes.length - 2) throw new TypeError('Avatar JPEG scan is missing.');
      return value;
    }
    offset += length;
  }
  throw new TypeError('Avatar JPEG frame and scan are required.');
}

/** @param {JsonValue} value @returns {Profile} */
function validateProfile(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Profile must be an object.');
  const id = validateProfileId(value.id);
  const { name, color } = value;
  if (typeof name !== 'string' || !name.trim() || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) throw new TypeError('Profile name must contain 1 to 24 characters without control characters.');
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new TypeError('Profile color must be a six-digit hexadecimal color.');
  return { id, name: name.replace(/\s+/g, ' ').trim(), color, avatar: validateAvatar(value.avatar) };
}

module.exports = { MAX_AVATAR_BYTES, MAX_AVATAR_LENGTH, validateAvatar, validateProfileId, validateProfile };
