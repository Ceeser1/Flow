'use strict';

// Saving into Music\FlowPlayer: the trim cut out of the cached download and the
// artist, title and mix written into the file's own tags, so other players
// show them too. Both the cut and the re-tagging copy the audio stream rather
// than encoding it, so saving never costs quality. (A cut FLAC is the one
// exception, encoded again as FLAC: lossless all the same.) A saved song
// trimmed later (Edit) is cut the same way, in place.

const crypto = require('crypto');
const fs = require('fs');
const { shell } = require('electron');
const path = require('path');
const paths = require('./paths');
const media = require('./media');
const { songFileStem } = require('@flow/core/text');
const settings = require('./settings');
const covers = require('./covers');
const { tagArgs, flowIdText } = require('@flow/core/tags');

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
 * its tags written anew (media.rewriteTags: the other tags stay, the song's
 * flowid and cover go in). Resolves { file, written }: the new path, and
 * whether the tags were written. If ffmpeg cannot write them the file is
 * still renamed, since the library holds the names anyway.
 */
async function retagSong(song, meta) {
  const ext = path.extname(song.file).slice(1).toLowerCase();
  const dest = uniquePath(songFileStem(meta.artist, meta.title, meta.mix), ext, song.file);
  const tmp = path.join(path.dirname(dest), `.flow-retag-${Date.now()}.${ext}`);
  try {
    const picture = song.cover && song.cover !== '-' ? covers.localStore().read(song.id) : null;
    const ok = await media.rewriteTags(song.file, tmp, {
      meta: { ...meta, sourceUrl: song.sourceUrl },
      flowId: flowIdText(settings.clientId(), song.id),
      picture,
    });
    if (ok) {
      fs.rmSync(song.file, { force: true });
      fs.renameSync(tmp, dest);
      return { file: dest, written: true };
    }
  } catch {
    // Renamed all the same, below.
  }
  fs.rmSync(tmp, { force: true });
  if (!samePath(song.file, dest)) fs.renameSync(song.file, dest);
  return { file: dest, written: false };
}

/**
 * A saved song's file trimmed to [start, end] (seconds), where it is: cut
 * into a copy beside it, the uncut file to the Recycle Bin (`keep`) or
 * deleted, the copy put in its place. Resolves { duration }.
 */
async function trimSong(song, start, end, { keep = true } = {}) {
  const ext = path.extname(song.file);
  const tmp = path.join(path.dirname(song.file), `.flow-trim-${crypto.randomBytes(6).toString('hex')}${ext}`);
  try {
    const { duration } = await media.trimFile({ file: song.file, start, end, duration: song.duration }, tmp);
    try {
      if (keep) await shell.trashItem(song.file);
      else fs.rmSync(song.file);
    } catch {
      throw new Error('The file could not be replaced. It may be open in another program.');
    }
    fs.renameSync(tmp, song.file);
    return { duration };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { saveSong, retagSong, trimSong, tagArgs, uniquePath };
