'use strict';

// The songs' lyrics (4.0, @flow/core/lyrics): looked up on LRCLIB the first
// time an app asks for a song's, then kept in <home>/lyrics/<song id>.json
// (none found: asked again after a week; the song renamed or trimmed: at
// once). One lookup at a time per song, however many apps ask.

const fs = require('fs');
const path = require('path');
const lyrics = require('@flow/core/lyrics');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');

const ID = /^[\w-]{1,64}$/;

/** dir: where they are kept; lookup: how a song's are found (the tests' fake). */
function createLyricsStore({ dir, lookup = lyrics.lookupLyrics, log = () => {} }) {
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
        writeJsonAtomic(fileOf(song.id), { ...found, key: lyrics.lyricsKey(song), at: Date.now() });
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

  return { get, sweep };
}

module.exports = { createLyricsStore };
