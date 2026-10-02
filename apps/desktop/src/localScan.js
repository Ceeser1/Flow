'use strict';

// Looking through a folder for "Open local Folder". Someone may pick a whole
// drive, or a folder of code: the walk is asynchronous (the window stays
// usable and Cancel works), leaves out folders that hold no one's music,
// stops at MAX_FILES, and only lists files with a playable or convertible
// extension (formats.SCAN_EXTS).

const path = require('path');
const fsp = require('fs').promises;
const { SCAN_EXTS } = require('@flow/core/formats');

const MAX_FILES = 2000;
const MAX_DEPTH = 6;
const REPORT_MS = 150;

// Program and system folders, and the package folders of code projects.
// Folders whose name starts with "." or "$" (.git, $Recycle.Bin) are hidden
// ones and are left out too. A folder picked itself is always looked through.
const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'windows', 'program files', 'program files (x86)', 'programdata',
  'appdata', 'system volume information', 'recovery', 'perflogs', 'msocache', 'config.msi',
  '__pycache__', 'site-packages',
]);

function skipDir(name) {
  const n = String(name).toLowerCase();
  return n.startsWith('.') || n.startsWith('$') || SKIP_DIRS.has(n);
}

function isScanFile(name) {
  return !name.startsWith('.') && SCAN_EXTS.includes(path.extname(name).slice(1).toLowerCase());
}

function cancelledError() {
  const err = new Error('Cancelled.');
  err.cancelled = true;
  return err;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The openable files in `root`: its own first, by name, then each
 * subfolder's. opts:
 *   token       { cancelled }: checked at every folder; a cancel rejects
 *               with an error marked `cancelled`.
 *   onProgress  (found, dir) now and then while looking.
 *   skip        (dir) -> true leaves that subfolder out as well.
 *   limit       stop after this many files (MAX_FILES).
 * Resolves { files, truncated }.
 */
async function scanFolder(root, { token = {}, onProgress, skip, limit = MAX_FILES, depth = MAX_DEPTH } = {}) {
  const files = [];
  let truncated = false;
  let reported = 0;

  async function walk(dir, level) {
    if (token.cancelled) throw cancelledError();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (token.cancelled) throw cancelledError();
    entries.sort(byName);
    for (const e of entries) {
      if (!e.isFile() || !isScanFile(e.name)) continue;
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      files.push(path.join(dir, e.name));
    }
    if (onProgress && Date.now() - reported >= REPORT_MS) {
      reported = Date.now();
      onProgress(files.length, dir);
    }
    if (level >= depth) return;
    for (const e of entries) {
      if (!e.isDirectory() || skipDir(e.name)) continue;
      const sub = path.join(dir, e.name);
      if (skip && skip(sub)) continue;
      await walk(sub, level + 1);
      if (truncated) return;
    }
  }

  await walk(path.resolve(root), 0);
  return { files, truncated };
}

module.exports = { scanFolder, skipDir, isScanFile, MAX_FILES };
