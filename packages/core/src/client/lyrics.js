'use strict';

// A song's lyrics for the window (4.0, @flow/core/lyrics), kept in the Lyrics
// folder (4.0, lyricsFolder.js). A Flow Server's song: the server's (it
// looks them up once and keeps them), fetched when the song plays (or a
// little before, as the next song) and a copy kept here; the song carries
// the stamp of the server's (4.3.1, song.lyrics), and while the copy here is
// that one it is used without asking. One copy per song: a server song with
// a Local Files copy (uploaded from here and kept, or downloaded) keeps the
// server's in that copy's file; the songs kept for offline get theirs in
// advance (sync).
// Every other song (Local Files, Downloaded Songs), and a server's while the
// server cannot say (out of reach, or from before lyrics): looked up on
// LRCLIB (else lyrics.ovh) here and kept. Lyrics written or edited in the
// app (4.0, set): a server's song's on the server, any other's here for
// good (Clear lyrics cache leaves them). LRCLIB still busy or out of reach
// after all its tries (@flow/core/lyrics RETRY): "No lyrics found", kept an
// hour (`partial`), then looked up again.
//
// Settings' "Fetch/Sync Lyrics" off (fetchOn): nothing is looked up here,
// synchronized or newly kept; what the folder has is still shown, and the
// server's lyrics of a song played (it keeps its own, the user's too).

const lyrics = require('../lyrics');
const { LOCAL } = require('./lyricsFolder');
const { tr } = require('../lang');

// Before the Lyrics folder (4.0): every song's in one file of the app's own.
const OLD_FILE = 'lyrics.json';
// The offline songs' copies: how many asked for at once.
const SYNC_BATCH = 200;
// Another look at the server's after its library changed, at most this often.
const SYNC_GAP_MS = 5000;
// Songs of another server's session, looked up by their names: kept while the app runs.
const FOREIGN_KEEP = 50;
// The filler (fill): this long between two songs; LRCLIB out of reach, the
// rest after this long.
const FILL_PAUSE_MS = 2000;
const FILL_FAIL_WAIT_MS = 10 * 60 * 1000;

/**
 * remote: the server client (or null); library: Local Files; folder: the
 * Lyrics folder (lyricsFolder.js); jsonFiles: the app's own files (the old
 * lyrics.json moved over); fetchOn(): whether lyrics are looked up, asked
 * for and synchronized; syncEveryMs: the server's copies looked at this
 * often as well (0: only when its library changes); skip(id): a Local Files
 * song the filler leaves out (a copy of a server's song, which has the
 * server's); onChange(): told when lyrics were kept or the filler moved on
 * (Settings' Lyrics Cache); fetch, agent: as lyrics.lookupLyrics takes them.
 */
function createLyricsClient({
  remote = null, library, folder, jsonFiles = null, fetchOn = () => true, syncEveryMs = 0,
  skip = () => false, onChange = () => {}, fillPauseMs = FILL_PAUSE_MS, fillFailWaitMs = FILL_FAIL_WAIT_MS,
  fetch = globalThis.fetch, agent = true,
}) {
  const running = new Map();
  const foreign = new Map();
  // `${serverId}/${songId}` -> the stamp of the copy here ('' for none or a lookup of its own).
  const stamps = new Map();

  function moveOld() {
    if (!jsonFiles) return;
    let old = null;
    try {
      old = jsonFiles.read(OLD_FILE);
    } catch {
      return;
    }
    if (!old || typeof old !== 'object') return;
    // Only those written by hand: the others are looked up or synchronized again.
    for (const [id, k] of Object.entries(old)) {
      if (k && k.own && !folder.read(LOCAL, id)) folder.write(LOCAL, id, { ...k, used: undefined });
    }
    if (jsonFiles.remove) jsonFiles.remove(OLD_FILE);
  }
  try {
    moveOld();
  } catch {
    // Tried again at the next start.
  }

  /** The song by its id in the window's library: { song, server }, or null. */
  function songOf(id) {
    if (remote && remote.active()) {
      const v = remote.view();
      const s = v.songs.find((x) => x.id === id) || (v.deviceSongs || []).find((x) => x.id === id);
      if (s) return { song: s, server: !s.isDevice };
    }
    const s = library.get().songs.find((x) => x.id === id);
    return s ? { song: s, server: false } : null;
  }

  /**
   * Where a server song's copy is kept: its Local Files copy's file when it
   * has one (one copy per song), else the server's folder. { scope, id }.
   */
  function placeOf(serverId, songId) {
    const localId = remote && remote.localOf ? remote.localOf(songId) : '';
    return localId ? { scope: LOCAL, id: localId } : { scope: serverId, id: songId };
  }

  /** A copy of the server's answer: `v` its stamp. Own lyrics of the Local Files copy stay (with the stamp, asked no more). */
  function keepCopy(serverId, songId, r, v = '') {
    if (!serverId) return;
    const at = placeOf(serverId, songId);
    try {
      const here = at.scope === LOCAL ? folder.read(LOCAL, at.id) : null;
      if (here && here.own && !r.own) folder.write(LOCAL, at.id, { ...here, v });
      else folder.write(at.scope, at.id, { ...r, server: true, v });
      stamps.set(`${at.scope}/${at.id}`, v);
    } catch {
      // Asked for again.
    }
  }

  /** What is kept still stands for `song` with fetching off: the server's, own, or for its names. */
  const usable = (k, song) => !!k && (k.server || k.own || k.key === lyrics.lyricsKey(song));

  /** Looks `song` up (once at a time) and keeps the answer in `scope` under `id` (no scope: not kept). */
  function lookUp(scope, id, song) {
    const run = running.get(`${scope}/${id}`);
    if (run) return run;
    const next = (async () => {
      let r;
      try {
        r = await lyrics.lookupLyrics(song, { fetch, agent });
      } catch {
        r = { ...lyrics.NONE, partial: true };
      } finally {
        running.delete(`${scope}/${id}`);
      }
      if (!scope) return lyrics.clean(r);
      // Written by hand (or synchronized) meanwhile: those stay.
      const now = folder.read(scope, id);
      if (now && (now.own || now.server)) return lyrics.clean(now);
      try {
        folder.write(scope, id, lyrics.toKeep(r, song));
      } catch {
        // Looked up again next time.
      }
      return lyrics.clean(r);
    })();
    running.set(`${scope}/${id}`, next);
    return next;
  }

  /** A Local Files song's (also a server song's copy here while the server cannot say). */
  function ofLocal(localId, song) {
    const k = folder.read(LOCAL, localId);
    if (lyrics.stillGood(k, song) || (k && k.server)) return Promise.resolve(lyrics.clean(k));
    if (!fetchOn()) return Promise.resolve({ ...lyrics.NONE });
    return lookUp(LOCAL, localId, song);
  }

  async function ofServer(song) {
    const serverId = remote.serverId ? remote.serverId() : '';
    // Its copy in Local Files (uploaded from here, or downloaded): lyrics
    // written for that one by hand come before any looked up.
    const localId = song.localId || (remote.localOf ? remote.localOf(song.id) : '');
    const localKept = localId ? folder.read(LOCAL, localId) : null;
    const ownHere = localKept && localKept.own ? localKept : null;
    const copy = localId ? localKept : (serverId ? folder.read(serverId, song.id) : null);
    // The copy here is the server's as it is now (its stamp): no need to ask.
    const stamp = String(song.lyrics || '');
    if (stamp && copy && (copy.server || copy.own) && String(copy.v || '') === stamp) return lyrics.clean(copy);
    // The server's answer, fetching on or off (what it keeps is the user's
    // own library); kept here only with fetching on (own ones get its stamp).
    const r = await remote.songLyrics(song.id);
    if (r) {
      const { v, ...rest } = r;
      if (fetchOn() || ownHere) keepCopy(serverId, song.id, rest, String(v || ''));
      if (ownHere && !r.own) return lyrics.clean(ownHere);
      return lyrics.clean(rest);
    }
    // The server cannot say (or is not asked): own ones of its Local Files copy, a copy kept, else looked up here.
    if (ownHere) return lyrics.clean(ownHere);
    if (copy && (copy.server || lyrics.stillGood(copy, song))) return lyrics.clean(copy);
    if (!fetchOn()) {
      if (usable(copy, song)) return lyrics.clean(copy);
      return usable(localKept, song) ? lyrics.clean(localKept) : { ...lyrics.NONE };
    }
    if (localId) return ofLocal(localId, song);
    return lookUp(serverId, song.id, song);
  }

  /** A song of another server's session, by its names. */
  async function ofForeign(song) {
    if (foreign.has(song.id)) return foreign.get(song.id);
    if (!fetchOn()) return { ...lyrics.NONE };
    const r = await lookUp('', song.id, song);
    foreign.set(song.id, r);
    if (foreign.size > FOREIGN_KEEP) foreign.delete(foreign.keys().next().value);
    return r;
  }

  /**
   * { found, synced, plain, instrumental }; none found when LRCLIB could not
   * answer. Rejects for a song that is not here.
   * `id`: a song of the library, or { id, title, artist, duration } of one it
   * has not (another server's, in a session).
   */
  async function get(id) {
    if (id && typeof id === 'object') {
      return ofForeign({
        id: String(id.id || ''), title: String(id.title || ''), artist: String(id.artist || ''), duration: Number(id.duration) || 0,
      });
    }
    const found = songOf(String(id || ''));
    if (!found) throw new Error(tr('songs.error.songNotHere', 'That song is not here any more.'));
    const { song, server } = found;
    if (server) return ofServer(song);
    return ofLocal(song.localId || song.id, song);
  }

  /**
   * A song's own lyrics (4.0): `lines` [{ t, end, text }] as
   * lyrics.ownLyrics takes them, or null to let them go (looked up again).
   * Resolves them as get does. A server's song's go to the server; `server`:
   * the id is the server's, of a song it may not have told about yet (just
   * saved there from Add Songs).
   */
  async function set(id, lines, { server: onServer = false } = {}) {
    const found = songOf(String(id || '')) || (onServer && remote ? { song: { id: String(id) }, server: true } : null);
    if (!found) throw new Error(tr('songs.error.songNotHere', 'That song is not here any more.'));
    const { song, server } = found;
    if (server) {
      const { v, ...r } = await remote.setSongLyrics(song.id, lines);
      keepCopy(remote.serverId ? remote.serverId() : '', song.id, r, String(v || ''));
      return lyrics.clean(r);
    }
    const own = lyrics.ownLyrics(lines);
    const localId = song.localId || song.id;
    running.delete(`${LOCAL}/${localId}`);
    if (own) folder.write(LOCAL, localId, lyrics.toKeep(own, song));
    else {
      folder.remove(LOCAL, localId);
      settledKeys.delete(localId);
    }
    return own ? lyrics.clean(own) : get(id);
  }

  /** Own lyrics written for a Local Files song before it was saved (Add Songs): kept under its id now. */
  function keepOwn(localId, lines) {
    const own = lyrics.ownLyrics(lines);
    if (own) folder.write(LOCAL, String(localId), lyrics.toKeep(own, { artist: '', title: '', duration: 0 }));
  }

  /** The own lyrics kept for a Local Files song, as lines for the server (its upload), or null. */
  function ownLines(localId) {
    const k = folder.read(LOCAL, String(localId));
    if (!k || !k.own) return null;
    if (Array.isArray(k.synced) && k.synced.length) return k.synced.map((l) => ({ t: l.t, end: l.end === undefined ? null : l.end, text: l.text }));
    return String(k.plain || '').split('\n').map((text) => ({ t: null, end: null, text }));
  }

  /** A song not in the library yet (Add Songs, just downloaded) looked up by its names: { artist, title, duration }. Not kept. */
  async function lookup(meta) {
    if (!fetchOn()) return { ...lyrics.NONE };
    const song = {
      title: String((meta && meta.title) || ''), artist: String((meta && meta.artist) || ''), duration: Number(meta && meta.duration) || 0,
    };
    try {
      return lyrics.clean(await lyrics.lookupLyrics(song, { fetch, agent }));
    } catch {
      return { ...lyrics.NONE };
    }
  }

  // ---- the server's copies ----

  /** The stamp of a server song's copy here, read once and then remembered. */
  function stampHere(serverId, songId) {
    const at = placeOf(serverId, songId);
    const key = `${at.scope}/${at.id}`;
    if (!stamps.has(key)) {
      const k = folder.read(at.scope, at.id);
      stamps.set(key, k && (k.server || k.own) ? String(k.v || '') : '');
    }
    return stamps.get(key);
  }

  let syncing = null;
  let again = false;

  /**
   * After the server's library changed (4.3.1): the copies of songs gone
   * from it go, a copy kept twice from before (the server's folder and the
   * song's Local Files copy) once, and the songs kept here for offline get
   * the lyrics they lack (those whose stamp changed), many at once. Every
   * other song's come when it plays.
   */
  function sync() {
    if (!remote || !remote.lyricsOf || !remote.serverId || !fetchOn()) return Promise.resolve();
    if (syncing) {
      again = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        again = false;
        const serverId = remote.serverId();
        if (!serverId || !remote.active() || !fetchOn()) return;
        const songs = (remote.view().songs || []).filter((s) => !s.isDevice);
        const there = new Set(songs.map((s) => s.id));
        if (there.size) {
          for (const id of folder.ids(serverId)) {
            const local = remote.localOf ? remote.localOf(id) : '';
            if (there.has(id) && !(local && folder.read(LOCAL, local))) continue;
            folder.remove(serverId, id);
            stamps.delete(`${serverId}/${id}`);
          }
        }
        const offline = remote.offlineIds ? remote.offlineIds() : new Set();
        const want = songs.filter((s) => offline.has(s.id) && s.lyrics && stampHere(serverId, s.id) !== s.lyrics).map((s) => s.id);
        for (let i = 0; i < want.length; i += SYNC_BATCH) {
          if (!fetchOn() || remote.serverId() !== serverId) return;
          const got = await remote.lyricsOf(want.slice(i, i + SYNC_BATCH));
          for (const [id, r] of Object.entries(got || {})) {
            const { v, ...rest } = r || {};
            keepCopy(serverId, id, rest, String(v || ''));
          }
          onChange();
        }
      } while (again);
    })().catch(() => {
      // Again when the server's library changes next, or at the next look.
    }).finally(() => {
      syncing = null;
    });
    return syncing;
  }

  let syncTimer = null;
  /** The server's library changed: a look at its lyrics soon (many changes, one look). */
  function syncSoon() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      sync();
    }, SYNC_GAP_MS);
    if (syncTimer.unref) syncTimer.unref();
  }
  if (remote && remote.useLyricsSync) remote.useLyricsSync(syncSoon);
  // A Local Files song whose file went (uploaded with "Keep local files" off): its lyrics here go too.
  if (remote && remote.useForgotLocal) {
    remote.useForgotLocal((lid) => {
      folder.remove(LOCAL, lid);
      stamps.delete(`${LOCAL}/${lid}`);
      settledKeys.delete(lid);
    });
  }
  if (syncEveryMs > 0) {
    const t = setInterval(() => sync(), syncEveryMs);
    if (t.unref) t.unref();
  }

  // ---- every Local Files song's, in the background (4.0) ----
  //
  // The songs without an answer kept that settles them (@flow/core/lyrics
  // settled) looked up one after another, fillPauseMs apart, as the server
  // does for its own. LRCLIB out of reach: the rest after fillFailWaitMs.

  const settledKeys = new Map(); // song id -> its lyricsKey, settled
  let filling = null;
  let fillAgain = false;
  let fillFailedAt = 0;
  let fillLeft = 0;

  function needsLookup(s) {
    if (skip(s.id)) return false;
    const key = lyrics.lyricsKey(s);
    if (settledKeys.get(s.id) === key) return false;
    if (!lyrics.settled(folder.read(LOCAL, s.id), s)) return true;
    settledKeys.set(s.id, key);
    return false;
  }

  const pause = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });

  /** Looks up the lyrics of every Local Files song that has none kept. Resolves once through. */
  function fill() {
    if (!fetchOn()) return Promise.resolve();
    if (filling) {
      fillAgain = true;
      return filling;
    }
    if (Date.now() - fillFailedAt < fillFailWaitMs) return Promise.resolve();
    filling = (async () => {
      do {
        fillAgain = false;
        const list = library.get().songs.filter(needsLookup);
        fillLeft = list.length;
        if (list.length) onChange();
        for (const s of list) {
          if (!fetchOn()) break;
          const now = library.get().songs.find((x) => x.id === s.id);
          if (now && needsLookup(now)) {
            await lookUp(LOCAL, now.id, now);
            const k = folder.read(LOCAL, now.id);
            // Not answered in full (LRCLIB or lyrics.ovh out of reach): the rest later.
            if (k && k.partial) {
              fillFailedAt = Date.now();
              fillAgain = false;
              break;
            }
            if (lyrics.settled(k, now)) settledKeys.set(now.id, lyrics.lyricsKey(now));
            await pause(fillPauseMs);
          }
          fillLeft -= 1;
          onChange();
        }
      } while (fillAgain && fetchOn());
    })().catch(() => {
      // Again at the next change of the library.
    }).finally(() => {
      filling = null;
      fillLeft = 0;
      onChange();
    });
    return filling;
  }

  let fillTimer = null;
  /** The library changed: the filler soon (many changes, one pass). */
  function fillSoon() {
    if (fillTimer) return;
    fillTimer = setTimeout(() => {
      fillTimer = null;
      fill();
    }, SYNC_GAP_MS);
    if (fillTimer.unref) fillTimer.unref();
  }

  // ---- picked by hand and published (4.0) ----

  /** LRCLIB's search (lyrics.searchLyrics): lyrics to pick by hand. */
  function search(params) {
    return lyrics.searchLyrics(params || {}, { fetch, agent });
  }

  /** Lyrics written in Flow published on LRCLIB (lyrics.publishLyrics); solve(prefix, target): the nonce. */
  function publish(meta, solve) {
    return lyrics.publishLyrics(meta || {}, { fetch, agent, solve });
  }

  // ---- Settings' Lyrics cache ----

  /** Lyrics kept for Local Files songs that are gone (looked at once a run, and when cleared). */
  let swept = false;
  function sweep() {
    swept = true;
    const songs = library.get().songs;
    if (!songs.length) return;
    const here = new Set(songs.map((s) => s.id));
    for (const id of folder.ids(LOCAL)) {
      if (here.has(id)) continue;
      // Written by hand: never thrown away (the song may live on on a server).
      const k = folder.read(LOCAL, id);
      if (!k || !k.own) folder.remove(LOCAL, id);
    }
  }

  /**
   * { count, bytes, none, left }: the songs with lyrics kept here (each song
   * once, however many copies: a server song and its Local Files copy are
   * one), the room every file takes, the songs none were found for, and how
   * many the filler still looks up.
   */
  function stats() {
    if (!swept) {
      try {
        sweep();
      } catch {
        // Looked at again when cleared.
      }
    }
    const size = folder.size();
    const serverId = remote && remote.active() && remote.serverId ? remote.serverId() : '';
    const songs = new Set();
    for (const scope of folder.scopes()) {
      for (const id of folder.foundIds(scope)) {
        const local = scope === serverId && remote.localOf ? remote.localOf(id) : '';
        songs.add(local ? `${LOCAL}/${local}` : `${scope}/${id}`);
      }
    }
    return { ...size, count: songs.size, left: fillLeft };
  }

  /** Clear lyrics cache: all but those written here for Local Files songs; the server's come down again. */
  function clear() {
    for (const scope of folder.scopes()) {
      if (scope !== LOCAL) {
        folder.removeScope(scope);
        continue;
      }
      for (const id of folder.ids(LOCAL)) {
        const k = folder.read(LOCAL, id);
        if (!k || !k.own) folder.remove(LOCAL, id);
      }
    }
    stamps.clear();
    foreign.clear();
    settledKeys.clear();
    sweep();
    sync();
    fill();
    return stats();
  }

  /** A song coming next (4.3.1): its lyrics made ready now, so they show at once (kept as get keeps them). */
  function prepare(id) {
    return get(id).catch(() => null);
  }

  return {
    get, prepare, set, keepOwn, ownLines, lookup, sync, fill, fillSoon, search, publish, stats, clear,
  };
}

module.exports = { createLyricsClient };
