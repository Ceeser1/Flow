'use strict';

// Covers on this computer, in Music\FlowPlayer\Covers (paths.coversDir), in
// two sizes since 4.3.1 (@flow/core/client/coverStore):
//
//   local\thumbnails\<song id>.webp   Local Files' songs, 128 x 128 and
//   local\high_res\<song id>.webp     512 x 512, both made at once from the
//                                     picture found (cover.makeCoverPair).
//                                     Songs without one get one in the
//                                     background, one at a time (the song's
//                                     thumbnail, the picture in its file,
//                                     YouTube Music, else the video's).
//   <server id>\thumbnails\...        a Flow Server's, fetched by remote.js
//   <server id>\high_res\...          when they are shown (the big ones only
//                                     with "Download high resolution covers",
//                                     or kept from before), and kept across
//                                     restarts and server switches.
//
// song.cover is the version of the picture (the start of the big one's
// SHA-1, the same on the server), which each folder's index.json records for
// its files. Covers from before 4.3.1 (<scope>\<song id>.jpg): Local Files'
// are made into the two keeping their version, a server's go (they are
// fetched again when shown). The window shows covers as files
// (Covers.src); it hears of new ones through onUpdated.
//
// A song downloaded on the Add Songs page gets its cover looked for as soon
// as it is downloaded (stage), kept beside its cached file while it is
// trimmed and named (the window hears of it through onStaged), and handed to
// the song when it is finished (adoptStaged).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const tools = require('./tools');
const settings = require('./settings');
const cookieJar = require('./cookieJar');
const { createMedia } = require('@flow/core/media');
const library = require('./library');
const model = require('@flow/core/libraryModel');
const cover = require('@flow/core/cover');
const { createCoverStore } = require('@flow/core/client/coverStore');
const { isNameOnlyList } = require('@flow/core/text');
const { tr } = require('@flow/core/lang');

const LOCAL = 'local';
const BATCH = 10;
const BATCH_MS = 5000;
// A moment between songs: hundreds of lookups in a row must not get the
// downloads rate-limited by YouTube.
const PAUSE_MS = 1000;

// ---- the folders ----

/** A file written whole or not at all (a temporary file renamed over it). */
function writeAtomic(dest, data) {
  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** The store's way to this computer's files. */
const io = {
  join: path.join,
  list(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
      let size = 0;
      if (!e.isDirectory()) {
        try {
          size = fs.statSync(path.join(dir, e.name)).size;
        } catch {
          size = 0;
        }
      }
      return { name: e.name, dir: e.isDirectory(), size };
    });
  },
  readText(p) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  writeText: (p, text) => writeAtomic(p, text),
  appendText: (p, text) => fs.appendFileSync(p, text, 'utf8'),
  writeBytes: (p, bytes) => writeAtomic(p, bytes),
  readBytes: (p) => fs.readFileSync(p),
  remove: (p, { recursive = false } = {}) => fs.rmSync(p, { force: true, recursive }),
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  rename(from, to) {
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
    }
  },
  copy: (from, to) => fs.copyFileSync(from, to),
  exists: (p) => fs.existsSync(p),
};

const stores = new Map(); // scope -> its store, made once (its indexes read once)

/** The folder of a scope's covers ('local' or a server id). */
function dirOf(scope) {
  return path.join(paths.coversDir(), scope);
}

const storeOf = (scope) => {
  if (!/^[\w-]{1,64}$/.test(String(scope || ''))) throw new Error(tr('desktop.error.notCoverFolder', 'Not a cover folder.'));
  const dir = dirOf(scope);
  const known = stores.get(scope);
  if (known && known.dir === dir) return known;
  if (known) known.flush();
  const store = createCoverStore(dir, io);
  stores.set(scope, store);
  return store;
};
const localStore = () => storeOf(LOCAL);

/** Each Flow Server's covers, by server id: the folders under Covers but Local Files' own. */
function serverIds() {
  let names = [];
  try {
    names = fs.readdirSync(paths.coversDir(), { withFileTypes: true });
  } catch {
    names = [];
  }
  return names.filter((e) => e.isDirectory() && e.name !== LOCAL && /^[\w-]{1,64}$/.test(e.name)).map((e) => e.name);
}

/** A server's covers all gone (both sizes). */
function removeServer(id) {
  const store = stores.get(id);
  if (store) store.forget();
  stores.delete(id);
  fs.rmSync(dirOf(id), { recursive: true, force: true });
}

/** Pending index writes saved (quitting). */
function flush() {
  for (const store of stores.values()) store.flush();
}

/**
 * The two sizes of a picture (a JPEG found, a song file's): made in one go.
 * Without ffmpeg (or when it fails) a JPEG or WebP is kept as it is for both.
 */
async function pairOf(picture) {
  const pair = await cover.makeCoverPair(tools.findFfmpeg(), picture).catch(() => null);
  if (pair) return pair;
  const bytes = typeof picture === 'string' ? fs.readFileSync(picture) : picture;
  return cover.isJpeg(bytes) || cover.isWebp(bytes) ? { big: bytes, small: bytes } : null;
}

/** Both sizes into a store as `v` (the big one's version when none is given): the version. */
function writePair(store, id, pair, v = cover.coverVersion(pair.big)) {
  store.write(id, 'big', pair.big, v);
  store.write(id, 'small', pair.small, v);
  return v;
}

/** A Local Files song's cover as a JPEG, for its file's tags: from the big one. */
async function tagPicture(songId) {
  const store = localStore();
  const picture = store.read(songId, 'big') || store.read(songId, 'small');
  return picture ? cover.toJpeg(tools.findFfmpeg(), picture).catch(() => null) : null;
}

let updated = () => {};

// yt-dlp for the lookups, at low priority: the downloads started in the
// window come first. The same browser cookies as theirs. Made once.
let lookupsMade = null;
function lookups() {
  if (!lookupsMade) {
    lookupsMade = cover.lookupsFor(createMedia({
      ffmpeg: tools.findFfmpeg,
      ffprobe: tools.findFfprobe,
      ytdlp: tools.findYtDlp,
      cacheDir: paths.cacheDir,
      lowPriority: true,
      ytdlpArgs: () => cookieJar.ytdlpArgs(settings.get('useCookies') ? settings.get('cookiesBrowser') : ''),
    }));
  }
  return lookupsMade;
}

// Songs whose cover is still being looked for from when they were
// downloaded (adoptStaged): the filler leaves them be meanwhile.
const awaiting = new Set();
let fillerRun = () => {};

/** fn(scope, ids, size): covers that arrived or changed ('local' or a server id; size: 'small', 'big' or null for both). */
function onUpdated(fn) {
  updated = fn;
}

function tell(scope, ids, size = null) {
  if (!ids.length) return;
  try {
    updated(scope, ids, size);
  } catch {
    // The window may be gone.
  }
}

// ---- Local Files ----

/**
 * Sets songs' cover versions in Local Files, in one change: [{ id, version }].
 * onlyIfNone: a song that got a cover meanwhile (takeFromFile) keeps it.
 */
function setVersions(results, { onlyIfNone = false } = {}) {
  if (!results.length) return;
  library.mutate((d) => {
    for (const r of results) {
      const s = model.songById(d, r.id);
      if (s && !(onlyIfNone && s.cover)) model.setCover(d, r.id, r.version);
      else if (!s && r.version && r.version !== cover.NO_COVER) localStore().remove(r.id);
    }
  });
  tell(LOCAL, results.filter((r) => r.version && r.version !== cover.NO_COVER).map((r) => r.id));
}

/** A cover found for a Local Files song (a picture, or a file of one), kept in both sizes: its version, or null. */
async function keepLocal(songId, picture) {
  const pair = await pairOf(picture);
  if (!pair) return null;
  const version = writePair(localStore(), songId, pair);
  setVersions([{ id: songId, version }]);
  return version;
}

/**
 * The picture in a file (a local file being imported, before it is copied
 * without its tags) as a Local Files song's cover. Resolves true when it had one.
 */
async function takeFromFile(songId, file) {
  const jpeg = await cover.embeddedCover(tools.findFfmpeg(), file).catch(() => null);
  if (!jpeg || !model.songById(library.get(), songId)) return false;
  return !!(await keepLocal(songId, jpeg));
}

/**
 * Keeps finding covers for Local Files songs without one until there are
 * none left. skip(id): songs not to look for (copies of a server's songs,
 * whose covers come from the server).
 */
function createFiller({ skip = () => false } = {}) {
  const later = new Set(); // could not be reached: tried again at the next start
  let running = false;
  let again = false;
  let stopped = false;

  const nextSong = () => library.get().songs.find((s) => !s.cover && !later.has(s.id) && !awaiting.has(s.id) && !skip(s.id));

  async function find(s) {
    const ffmpeg = tools.findFfmpeg();
    const r = await cover.resolveCover({
      sourceKey: s.sourceKey,
      sourceUrl: s.sourceUrl,
      artist: s.artist,
      title: s.title,
      duration: s.duration,
      noSearch: isNameOnlyList(s.sourcePlaylistUrl),
    }, {
      ffmpeg,
      ...lookups(),
      embedded: () => (fs.existsSync(s.file) ? cover.embeddedCover(ffmpeg, s.file) : null),
      cancelled: () => stopped,
    });
    if (r.jpeg) {
      const pair = await pairOf(r.jpeg);
      if (pair) return writePair(localStore(), s.id, pair);
    }
    if (r.retry || r.jpeg) {
      later.add(s.id);
      return null;
    }
    return cover.NO_COVER;
  }

  async function run() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    let results = [];
    let lastSave = Date.now();
    const flushResults = () => {
      const batch = results;
      results = [];
      lastSave = Date.now();
      setVersions(batch, { onlyIfNone: true });
    };
    try {
      for (let s = nextSong(); s && !stopped; s = nextSong()) {
        let version = null;
        try {
          version = await find(s);
        } catch {
          later.add(s.id);
        }
        if (version) results.push({ id: s.id, version });
        else later.add(s.id);
        if (results.length >= BATCH || Date.now() - lastSave > BATCH_MS) flushResults();
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      }
    } finally {
      flushResults();
      running = false;
    }
    if (again) {
      again = false;
      run();
    }
  }

  const filler = {
    run: () => {
      run().catch(() => {});
    },
    stop() {
      stopped = true;
      stageStopped = true;
      legacyStopped = true;
    },
  };
  fillerRun = filler.run;
  return filler;
}

// ---- songs not saved yet (Add Songs) ----

const staged = new Map(); // cached file, lower-cased -> { promise, done, adopted, dropped }
let stageChain = Promise.resolve();
let stageStopped = false;
let stagedHeard = () => {};

/** fn({ cachePath, file, version }): a cover found for a song not saved yet. */
function onStaged(fn) {
  stagedHeard = fn;
}

const stagedFile = (cachePath) => `${cachePath}.cover.jpg`;
const stageKey = (cachePath) => path.resolve(String(cachePath)).toLowerCase();

/**
 * Looks for the cover of a song just downloaded into the cache, one song at
 * a time. song: { sourceKey, sourceUrl, artist, title, duration, thumbnails,
 * noSearch, embeddedFrom (a file whose picture counts: a local file's
 * original) }. Not for a song thrown away meanwhile.
 */
function stage(cachePath, song) {
  if (!cachePath || staged.has(stageKey(cachePath))) return;
  const entry = { done: false, adopted: false, dropped: false };
  staged.set(stageKey(cachePath), entry);
  const gone = () => stageStopped || entry.dropped || (!entry.adopted && !fs.existsSync(cachePath));
  entry.promise = stageChain.then(async () => {
    if (gone()) return null;
    const ffmpeg = tools.findFfmpeg();
    const picture = song.embeddedFrom || cachePath;
    const r = await cover.resolveCover({
      sourceKey: song.sourceKey || '',
      sourceUrl: song.sourceUrl || '',
      artist: song.artist || '',
      title: song.title || '',
      duration: Number(song.duration) || 0,
      thumbnails: Array.isArray(song.thumbnails) ? song.thumbnails : undefined,
      noSearch: !!song.noSearch,
    }, {
      ffmpeg,
      ...lookups(),
      embedded: () => (fs.existsSync(picture) ? cover.embeddedCover(ffmpeg, picture) : null),
      cancelled: gone,
    });
    if (!r.jpeg || gone()) return null;
    fs.writeFileSync(stagedFile(cachePath), r.jpeg);
    const version = cover.coverVersion(r.jpeg);
    if (!entry.adopted) {
      try {
        stagedHeard({ cachePath, file: stagedFile(cachePath), version });
      } catch {
        // The window may be gone.
      }
    }
    return r.jpeg;
  }).catch(() => null).finally(() => {
    entry.done = true;
  });
  stageChain = entry.promise;
}

/** The cover a song not saved yet has so far: { file, version }, or null. */
function stagedCover(cachePath) {
  const file = stagedFile(cachePath);
  try {
    return { file, version: cover.coverVersion(fs.readFileSync(file)) };
  } catch {
    return null;
  }
}

/** A song thrown away: its lookup stops, its cover goes. */
function dropStaged(cachePath) {
  const entry = staged.get(stageKey(cachePath));
  if (entry) entry.dropped = true;
  staged.delete(stageKey(cachePath));
  fs.rmSync(stagedFile(cachePath), { force: true });
}

/**
 * The song from cachePath is saved as songId: its cover, found or still
 * being looked for, becomes the song's. wait: false takes only one found
 * already and stops the lookup otherwise. Resolves true when the song got one.
 */
function adoptStaged(cachePath, songId, { wait = true } = {}) {
  const key = stageKey(cachePath);
  const entry = staged.get(key);
  staged.delete(key);
  const take = async () => {
    const file = stagedFile(cachePath);
    let jpeg = null;
    try {
      jpeg = fs.readFileSync(file);
    } catch {
      return false;
    } finally {
      fs.rmSync(file, { force: true });
    }
    const song = model.songById(library.get(), songId);
    if (!song || (song.cover && song.cover !== cover.NO_COVER)) return false;
    return !!(await keepLocal(songId, jpeg).catch(() => null));
  };
  if (!entry || entry.done) return take();
  if (!wait) {
    entry.dropped = true;
    return take();
  }
  entry.adopted = true;
  awaiting.add(songId);
  return entry.promise.then(take).finally(() => {
    awaiting.delete(songId);
    // None found: the filler tries the song itself.
    fillerRun();
  });
}

// ---- covers from before 4.3.1 ----

let legacyStopped = false;

/**
 * Local Files' old covers (local\<id>.jpg) made into the two sizes, one at a
 * time in the background, keeping the song's version (the same picture);
 * one of no song goes. A server's old ones go: they are fetched when shown.
 */
async function convertLegacy() {
  for (const id of serverIds()) {
    for (const old of storeOf(id).legacy()) fs.rmSync(old.file, { force: true });
  }
  const store = localStore();
  for (const old of store.legacy()) {
    if (legacyStopped) return;
    const song = model.songById(library.get(), old.id);
    if (song && song.cover && song.cover !== cover.NO_COVER && !store.has(old.id, 'small')) {
      const pair = await pairOf(old.file).catch(() => null);
      if (legacyStopped) return;
      if (pair) {
        writePair(store, old.id, pair, song.cover);
        tell(LOCAL, [old.id]);
      }
    }
    fs.rmSync(old.file, { force: true });
  }
}

/**
 * Local Files' covers in step with its songs: a song gone takes its cover
 * along (watching every change), a cover of no song is swept at the start,
 * old covers are made into the two sizes, and a song whose cover file went
 * missing is looked for again.
 */
function watchLocal() {
  const withCover = () => new Set(library.get().songs.filter((s) => s.cover && s.cover !== cover.NO_COVER).map((s) => s.id));
  const store = localStore();
  store.sweep(new Set(library.get().songs.map((s) => s.id)));
  const old = new Set(store.legacy().map((x) => x.id));
  const lost = library.get().songs.filter((s) => s.cover && s.cover !== cover.NO_COVER && !store.has(s.id, 'small') && !store.has(s.id, 'big') && !old.has(s.id)).map((s) => s.id);
  if (lost.length) {
    library.mutate((d) => {
      for (const id of lost) if (model.songById(d, id)) model.setCover(d, id, null);
    });
  }
  convertLegacy().catch(() => {}).finally(() => fillerRun());
  let known = withCover();
  library.onChange((data) => {
    const now = new Set(data.songs.map((s) => s.id));
    for (const id of known) if (!now.has(id)) localStore().remove(id);
    known = withCover();
  });
}

/** A server song's covers copied to its copy in Local Files (a playlist downloaded): the version, or null. */
function copyToLocal(serverId, serverSongId, localId) {
  try {
    return storeOf(serverId).copyTo(serverSongId, localStore(), localId) || null;
  } catch {
    return null;
  }
}

/** A Local Files song's covers as a server song's (it was uploaded): true when copied. */
function copyToServer(localId, serverId, serverSongId) {
  try {
    if (!localStore().copyTo(localId, storeOf(serverId), serverSongId)) return false;
    tell(serverId, [serverSongId]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves the Covers folder along with the songs (library.relocate): a rename,
 * or across drives a copy and a delete. Never throws: covers can be found again.
 * `name`: another of Flow's folders there moved the same way (Lyrics).
 */
function moveFolder(oldMusicDir, newMusicDir, name = paths.COVERS) {
  const from = path.join(oldMusicDir, name);
  const to = path.join(newMusicDir, name);
  if (!fs.existsSync(from)) return;
  if (name === paths.COVERS) {
    flush();
    for (const store of stores.values()) store.forget();
    stores.clear();
  }
  try {
    if (!fs.existsSync(to)) {
      fs.renameSync(from, to);
      return;
    }
  } catch (err) {
    if (err.code !== 'EXDEV') return;
  }
  try {
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    fs.rmSync(from, { recursive: true, force: true });
  } catch {
    // What could not be copied is found again.
  }
}

module.exports = {
  LOCAL, storeOf, localStore, dirOf, serverIds, removeServer, flush, pairOf, writePair, tagPicture,
  onUpdated, tell, keepLocal, takeFromFile, createFiller, watchLocal,
  copyToLocal, copyToServer, moveFolder, stage, stagedCover, dropStaged, adoptStaged, onStaged,
};
