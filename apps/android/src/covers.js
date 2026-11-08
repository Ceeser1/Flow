'use strict';

// Song covers on the phone, in two sizes since 4.3.1, as on the desktop
// (apps/desktop/src/covers.js, the store being @flow/core/client/coverStore):
//
//   <files>/Covers/<scope>/thumbnails/<song id>.webp   128 x 128
//   <files>/Covers/<scope>/high_res/<song id>.webp     512 x 512
//
// scope being 'local' (Local Files) or a Flow Server's id. Each folder's
// index.json records the versions, so knowing which are up to date needs no
// file read through the bridge. The phone has no ffmpeg: a picture is made
// into the two sizes by the WebView's canvas (WebP), in the background; until
// then (or where the canvas cannot) the picture stands in for both.
// Covers from before 4.3.1 (<scope>/<song id>.jpg): Local Files' are made
// into the two keeping their version, a server's go (fetched when shown).

const { fs, path } = require('./native');
const { createCoverStore } = require('@flow/core/client/coverStore');

const LOCAL = 'local';
const BIG = 512;
const SMALL = 128;

/** The store's way to the phone's files (the bridge). */
const io = {
  join: path.join,
  list: (dir) => fs.list(dir),
  readText: (p) => fs.readText(p),
  writeText: (p, text) => fs.writeText(p, text),
  ...(fs.canAppend() ? { appendText: (p, text) => fs.appendText(p, text) } : {}),
  writeBytes: (p, bytes) => fs.writeBytes(p, bytes),
  readBytes: (p) => fs.readBytes(p),
  remove: (p, opts) => fs.remove(p, opts),
  mkdir: (p) => fs.mkdir(p),
  rename: (from, to) => fs.rename(from, to),
  copy: (from, to) => fs.copy(from, to),
  exists: (p) => fs.exists(p),
};

/** One square size of a picture as WebP (its middle when it is not square), or null where the canvas cannot. */
async function squareWebp(bitmap, side) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(side, side);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const crop = Math.min(bitmap.width, bitmap.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, side, side);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
  if (!blob || blob.type !== 'image/webp') return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/** A picture's two sizes as WebP: { big, small }, or null where the WebView cannot make them. */
async function makePair(bytes) {
  if (typeof createImageBitmap !== 'function' || typeof Blob === 'undefined') return null;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]));
    const big = await squareWebp(bitmap, BIG);
    const small = big ? await squareWebp(bitmap, SMALL) : null;
    return big && small ? { big, small } : null;
  } catch {
    return null;
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
  }
}

/** The covers of every scope under `root`; tell(scope, ids, size) when some arrived. */
function createCovers({ root, tell }) {
  const stores = new Map();
  const dirOf = (scope) => path.join(root, scope);
  const storeOf = (scope) => {
    if (!stores.has(scope)) stores.set(scope, createCoverStore(dirOf(scope), io));
    return stores.get(scope);
  };
  const localStore = () => storeOf(LOCAL);
  const told = (scope, ids, size = null) => {
    if (ids && ids.length) tell(scope, ids, size);
  };

  // Pictures still to be made into the two sizes, one at a time: [{ id, v }].
  const toMake = [];
  let making = null;
  function makeSoon(id, v) {
    if (!toMake.some((x) => x.id === id)) toMake.push({ id, v });
    if (making) return;
    making = (async () => {
      while (toMake.length) {
        const { id: next, v: version } = toMake.shift();
        const store = localStore();
        const bytes = store.read(next, 'big');
        if (!bytes || store.version(next, 'big') !== version) continue;
        const pair = await makePair(bytes);
        // Changed meanwhile (another picture, or gone): left as it is.
        if (!pair || store.version(next, 'big') !== version) continue;
        store.write(next, 'big', pair.big, version);
        store.write(next, 'small', pair.small, version);
        told(LOCAL, [next]);
      }
    })().catch(() => {}).finally(() => {
      making = null;
    });
  }

  /** The big one copied as the thumbnail too, until the two are made. */
  function standIn(store, id, v, n) {
    try {
      io.mkdir(store.folder('small'));
      fs.copy(store.file(id, 'big'), store.file(id, 'small'));
      store.adopt(id, 'small', { v, n });
    } catch {
      // The big one shows meanwhile.
    }
    makeSoon(id, v);
  }

  return {
    LOCAL,
    dirOf,
    storeOf,
    localStore,
    tell: told,
    /**
     * A picture file (a song's own, found when it was imported) moved in as
     * a Local Files song's cover: its version (the picture's SHA-1 start).
     * It stands in for both sizes until the two are made, in the background.
     */
    takeLocal(id, file) {
      const store = localStore();
      const v = fs.sha1(file).slice(0, 10);
      const n = Math.max(0, fs.size(file));
      store.take(id, 'big', file, v, n);
      standIn(store, id, v, n);
      return v;
    },
    /** Covers from before 4.3.1: Local Files' made into the two (version kept, `songCover(id)` the song's), a server's gone. */
    convertLegacy(songCover) {
      for (const e of fs.list(root)) {
        if (!e.dir || e.name === LOCAL) continue;
        for (const old of storeOf(e.name).legacy()) fs.remove(old.file);
      }
      const store = localStore();
      for (const old of store.legacy()) {
        const v = songCover(old.id);
        if (v && v !== '-' && !store.has(old.id, 'big')) {
          const n = Math.max(0, fs.size(old.file));
          store.take(old.id, 'big', old.file, v, n);
          standIn(store, old.id, v, n);
        } else {
          fs.remove(old.file);
        }
      }
    },
    copyToLocal(serverId, serverSongId, localId) {
      try {
        return storeOf(serverId).copyTo(serverSongId, localStore(), localId) || null;
      } catch {
        return null;
      }
    },
    copyToServer(localId, serverId, serverSongId) {
      try {
        if (!localStore().copyTo(localId, storeOf(serverId), serverSongId)) return false;
        told(serverId, [serverSongId]);
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
    flush() {
      for (const store of stores.values()) store.flush();
    },
  };
}

module.exports = { createCovers, makePair, LOCAL };
