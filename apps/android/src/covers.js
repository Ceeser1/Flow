'use strict';

// Song covers on the phone: <files>/Covers/<scope>/<song id>.jpg, scope being
// 'local' (Local Files) or a Flow Server's id, as on the desktop
// (apps/desktop/src/covers.js). What differs: a cover's version (the start of
// its SHA-1) is kept in an index.json beside the covers, so knowing which are
// up to date needs no file read through the bridge. store.read(id) gives
// { version } from it, which versionOf() hands back; the shared client only
// reads a cover to learn its version.

const { fs, path } = require('./native');

const LOCAL = 'local';
const ID_RE = /^[\w-]{1,64}$/;
const INDEX = 'index.json';

function createStore(dir) {
  let index = null; // id -> { v, size }
  let saveTimer = null;

  const file = (id) => {
    if (!ID_RE.test(String(id || ''))) throw new Error('Not a song id.');
    return path.join(dir, `${id}.jpg`);
  };

  /** The index, checked against the folder: a cover without an entry is hashed once. */
  function load() {
    if (index) return index;
    let saved = null;
    try {
      saved = JSON.parse(fs.readText(path.join(dir, INDEX)) || 'null');
    } catch {
      saved = null;
    }
    index = {};
    let changed = !saved;
    for (const e of fs.list(dir)) {
      if (e.dir || !/\.jpg$/i.test(e.name)) {
        if (/\.tmp$/i.test(e.name)) fs.remove(path.join(dir, e.name));
        continue;
      }
      const id = e.name.slice(0, -4);
      if (!ID_RE.test(id)) continue;
      const known = saved && saved[id];
      if (known && known.size === e.size && known.v) {
        index[id] = known;
      } else {
        index[id] = { v: fs.sha1(path.join(dir, e.name)).slice(0, 10), size: e.size };
        changed = true;
      }
    }
    if (saved && Object.keys(saved).some((id) => !index[id])) changed = true;
    if (changed) saveSoon();
    return index;
  }

  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdir(dir);
        fs.writeText(path.join(dir, INDEX), JSON.stringify(index || {}));
      } catch {
        // The next change saves it; a lost index is rebuilt from the files.
      }
    }, 1000);
  }

  return {
    dir,
    file,
    has: (id) => !!load()[id],
    read: (id) => (load()[id] ? { version: load()[id].v } : null),
    write(id, jpeg) {
      const dest = file(id);
      fs.mkdir(dir);
      fs.writeBytes(dest, jpeg);
      const v = fs.sha1(dest).slice(0, 10);
      load()[id] = { v, size: jpeg.length };
      saveSoon();
      return v;
    },
    remove(id) {
      try {
        fs.remove(file(id));
      } catch {
        // The next look at the folder gets it.
      }
      if (load()[id]) {
        delete index[id];
        saveSoon();
      }
    },
    ids: () => Object.keys(load()),
    size() {
      const all = Object.values(load());
      return { count: all.length, bytes: all.reduce((n, e) => n + (e.size || 0), 0) };
    },
    /** This cover as `toId`'s in another store: its version, or null without one. */
    copyTo(id, other, toId) {
      const e = load()[id];
      if (!e) return null;
      fs.mkdir(other.dir);
      fs.copy(file(id), other.file(toId));
      other.adopt(toId, e);
      return e.v;
    },
    /** A JPEG elsewhere in Flow's storage moved in as `id`'s cover; its version. */
    take(id, jpegFile) {
      const dest = file(id);
      fs.mkdir(dir);
      fs.rename(jpegFile, dest);
      const v = fs.sha1(dest).slice(0, 10);
      load()[id] = { v, size: Math.max(0, fs.size(dest)) };
      saveSoon();
      return v;
    },
    adopt(id, entry) {
      load()[id] = { ...entry };
      saveSoon();
    },
    forget() {
      clearTimeout(saveTimer);
      saveTimer = null;
      index = null;
    },
  };
}

/** The covers of every scope under `root`; tell(scope, ids) when some arrived. */
function createCovers({ root, tell }) {
  const stores = new Map();
  const dirOf = (scope) => path.join(root, scope);
  const storeOf = (scope) => {
    if (!stores.has(scope)) stores.set(scope, createStore(dirOf(scope)));
    return stores.get(scope);
  };
  const localStore = () => storeOf(LOCAL);

  return {
    LOCAL,
    dirOf,
    storeOf,
    localStore,
    tell: (scope, ids) => {
      if (ids && ids.length) tell(scope, ids);
    },
    versionOf: (read) => (read && read.version) || '',
    copyToLocal(serverId, serverSongId, localId) {
      try {
        return storeOf(serverId).copyTo(serverSongId, localStore(), localId);
      } catch {
        return null;
      }
    },
    copyToServer(localId, serverId, serverSongId) {
      try {
        if (!localStore().copyTo(localId, storeOf(serverId), serverSongId)) return false;
        tell(serverId, [serverSongId]);
        return true;
      } catch {
        return false;
      }
    },
    serverIds: () => fs.list(root).filter((e) => e.dir && e.name !== LOCAL).map((e) => e.name),
    removeServer(id) {
      if (stores.has(id)) stores.get(id).forget();
      stores.delete(id);
      fs.remove(dirOf(id), { recursive: true });
    },
  };
}

module.exports = { createCovers, LOCAL };
