'use strict';

// flow-server move-music <old folder>: everything in a music folder used
// before moved into the one now, its folders merged with those of the same
// name there (a file whose name is taken gets " (2)"). The library's songs,
// ignored files and the trash's records follow their files, so playlists,
// covers and stats stay. install.sh and Flow Server Settings offer it when the
// music folder is changed. The server must not be running: it would scan the
// files away while they move.

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('@flow/core/jsonFile');

// Windows' paths are the same in any case ("c:\Users" and "C:\Users").
const key = (file) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
const inside = (dir, file) => {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Every file below `dir`, deepest folders included. */
function filesIn(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Why `from` can't be moved into `to`, or ''. */
function problem(from, to) {
  if (key(from) === key(to)) return 'That is the music folder already.';
  if (inside(from, to)) return `The music folder (${to}) is inside ${from}: move it out first, or pick another.`;
  if (inside(to, from)) return `${from} is inside the music folder (${to}) already: the server plays its songs as they are.`;
  return '';
}

/** What a move would take: { songs, files } (songs: the library's songs whose file is in `from`). */
function plan(config, from) {
  const dir = path.resolve(from);
  const raw = readJson(config.libraryFile) || {};
  const songs = (raw.songs || []).filter((s) => s && typeof s.file === 'string' && inside(dir, s.file) && fs.existsSync(s.file)).length;
  return { songs, files: fs.existsSync(dir) ? filesIn(dir).length : 0 };
}

/** A free path for `want`: itself, else "name (2).ext", "name (3).ext"... */
function freePath(want) {
  if (!fs.existsSync(want)) return want;
  const ext = path.extname(want);
  const stem = want.slice(0, want.length - ext.length);
  for (let n = 2; ; n += 1) {
    const p = `${stem} (${n})${ext}`;
    if (!fs.existsSync(p)) return p;
  }
}

/** Moves one file, across drives too (a copy, then the old one deleted). */
function moveFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dst);
    const st = fs.statSync(src);
    fs.utimesSync(dst, st.atime, st.mtime);
    fs.unlinkSync(src);
  }
}

/** Removes the folders below `dir` (and `dir`) that are empty now; returns whether `dir` went. */
function removeEmpty(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let left = 0;
  for (const e of entries) {
    if (!(e.isDirectory() && removeEmpty(path.join(dir, e.name)))) left += 1;
  }
  if (left) return false;
  try {
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves everything in `from` into the music folder (config.musicDir) and
 * points the library at the new places. Returns { files, songs, renamed,
 * failed: [{ file, error }], removed (whether `from` is gone) }.
 */
function moveMusic({ config, from, log = () => {} }) {
  const src = path.resolve(from);
  const dst = path.resolve(config.musicDir);
  const why = problem(src, dst);
  if (why) throw new Error(why);
  if (!fs.existsSync(src)) throw new Error(`${src} is not there (any more).`);

  const moved = new Map();
  const failed = [];
  let renamed = 0;
  for (const file of filesIn(src)) {
    const want = path.join(dst, path.relative(src, file));
    const to = freePath(want);
    try {
      moveFile(file, to);
      moved.set(key(file), to);
      if (to !== want) renamed += 1;
    } catch (err) {
      failed.push({ file, error: err.message });
    }
  }

  // The library, then the trash's records: only what moved changes.
  let songs = 0;
  const raw = readJson(config.libraryFile);
  if (raw && Array.isArray(raw.songs)) {
    for (const s of raw.songs) {
      const to = s && typeof s.file === 'string' && moved.get(key(s.file));
      if (!to) continue;
      s.file = to;
      songs += 1;
    }
    if (Array.isArray(raw.ignoredFiles)) {
      raw.ignoredFiles = raw.ignoredFiles.map((f) => {
        const to = moved.get(key(f));
        return to ? to.toLowerCase() : f;
      });
    }
    writeJsonAtomic(config.libraryFile, raw);
  }
  const trashFile = path.join(config.home, 'trash.json');
  const trash = readJson(trashFile);
  if (Array.isArray(trash) && trash.length) {
    const bin = path.join(dst, '.flow-trash');
    let changed = false;
    for (const e of trash) {
      if (!e || typeof e.name !== 'string') continue;
      // A trash file renamed because one of that name was there already.
      const to = moved.get(key(path.join(src, '.flow-trash', e.name)));
      if (to && path.dirname(to) === bin && path.basename(to) !== e.name) {
        e.name = path.basename(to);
        changed = true;
      }
      // Where it goes back to when it is restored.
      const back = e.song && typeof e.song.file === 'string' && inside(src, e.song.file) ? path.join(dst, path.relative(src, e.song.file)) : '';
      if (back) {
        e.song.file = back;
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(trashFile, trash);
  }

  const removed = removeEmpty(src);
  log(`Moved ${moved.size} ${moved.size === 1 ? 'file' : 'files'} (${songs} ${songs === 1 ? 'song' : 'songs'}) from ${src} into ${dst}`);
  return { files: moved.size, songs, renamed, failed, removed };
}

module.exports = { moveMusic, plan, problem };
