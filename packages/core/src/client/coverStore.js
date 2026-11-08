'use strict';

// An app's covers of one library (4.3.1): Local Files' ('local') or a Flow
// Server's (its id), each in two sizes, one folder each:
//
//   <dir>/thumbnails/<song id>.webp   128 x 128, what every list shows
//   <dir>/high_res/<song id>.webp     512 x 512, Details, the visualizers,
//                                     the lock screen
//
// Each folder keeps an index.json, { id: { v, n } }: the version of the
// picture (the library's song.cover: the same for both sizes, so it is kept,
// not read from the file) and its size. A file without an entry (the index
// lost) has no version and is fetched again when it is shown. Covers from
// before 4.3.1 (<dir>/<song id>.jpg, one size) are `legacy`: whoever owns the
// store makes them into the two, or lets them go.
//
// `io` is the app's way to its files (the desktop's fs, the phone's bridge):
// { join, list(dir) -> [{ name, dir, size }], readText, writeText, writeBytes,
// readBytes, remove(path, { recursive }), mkdir, rename, copy, exists }.
// No Node modules: the phone runs this in its WebView.

const ID_RE = /^[\w-]{1,64}$/;
const SIZES = { small: 'thumbnails', big: 'high_res' };
const INDEX = 'index.json';
const EXT = '.webp';

function createCoverStore(dir, io, { saveDelayMs = 1000 } = {}) {
  const sub = (size) => io.join(dir, SIZES[size] || SIZES.small);
  const check = (id) => {
    if (!ID_RE.test(String(id || ''))) throw new Error('Not a song id.');
    return String(id);
  };
  const file = (id, size = 'small') => io.join(sub(size), `${check(id)}${EXT}`);
  const indexes = { small: null, big: null };
  const timers = { small: null, big: null };

  /** A size's index, checked against its folder once: files without an entry have no version. */
  function load(size) {
    if (indexes[size]) return indexes[size];
    let saved = null;
    try {
      saved = JSON.parse(io.readText(io.join(sub(size), INDEX)) || 'null');
    } catch {
      saved = null;
    }
    const index = {};
    let changed = false;
    let entries = [];
    try {
      entries = io.list(sub(size));
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (e.dir) continue;
      if (/\.tmp$/i.test(e.name)) {
        try {
          io.remove(io.join(sub(size), e.name));
        } catch {
          // The next look.
        }
        continue;
      }
      if (!e.name.endsWith(EXT)) continue;
      const id = e.name.slice(0, -EXT.length);
      if (!ID_RE.test(id)) continue;
      const known = saved && saved[id];
      index[id] = known && known.n === e.size ? { v: String(known.v || ''), n: e.size } : { v: '', n: e.size };
      if (!known || known.n !== e.size) changed = true;
    }
    if (saved && Object.keys(saved).some((id) => !index[id])) changed = true;
    indexes[size] = index;
    if (changed) saveSoon(size);
    return index;
  }

  function saveSoon(size) {
    if (timers[size]) return;
    timers[size] = setTimeout(() => {
      timers[size] = null;
      saveNow(size);
    }, saveDelayMs);
  }

  function saveNow(size) {
    if (!indexes[size]) return;
    try {
      io.mkdir(sub(size));
      io.writeText(io.join(sub(size), INDEX), JSON.stringify(indexes[size]));
    } catch {
      // The next change saves it; a lost index costs a fetch again.
    }
  }

  const sizesOf = (size) => (size ? [size] : ['small', 'big']);

  const store = {
    dir,
    file,
    /** The folder of one size (the window builds its file addresses from it). */
    folder: sub,
    has: (id, size = 'small') => !!load(size)[id],
    /** The version of the file here ('' when it has none known, or there is none). */
    version: (id, size = 'small') => (load(size)[id] ? load(size)[id].v : ''),
    /** A cover's bytes as this size, kept as version `v`. */
    write(id, size, bytes, v) {
      const dest = file(id, size);
      io.mkdir(sub(size));
      io.writeBytes(dest, bytes);
      load(size)[id] = { v: String(v || ''), n: bytes.length };
      saveSoon(size);
    },
    /** Another file moved in as this size (same drive best), kept as version `v`. */
    take(id, size, from, v, n = 0) {
      const dest = file(id, size);
      io.mkdir(sub(size));
      io.rename(from, dest);
      load(size)[id] = { v: String(v || ''), n };
      saveSoon(size);
    },
    read(id, size = 'small') {
      try {
        return load(size)[id] ? io.readBytes(file(id, size)) : null;
      } catch {
        return null;
      }
    },
    /** A song's covers gone (both sizes, or one). */
    remove(id, size = null) {
      for (const sz of sizesOf(size)) {
        try {
          io.remove(file(id, sz));
        } catch {
          // Open somewhere; the next sweep.
        }
        if (load(sz)[id]) {
          delete indexes[sz][id];
          saveSoon(sz);
        }
      }
    },
    ids: (size = 'small') => Object.keys(load(size)),
    /** { count, bytes } of one size. */
    size(size = 'small') {
      const all = Object.values(load(size));
      return { count: all.length, bytes: all.reduce((n, e) => n + (e.n || 0), 0) };
    },
    /** Every cover of one size gone (Settings' Clear). Answers how many. */
    clear(size) {
      const ids = Object.keys(load(size));
      for (const id of ids) {
        try {
          io.remove(file(id, size));
        } catch {
          // Open somewhere.
        }
      }
      indexes[size] = {};
      saveNow(size);
      return ids.length;
    },
    /** The covers of songs not in `keep` (a Set) gone. */
    sweep(keep) {
      let removed = 0;
      for (const sz of sizesOf()) {
        for (const id of Object.keys(load(sz))) {
          if (keep.has(id)) continue;
          store.remove(id, sz);
          removed += 1;
        }
      }
      return removed;
    },
    /** This song's covers as `toId`'s in another store (both sizes it has); the version copied, or ''. */
    copyTo(id, other, toId, v = null) {
      let copied = '';
      for (const sz of sizesOf()) {
        const e = load(sz)[id];
        if (!e) continue;
        io.mkdir(other.folder(sz));
        io.copy(file(id, sz), other.file(toId, sz));
        other.adopt(toId, sz, { v: v === null ? e.v : v, n: e.n });
        copied = v === null ? e.v : v;
      }
      return copied;
    },
    adopt(id, size, entry) {
      load(size)[id] = { v: String(entry.v || ''), n: Number(entry.n) || 0 };
      saveSoon(size);
    },
    /** Covers from before 4.3.1 still here: [{ id, file }]. */
    legacy() {
      let entries = [];
      try {
        entries = io.list(dir);
      } catch {
        return [];
      }
      return entries.filter((e) => !e.dir && /\.jpg$/i.test(e.name) && ID_RE.test(e.name.slice(0, -4)))
        .map((e) => ({ id: e.name.slice(0, -4), file: io.join(dir, e.name) }));
    },
    /** Pending index writes done now (quitting). */
    flush() {
      for (const sz of sizesOf()) {
        if (timers[sz]) {
          clearTimeout(timers[sz]);
          timers[sz] = null;
          saveNow(sz);
        }
      }
    },
    forget() {
      for (const sz of sizesOf()) {
        clearTimeout(timers[sz]);
        timers[sz] = null;
        indexes[sz] = null;
      }
    },
  };
  return store;
}

module.exports = { createCoverStore, SIZES, ID_RE };
