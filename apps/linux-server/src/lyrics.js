'use strict';

// The songs' lyrics (4.0, @flow/core/lyrics): looked up on LRCLIB (else
// lyrics.ovh) the first time an app asks for a song's, or by the filler
// before that, then kept in <home>/lyrics/<song id>.json (none found: asked
// again after a week when an app asks; the song renamed or trimmed: at
// once). One lookup at a time per song, however many apps ask.

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

  return { get, sweep, fill, stop };
}

module.exports = { createLyricsStore };
