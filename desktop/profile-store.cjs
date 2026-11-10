// @ts-check
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateProfile } = require('./app-server/lib/profile-avatar.cjs');
/** @typedef {import('../lib/profile-avatar.cjs').Profile} Profile */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */

/** @param {string} directory */
function createProfileStore(directory) {
  const target = path.join(directory, 'profile.json');
  let queue = Promise.resolve();
  /** @returns {Promise<Profile|null>} */
  async function load() {
    await queue;
    try {
      const stat = await fs.stat(target);
      if (stat.size > 20000) throw new RangeError('Stored profile exceeds 20000 bytes.');
      return validateProfile(/** @type {JsonValue} */ (JSON.parse(await fs.readFile(target, 'utf8'))));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  /** @param {JsonValue} value @returns {Promise<Profile>} */
  async function save(value) {
    const profile = validateProfile(value);
    const operation = queue.then(async () => {
      await fs.mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `profile.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify(profile), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    queue = operation;
    await operation;
    return profile;
  }
  return { load, save };
}
module.exports = { createProfileStore };
