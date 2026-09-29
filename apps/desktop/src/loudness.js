'use strict';

// "Equalize volume": how loud each song is, measured once in the background
// with ffmpeg's EBU R128 meter (the loudness measure streaming services use)
// and kept in the library as song.loudness, in LUFS. The player turns every
// song up or down to the same target from it (player.js).
//
// One song at a time, at low priority, so it never gets in the way of playing
// or downloading. Results are saved in batches: every save sends the whole
// library to the window, which redraws its lists.

const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const tools = require('./tools');

const BATCH = 25;
const BATCH_MS = 20000;

/** The integrated loudness from ebur128's summary, or null (silence, nothing read). */
function parseLoudness(stderr) {
  const summary = String(stderr).split(/Summary:/).pop();
  const m = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
  if (!m) return null;
  const v = Number(m[1]);
  // -70 is the meter's floor: the song is silent (or unreadable).
  return Number.isFinite(v) && v > -69 ? v : null;
}

let child = null;

function measure(file) {
  return new Promise((resolve) => {
    const ffmpeg = tools.findFfmpeg();
    if (!ffmpeg) return resolve(null);
    const proc = spawn(ffmpeg, [
      '-hide_banner', '-nostats', '-nostdin', '-i', file,
      '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-',
    ], { windowsHide: true });
    child = proc;
    try {
      os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      // Normal priority then.
    }
    const err = [];
    proc.stderr.on('data', (d) => err.push(String(d)));
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      if (child === proc) child = null;
      resolve(parseLoudness(err.join('')));
    });
  });
}

/**
 * Keeps measuring songs without a loudness until there are none left.
 * `library` and `enabled()` are handed in by main.js. Calling it while it runs
 * makes it look again once it is through.
 */
function createFiller(library, model, enabled) {
  let running = false;
  let again = false;
  let stopped = false;
  const failed = new Set(); // not measurable this session; not tried again

  const todo = () => library.get().songs.filter((s) => (s.loudness === null || s.loudness === undefined)
    && !failed.has(s.id) && fs.existsSync(s.file));

  async function run() {
    if (stopped || !enabled()) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    let results = [];
    let lastSave = Date.now();
    const flush = () => {
      if (!results.length) return;
      const batch = results;
      results = [];
      lastSave = Date.now();
      library.mutate((d) => {
        for (const r of batch) {
          if (model.songById(d, r.id)) model.updateSong(d, r.id, { loudness: r.loudness });
        }
      });
    };
    try {
      for (const song of todo()) {
        if (stopped || !enabled()) break;
        const loudness = await measure(song.file);
        if (loudness === null) failed.add(song.id);
        else results.push({ id: song.id, loudness });
        if (results.length >= BATCH || Date.now() - lastSave > BATCH_MS) flush();
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

  return {
    run: () => {
      run().catch(() => {});
    },
    stop() {
      stopped = true;
      if (child) {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      }
    },
  };
}

module.exports = { parseLoudness, measure, createFiller };
