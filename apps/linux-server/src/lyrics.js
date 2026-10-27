'use strict';

// The songs' lyrics (4.0, @flow/core/lyrics): looked up on LRCLIB (else
// lyrics.ovh) the first time an app asks for a song's, or by the filler
// before that, then kept in <home>/lyrics/<song id>.json (none found: asked
// again after a week when an app asks; the song renamed or trimmed: at
// once). One lookup at a time per song, however many apps ask. Lyrics
// written or edited in an app (4.0.1, put) are kept for good instead. The
// apps keep copies of them (4.0.1, index and many: GET / POST /api/lyrics).

const fs = require('fs');
const path = require('path');
const lyrics = require('@flow/core/lyrics');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');

const ID = /^[\w-]{1,64}$/;
// The filler asks for a song's lyrics this long after the one before.
const PAUSE_MS = 5000;
// LRCLIB out of reach: the filler tries again after this long.
const FAIL_WAIT_MS = 10 * 60 * 1000;

/** dir: where they are kept; lookup: how a song's are found (the tests' fake); pauseMs, failWaitMs: the filler's. */
function createLyricsStore({
  dir, lookup = lyrics.lookupLyrics, log = () => {}, pauseMs = PAUSE_MS, failWaitMs = FAIL_WAIT_MS,
}) {
  const running = new Map();
  const fileOf = (id) => path.join(dir, `${id}.json`);

  /** The song's lyrics ({ found, synced, plain, instrumental }); rejects when LRCLIB cannot be reached. */
  function get(song) {
    if (!song || !ID.test(String(song.id))) return Promise.resolve({ ...lyrics.NONE });
    const kept = readJson(fileOf(song.id));
    if (lyrics.stillGood(kept, song)) return Promise.resolve(lyrics.clean(kept));
    if (running.has(song.id)) return running.get(song.id);
    const run = (async () => {
      try {
        const found = await lookup(song);
        // Written by hand meanwhile: those stay.
        const now = readJson(fileOf(song.id));
        if (now && now.own) return lyrics.clean(now);
        fs.mkdirSync(dir, { recursive: true });
        writeJsonAtomic(fileOf(song.id), lyrics.toKeep(found, song));
        return lyrics.clean(found);
      } catch (err) {
        log(`Lyrics of "${song.title}" could not be looked up: ${err.message}`);
        throw err;
      } finally {
        running.delete(song.id);
      }
    })();
    running.set(song.id, run);
    return run;
  }

  /**
   * The song's own lyrics (lyrics.ownLyrics, from an app's lines), kept for
   * good; null takes them away, and the song's are looked up again. Resolves
   * them as handed out (get). Throws when only some lines have times.
   */
  function put(song, lines) {
    if (!song || !ID.test(String(song.id))) throw new Error('That song is not on the server.');
    const own = lyrics.ownLyrics(lines);
    answered.delete(song.id);
    failed.delete(song.id);
    if (!own) {
      fs.rmSync(fileOf(song.id), { force: true });
      return get(song).catch(() => ({ ...lyrics.NONE }));
    }
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(fileOf(song.id), lyrics.toKeep(own, song));
    return Promise.resolve(lyrics.clean(own));
  }

  // For the apps' copies (index, many): each file's stamp (its size and time)
  // and what it was kept for, read once a stamp.
  const seen = new Map();

  /** The answer kept for `song` that still stands for its names (or own), with its stamp; null without one. */
  function keptFor(song) {
    if (!song || !ID.test(String(song.id))) return null;
    let st;
    try {
      st = fs.statSync(fileOf(song.id));
    } catch {
      return null;
    }
    const stamp = `${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}`;
    let s = seen.get(song.id);
    if (!s || s.stamp !== stamp) {
      const kept = readJson(fileOf(song.id));
      if (!kept) return null;
      s = { stamp, key: kept.key, own: kept.own === true };
      seen.set(song.id, s);
    }
    return s.own || s.key === lyrics.lyricsKey(song) ? s : null;
  }

  /** `songs`' answers kept, by id: their stamps, which change when the answer does (an app keeps copies). */
  function index(songs) {
    const out = {};
    for (const song of songs) {
      const s = keptFor(song);
      if (s) out[song.id] = s.stamp;
    }
    return out;
  }

  /** `songs`' answers kept, by id, as get hands them out, each with its stamp (v); those without one left out. */
  function many(songs) {
    const out = {};
    for (const song of songs) {
      const s = keptFor(song);
      const kept = s && readJson(fileOf(song.id));
      if (kept) out[song.id] = { ...lyrics.clean(kept), v: s.stamp };
    }
    return out;
  }

  /** Throws away the lyrics of songs no longer there (`ids`: the songs that are). */
  function sweep(ids) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.replace(/\.json(\.bak|\.tmp)?$/, '');
      if (!ids.has(id)) fs.rmSync(path.join(dir, name), { force: true });
    }
  }

  // The filler: songs settled or looked up since the start (id -> its
  // lyricsKey), and those LRCLIB could not answer (asked again at the next
  // start, as are those lyrics.ovh could not).
  const answered = new Map();
  const failed = new Set();
  let filling = false;
  let again = false;
  let stopped = false;
  let failedAt = 0;
  let current = Promise.resolve();
  let wake = null;

  /** Whether `song` needs no lookup: an answer kept that settles it (lyrics.settled), or looked up since the start. */
  function hasAnswer(song) {
    const key = lyrics.lyricsKey(song);
    if (answered.get(song.id) === key) return true;
    if (!lyrics.settled(readJson(fileOf(song.id)), song)) return false;
    answered.set(song.id, key);
    return true;
  }

  const pause = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  });

  /**
   * Looks up the lyrics of the songs that have none kept, one after another
   * in the background, pauseMs apart: once a song, found or not (kept from
   * fewer sources than there are now: once more). LRCLIB out of reach: that
   * song at the next start, the others after failWaitMs.
   * songs(): the library's songs now.
   */
  function fill(songs) {
    if (stopped) return current;
    if (filling) {
      again = true;
      return current;
    }
    if (Date.now() - failedAt < failWaitMs) return current;
    filling = true;
    const next = () => songs().find((s) => ID.test(String(s.id)) && !failed.has(s.id) && !hasAnswer(s)) || null;
    current = (async () => {
      do {
        again = false;
        for (let s = next(); s && !stopped; s = next()) {
          try {
            await get(s);
            answered.set(s.id, lyrics.lyricsKey(s));
          } catch {
            failed.add(s.id);
            failedAt = Date.now();
            return;
          }
          if (!stopped) await pause(pauseMs);
        }
      } while (again && !stopped);
    })().catch((err) => log(`Lyrics: ${err.message}`)).finally(() => {
      filling = false;
    });
    return current;
  }

  /** Stops the filler: resolves once its lookup running has ended. */
  function stop() {
    stopped = true;
    if (wake) wake();
    return current;
  }

  return {
    get, put, index, many, sweep, fill, stop,
  };
}

module.exports = { createLyricsStore };
