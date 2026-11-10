// @ts-check
/** @typedef {{id: string, name: string, color: string, avatar: string|null}} Profile */
/** @typedef {{getProfile: () => Promise<Profile|null>, saveProfile: (profile: Profile) => Promise<Profile>}} ProfileBridge */
/** @typedef {null|boolean|number|string|JsonValue[]|{[key: string]: JsonValue}} JsonValue */
const PROFILE_KEY = 'deepscord.profile.v1';
const MAX_BYTES = 12 * 1024;
const MAX_LENGTH = 23 + Math.ceil(MAX_BYTES / 3) * 4;

/** @param {JsonValue} value @returns {Profile} */
export function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Profile must be an object.');
  const { id, name, color, avatar } = value;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new TypeError('Profile id must be a UUID v4.');
  if (typeof name !== 'string' || !name.trim() || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) throw new TypeError('Name must contain 1 to 24 characters without control characters.');
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new TypeError('Profile color must be a six-digit hexadecimal color.');
  if (avatar !== null) {
    if (typeof avatar !== 'string' || avatar.length > MAX_LENGTH || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)) throw new TypeError('Avatar must be a JPEG no larger than 12 KiB.');
    const binary = atob(avatar.slice(23));
    if (binary.length > MAX_BYTES || btoa(binary) !== avatar.slice(23) || !binary.startsWith('\xff\xd8') || !binary.endsWith('\xff\xd9')) throw new TypeError('Avatar JPEG encoding is invalid.');
  }
  return { id: id.toLowerCase(), name: name.replace(/\s+/g, ' ').trim(), color, avatar };
}

/** @returns {ProfileBridge|null} */
function desktopBridge() {
  const bridge = /** @type {Window & {deepscord?: ProfileBridge}} */ (window).deepscord;
  return bridge && typeof bridge.getProfile === 'function' && typeof bridge.saveProfile === 'function' ? bridge : null;
}

/** @param {string} name @param {string} color @returns {Profile} */
export function createProfile(name, color) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return validateProfile({ id, name, color, avatar: null });
}

/** @returns {Promise<Profile|null>} */
export async function loadProfile() {
  const bridge = desktopBridge();
  if (bridge) {
    const value = await bridge.getProfile();
    return value === null ? null : validateProfile(value);
  }
  const stored = localStorage.getItem(PROFILE_KEY);
  return stored === null ? null : validateProfile(/** @type {JsonValue} */ (JSON.parse(stored)));
}

/** @param {Profile} value @returns {Promise<Profile>} */
export async function saveProfile(value) {
  const profile = validateProfile(value);
  const bridge = desktopBridge();
  if (bridge) return validateProfile(await bridge.saveProfile(profile));
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  return profile;
}

/** @param {Profile} profile @returns {{profileId: string, avatar: string|null}} */
export function profilePayload(profile) {
  const validated = validateProfile(profile);
  return { profileId: validated.id, avatar: validated.avatar };
}

/** @param {File} file @returns {Promise<string>} */
export async function prepareAvatar(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new TypeError('Choose a JPEG, PNG, or WebP image.');
  if (file.size > 10 * 1024 * 1024) throw new RangeError('Source image must be no larger than 10 MiB.');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > 40000000) throw new RangeError('Source image dimensions exceed 40 megapixels.');
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Avatar canvas is unavailable.');
    context.fillStyle = '#252733';
    context.fillRect(0, 0, 96, 96);
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 96, 96);
    const encoded = canvas.toDataURL('image/jpeg', 0.72);
    if (encoded.length > MAX_LENGTH) throw new RangeError('Compressed avatar exceeds 12 KiB.');
    return encoded;
  } finally {
    bitmap.close();
  }
}

/** @param {HTMLElement} element @param {{name: string, color: string, avatar?: string|null}} profile @returns {void} */
export function renderAvatar(element, profile) {
  element.replaceChildren();
  element.style.backgroundColor = profile.color;
  if (profile.avatar && profile.avatar.length <= MAX_LENGTH && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(profile.avatar)) {
    const image = document.createElement('img');
    image.src = profile.avatar;
    image.alt = '';
    image.width = 96;
    image.height = 96;
    image.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block';
    element.append(image);
  } else {
    element.textContent = Array.from(profile.name.trim()).slice(0, 2).join('').toUpperCase();
  }
}
