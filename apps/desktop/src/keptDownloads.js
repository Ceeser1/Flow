'use strict';

// Add Songs' downloads on this computer kept over a restart (4.5.3): the
// Client queue's links and every batch not saved yet (its checklist, its
// songs downloaded into the cache with their cuts and names), as the window
// last sent them. The window writes it at every change (save) and once more
// as it closes (the sync IPC), and reads it once it has started (load). The
// cache is emptied at the start but for the files these batches still need
// (keep).

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const MAX_BYTES = 32 * 1024 * 1024;

const file = () => path.join(paths.rootDir(), 'pending-downloads.json');

function read() {
  try {
    const text = fs.readFileSync(file(), 'utf8');
    const state = JSON.parse(text);
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

/** Nothing waiting: no queue, no batch. */
function isEmpty(state) {
  return !state || ((!Array.isArray(state.queue) || !state.queue.length) && (!Array.isArray(state.batches) || !state.batches.length));
}

/**
 * Written whole through a temporary file, so a crash mid-write leaves the
 * last one. `sent`: the window's JSON text (or the state). Empty: the file goes.
 */
function save(sent) {
  const target = file();
  let state = sent;
  const text = typeof sent === 'string' ? sent : JSON.stringify(sent);
  if (typeof sent === 'string') {
    try {
      state = JSON.parse(sent);
    } catch {
      return;
    }
  }
  if (isEmpty(state)) {
    fs.rmSync(target, { force: true });
    return;
  }
  if (text.length > MAX_BYTES) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

/** The songs' files in the cache the kept batches hold (lower-cased), with their covers found so far. */
function cacheFiles(state = read()) {
  const keep = new Set();
  if (!state || !Array.isArray(state.batches)) return keep;
  const cache = path.resolve(paths.cacheDir()).toLowerCase() + path.sep;
  for (const b of state.batches) {
    for (const it of Array.isArray(b && b.included) ? b.included : []) {
      const p = it && it.media && typeof it.media.path === 'string' ? path.resolve(it.media.path) : '';
      if (!p || !p.toLowerCase().startsWith(cache)) continue;
      keep.add(p.toLowerCase());
      keep.add(`${p}.cover.jpg`.toLowerCase());
    }
  }
  return keep;
}

/**
 * What the window gets back: as saved, each song whose file is gone from
 * the cache marked `missing` (saved just before Flow closed, or deleted).
 * `localFiles`: the originals of the computer's files it holds, which Move
 * Originals may then delete again (importer.allowLocal).
 */
function load() {
  const state = read();
  if (isEmpty(state)) return null;
  const originals = [];
  for (const b of Array.isArray(state.batches) ? state.batches : []) {
    for (const it of Array.isArray(b && b.included) ? b.included : []) {
      if (!it || typeof it !== 'object') continue;
      if (it.media && typeof it.media.path === 'string' && !fs.existsSync(it.media.path)) it.missing = true;
      const original = it.song && typeof it.song.originalPath === 'string' ? it.song.originalPath : '';
      if (original) originals.push(original);
      // A file not prepared yet: prepared at the next start, then saved (and maybe moved) as any.
      if (b.local && typeof it.path === 'string' && it.path) originals.push(it.path);
    }
  }
  return { state, originals };
}

module.exports = {
  save, load, cacheFiles, file,
};
