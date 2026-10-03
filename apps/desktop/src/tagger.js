'use strict';

// New Local Files songs carry their song's id and cover in their file
// (@flow/core/tags: flowid=<this install's id>:<song id>, the cover as a
// picture), written once the cover is settled (found, or none found) and
// again when it changes. Songs from before, and files put into the folder
// by hand, are left as they are (song.tagged null); a rename writes them
// too (exporter.retagSong).
//
// One song at a time in the background, at low priority, through a copy
// beside the file put in its place. A file in use (the song playing) cannot
// be replaced: tried again a while later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const library = require('./library');
const media = require('./media');
const settings = require('./settings');
const covers = require('./covers');
const model = require('@flow/core/libraryModel');
const { flowIdText } = require('@flow/core/tags');
const { NO_COVER } = require('@flow/core/cover');

const RETRY_MS = 10 * 60 * 1000;
const WAIT_MS = 2000;

/** skip(id): songs not to write (copies of a server's songs). */
function createTagger({ skip = () => false } = {}) {
  const failedAt = new Map(); // song id -> when its file could not be written
  let running = false;
  let again = false;
  let stopped = false;
  let timer = null;

  const nextSong = () => library.get().songs.find((s) => model.needsTags(s) && !skip(s.id)
    && !(Date.now() - (failedAt.get(s.id) || 0) < RETRY_MS) && fs.existsSync(s.file));

  async function tagOne(s) {
    const file = s.file;
    const coverNow = s.cover;
    const cutNow = s.cut;
    const out = path.join(path.dirname(file), `.flow-retag-${crypto.randomBytes(6).toString('hex')}${path.extname(file)}`);
    let ok = false;
    try {
      // The folder watch waits meanwhile: the copy is no song of its own.
      await library.quietly(async () => {
        const picture = coverNow && coverNow !== NO_COVER ? covers.localStore().read(s.id) : null;
        ok = await media.rewriteTags(file, out, {
          meta: { title: s.title, artist: s.artist, mix: s.mix, sourceUrl: s.sourceUrl },
          flowId: flowIdText(settings.clientId(), s.id),
          picture,
        });
        // Renamed, trimmed or gone meanwhile: written again later, or not at all.
        const now = model.songById(library.get(), s.id);
        ok = ok && !stopped && !!now && now.file === file && now.cut === cutNow;
        if (ok) fs.renameSync(out, file);
      });
    } catch {
      ok = false;
    } finally {
      fs.rmSync(out, { force: true });
    }
    if (!ok) {
      failedAt.set(s.id, Date.now());
      return;
    }
    failedAt.delete(s.id);
    library.mutate((d) => {
      if (model.songById(d, s.id)) model.setTagged(d, s.id, coverNow === null ? '' : coverNow);
    });
  }

  async function run() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      for (let s = nextSong(); s && !stopped; s = nextSong()) await tagOne(s);
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      run().catch(() => {});
    }
  }

  return {
    /** Looks for songs to write, a moment after the last call (every library change calls it). */
    run() {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(() => run().catch(() => {}), WAIT_MS);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

module.exports = { createTagger };
