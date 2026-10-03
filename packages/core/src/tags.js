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

// ---- a saved song's tags written again (a rename, its id, its cover) ----
//
// The file carries its song's id as flowid=<library>:<song id> (the server's
// id, or the app's own for Local Files), so a file renamed or moved outside
// Flow is still known (a hint, never more: a copy gets an id of its own).
// The cover goes into the file too: as a picture stream in MP3 and FLAC, as
// a METADATA_BLOCK_PICTURE comment in Ogg (Opus, Vorbis). M4A keeps none: its
// tags are written in the form that holds Mix and flowid, which leaves no
// room for one (ffmpeg writes the cover only in iTunes' form). WAV keeps
// title and artist only.

const ID_EXTS = new Set(['mp3', 'm4a', 'flac', 'opus', 'ogg', 'oga']);
const PICTURE_EXTS = new Set(['mp3', 'flac', 'opus', 'ogg', 'oga']);
const OGG_EXTS = new Set(['opus', 'ogg', 'oga']);
const ID_PART = /^[\w-]{1,64}$/;

/** The flowid tag's text, or '' when either part is not an id. */
function flowIdText(library, songId) {
  return ID_PART.test(String(library || '')) && ID_PART.test(String(songId || '')) ? `${library}:${songId}` : '';
}

/** { library, songId } from a file's tags (any case of the key), or null. */
function parseFlowId(tags) {
  const key = Object.keys(tags || {}).find((k) => k.toLowerCase() === 'flowid');
  const m = key ? /^([\w-]{1,64}):([\w-]{1,64})$/.exec(String(tags[key]).trim()) : null;
  return m ? { library: m[1], songId: m[2] } : null;
}

// Tags that describe the file rather than the song, and the names, which are
// always Flow's (a Mix taken away goes from the file too).
const DROPPED = new Set(['encoder', 'major_brand', 'minor_version', 'compatible_brands', 'metadata_block_picture',
  'creation_time', 'handler_name', 'vendor_id', 'language']);
const NAMES = ['title', 'artist', 'mix'];

/**
 * The tags a file is written with: the ones it has (album, year, track ...)
 * with the names of `meta` over them, and its source (comment) and flowid
 * when it gives them. Keys lower-case.
 */
function mergedTags(existing, { title = '', artist = '', mix = '', sourceUrl = '', flowId = '' }) {
  const out = {};
  for (const [k, v] of Object.entries(existing || {})) {
    const key = k.toLowerCase();
    if (DROPPED.has(key) || NAMES.includes(key) || key.startsWith('id3v2_priv') || !/^[\w .-]{1,64}$/.test(key)) continue;
    out[key] = String(v);
  }
  out.title = title;
  out.artist = artist;
  if (mix) out.mix = mix;
  if (sourceUrl) out.comment = sourceUrl;
  if (flowId) out.flowid = flowId;
  return out;
}

// ffmetadata: = ; # \ and line breaks are escaped with a backslash.
const ffEscape = (s) => String(s).replace(/[=;#\\\n]/g, (c) => `\\${c}`);

/** An ffmetadata file's text holding `tags` (and an Ogg picture comment). */
function ffmetadata(tags, oggPicture = '') {
  const lines = Object.entries(tags).map(([k, v]) => `${ffEscape(k)}=${ffEscape(v)}`);
  if (oggPicture) lines.push(`METADATA_BLOCK_PICTURE=${oggPicture}`);
  return `;FFMETADATA1\n${lines.join('\n')}\n`;
}

/** A FLAC picture block (front cover), base64: how Ogg files carry a picture. */
function oggPictureBlock(image, { width = 0, height = 0 } = {}) {
  const png = image.length > 8 && image.readUInt32BE(0) === 0x89504e47;
  const mime = Buffer.from(png ? 'image/png' : 'image/jpeg');
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
  };
  return Buffer.concat([u32(3), u32(mime.length), mime, u32(0), u32(width), u32(height), u32(0), u32(0),
    u32(image.length), image]).toString('base64');
}

/**
 * ffmpeg's arguments for writing a file's tags anew into `out`: the audio
 * copied as it is, the tags from `metaFile` (ffmetadata), and for MP3 and
 * FLAC the picture in `pictureFile` (null: none).
 */
function retagArgs({ file, out, ext, metaFile, pictureFile = null }) {
  const pic = !!pictureFile && PICTURE_EXTS.has(ext) && !OGG_EXTS.has(ext);
  const args = ['-i', file, '-f', 'ffmetadata', '-i', metaFile];
  if (pic) args.push('-i', pictureFile);
  args.push('-map', '0:a:0');
  if (pic) args.push('-map', '2:0');
  // The tags only from the file: the input's own (also those Ogg keeps on
  // its stream, which would win) were read into it.
  args.push('-c', 'copy', '-map_metadata', '1', '-map_metadata:s:a:0', '-1');
  if (pic) {
    args.push('-disposition:v:0', 'attached_pic', '-metadata:s:v:0', 'title=Album cover', '-metadata:s:v:0', 'comment=Cover (front)');
  }
  if (ext === 'mp3') args.push('-id3v2_version', '3', '-write_id3v1', '0');
  if (ext === 'm4a') args.push('-movflags', '+faststart+use_metadata_tags');
  args.push(out);
  return args;
}

module.exports = {
  tagArgs, parseLoudness, ID_EXTS, PICTURE_EXTS, OGG_EXTS, flowIdText, parseFlowId, mergedTags, ffmetadata,
  oggPictureBlock, retagArgs,
};
