'use strict';

// Cover art: one square JPEG per song (512 x 512, 25 to 40 KB), made with
// ffmpeg from a picture on the web or in the song's file. Shared by the
// desktop app and the Flow Server; each hands over its ffmpeg and, for the
// YouTube Music lookup, a way to run yt-dlp.
//
// Where the picture comes from (resolveCover):
//   1. The song's own thumbnail. YouTube Music and "- Topic" uploads show the
//      album cover as a square in the middle of a 16:9 picture, with flat
//      side bars (one colour). Flat bars: the square in the middle is the
//      cover. A square picture (SoundCloud's artwork) is a cover as it is.
//   2. Otherwise (a music video): YouTube Music's song search for artist and
//      title, whose hit at the same length (within 3 s) carries the cover in
//      its thumbnail the same way.
//   3. Otherwise the middle of the video's own thumbnail.
//
// The covers are kept by song id (client/coverStore.js, createPairStore), never by name, so a song
// renamed keeps its cover; `song.cover` is the version of the file (a short
// hash), so an app sees when one changed.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const spotify = require('./spotify');
const { tr } = require('./lang');
const { packCovers, unpackCovers } = require('./coverPack');

const SIZE = 512;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT = 15000;
// Standard deviation of the side bars' grey values, out of 255: flat bars
// measure 0 to 1, JPEG noise included; real video frames 40 to 55.
const FLAT_LIMIT = 2;
// Pixels left out at the bars' edges (JPEG blur at the cover's border).
const INSET = 4;
// Length difference a YouTube Music hit may have and still be this song.
const SAME_LENGTH = 3;
// `song.cover` once looked for and nothing found: not looked for again.
const NO_COVER = '-';
const ID_RE = /^[\w-]{1,64}$/;

// ---- pictures ----

/** { width, height } of a JPEG, PNG, GIF or WebP, or null. */
function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  // PNG: IHDR right after the signature.
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X' && buf.length >= 30) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return null;
  }
  // JPEG: the first start-of-frame marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Runs ffmpeg with `input` (a Buffer) on stdin when given, at low priority
 * (covers are background work: playing and downloading come first).
 * Resolves { ok, stdout: Buffer, stderr }. Killed after `timeout`.
 */
function ffmpegRun(ffmpeg, args, { input = null, timeout = 30000, maxOut = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpeg, ['-hide_banner', '-nostats', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    } catch {
      resolve({ ok: false, stdout: Buffer.alloc(0), stderr: '' });
      return;
    }
    try {
      if (proc.pid) os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      // Normal priority then.
    }
    const out = [];
    let size = 0;
    const err = [];
    const timer = setTimeout(() => proc.kill(), timeout);
    proc.stdout.on('data', (c) => {
      size += c.length;
      if (size > maxOut) proc.kill();
      else out.push(c);
    });
    proc.stderr.on('data', (d) => err.push(String(d)));
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: Buffer.alloc(0), stderr: err.join('') });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && size <= maxOut, stdout: Buffer.concat(out), stderr: err.join('') });
    });
    // ffmpeg may stop reading early (it has what it needs); that is no error.
    proc.stdin.on('error', () => {});
    if (input) proc.stdin.end(input);
    else proc.stdin.end();
  });
}

function stddev(buf, from, to) {
  const n = to - from;
  if (n <= 0) return Infinity;
  let sum = 0;
  let sq = 0;
  for (let i = from; i < to; i += 1) {
    sum += buf[i];
    sq += buf[i] * buf[i];
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

/**
 * Whether a wide picture is a square cover between flat side bars: both bars
 * (beside the middle square, `INSET` pixels in from every edge) one colour
 * each. False for a picture that is not wider than high.
 */
async function bandsAreFlat(ffmpeg, image, { letterbox = false } = {}) {
  const size = imageSize(image);
  if (!size) return false;
  const w = size.width;
  // Letterboxed: the 16:9 picture in the middle of the 4:3 one.
  const h = letterbox ? Math.floor((w * 9) / 16) : size.height;
  const top = letterbox ? Math.floor((size.height - h) / 2) : 0;
  const bar = Math.floor((w - h) / 2);
  const sw = bar - 2 * INSET;
  const sh = h - 2 * INSET;
  if (sw < 8 || sh < 8 || top < 0) return false;
  const filter = `[0:v]format=gray,split[a][b];[a]crop=${sw}:${sh}:${INSET}:${top + INSET}[l];`
    + `[b]crop=${sw}:${sh}:${w - bar + INSET}:${top + INSET}[r];[l][r]hstack=inputs=2[out]`;
  const r = await ffmpegRun(ffmpeg, ['-f', 'image2pipe', '-i', 'pipe:0', '-filter_complex', filter,
    '-map', '[out]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { input: image });
  if (!r.ok || r.stdout.length !== sw * 2 * sh) return false;
  // Row by row: the left bar's pixels, then the right's.
  const left = Buffer.alloc(sw * sh);
  const right = Buffer.alloc(sw * sh);
  for (let y = 0; y < sh; y += 1) {
    r.stdout.copy(left, y * sw, y * sw * 2, y * sw * 2 + sw);
    r.stdout.copy(right, y * sw, y * sw * 2 + sw, y * sw * 2 + 2 * sw);
  }
  return stddev(left, 0, left.length) < FLAT_LIMIT && stddev(right, 0, right.length) < FLAT_LIMIT;
}

/**
 * The middle square of a picture (or of the first picture in a song's file:
 * `input` a path), scaled to 512 x 512, as a JPEG Buffer; null when ffmpeg
 * could not. `letterbox`: the picture is 4:3 with a 16:9 picture inside
 * (YouTube's hqdefault), which is cut out first.
 */
async function makeSquare(ffmpeg, input, { letterbox = false } = {}) {
  const fromFile = typeof input === 'string';
  const vf = [
    ...(letterbox ? ['crop=iw:iw*9/16'] : []),
    'crop=w=min(iw\\,ih):h=min(iw\\,ih)',
    `scale=${SIZE}:${SIZE}:flags=lanczos`,
    'format=yuvj420p',
  ].join(',');
  const source = fromFile ? ['-i', input, '-map', '0:v:0'] : ['-f', 'image2pipe', '-i', 'pipe:0'];
  const r = await ffmpegRun(ffmpeg, [...source, '-vf', vf, '-frames:v', '1', '-q:v', '3',
    '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { input: fromFile ? null : input });
  if (!r.ok || r.stdout.length < 100 || r.stdout[0] !== 0xff || r.stdout[1] !== 0xd8) return null;
  return r.stdout;
}

// The two covers kept of each song (4.3.1): the high resolution one and the
// thumbnail every list shows, both WebP (a third smaller than JPEG).
const THUMB = 128;
const WEBP_QUALITY = '80';

/** Whether a picture is a WebP. */
function isWebp(buf) {
  return Buffer.isBuffer(buf) && buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}

/** Whether a picture is a JPEG. */
function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * A song's two covers from a picture (a Buffer, or a song file's first
 * picture: `input` a path), in one ffmpeg run: { big } 512 x 512 and
 * { small } 128 x 128, WebP, the middle square of the picture. An ffmpeg
 * without WebP (libwebp) makes JPEGs instead, which every app shows as well.
 * Null when ffmpeg could not.
 */
async function makeCoverPair(ffmpeg, input, { letterbox = false } = {}) {
  if (!ffmpeg || !input) return null;
  const fromFile = typeof input === 'string';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cover-'));
  const square = [...(letterbox ? ['crop=iw:iw*9/16'] : []), 'crop=w=min(iw\\,ih):h=min(iw\\,ih)'].join(',');
  const filter = `[0:v]${square},split=2[a][b];[a]scale=${SIZE}:${SIZE}:flags=lanczos[big];[b]scale=${THUMB}:${THUMB}:flags=lanczos[small]`;
  const source = fromFile ? ['-i', input] : ['-f', 'image2pipe', '-i', 'pipe:0'];
  const run = async (codec, ext) => {
    const big = path.join(dir, `big.${ext}`);
    const small = path.join(dir, `small.${ext}`);
    const r = await ffmpegRun(ffmpeg, [...source, '-filter_complex', filter,
      '-map', '[big]', '-frames:v', '1', ...codec, big,
      '-map', '[small]', '-frames:v', '1', ...codec, small], { input: fromFile ? null : input });
    if (!r.ok) return null;
    try {
      return { big: fs.readFileSync(big), small: fs.readFileSync(small) };
    } catch {
      return null;
    }
  };
  try {
    let pair = await run(['-c:v', 'libwebp', '-quality', WEBP_QUALITY], 'webp');
    if (!pair || !isWebp(pair.big)) pair = await run(['-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', '3'], 'jpg');
    if (!pair || pair.big.length < 100 || pair.small.length < 50) return null;
    return pair;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A cover as a JPEG (for a song file's tags, which want one): as it is when it is one. */
async function toJpeg(ffmpeg, picture) {
  if (!picture || isJpeg(picture)) return picture || null;
  if (!ffmpeg) return null;
  const r = await ffmpegRun(ffmpeg, ['-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '3',
    '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { input: picture });
  return r.ok && isJpeg(r.stdout) ? r.stdout : null;
}

/** The picture's content type, for sending it. */
function pictureType(buf) {
  if (isWebp(buf)) return 'image/webp';
  if (Buffer.isBuffer(buf) && buf.length > 4 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  return 'image/jpeg';
}

/**
 * A picture from the web as a Buffer: http(s) only, an image content type,
 * at most `maxBytes`, within `timeout`. Throws otherwise.
 */
async function fetchImage(url, { maxBytes = MAX_IMAGE_BYTES, timeout = FETCH_TIMEOUT, fetchFn = globalThis.fetch } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error(tr('core.cover.notWebAddress', 'Not a web address.'));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 Flow' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) throw new Error(tr('common.notPicture', 'Not a picture.'));
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) throw new Error(tr('core.cover.tooLarge', 'The picture is too large.'));
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) {
        ctrl.abort();
        throw new Error(tr('core.cover.tooLarge', 'The picture is too large.'));
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

// ---- where a song's picture is ----

/** The YouTube video id in a source key ('youtube:<id>'), or null. */
function youtubeIdOf(sourceKey) {
  const m = /^youtube:([A-Za-z0-9_-]{11})$/i.exec(String(sourceKey || ''));
  return m ? m[1] : null;
}

/**
 * YouTube's thumbnails of a video, best first: maxresdefault and hq720
 * (16:9, never webp), then hqdefault (4:3 with the 16:9 picture in it).
 */
function youtubeThumbs(id) {
  const base = `https://i.ytimg.com/vi/${id}`;
  return [
    { url: `${base}/maxresdefault.jpg` },
    { url: `${base}/hq720.jpg` },
    { url: `${base}/hqdefault.jpg`, letterbox: true },
  ];
}

/**
 * The pictures to try for what yt-dlp said about a song (its info JSON), best
 * first: [{ url, letterbox? }]. YouTube's by the video id; any other site's
 * largest thumbnail that is not webp (else any).
 */
function coverUrlsFromInfo(info) {
  if (!info || typeof info !== 'object') return [];
  const extractor = String(info.extractor_key || info.extractor || '').toLowerCase();
  if (extractor.startsWith('youtube') && /^[A-Za-z0-9_-]{11}$/.test(String(info.id || ''))) return youtubeThumbs(info.id);
  const thumbs = (Array.isArray(info.thumbnails) ? info.thumbnails : [])
    .filter((t) => t && /^https?:\/\//i.test(String(t.url || '')));
  const area = (t) => (Number(t.width) || 0) * (Number(t.height) || 0) || Number(t.preference) || 0;
  const webp = (t) => /\.webp(\?|$)/i.test(t.url);
  thumbs.sort((a, b) => (webp(a) - webp(b)) || (area(b) - area(a)));
  const urls = thumbs.map((t) => t.url);
  if (/^https?:\/\//i.test(String(info.thumbnail || '')) && !urls.includes(info.thumbnail)) urls.push(info.thumbnail);
  return urls.slice(0, 3).map((url) => ({ url }));
}

/**
 * The first of `candidates` that downloads: { image, letterbox } or null.
 * `seen.unreachable` is set when one failed for another reason than not
 * being there (offline, timed out): worth trying again later.
 */
async function firstImage(candidates, fetchFn, seen) {
  for (const c of candidates) {
    try {
      const image = await fetchFn(c.url);
      if (imageSize(image)) return { image, letterbox: !!c.letterbox };
    } catch (err) {
      if (!/^HTTP 4\d\d|Not a picture|too large|Not a web address/i.test(String((err && err.message) || ''))) seen.unreachable = true;
    }
  }
  return null;
}

/**
 * The cover a picture holds: 'art' for a square one (a site's artwork),
 * 'cover' for a square between flat bars, else null (a video frame).
 */
async function coverIn(ffmpeg, found) {
  if (!found) return null;
  const size = imageSize(found.image);
  if (!size) return null;
  if (!found.letterbox && size.width <= size.height * 1.15) return 'art';
  return (await bandsAreFlat(ffmpeg, found.image, { letterbox: found.letterbox })) ? 'cover' : null;
}

/**
 * Finds a song's cover. song: { sourceKey, sourceUrl, artist, title,
 * duration, thumbnails?, noSearch? } (thumbnails: what coverUrlsFromInfo
 * gave, when the info is at hand; noSearch: the song came from a search
 * already, a Spotify import). deps: { ffmpeg (path), fetchImage?,
 * readInfo?(url) -> yt-dlp info JSON (another site's thumbnail),
 * searchMusic?(track) -> [{ id, title, duration }] (YouTube Music's song
 * search), embedded?() -> JPEG or null (the picture in the song's file),
 * cancelled?() }.
 * Resolves { jpeg, kind: 'cover' | 'art' | 'embedded' | 'search' | 'frame' },
 * or { jpeg: null, kind: null, retry } when nothing was found; retry: some of
 * it could not be reached (offline), so it is worth another try later.
 */
async function resolveCover(song, deps) {
  const ffmpeg = deps.ffmpeg;
  const seen = { unreachable: false };
  const none = () => ({ jpeg: null, kind: null, retry: seen.unreachable || stop() });
  if (!ffmpeg) return { jpeg: null, kind: null, retry: true };
  const fetchFn = deps.fetchImage || ((url) => fetchImage(url));
  const stop = () => !!(deps.cancelled && deps.cancelled());
  const ytId = youtubeIdOf(song.sourceKey);
  // thumbnails given (even none): yt-dlp's info was read already.
  const known = Array.isArray(song.thumbnails);
  let candidates = known && song.thumbnails.length ? song.thumbnails : (ytId ? youtubeThumbs(ytId) : []);
  if (!candidates.length && !known && song.sourceUrl && deps.readInfo) {
    try {
      candidates = coverUrlsFromInfo(await deps.readInfo(song.sourceUrl));
    } catch (err) {
      candidates = [];
      if (!/not available|404|private|unsupported/i.test(String((err && err.message) || ''))) seen.unreachable = true;
    }
  }
  if (stop()) return none();
  const own = await firstImage(candidates, fetchFn, seen);
  const ownKind = await coverIn(ffmpeg, own);
  if (ownKind) {
    const jpeg = await makeSquare(ffmpeg, own.image, { letterbox: own.letterbox });
    if (jpeg) return { jpeg, kind: ownKind };
  }

  // A picture in the file (put there by another program, or by Flow).
  if (deps.embedded && !stop()) {
    try {
      const jpeg = await deps.embedded();
      if (jpeg) return { jpeg, kind: 'embedded' };
    } catch {
      // None then.
    }
  }

  // A music video: the song itself on YouTube Music.
  if (!song.noSearch && song.title && deps.searchMusic && !stop()) {
    const track = { title: song.title, artists: song.artist || '', duration: Number(song.duration) || 0 };
    try {
      const entries = await deps.searchMusic(track);
      const hit = spotify.pickMusicResult(track, entries);
      const close = hit && (!track.duration || (hit.duration && Math.abs(hit.duration - track.duration) <= SAME_LENGTH));
      if (close && hit.id !== ytId && !stop()) {
        const found = await firstImage(youtubeThumbs(hit.id), fetchFn, seen);
        if (await coverIn(ffmpeg, found)) {
          const jpeg = await makeSquare(ffmpeg, found.image, { letterbox: found.letterbox });
          if (jpeg) return { jpeg, kind: 'search' };
        }
      }
    } catch {
      // No answer from YouTube Music: the video's own picture then (and
      // another try later, when there is none).
      seen.unreachable = true;
    }
  }

  if (own && !stop()) {
    const jpeg = await makeSquare(ffmpeg, own.image, { letterbox: own.letterbox });
    if (jpeg) return { jpeg, kind: 'frame' };
  }
  return none();
}

/**
 * The picture embedded in a song's file (an attached picture: ID3 APIC, an
 * MP4 covr, a FLAC picture block) as a cover, or null.
 */
async function embeddedCover(ffmpeg, file) {
  if (!ffmpeg || !file) return null;
  return makeSquare(ffmpeg, file);
}

/**
 * resolveCover's readInfo and searchMusic, through an app's yt-dlp
 * (@flow/core/media). The search lists titles only, so the length of the
 * result that will be picked is read once more when it is missing.
 */
function lookupsFor(media) {
  return {
    readInfo: (url) => media.readJson(['--no-playlist', '-I', '1', '-j', url]),
    async searchMusic(track) {
      const res = await media.readJson(['--flat-playlist', '-J', '-I', '1:5', spotify.musicSearchUrl(track)]);
      const entries = (res.entries || []).filter((e) => e && e.id)
        .map((e) => ({ id: String(e.id), title: String(e.title || ''), duration: Number(e.duration) || 0 }));
      const hit = spotify.pickMusicResult(track, entries);
      if (hit && !hit.duration) {
        const info = await media.readJson(['--no-playlist', '-j', `https://www.youtube.com/watch?v=${hit.id}`]);
        hit.duration = Number(info.duration) || 0;
      }
      return entries;
    },
  };
}

/** A cover's version: short, and changing with its bytes. */
function coverVersion(jpeg) {
  return crypto.createHash('sha1').update(jpeg).digest('hex').slice(0, 10);
}

// ---- the server's store (4.3.1): <dir>/high_res/<id>.webp, <dir>/thumbnails/<id>.webp ----

const SIZES = { big: 'high_res', small: 'thumbnails' };

/**
 * A Flow Server's covers: each song's two (makeCoverPair) in a folder each.
 * A song's version (song.cover) is the picture's, kept in the library, so
 * the two files carry none of their own. A cover from before 4.3.1
 * (<dir>/<id>.jpg) is `legacy` until it is made into the two.
 */
function createPairStore(dir) {
  const check = (id) => {
    if (!ID_RE.test(String(id || ''))) throw new Error(tr('common.notSongId', 'Not a song id.'));
    return String(id);
  };
  const file = (id, size = 'big') => path.join(dir, SIZES[size] || SIZES.big, `${check(id)}.webp`);
  const legacyFile = (id) => path.join(dir, `${check(id)}.jpg`);
  const exists = (f) => {
    try {
      return fs.statSync(f).size > 0;
    } catch {
      return false;
    }
  };
  function put(dest, bytes) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, bytes);
    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
  const idsIn = (folder, ext) => {
    try {
      return fs.readdirSync(folder).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)).filter((id) => ID_RE.test(id));
    } catch {
      return [];
    }
  };
  return {
    dir,
    file,
    legacyFile,
    has: (id, size = 'big') => exists(file(id, size)),
    /** A cover from before 4.3.1 still to be made into the two. */
    legacy: (id) => (exists(legacyFile(id)) ? legacyFile(id) : null),
    read(id, size = 'big') {
      try {
        return fs.readFileSync(file(id, size));
      } catch {
        return null;
      }
    },
    /** Both covers of a song (makeCoverPair's); the old one goes. Answers the new version. */
    write(id, { big, small }) {
      put(file(id, 'big'), big);
      put(file(id, 'small'), small);
      fs.rmSync(legacyFile(id), { force: true });
      return coverVersion(big);
    },
    /** One of the two, as it is. */
    writeOne(id, size, bytes) {
      put(file(id, size), bytes);
    },
    remove(id) {
      for (const f of [file(id, 'big'), file(id, 'small'), legacyFile(id)]) {
        try {
          fs.rmSync(f, { force: true });
        } catch {
          // Open somewhere; the next sweep gets it.
        }
      }
    },
    /** The ids with a cover, made or from before. */
    ids() {
      return [...new Set([...idsIn(path.join(dir, SIZES.big), '.webp'), ...idsIn(dir, '.jpg')])];
    },
    /** Removes the covers of songs not in `keep`, and leftover temporary files. */
    sweep(keep) {
      let removed = 0;
      for (const folder of [dir, path.join(dir, SIZES.big), path.join(dir, SIZES.small)]) {
        let names = [];
        try {
          names = fs.readdirSync(folder);
        } catch {
          continue;
        }
        for (const name of names) {
          const full = path.join(folder, name);
          const m = /^(.+)\.(webp|jpg)$/i.exec(name);
          if (/\.tmp$/i.test(name) || (m && !keep.has(m[1]))) {
            try {
              fs.rmSync(full, { force: true });
              if (m) removed += 1;
            } catch {
              // In use; the next sweep.
            }
          }
        }
      }
      return removed;
    },
  };
}

module.exports = {
  SIZE, THUMB, NO_COVER, ID_RE, FLAT_LIMIT,
  imageSize, bandsAreFlat, makeSquare, makeCoverPair, toJpeg, isWebp, isJpeg, pictureType, fetchImage, ffmpegRun, createPairStore, packCovers, unpackCovers,
  youtubeIdOf, youtubeThumbs, coverUrlsFromInfo, resolveCover, lookupsFor, embeddedCover, coverVersion,
};
