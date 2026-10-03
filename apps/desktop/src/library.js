'use strict';

// The library on disk: library.json, saved after every change, and the scan
// that keeps it in step with the Music\FlowPlayer folder. The rules themselves
// live in libraryModel.js.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const tools = require('./tools');
const model = require('@flow/core/libraryModel');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');
const { parseTitle } = require('@flow/core/titleParser');
const { sourceKeyFromUrl } = require('@flow/core/text');
const { AUDIO_EXTS } = require('@flow/core/formats');
const { checkTarget, planMoves } = require('@flow/core/relocate');

let data = null;
const listeners = [];

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function load() {
  data = model.sanitize(readJson(paths.libraryFile()));
  return data;
}

function get() {
  return data || load();
}

function save() {
  writeJsonAtomic(paths.libraryFile(), get());
}

function onChange(fn) {
  listeners.push(fn);
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(get());
    } catch {
      // A closed window must not stop the save that follows.
    }
  }
}

/**
 * Runs one change against the library, then saves and tells the window.
 * Whatever `fn` returns is handed back; whatever it throws is thrown on, with
 * nothing saved.
 */
function mutate(fn) {
  const result = fn(get());
  save();
  notify();
  return result;
}

// ---- the folder scan ----

function listAudioFiles(dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.flow-')) continue;
    // The covers (covers.js) are pictures only.
    if (depth === 0 && e.isDirectory() && e.name === paths.COVERS) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 4) out.push(...listAudioFiles(full, depth + 1));
    } else if (AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Artist, title, mix and source link of a file, from its tags or else its
 * name. The source link is the one Flow writes into the comment tag.
 */
function metaFromFile(file, tags = {}) {
  const fromName = parseTitle(path.basename(file, path.extname(file)));
  const comment = tags.comment || tags.purl || '';
  const sourceUrl = /^https?:\/\//i.test(comment) ? comment : '';
  return {
    title: tags.title || fromName.title,
    artist: tags.artist || tags.album_artist || fromName.artist,
    mix: tags.mix || (tags.title ? '' : fromName.mix),
    sourceUrl,
    sourceKey: sourceKeyFromUrl(sourceUrl) || '',
  };
}

/** A library entry for a file found in the folder, from its tags or its name. */
async function songFromFile(file) {
  const info = await require('./media').probeAudio(file);
  if (!info.codec) return null;
  const meta = metaFromFile(file, info.tags);
  let addedAt = Date.now();
  try {
    const st = fs.statSync(file);
    addedAt = Math.round(st.birthtimeMs || st.mtimeMs) || addedAt;
  } catch {
    // Keep now.
  }
  return {
    id: newId(),
    file,
    title: meta.title,
    artist: meta.artist,
    mix: meta.mix,
    duration: info.duration,
    format: path.extname(file).slice(1).toLowerCase(),
    sourceUrl: meta.sourceUrl,
    sourceKey: meta.sourceKey,
    addedAt,
  };
}

// A file younger than this may still be being copied in; it waits for the next
// scan rather than being read half-written.
const SETTLE_MS = 2000;

/**
 * A song whose file is gone and a new file that is the same recording: same
 * format, same length to a twentieth of a second. With several such songs the
 * one with the same title and artist wins; without that, none does.
 */
function findMoved(fresh, gone) {
  const same = gone.filter((g) => g.format === fresh.format && Math.abs((g.duration || 0) - fresh.duration) < 0.05);
  if (same.length === 1) return same[0];
  const fold = (t) => String(t || '').toLowerCase();
  return same.find((g) => fold(g.title) === fold(fresh.title) && fold(g.artist) === fold(fresh.artist)) || null;
}

/**
 * Adds files that were put into Music\FlowPlayer by hand, drops songs whose file
 * is gone, and follows songs that were renamed or moved in Explorer (they keep
 * their playlists and their Added date). Resolves { added, removed, moved,
 * unsettled }.
 */
async function scanOnce() {
  const lib = get();
  const known = new Set(lib.songs.map((s) => s.file.toLowerCase()));
  const ignored = new Set(lib.ignoredFiles);
  const found = listAudioFiles(paths.musicDir());

  const fresh = [];
  let unsettled = 0;
  for (const file of found) {
    const lower = file.toLowerCase();
    if (known.has(lower) || ignored.has(lower)) continue;
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < SETTLE_MS) {
        unsettled += 1;
        continue;
      }
      const song = await songFromFile(file);
      if (song) fresh.push(song);
    } catch {
      // Unreadable; left out rather than failing the whole scan.
    }
  }

  // A missing file only counts as gone while the music folder itself is there
  // (or, for a song kept elsewhere, the folder around it): an unplugged drive
  // must not empty the library. A subfolder deleted in Explorer does count.
  const root = paths.musicDir();
  const rootThere = fs.existsSync(root);
  const inRoot = (file) => file.toLowerCase().startsWith(root.toLowerCase() + path.sep);
  const gone = lib.songs.filter((s) => !fs.existsSync(s.file)
    && (inRoot(s.file) ? rootThere : fs.existsSync(path.dirname(s.file))));
  const moves = [];
  const left = [...gone];
  for (const song of [...fresh]) {
    const from = findMoved(song, left);
    if (!from) continue;
    moves.push({ id: from.id, file: song.file });
    left.splice(left.indexOf(from), 1);
    fresh.splice(fresh.indexOf(song), 1);
  }

  // Forget ignored files that no longer exist, so the list cannot grow forever.
  const stillIgnored = lib.ignoredFiles.filter((f) => fs.existsSync(f));
  if (!fresh.length && !left.length && !moves.length && stillIgnored.length === lib.ignoredFiles.length) {
    return { added: 0, removed: 0, moved: 0, unsettled };
  }

  mutate((d) => {
    // Checked again rather than trusted from before the awaits above: the
    // library may have changed while the files were being read.
    const nowKnown = new Set(d.songs.map((s) => s.file.toLowerCase()));
    for (const m of moves) {
      const song = model.songById(d, m.id);
      if (song && !fs.existsSync(song.file) && !nowKnown.has(m.file.toLowerCase())) {
        model.updateSong(d, m.id, { file: m.file });
      }
    }
    for (const song of fresh) {
      if (!nowKnown.has(song.file.toLowerCase())) model.addSong(d, song);
    }
    for (const s of left) {
      if (model.songById(d, s.id) && !fs.existsSync(s.file)) model.removeSong(d, s.id, false);
    }
    d.ignoredFiles = d.ignoredFiles.filter((f) => fs.existsSync(f));
  });
  return { added: fresh.length, removed: left.length, moved: moves.length, unsettled };
}

// ---- keeping up with the folder ----
//
// Explorer changes are noticed through a watch on the folder and answered with
// a scan once things have been quiet for a moment. While the app is writing
// into the folder itself (saving, renaming, deleting a song) the scan waits:
// run in the middle of a save it would find the new file before the save has
// put it in the library, and add it a second time.

let chain = Promise.resolve();
let busy = 0;
let pending = false;
let timer = null;
let watcher = null;
const scanListeners = [];

function onScanned(fn) {
  scanListeners.push(fn);
}

/** One scan at a time; a scan asked for during another runs after it. */
function scan() {
  const run = chain.then(scanOnce).then((result) => {
    if (result.added || result.removed || result.moved) {
      for (const fn of scanListeners) {
        try {
          fn(result);
        } catch {
          // The window may be gone.
        }
      }
    }
    // Something was still being copied: look again once it has settled.
    if (result.unsettled) requestScan(SETTLE_MS + 500);
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

function requestScan(delay = 1500) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (busy) pending = true;
    else scan().catch(() => {});
  }, delay);
}

/** Runs the app's own work on the folder with the scan held back. */
async function quietly(fn) {
  busy += 1;
  try {
    return await fn();
  } finally {
    busy -= 1;
    if (!busy && pending) {
      pending = false;
      requestScan(500);
    }
  }
}

function watch() {
  if (watcher) return;
  try {
    watcher = fs.watch(paths.musicDir(), { recursive: true }, (_event, name) => {
      const file = String(name || '');
      if (path.basename(file).startsWith('.flow-')) return;
      // Anything without an extension may be a folder being moved in or out.
      const ext = path.extname(file).toLowerCase();
      if (ext && !AUDIO_EXTS.includes(ext)) return;
      requestScan();
    });
    watcher.on('error', () => {
      // The folder went away or became unreachable. Try again in a while.
      unwatch();
      setTimeout(watch, 10000);
    });
  } catch {
    watcher = null;
    setTimeout(watch, 10000);
  }
}

function unwatch() {
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    // Already closed.
  }
  watcher = null;
}

// ---- moving to another save folder ----

/** A rename, or across drives a copy and a delete. */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    try {
      fs.unlinkSync(from);
    } catch (unlinkErr) {
      fs.rmSync(to, { force: true });
      throw unlinkErr;
    }
  }
}

/** Removes the folders under `dir` that the move left empty (not `dir` itself). */
function removeEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    removeEmptyDirs(sub);
    try {
      fs.rmdirSync(sub);
    } catch {
      // Not empty: something else lives there.
    }
  }
}

/**
 * Moves every song file of the save folder (subfolders included) into
 * `newDir` and makes that the save folder. Songs keep their playlists and
 * statistics; a file that cannot be moved (open in another program) stays
 * where it is and keeps working from there. Resolves { moved, failed, dir }.
 */
async function relocate(newDir, onProgress = () => {}) {
  const oldDir = paths.musicDir();
  const target = path.resolve(String(newDir || ''));
  checkTarget(oldDir, target);
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    throw new Error(`The folder ${target} could not be created.`);
  }
  unwatch();
  try {
    return await quietly(async () => {
      const plan = planMoves(listAudioFiles(oldDir), oldDir, target, (p) => fs.existsSync(p));
      const done = new Map(); // lower-case old path -> new path
      const failed = [];
      for (let i = 0; i < plan.length; i += 1) {
        const { from, to } = plan[i];
        onProgress(i, plan.length, path.basename(from));
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          moveFile(from, to);
          done.set(from.toLowerCase(), to);
        } catch (err) {
          failed.push({ file: from, reason: err.code === 'EBUSY' || err.code === 'EPERM' ? 'in use by another program' : err.message });
        }
        // Let the window hear about the progress between files.
        await new Promise((resolve) => setImmediate(resolve));
      }
      onProgress(plan.length, plan.length, '');
      mutate((d) => {
        for (const s of d.songs) {
          const to = done.get(s.file.toLowerCase());
          if (to) s.file = to;
        }
        d.ignoredFiles = d.ignoredFiles.map((f) => (done.has(f) ? done.get(f).toLowerCase() : f));
      });
      removeEmptyDirs(oldDir);
      paths.setMusicDir(target);
      return { moved: done.size, failed, dir: target };
    });
  } finally {
    watch();
  }
}

module.exports = {
  load, get, save, mutate, onChange, scan, newId, onScanned, quietly, watch, unwatch, findMoved, relocate,
  metaFromFile,
};
