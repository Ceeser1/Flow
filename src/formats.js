'use strict';

// Which format a download is kept in. Pure, pinned by test/formats.test.js.
//
// The rule is that no song is ever converted from one lossy format into
// another unless the user asks for it with "Always convert to MP3":
//   - Opus, AAC, MP3, Vorbis, FLAC and PCM WAV play as they are. At most the
//     audio is lifted out of its container (.webm -> .opus, .mp4 -> .m4a),
//     which copies the stream and costs no quality.
//   - Lossless formats the player cannot handle well (AIFF, ALAC, WavPack...)
//     become FLAC, which is still lossless.
//   - Anything else becomes MP3 at the chosen quality.

const MP3_QUALITIES = [64, 96, 128, 160, 192, 224, 256, 320];
const DEFAULT_MP3_QUALITY = 192;

// codec_name as ffprobe reports it -> how it is stored.
const KEEP = {
  opus: { ext: 'opus', name: 'Opus' },
  aac: { ext: 'm4a', name: 'AAC' },
  mp3: { ext: 'mp3', name: 'MP3' },
  vorbis: { ext: 'ogg', name: 'Vorbis' },
  flac: { ext: 'flac', name: 'FLAC' },
};

const LOSSLESS_TO_FLAC = {
  alac: 'ALAC', wavpack: 'WavPack', ape: 'Monkey\'s Audio', tta: 'TTA',
  tak: 'TAK', mlp: 'MLP', truehd: 'TrueHD', shorten: 'Shorten',
};

const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.opus', '.ogg', '.oga', '.flac', '.wav'];

// What "Open local File(s) / Folder" offers: anything ffmpeg reads audio from,
// video included. Whatever does not play as it is gets converted (planFor).
const LOCAL_EXTS = [
  ...AUDIO_EXTS.map((e) => e.slice(1)),
  'aif', 'aiff', 'aifc', 'wma', 'wv', 'ape', 'tta', 'tak', 'mka', 'm4b', 'caf', 'ac3', 'eac3', 'dts',
  'mp2', 'mpc', 'spx', 'amr', 'au', 'weba', 'webm', 'mp4', 'm4v', 'mkv', 'mov', 'avi', 'flv', '3gp',
  'wmv', 'mpg', 'mpeg', 'ts',
];

function isPcm(codec) {
  return /^pcm_/.test(codec);
}

function isAiff(formatName) {
  return /\baiff\b/.test(formatName || '');
}

function clampQuality(q) {
  const n = Number(q);
  return MP3_QUALITIES.includes(n) ? n : DEFAULT_MP3_QUALITY;
}

/** "Opus ~160 kbit/s", "WAV (lossless)": how the source is described to the user. */
function describeSource(codec, formatName, bitRate) {
  const c = String(codec || '').toLowerCase();
  const kbps = bitRate ? Math.round(bitRate / 1000) : 0;
  const rate = kbps ? ` ~${kbps} kbit/s` : '';
  if (isPcm(c)) return isAiff(formatName) ? 'AIFF (lossless)' : 'WAV (lossless)';
  if (c === 'flac') return 'FLAC (lossless)';
  if (LOSSLESS_TO_FLAC[c]) return `${LOSSLESS_TO_FLAC[c]} (lossless)`;
  if (KEEP[c]) return KEEP[c].name + rate;
  return (c ? c.toUpperCase() : 'Unknown format') + rate;
}

/**
 * The plan for one downloaded file.
 *   probe:  { codec, formatName, bitRate } from ffprobe
 *   opts:   { alwaysMp3, quality, keepMp3 }
 * Returns { action: 'copy' | 'flac' | 'mp3', ext, source, target, bitrate }.
 * 'copy' still runs through ffmpeg, to lift the audio out of its container
 * and drop any video or cover picture that came with it.
 */
function planFor(probe, opts = {}) {
  const codec = String((probe && probe.codec) || '').toLowerCase();
  const formatName = String((probe && probe.formatName) || '').toLowerCase();
  const source = describeSource(codec, formatName, probe && probe.bitRate);
  const quality = clampQuality(opts.quality);
  const mp3 = { action: 'mp3', ext: 'mp3', source, target: `MP3 ${quality} kbit/s`, bitrate: quality };

  // An MP3 is kept as it is: encoding it again only loses quality, and a
  // higher bitrate than the source had just makes the file bigger. Only
  // "Always convert" with "Ignore files already in .mp3" unticked re-encodes
  // it, to bring every song to the chosen bitrate (a smaller one, usually).
  if (codec === 'mp3') {
    if (opts.alwaysMp3 && opts.keepMp3 === false) return mp3;
    return { action: 'copy', ext: 'mp3', source, target: 'MP3' };
  }
  if (opts.alwaysMp3) return mp3;

  if (KEEP[codec]) return { action: 'copy', ext: KEEP[codec].ext, source, target: KEEP[codec].name };
  if (isPcm(codec)) {
    if (isAiff(formatName)) return { action: 'flac', ext: 'flac', source, target: 'FLAC' };
    return { action: 'copy', ext: 'wav', source, target: 'WAV' };
  }
  if (LOSSLESS_TO_FLAC[codec]) return { action: 'flac', ext: 'flac', source, target: 'FLAC' };
  return mp3;
}

/** ffmpeg output arguments for a plan (after -i). */
function ffmpegArgsFor(plan) {
  const base = ['-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1'];
  if (plan.action === 'mp3') {
    return [...base, '-c:a', 'libmp3lame', '-b:a', `${plan.bitrate}k`];
  }
  if (plan.action === 'flac') {
    return [...base, '-c:a', 'flac', '-compression_level', '5'];
  }
  const args = [...base, '-c:a', 'copy'];
  if (plan.ext === 'm4a') args.push('-movflags', '+faststart');
  return args;
}

/**
 * Megabytes a song of `seconds` takes at `kbps`. Used for the "about 5.0 MB
 * average per song" note next to the quality dropdown.
 */
function estimateMb(kbps, seconds) {
  return (kbps * 1000 / 8) * seconds / 1e6;
}

module.exports = {
  MP3_QUALITIES, DEFAULT_MP3_QUALITY, AUDIO_EXTS, LOCAL_EXTS,
  planFor, ffmpegArgsFor, describeSource, estimateMb, clampQuality,
};
