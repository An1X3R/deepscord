// @ts-check
'use strict';
const fs = require('node:fs');
const { parseSteamStore, createSteamStateReader } = require('./steam-state.cjs');
const { writeAtomicFile } = require('./atomic-file.cjs');
/** @typedef {import('./steam-state.cjs').RoomStore} RoomStore */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */

/** @param {string} filename @returns {RoomStore} */
function readRoomStore(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new RangeError('Room store must be a regular file within 4 MiB: ' + filename);
  try { return parseSteamStore(JSON.parse(fs.readFileSync(filename, 'utf8'))); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
      throw new TypeError('Invalid room store at ' + filename + '; original file retained. Inspect the recovery copy at ' + filename + '.backup before restoring manually: ' + error.message, { cause:error });
    }
    throw error;
  }
}

/** @param {{filename:string,initial:JsonValue}} options */
function openRoomStore(options) {
  const reader = createSteamStateReader({ maxEntries:2, maxBytes:4 * 1024 * 1024 });
  let committed = fs.existsSync(options.filename) ? readRoomStore(options.filename) : parseSteamStore(options.initial);
  /** @param {RoomStore} input @returns {void} */
  function save(input) {
    const next = reader.parseStore(input);
    if (committed.content && !next.content) throw new TypeError('An encrypted room store cannot be replaced with plaintext');
    const serialized = JSON.stringify(next);
    // Encryption activation replaces the recovery copy with ciphertext as well.
    const recovery = next.content && !committed.content ? serialized : JSON.stringify(committed);
    writeAtomicFile(options.filename + '.backup', recovery);
    writeAtomicFile(options.filename, serialized);
    committed = next;
  }
  return { initial:structuredClone(committed), save };
}

module.exports = { openRoomStore, readRoomStore };
