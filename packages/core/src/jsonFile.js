'use strict';

const fs = require('fs');

/**
 * Writes JSON through a temporary file and a rename, so a crash or a power cut
 * in the middle of a save leaves the previous file whole instead of half of
 * the new one. The previous version is kept as .bak for the same reason.
 */
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  } catch {
    // A missing backup is no reason to fail the save itself.
  }
  fs.renameSync(tmp, file);
}

/** The file's JSON, falling back to the .bak copy, or null. */
function readJson(file) {
  for (const candidate of [file, file + '.bak']) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      // Missing or damaged; try the next one.
    }
  }
  return null;
}

module.exports = { writeJsonAtomic, readJson };
