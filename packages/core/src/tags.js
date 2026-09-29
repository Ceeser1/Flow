'use strict';

// What ffmpeg is told and what it answers, for every Flow that runs it: the
// tags a saved song gets, and the loudness read out of its EBU R128 meter.

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

/** The integrated loudness from ebur128's summary, or null (silence, nothing read). */
function parseLoudness(stderr) {
  const summary = String(stderr).split(/Summary:/).pop();
  const m = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
  if (!m) return null;
  const v = Number(m[1]);
  // -70 is the meter's floor: the song is silent (or unreadable).
  return Number.isFinite(v) && v > -69 ? v : null;
}

module.exports = { tagArgs, parseLoudness };
