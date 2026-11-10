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

/**
 * Text written as writeJsonAtomic writes, for big files (4.3.4): the previous
 * one becomes the .bak by a rename instead of a copy, so 80 MB are written
 * once and not three times.
 */
function writeTextAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    if (fs.existsSync(file)) fs.renameSync(file, file + '.bak');
  } catch {
    // A missing backup is no reason to fail the save itself.
  }
  fs.renameSync(tmp, file);
}

/** A file's text, or null when it is not there. */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** A journal's way to its files by their full paths (journalFile.js). */
const fileJournalIo = {
  read: readJson,
  write: writeJsonAtomic,
  readText,
  writeText: writeTextAtomic,
  appendText: (file, text) => fs.appendFileSync(file, text, 'utf8'),
  remove: (file) => fs.rmSync(file, { force: true }),
};

module.exports = {
  writeJsonAtomic, readJson, writeTextAtomic, readText, fileJournalIo,
};
