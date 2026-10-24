'use strict';

// A song's lyrics for the window (4.0, @flow/core/lyrics). A Flow Server's
// song: the server's (it looks them up once and keeps them). Every other
// song (Local Files, Downloaded Songs), and a server's while the server
// cannot say (out of reach, or from before lyrics): looked up on LRCLIB (else
// lyrics.ovh) here and kept in lyrics.json, the last KEEP songs asked for.
// Lyrics written or edited in the app (4.0.1, set): a server's song's on the
// server, any other's in lyrics.json for good (never among those let go).
// LRCLIB still busy or out of reach after all its tries (@flow/core/lyrics
// RETRY): "No lyrics found", kept an hour (`partial`), then looked up again.

const lyrics = require('../lyrics');

const FILE = 'lyrics.json';
const KEEP = 400;

/**
 * remote: the server client (or null); library: Local Files; jsonFiles: the
 * app's own files; fetch, agent: as lyrics.lookupLyrics takes them.
 */
function createLyricsClient({
  remote = null, library, jsonFiles, fetch = globalThis.fetch, agent = true,
}) {
  let kept = null;
  const running = new Map();

  function load() {
    if (!kept) {
      const raw = jsonFiles.read(FILE);
      kept = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }
    return kept;
  }

  function save() {
    const all = Object.entries(load());
    const looked = all.filter(([, k]) => !k.own).sort((a, b) => (b[1].used || 0) - (a[1].used || 0)).slice(0, KEEP);
    kept = Object.fromEntries([...all.filter(([, k]) => k.own), ...looked]);
    try {
      jsonFiles.write(FILE, kept);
    } catch {
      // Looked up again next time.
    }
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
   * { found, synced, plain, instrumental }; none found when LRCLIB could not
   * answer. Rejects for a song that is not here.
   * `id`: a song of the library, or { id, title, artist, duration } of one it
   * has not (another server's, in a session).
   */
  async function get(id) {
    const found = id && typeof id === 'object'
      ? { song: { id: String(id.id || ''), title: String(id.title || ''), artist: String(id.artist || ''), duration: Number(id.duration) || 0 }, server: false }
      : songOf(String(id || ''));
    if (!found) throw new Error('That song is not here any more.');
    const { song, server } = found;
    if (server) {
      const r = await remote.songLyrics(song.id);
      if (r) return lyrics.clean(r);
    }
    const ownId = song.localId || song.id;
    const k = load()[ownId];
    if (lyrics.stillGood(k, song)) {
      k.used = Date.now();
      return lyrics.clean(k);
    }
    if (running.has(ownId)) return running.get(ownId);
    const run = (async () => {
      let r;
      try {
        r = await lyrics.lookupLyrics(song, { fetch, agent });
      } catch {
        r = { ...lyrics.NONE, partial: true };
      } finally {
        running.delete(ownId);
      }
      // Written by hand meanwhile: those stay.
      const now = load()[ownId];
      if (now && now.own) return lyrics.clean(now);
      load()[ownId] = { ...lyrics.toKeep(r, song), used: Date.now() };
      save();
      return lyrics.clean(r);
    })();
    running.set(ownId, run);
    return run;
  }

  /**
   * A song's own lyrics (4.0.1): `lines` [{ t, end, text }] as
   * lyrics.ownLyrics takes them, or null to let them go (looked up again).
   * Resolves them as get does. A server's song's go to the server; `server`:
   * the id is the server's, of a song it may not have told about yet (just
   * saved there from Add Songs).
   */
  async function set(id, lines, { server: onServer = false } = {}) {
    const found = songOf(String(id || '')) || (onServer && remote ? { song: { id: String(id) }, server: true } : null);
    if (!found) throw new Error('That song is not here any more.');
    const { song, server } = found;
    if (server) return lyrics.clean(await remote.setSongLyrics(song.id, lines));
    const own = lyrics.ownLyrics(lines);
    const ownId = song.localId || song.id;
    running.delete(ownId);
    if (own) load()[ownId] = { ...lyrics.toKeep(own, song), used: Date.now() };
    else delete load()[ownId];
    save();
    return own ? lyrics.clean(own) : get(id);
  }

  /** Own lyrics written for a Local Files song before it was saved (Add Songs): kept under its id now. */
  function keepOwn(localId, lines) {
    const own = lyrics.ownLyrics(lines);
    if (!own) return;
    load()[String(localId)] = { ...lyrics.toKeep(own, { artist: '', title: '', duration: 0 }), used: Date.now() };
    save();
  }

  /** The own lyrics kept for a Local Files song, as lines for the server (its upload), or null. */
  function ownLines(localId) {
    const k = load()[String(localId)];
    if (!k || !k.own) return null;
    if (Array.isArray(k.synced) && k.synced.length) return k.synced.map((l) => ({ t: l.t, end: l.end === undefined ? null : l.end, text: l.text }));
    return String(k.plain || '').split('\n').map((text) => ({ t: null, end: null, text }));
  }

  /** A song not in the library yet (Add Songs, just downloaded) looked up by its names: { artist, title, duration }. Not kept. */
  async function lookup(meta) {
    const song = {
      title: String((meta && meta.title) || ''), artist: String((meta && meta.artist) || ''), duration: Number(meta && meta.duration) || 0,
    };
    try {
      return lyrics.clean(await lyrics.lookupLyrics(song, { fetch, agent }));
    } catch {
      return { ...lyrics.NONE };
    }
  }

  return {
    get, set, keepOwn, ownLines, lookup,
  };
}

module.exports = { createLyricsClient };
