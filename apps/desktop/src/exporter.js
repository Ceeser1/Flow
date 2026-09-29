'use strict';

// Saving into Music\FlowPlayer: the trim cut out of the cached download and the
// artist, title and mix written into the file's own tags, so other players
// show them too. Both the cut and the re-tagging copy the audio stream rather
// than encoding it, so saving never costs quality. (A cut FLAC is the one
// exception, encoded again as FLAC: lossless all the same.)

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const tools = require('./tools');
const { runFfmpeg } = require('./ffmpeg');
const { songFileStem } = require('@flow/core/text');

// Trims closer than this to either end are treated as no trim at all.
const EDGE = 0.02;

/** Tag arguments for ffmpeg. WAV keeps title and artist only (RIFF INFO). */
function tagArgs(meta, ext) {
  const args = ['-map_metadata', '-1',
    '-metadata', `title=${meta.title || ''}`,
    '-metadata', `artist=${meta.artist || ''}`];
  if (ext !== 'wav') {
    if (meta.mix) args.push('-metadata', `mix=${meta.mix}`);
    if (meta.sourceUrl) args.push('-metadata', `comment=${meta.sourceUrl}`);
  }
  if (ext === 'mp3') args.push('-id3v2_version', '3', '-write_id3v1', '0');
  if (ext === 'm4a') args.push('-movflags', '+faststart+use_metadata_tags');
  return args;
}

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
async function saveSong({ cachePath, start, end, duration, artist, title, mix, sourceUrl }) {
  const ext = path.extname(cachePath).slice(1).toLowerCase();
  const dest = uniquePath(songFileStem(artist, title, mix), ext);
  const cut = [];
  if (start > EDGE) cut.push('-ss', start.toFixed(3));
  if (duration && end < duration - EDGE) cut.push('-to', end.toFixed(3));
  // A cut FLAC is encoded again (still lossless): a copied stream keeps the
  // whole file's length in its header, so players would show the uncut length.
  const codec = cut.length && ext === 'flac' ? ['-c:a', 'flac', '-compression_level', '5'] : ['-c', 'copy'];
  try {
    await runFfmpeg([...cut, '-i', cachePath, '-map', '0:a:0', ...codec,
      ...tagArgs({ artist, title, mix, sourceUrl }, ext), dest], end - start);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  const info = await tools.probeAudio(dest);
  return { file: dest, duration: info.duration || (end - start), format: ext };
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
    await runFfmpeg(['-i', song.file, '-map', '0:a:0', '-c', 'copy',
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
