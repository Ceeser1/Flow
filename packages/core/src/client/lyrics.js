'use strict';

// A song's lyrics for the window (4.0, @flow/core/lyrics). A Flow Server's
// song: the server's (it looks them up once and keeps them). Every other
// song (Local Files, Downloaded Songs), and a server's while the server
// cannot say (out of reach, or from before lyrics): looked up on LRCLIB here
// and kept in lyrics.json, the last KEEP songs asked for.

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
    kept = Object.fromEntries(Object.entries(load()).sort((a, b) => (b[1].used || 0) - (a[1].used || 0)).slice(0, KEEP));
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

  /** { found, synced, plain, instrumental }; rejects when nobody can say. */
  async function get(id) {
    const found = songOf(String(id || ''));
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
        throw new Error('The lyrics could not be looked up: LRCLIB (lrclib.net) cannot be reached right now.');
      } finally {
        running.delete(ownId);
      }
      load()[ownId] = {
        ...r, key: lyrics.lyricsKey(song), at: Date.now(), used: Date.now(),
      };
      save();
      return lyrics.clean(r);
    })();
    running.set(ownId, run);
    return run;
  }

  return { get };
}

module.exports = { createLyricsClient };
