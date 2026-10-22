'use strict';

// Backups (4.0): a library's data, once a week, the last KEEP kept. Only the
// data: the songs' entries (names, album, genre, Info, trim, who added them),
// the playlists, favourites, follows and listening stats; never a song's
// file, a cover, the trash or what a download left behind. The Flow Server
// adds its profiles (names, PIN hashes, admin flags; never the password, the
// level or a device's token); the desktop app backs up its own library.json.
//
// One gzip'd JSON file per backup in a backups folder:
//   { app: 'flow-backup', format, kind ('server' | 'app'), createdAt, reason,
//     summary: { songs, playlists, profiles }, ...what the app put in }
// reason: 'weekly', 'manual', or 'restore' (made just before one, so a
// restore can be undone).
//
// A restore puts the backup's data back over what is there now (merge):
// songs whose files are still there keep them, and songs that came since
// stay, since a backup holds no files to bring back.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KEEP = 6;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FORMAT = 1;
const NAME = /^flow-backup-\d{8}-\d{6}(?:-\d+)?\.json\.gz$/;
const REASONS = ['weekly', 'manual', 'restore'];

/** A backup's file name for `at` (UTC, so they sort by name too). */
function fileName(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `flow-backup-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.json.gz`;
}

const isName = (name) => typeof name === 'string' && NAME.test(name);

function pack(doc) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'));
}

/** A backup file's content, or an Error saying it is none. */
function unpack(buf) {
  let doc;
  try {
    doc = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  } catch {
    throw new Error('That file is not a Flow backup (or it is damaged).');
  }
  if (!doc || doc.app !== 'flow-backup' || !doc.library || typeof doc.library !== 'object') {
    throw new Error('That file is not a Flow backup.');
  }
  if (Number(doc.format) > FORMAT) throw new Error('That backup was made by a newer Flow. Update Flow first.');
  return doc;
}

/**
 * The backups in `dir`. kind: what is backed up ('server' | 'app');
 * collect(): what goes in ({ library, ... }, `library` with songs and
 * playlists); summary(payload): { songs, playlists, profiles }.
 */
function createBackupStore({
  dir, kind, collect, summary = defaultSummary, keep = KEEP, now = Date.now, log = () => {},
}) {
  // Read once per file: name -> { mtime, info }.
  const infoCache = new Map();

  function names() {
    try {
      return fs.readdirSync(dir).filter(isName);
    } catch {
      return [];
    }
  }

  function infoOf(name) {
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const cached = infoCache.get(name);
    if (cached && cached.mtime === st.mtimeMs) return cached.info;
    let info = null;
    try {
      const doc = unpack(fs.readFileSync(file));
      const s = doc.summary || {};
      info = {
        name,
        createdAt: Number(doc.createdAt) || st.mtimeMs,
        reason: REASONS.includes(doc.reason) ? doc.reason : 'manual',
        size: st.size,
        songs: Number(s.songs) || 0,
        playlists: Number(s.playlists) || 0,
        profiles: Number(s.profiles) || 0,
      };
    } catch {
      info = null;
    }
    infoCache.set(name, { mtime: st.mtimeMs, info });
    return info;
  }

  /** The backups, newest first: [{ name, createdAt, reason, size, songs, playlists, profiles }]. */
  function list() {
    return names().map(infoOf).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
  }

  /** Keeps the newest `keep`; `protect`: one of them whatever its age (the one being restored). */
  function prune(protect = '') {
    const all = list();
    const kept = new Set(all.some((b) => b.name === protect) ? [protect] : []);
    for (const b of all) if (kept.size < keep) kept.add(b.name);
    for (const b of all) {
      if (kept.has(b.name)) continue;
      try {
        fs.rmSync(path.join(dir, b.name), { force: true });
        infoCache.delete(b.name);
      } catch {
        // Kept a while longer.
      }
    }
  }

  /** A new backup of what is there now. Returns its info. */
  function make(reason = 'manual', protect = '') {
    const payload = collect();
    const at = now();
    const doc = {
      app: 'flow-backup', format: FORMAT, kind, createdAt: at, reason: REASONS.includes(reason) ? reason : 'manual', summary: summary(payload), ...payload,
    };
    fs.mkdirSync(dir, { recursive: true });
    let name = fileName(at);
    for (let n = 2; fs.existsSync(path.join(dir, name)); n += 1) name = fileName(at).replace('.json.gz', `-${n}.json.gz`);
    const file = path.join(dir, name);
    fs.writeFileSync(`${file}.tmp`, pack(doc));
    fs.renameSync(`${file}.tmp`, file);
    prune(protect);
    log(`Backup made: ${name}`);
    return infoOf(name);
  }

  /** Whether the newest backup is a week old (or there is none). */
  function due() {
    const newest = list()[0];
    return !newest || now() - newest.createdAt >= WEEK_MS || newest.createdAt > now() + WEEK_MS;
  }

  /** The weekly backup, when it is due. Returns its info, or null. */
  function weekly() {
    if (!due()) return null;
    try {
      return make('weekly');
    } catch (err) {
      log(`The weekly backup failed: ${err.message}`);
      return null;
    }
  }

  /** A backup's content by its name, or an Error. */
  function read(name) {
    if (!isName(name)) throw new Error('There is no such backup.');
    let buf;
    try {
      buf = fs.readFileSync(path.join(dir, name));
    } catch {
      throw new Error('That backup is gone.');
    }
    return unpack(buf);
  }

  return {
    dir, list, make, due, weekly, read, prune,
  };
}

function defaultSummary(payload) {
  const lib = payload.library || {};
  const profiles = lib.profiles && typeof lib.profiles === 'object' ? Object.keys(lib.profiles).length : 0;
  return {
    songs: Array.isArray(lib.songs) ? lib.songs.length : 0,
    playlists: Array.isArray(lib.playlists) ? lib.playlists.length : 0,
    profiles,
  };
}

// What a song's file decides: it comes from the file that is there now.
const FILE_FIELDS = ['file', 'format', 'duration', 'loudness', 'cover', 'tagged', 'cut'];

/**
 * The library a restore leaves (both sanitized by libraryModel): `backup`'s
 * data, with each song's file as it is now. A song of the backup:
 *  - still here (same id): the backup's names, stats and favourite, the
 *    file's own fields (FILE_FIELDS) as they are now;
 *  - gone, its file still there: as in the backup, its cover looked for again;
 *  - gone with its file: takeBack(song) may bring the file back (the
 *    server's trash) and answers its path, else '' and the song stays out.
 * Songs that came since the backup stay as they are (outside its playlists).
 */
function mergeRestore(current, backup, { fileExists = (f) => fs.existsSync(f), takeBack = () => '' } = {}) {
  const now = new Map(current.songs.map((s) => [s.id, s]));
  const songs = [];
  const files = new Set();
  let back = 0;
  let missing = 0;
  for (const b of backup.songs) {
    const c = now.get(b.id);
    let song = null;
    if (c) {
      song = { ...b };
      for (const k of FILE_FIELDS) song[k] = c[k];
    } else if (fileExists(b.file)) {
      song = { ...b, cover: null };
    } else {
      const file = takeBack(b);
      if (file) {
        song = { ...b, file, cover: null };
        back += 1;
      } else missing += 1;
    }
    if (!song || files.has(song.file.toLowerCase())) continue;
    files.add(song.file.toLowerCase());
    songs.push(song);
  }
  const ids = new Set(songs.map((s) => s.id));
  let kept = 0;
  for (const c of current.songs) {
    if (ids.has(c.id) || files.has(c.file.toLowerCase())) continue;
    songs.push(c);
    kept += 1;
  }
  const ignored = new Set([...(current.ignoredFiles || []), ...(backup.ignoredFiles || [])]);
  const data = {
    ...backup,
    songs,
    ignoredFiles: [...ignored],
    infoRound: Math.max(Number(current.infoRound) || 0, Number(backup.infoRound) || 0),
  };
  return {
    data,
    counts: {
      songs: songs.length, back, missing, kept,
    },
  };
}

module.exports = {
  createBackupStore, mergeRestore, pack, unpack, fileName, isName, KEEP, WEEK_MS,
};
