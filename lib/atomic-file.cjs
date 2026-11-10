// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** @param {string} filename @param {Buffer|string} data @returns {void} */
function writeAtomicFile(filename, data) {
  if (!path.isAbsolute(filename)) throw new TypeError('Atomic file destination must be absolute: ' + filename);
  const temporary = filename + '.pending-' + randomUUID();
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, filename);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(filename), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } catch (error) {
    if (fs.existsSync(temporary)) {
      try { fs.unlinkSync(temporary); }
      catch (cleanupError) { console.error('atomic_file_cleanup_failed', { filename, temporary, message:cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }); }
    }
    console.error('atomic_file_write_failed', { filename, message:error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

module.exports = { writeAtomicFile };
