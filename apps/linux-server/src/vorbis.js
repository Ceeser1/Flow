'use strict';

// Ogg Vorbis for the apps that cannot play it: the iPhone (iOS has no Vorbis
// decoder; it plays Ogg Opus). Asked for with GET /api/songs/:id/audio?vorbis=0,
// a song whose file is Ogg Vorbis is converted once to Ogg Opus with ffmpeg,
// kept in <home>/converted and sent in its place; any other file is sent as
// it is. A song's copy goes when its file changes (a trim), and a copy not
// asked for in KEEP_DAYS is let go.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const KEEP_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;
// Opus at this rate is as good as the Vorbis it comes from; level 5 of 10
// halves the time (a Raspberry Pi converts while the phone waits to play).
const OPUS_ARGS = ['-c:a', 'libopus', '-b:a', '160k', '-compression_level', '5'];

/** Whether `file` is Ogg Vorbis: an Ogg page whose first packet is Vorbis's header. */
function isVorbis(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(300);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    if (n < 28 || b.toString('latin1', 0, 4) !== 'OggS') return false;
    const at = 27 + b[26];
    return n >= at + 7 && b[at] === 1 && b.toString('latin1', at + 1, at + 7) === 'vorbis';
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * home(): the server's folder. ffmpeg(): its path, or null (then a Vorbis
 * song is sent as it is). log: the server's log.
 */
function createVorbis({ home, ffmpeg, log = () => {} }) {
  const making = new Map(); // a copy's path -> its conversion
  const failed = new Set(); // copies ffmpeg could not make: not tried again until the server restarts

  const dir = () => path.join(home(), 'converted');

  function convert(exe, file, out) {
    const part = `${out}.part`;
    return new Promise((resolve, reject) => {
      const proc = spawn(exe, ['-hide_banner', '-nostats', '-nostdin', '-y', '-v', 'error', '-i', file,
        '-map', '0:a:0', ...OPUS_ARGS, '-f', 'ogg', part]);
      const err = [];
      const timer = setTimeout(() => proc.kill(), 10 * 60 * 1000);
      proc.stderr.on('data', (d) => err.push(String(d)));
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          fs.renameSync(part, out);
          resolve();
        } else {
          fs.rmSync(part, { force: true });
          reject(new Error(err.join('').trim().split('\n').pop() || `ffmpeg ended with ${code}`));
        }
      });
    });
  }

  /** A song's older copies, and copies not asked for in KEEP_DAYS. */
  function tidy(id, keep) {
    const old = Date.now() - KEEP_DAYS * DAY_MS;
    for (const name of fs.readdirSync(dir())) {
      const f = path.join(dir(), name);
      if (f === keep || making.has(f) || making.has(f.replace(/\.part$/, ''))) continue;
      try {
        if (name.startsWith(`${id}-`) || fs.statSync(f).mtimeMs < old) fs.rmSync(f, { force: true });
      } catch {
        // Gone already.
      }
    }
  }

  /**
   * The file to send for song `id` (its file `file`) to an app that cannot
   * play Vorbis: an Opus copy when it is Vorbis and ffmpeg is there, else the file.
   */
  async function playable(id, file) {
    if (!isVorbis(file)) return file;
    const exe = ffmpeg();
    if (!exe) return file;
    const st = fs.statSync(file);
    const out = path.join(dir(), `${id}-${Math.round(st.mtimeMs)}-${st.size}.opus`);
    if (fs.existsSync(out)) {
      // Asked for: kept another KEEP_DAYS.
      const now = new Date();
      try {
        fs.utimesSync(out, now, now);
      } catch {
        // Kept as it was.
      }
      return out;
    }
    if (failed.has(out)) return file;
    if (!making.has(out)) {
      fs.mkdirSync(dir(), { recursive: true });
      const started = Date.now();
      making.set(out, convert(exe, file, out).then(() => {
        log(`Converted to Opus for an iPhone (${((Date.now() - started) / 1000).toFixed(1)} s): ${path.basename(file)}`);
        tidy(id, out);
      }).finally(() => making.delete(out)));
    }
    try {
      await making.get(out);
      return out;
    } catch (err) {
      if (!failed.has(out)) log(`Could not convert ${path.basename(file)} to Opus: ${err.message}`);
      failed.add(out);
      return file;
    }
  }

  return { playable };
}

module.exports = { createVorbis, isVorbis };
