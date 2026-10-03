'use strict';

// Covers on this computer, in Music\FlowPlayer\Covers (paths.coversDir):
//
//   local\<song id>.jpg      Local Files' songs. Songs without one get one in
//                            the background, one at a time (@flow/core/cover:
//                            the song's thumbnail, the picture in its file,
//                            YouTube Music, else the video's thumbnail).
//   <server id>\<song id>.jpg  a Flow Server's, downloaded from it by remote.js
//                            (all of them, in the background) and kept across
//                            restarts and server switches. One goes only when
//                            its song is gone from that server.
//
// song.cover is the version of the file (its hash), so a file here is
// checked against the library by hashing it. The window shows covers as files
// (Store.coverSrc); it hears of new ones through onUpdated.
//
// A song downloaded on the Add Songs page gets its cover looked for as soon
// as it is downloaded (stage), kept beside its cached file while it is
// trimmed and named (the window hears of it through onStaged), and handed to
// the song when it is finished (adoptStaged).

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const tools = require('./tools');
const settings = require('./settings');
const cookieJar = require('./cookieJar');
const { createMedia } = require('@flow/core/media');
const library = require('./library');
const model = require('@flow/core/libraryModel');
const cover = require('@flow/core/cover');

const LOCAL = 'local';
const BATCH = 10;
const BATCH_MS = 5000;
// A moment between songs: hundreds of lookups in a row must not get the
// downloads rate-limited by YouTube.
const PAUSE_MS = 1000;

const storeOf = (scope) => {
  if (!/^[\w-]{1,64}$/.test(String(scope || ''))) throw new Error('Not a cover folder.');
  return cover.createCoverStore(path.join(paths.coversDir(), scope));
};
const localStore = () => storeOf(LOCAL);

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

/** fn(scope, ids): covers that arrived or changed ('local' or a server id). */
function onUpdated(fn) {
  updated = fn;
}

function tell(scope, ids) {
  if (!ids.length) return;
  try {
    updated(scope, ids);
  } catch {
    // The window may be gone.
  }
}

/** The folder the window builds a song's cover file from. */
function dirOf(scope) {
  return path.join(paths.coversDir(), scope);
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

/** A cover found for a Local Files song, kept: its version. */
function keepLocal(songId, jpeg) {
  const version = localStore().write(songId, jpeg);
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
  keepLocal(songId, jpeg);
  return true;
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
      noSearch: /spotify\.com/i.test(s.sourcePlaylistUrl || ''),
    }, {
      ffmpeg,
      ...lookups(),
      embedded: () => (fs.existsSync(s.file) ? cover.embeddedCover(ffmpeg, s.file) : null),
      cancelled: () => stopped,
    });
    if (r.jpeg) return localStore().write(s.id, r.jpeg);
    if (r.retry) {
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
    const flush = () => {
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
        if (results.length >= BATCH || Date.now() - lastSave > BATCH_MS) flush();
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      }
    } finally {
      flush();
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
  const take = () => {
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
    keepLocal(songId, jpeg);
    return true;
  };
  if (!entry || entry.done) return Promise.resolve(take());
  if (!wait) {
    entry.dropped = true;
    return Promise.resolve(take());
  }
  entry.adopted = true;
  awaiting.add(songId);
  return entry.promise.then(take).finally(() => {
    awaiting.delete(songId);
    // None found: the filler tries the song itself.
    fillerRun();
  });
}

/**
 * Local Files' covers in step with its songs: a song gone takes its cover
 * along (watching every change), a cover of no song is swept at the start,
 * and a song whose cover file went missing is looked for again.
 */
function watchLocal() {
  const withCover = () => new Set(library.get().songs.filter((s) => s.cover && s.cover !== cover.NO_COVER).map((s) => s.id));
  const store = localStore();
  store.sweep(new Set(library.get().songs.map((s) => s.id)));
  const lost = library.get().songs.filter((s) => s.cover && s.cover !== cover.NO_COVER && !store.has(s.id)).map((s) => s.id);
  if (lost.length) {
    library.mutate((d) => {
      for (const id of lost) if (model.songById(d, id)) model.setCover(d, id, null);
    });
  }
  let known = withCover();
  library.onChange((data) => {
    const now = new Set(data.songs.map((s) => s.id));
    for (const id of known) if (!now.has(id)) localStore().remove(id);
    known = withCover();
  });
}

/** A server song's cover copied to its copy in Local Files (a playlist downloaded): the version, or null. */
function copyToLocal(serverId, serverSongId, localId) {
  try {
    const jpeg = storeOf(serverId).read(serverSongId);
    return jpeg ? localStore().write(localId, jpeg) : null;
  } catch {
    return null;
  }
}

/** A Local Files song's cover as a server song's (it was uploaded): true when copied. */
function copyToServer(localId, serverId, serverSongId) {
  try {
    const jpeg = localStore().read(localId);
    if (!jpeg) return false;
    storeOf(serverId).write(serverSongId, jpeg);
    tell(serverId, [serverSongId]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves the Covers folder along with the songs (library.relocate): a rename,
 * or across drives a copy and a delete. Never throws: covers can be found again.
 */
function moveFolder(oldMusicDir, newMusicDir) {
  const from = path.join(oldMusicDir, paths.COVERS);
  const to = path.join(newMusicDir, paths.COVERS);
  if (!fs.existsSync(from)) return;
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
  LOCAL, storeOf, localStore, dirOf, onUpdated, tell, keepLocal, takeFromFile, createFiller, watchLocal,
  copyToLocal, copyToServer, moveFolder, stage, stagedCover, dropStaged, adoptStaged, onStaged,
};
