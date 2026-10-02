'use strict';

// Saving into Music\FlowPlayer: the trim cut out of the cached download and the
// artist, title and mix written into the file's own tags, so other players
// show them too. Both the cut and the re-tagging copy the audio stream rather
// than encoding it, so saving never costs quality. (A cut FLAC is the one
// exception, encoded again as FLAC: lossless all the same.)

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const media = require('./media');
const { songFileStem } = require('@flow/core/text');
const { tagArgs } = require('@flow/core/tags');

function samePath(a, b) {
  return !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * A free path for "stem.ext": "stem (2).ext" and so on when taken. `current`
 * is a file that may keep its own name; a new name stays in its folder, so a
 * song sorted into a subfolder by hand is renamed where it is. Without one it
 * goes into the music folder.
 */
function uniquePath(stem, ext, current = null) {
  const dir = current ? path.dirname(current) : paths.musicDir();
  let candidate = path.join(dir, `${stem}.${ext}`);
  for (let n = 2; fs.existsSync(candidate) && !samePath(candidate, current); n += 1) {
    candidate = path.join(dir, `${stem} (${n}).${ext}`);
  }
  return candidate;
}

/**
 * Cuts [start, end] out of the cached download into the music folder, with
 * tags. Resolves { file, duration, format }.
 */
function saveSong(job) {
  const ext = path.extname(job.cachePath).slice(1).toLowerCase();
  return media.cutSong(job, uniquePath(songFileStem(job.artist, job.title, job.mix), ext));
}

/**
 * New artist / title / mix for a saved song: the file is renamed to match and
 * its tags rewritten. Resolves the new path. If ffmpeg cannot rewrite the tags
 * the file is still renamed, since the library holds the names anyway.
 */
async function retagSong(song, meta) {
  const ext = path.extname(song.file).slice(1).toLowerCase();
  const dest = uniquePath(songFileStem(meta.artist, meta.title, meta.mix), ext, song.file);
  const tmp = path.join(path.dirname(dest), `.flow-retag-${Date.now()}.${ext}`);
  try {
    await media.runFfmpeg(['-i', song.file, '-map', '0:a:0', '-c', 'copy',
      ...tagArgs({ ...meta, sourceUrl: song.sourceUrl }, ext), tmp], song.duration);
    fs.rmSync(song.file, { force: true });
    fs.renameSync(tmp, dest);
    return dest;
  } catch {
    fs.rmSync(tmp, { force: true });
  }
  if (!samePath(song.file, dest)) fs.renameSync(song.file, dest);
  return dest;
}

module.exports = { saveSong, retagSong, tagArgs, uniquePath };
