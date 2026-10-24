'use strict';

// The Lyrics folder (4.0.1), next to Covers in Flow's music folder: a file
// for each song, by scope as the covers are:
//
//   local/<song id>.json        Local Files' songs: looked up here, or written in Flow
//   <server id>/<song id>.json  a Flow Server's songs: copies of the server's
//                               (or looked up here while it could not say)
//
// A song none were found for has <song id>.none.json instead (the answer is
// kept so it is not asked again too soon), which does not count as lyrics.
//
// fs: { readText, writeText, list, remove, mkdir } as the phone's native fs
// has them (list: [{ name, dir, size }]); join: path.join; dir(): the folder.

const LOCAL = 'local';
const ID = /^[\w-]{1,64}$/;
const FILE = /^([\w-]{1,64})(\.none)?\.json$/;

function createLyricsFolder({ dir, fs, join }) {
  const fileOf = (scope, id, none) => join(dir(), scope, `${id}${none ? '.none' : ''}.json`);
  const ok = (scope, id) => ID.test(String(scope || '')) && ID.test(String(id || ''));

  function list(path) {
    try {
      return fs.list(path) || [];
    } catch {
      return [];
    }
  }

  function drop(file) {
    try {
      fs.remove(file);
    } catch {
      // Not there.
    }
  }

  /** What is kept for the song, or null. */
  function read(scope, id) {
    if (!ok(scope, id)) return null;
    for (const none of [false, true]) {
      try {
        const text = fs.readText(fileOf(scope, id, none));
        if (text) return JSON.parse(text);
      } catch {
        // Not there, or unreadable: the other one, else nothing.
      }
    }
    return null;
  }

  /** Keeps `kept` for the song (a .none file when nothing was found). */
  function write(scope, id, kept) {
    if (!ok(scope, id) || !kept) return;
    const none = !kept.found;
    fs.mkdir(join(dir(), scope));
    fs.writeText(fileOf(scope, id, none), JSON.stringify(kept));
    drop(fileOf(scope, id, !none));
  }

  function remove(scope, id) {
    if (!ok(scope, id)) return;
    drop(fileOf(scope, id, false));
    drop(fileOf(scope, id, true));
  }

  /** The songs with something kept in `scope`. */
  function ids(scope) {
    if (!ID.test(String(scope || ''))) return [];
    const out = new Set();
    for (const e of list(join(dir(), scope))) {
      const m = !e.dir && FILE.exec(e.name);
      if (m) out.add(m[1]);
    }
    return [...out];
  }

  /** local and the servers' ids. */
  function scopes() {
    return list(dir()).filter((e) => e.dir && ID.test(e.name)).map((e) => e.name);
  }

  function removeScope(scope) {
    if (!ID.test(String(scope || ''))) return;
    try {
      fs.remove(join(dir(), scope), { recursive: true });
    } catch {
      // Not there.
    }
  }

  /** count: the songs with lyrics kept; none: those none were found for; bytes: every file. */
  function size() {
    let count = 0;
    let none = 0;
    let bytes = 0;
    for (const scope of scopes()) {
      for (const e of list(join(dir(), scope))) {
        const m = !e.dir && FILE.exec(e.name);
        if (!m) continue;
        bytes += Number(e.size) || 0;
        if (m[2]) none += 1;
        else count += 1;
      }
    }
    return { count, none, bytes };
  }

  return {
    read, write, remove, ids, scopes, removeScope, size,
  };
}

module.exports = { createLyricsFolder, LOCAL };
