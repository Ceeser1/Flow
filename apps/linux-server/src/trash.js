'use strict';

// The music folder's trash: a deleted song's file goes to .flow-trash for
// TRASH_KEEP_MS (30 days), in case it was deleted by mistake. Since 3.5 the
// song itself is kept beside it, in <home>/trash.json: its library entry,
// each profile's stats and favourite of it, and the playlists it was in. An
// admin can then put it back as it was (library.js restoreFromTrash). Files
// without an entry (deleted before 3.5, a trimmed song's uncut file) can
// only come back as new songs.
//
//   entry  { name, at, by, song, own: { profileId: { stats, favouriteAt } },
//            lists: [{ owner, playlistId, addedAt, index }] }
//   name   the file's name in .flow-trash; by: the profile that deleted it
//          ('default': the Default / Shared, '' unknown)

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');

const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// The time put in front of a file's name in the trash.
const STAMP = /^\d{10,}-(?:\d+-)?/;

/** opts: { dir (.flow-trash), indexFile, log }. */
function createTrash({ dir, indexFile, log = () => {} }) {
  let entries = (Array.isArray(readJson(indexFile)) ? readJson(indexFile) : [])
    .filter((e) => e && typeof e.name === 'string' && e.name === path.basename(e.name));

  const saveIndex = () => writeJsonAtomic(indexFile, entries);

  /** A trash file's name as it was, without the time in front. */
  const originalName = (name) => name.replace(STAMP, '');

  /**
   * Moves `file` into the trash, with what is known of its song (`record`:
   * { by, song, own, lists }, or null). Returns its name there, or '' when
   * it could not be moved.
   */
  function put(file, record = null) {
    try {
      if (!fs.existsSync(file)) return '';
      fs.mkdirSync(dir, { recursive: true });
      const now = Date.now();
      let name = `${now}-${path.basename(file)}`;
      for (let n = 2; fs.existsSync(path.join(dir, name)); n += 1) name = `${now}-${n}-${path.basename(file)}`;
      fs.renameSync(file, path.join(dir, name));
      // A move keeps the file's own time, which may be long ago: the 30 days
      // count from now.
      fs.utimesSync(path.join(dir, name), new Date(now), new Date(now));
      if (record && record.song) {
        entries.push({ name, at: now, by: String(record.by || ''), song: record.song, own: record.own || {}, lists: record.lists || [] });
        saveIndex();
      }
      return name;
    } catch (err) {
      log(`Could not move ${file} to the trash: ${err.message}`);
      return '';
    }
  }

  /** What is in the trash, newest first: [{ name, at, size, song|null, by }]. */
  function list() {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const byName = new Map(entries.map((e) => [e.name, e]));
    const out = [];
    for (const name of names) {
      let st;
      try {
        st = fs.statSync(path.join(dir, name));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const e = byName.get(name);
      out.push({
        name, at: e ? e.at : st.mtimeMs, size: st.size, song: e ? e.song : null, by: e ? e.by : '', originalName: originalName(name),
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** A trash file and its entry (null: none), or null when there is no such file. */
  function get(name) {
    if (typeof name !== 'string' || !name || name !== path.basename(name) || name.startsWith('.')) return null;
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return null;
    return { file, originalName: originalName(name), entry: entries.find((e) => e.name === name) || null };
  }

  /** Forgets a file's entry (it was put back). */
  function forget(name) {
    const before = entries.length;
    entries = entries.filter((e) => e.name !== name);
    if (entries.length !== before) saveIndex();
  }

  /**
   * Deletes files older than TRASH_KEEP_MS, or everything (`all`), and the
   * entries of files no longer there. Returns how many files went.
   */
  function empty(all = false) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    const cutoff = Date.now() - TRASH_KEEP_MS;
    let gone = 0;
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (all || fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { force: true, recursive: true });
          gone += 1;
        }
      } catch {
        // Gone already.
      }
    }
    const left = new Set(names.filter((n) => fs.existsSync(path.join(dir, n))));
    const before = entries.length;
    entries = entries.filter((e) => left.has(e.name));
    if (entries.length !== before) saveIndex();
    return gone;
  }

  return {
    put, list, get, forget, empty,
  };
}

module.exports = { createTrash, TRASH_KEEP_MS };
