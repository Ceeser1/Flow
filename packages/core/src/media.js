'use strict';

// Getting songs, shared by the desktop app and the Flow Server. Plain Node:
// each app makes one with createMedia(), handing over where its tools are and
// which folder downloads land in.
//
// Link -> audio file in the cache, in three steps the progress frame shows:
//   1. probe:    yt-dlp -j reads the title, length and source id.
//   2. download: yt-dlp fetches the best audio the site has, as it is.
//   3. prepare:  ffmpeg keeps, lifts out or converts it (see formats.js).
// Then cutSong() cuts the trim out and writes the tags, and peaksFor() draws
// the waveform for the trim editor. Download and prepare are adapted from
// LWClipper's src/ytdlp.js, the peaks from its src/waveform.js.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { runProcess, ProcessCancelledError } = require('./processRunner');
const { normalizeUrl, sourceKey, safeFilename } = require('./text');
const { guessFromInfo } = require('./titleParser');
const { planFor, ffmpegArgsFor } = require('./formats');
const tags = require('./tags');
const { coverUrlsFromInfo, ffmpegRun, imageSize } = require('./cover');

const { tagArgs } = tags;

// Best audio, but not YouTube's "-drc" copies: those have their dynamic range
// squashed for loudness normalisation and sound flatter than the original.
const FORMAT_SELECTOR = 'bestaudio[format_id!*=-drc]/bestaudio/best';

const PROGRESS_TEMPLATE = 'download:FLOW_DL\t%(progress.downloaded_bytes)s\t%(progress.total_bytes_estimate)s\t%(progress.speed)s\t%(progress.eta)s';
const PROGRESS_RE = /^FLOW_DL\t([\d.]+|NA)\t([\d.]+|NA)\t([\d.]+|NA)\t([\d.]+|NA)$/;

// Trims closer than this to either end are treated as no trim at all.
const EDGE = 0.02;

// The waveform: decoded to 8 kHz mono, each bucket keeps its lowest and
// highest sample, so it is a few tens of KB however long the song is.
const PEAK_RATE = 8000;
const PEAK_BUCKETS = 6400;

function parseNum(s) {
  if (!s || s === 'NA') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function mb(n) {
  return ((n || 0) / 1048576).toFixed(1) + ' MB';
}

function downloadStatusLine(got, total, speed, eta) {
  const parts = [];
  if (total) parts.push(`${((got || 0) / total * 100).toFixed(1)}%   ${mb(got)} / ${mb(total)}`);
  else parts.push(mb(got));
  if (speed) parts.push(`${(speed / 1048576).toFixed(1)} MB/s`);
  if (eta !== null && eta !== undefined) parts.push(`ETA ${Math.round(eta)}s`);
  return parts.join('   ');
}

/** One line of yt-dlp's progress template: { frac, text }, or null for any other line. */
function parseProgress(line) {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const got = parseNum(m[1]);
  const total = parseNum(m[2]);
  return {
    frac: (got !== null && total) ? Math.min(1, got / total) : null,
    text: downloadStatusLine(got, total, parseNum(m[3]), parseNum(m[4])),
  };
}

/** yt-dlp's own "ERROR: ..." lines, or the tail of what it said. */
function ytDlpError(stderrTail) {
  const errors = stderrTail.filter((l) => /^ERROR:/.test(l)).map((l) => l.replace(/^ERROR:\s*/, ''));
  const text = (errors.length ? errors : stderrTail.slice(-4)).join('\n');
  if (/Unsupported URL/i.test(text)) return 'This site is not supported.';
  if (/HTTP Error 404/i.test(text)) return 'Nothing was found at this link (error 404).';
  if (/HTTP Error 403/i.test(text)) return 'The site refused the download (error 403). Try again later.';
  if (/HTTP Error 429/i.test(text)) return 'The site is limiting requests right now (error 429). Try again later.';
  if (/Private video|This video is private/i.test(text)) return 'This video is private.';
  if (/Video unavailable|not available/i.test(text)) return 'This video is not available.';
  if (/Sign in to confirm your age/i.test(text)) {
    return 'This video is age restricted and needs a signed-in account (Settings, Website Downloads: browser cookies).';
  }
  if (/Sign in to confirm you.re not a bot/i.test(text)) {
    return 'YouTube wants a signed-in visitor right now ("confirm you\'re not a bot"). Settings, Website Downloads: browser cookies.';
  }
  // Browser cookies (--cookies-from-browser, or a server's cookie file).
  const noDb = /could not find (\w+) cookies database/i.exec(text);
  if (noDb) return `No ${noDb[1][0].toUpperCase()}${noDb[1].slice(1)} cookies were found on this computer. Pick another browser in Settings, or turn browser cookies off.`;
  if (/Could not copy .* cookie database/i.test(text)) {
    return 'The browser\'s cookies cannot be read while it is open. Close the browser and try again, or pick Firefox in Settings.';
  }
  if (/Failed to decrypt with DPAPI|app.?bound/i.test(text)) {
    return 'This browser keeps its cookies locked so yt-dlp cannot read them (Chrome, Edge and Brave on Windows). Firefox works: pick it in Settings, or turn browser cookies off.';
  }
  if (/invalid Netscape format cookies file|cookies file.*(not|invalid)/i.test(text)) return 'The browser cookies sent along could not be read.';
  if (/getaddrinfo|Failed to resolve|Unable to download webpage.*(timed out|Errno)/i.test(text)) {
    return 'Could not reach the site. Please check the internet connection.';
  }
  return text || 'yt-dlp could not read this link.';
}

/** What the Add Songs page needs from yt-dlp's info about one song. */
function probedFrom(info, url, rawUrl, knownArtists = []) {
  if (info.is_live || info.live_status === 'is_live') {
    throw new Error('Live streams cannot be downloaded.');
  }
  return {
    url: info.webpage_url || url,
    pastedUrl: String(rawUrl || '').trim(),
    key: sourceKey(info.extractor_key || info.extractor, info.id),
    title: String(info.title || info.fulltitle || 'Untitled'),
    duration: Number(info.duration) || 0,
    site: String(info.extractor_key || info.extractor || ''),
    guess: guessFromInfo(info, { knownArtists }),
    // Where its cover may be (cover.js), best first.
    thumbnails: coverUrlsFromInfo(info),
  };
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Still open somewhere; the startup sweep of the cache gets it later.
  }
}

function filesStartingWith(dir, prefix) {
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
  } catch {
    return [];
  }
}

const NO_AUDIO = { duration: 0, codec: '', formatName: '', bitRate: 0, tags: {} };

/**
 * The tools of one app. Each of ffmpeg, ffprobe and ytdlp is a function
 * giving the tool's path, or null when there is none; cacheDir gives the
 * folder downloads are prepared in. missing(name) is the message when a tool
 * is needed and not there. lowPriority runs every tool niced. ytdlpArgs()
 * gives what every yt-dlp run gets on top (the app's browser cookies); a
 * cancel token's own `ytdlpArgs` go along with the runs made with it (one
 * server download's cookies).
 */
function createMedia({
  ffmpeg, ffprobe, ytdlp, cacheDir, missing = (name) => `${name} was not found.`, lowPriority = false, ytdlpArgs = () => [],
}) {
  const runOpts = { lowPriority };
  const extraArgs = (cancelToken) => [...(ytdlpArgs() || []), ...((cancelToken && cancelToken.ytdlpArgs) || [])];

  // A tool that is a .js file (the server tests' fake yt-dlp) runs with this Node.
  const runTool = (exe, args, onLine, cancelToken) => (/\.js$/i.test(exe)
    ? runProcess(process.execPath, [exe, ...args], onLine, cancelToken, null, runOpts)
    : runProcess(exe, args, onLine, cancelToken, null, runOpts));

  function need(find, name) {
    const exe = find && find();
    if (!exe) throw new Error(missing(name));
    return exe;
  }

  /**
   * Runs a short tool call. With a cancel token (see processRunner.js),
   * cancel() on it kills the call too, so an import that is cancelled starts
   * nothing new and leaves nothing running.
   */
  function run(exe, args, timeout = 60000, cancelToken = null) {
    return new Promise((resolve) => {
      const child = execFile(exe, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
      if (cancelToken) {
        cancelToken.cancel = () => {
          cancelToken.cancelled = true;
          child.kill();
        };
        if (cancelToken.cancelled) child.kill();
      }
    });
  }

  /**
   * Duration, audio codec, container, bit rate and tags of a file, from one
   * ffprobe call. Tag names come back lower-cased, with stream tags (where
   * Ogg and Opus keep theirs) merged under the container's.
   */
  async function probeAudio(filePath, cancelToken = null) {
    const exe = need(ffprobe, 'ffprobe');
    const r = await run(exe, [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'format=duration,bit_rate,format_name:format_tags:stream=codec_name,bit_rate:stream_tags',
      '-of', 'json', filePath,
    ], 30000, cancelToken);
    if (!r.ok) return { ...NO_AUDIO };
    let info;
    try {
      info = JSON.parse(r.stdout);
    } catch {
      return { ...NO_AUDIO };
    }
    const format = info.format || {};
    const stream = (info.streams || [])[0] || {};
    const tags = {};
    for (const source of [stream.tags, format.tags]) {
      for (const [k, v] of Object.entries(source || {})) tags[k.toLowerCase()] = String(v);
    }
    const duration = parseFloat(format.duration);
    return {
      duration: Number.isFinite(duration) ? duration : 0,
      codec: String(stream.codec_name || ''),
      formatName: String(format.format_name || ''),
      bitRate: Math.round(Number(stream.bit_rate) || Number(format.bit_rate) || 0),
      tags,
    };
  }

  /**
   * Runs ffmpeg with -progress, reporting 0..1 of `duration` to onFrac.
   * Throws with the tail of ffmpeg's own output when it fails.
   */
  async function runFfmpeg(args, duration, onFrac, cancelToken) {
    const exe = need(ffmpeg, 'ffmpeg');
    const result = await runProcess(exe,
      ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args],
      (line) => {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && duration > 0 && onFrac) onFrac(Math.min(1, Number(m[1]) / 1e6 / duration));
      }, cancelToken, null, runOpts);
    if (result.exitCode !== 0) {
      throw new Error('ffmpeg failed:\n' + result.stderrTail.slice(-4).join('\n'));
    }
  }

  /** Runs yt-dlp with `args` and parses the JSON it prints. */
  async function readJson(args, cancelToken) {
    const exe = need(ytdlp, 'yt-dlp');
    need(ffmpeg, 'ffmpeg');
    let out = '';
    const result = await runTool(exe, ['--no-warnings', ...extraArgs(cancelToken), ...args], (line) => {
      if (!out && line.trim().startsWith('{')) out = line.trim();
    }, cancelToken);
    if (result.exitCode !== 0 && !out) throw new Error(ytDlpError(result.stderrTail));
    try {
      return JSON.parse(out);
    } catch {
      throw new Error('Could not read this link.');
    }
  }

  /**
   * Reads one song's link without downloading it. A link into a playlist is
   * read as that one song (or the first entry), never as the whole list:
   * whole lists go through listing.js.
   */
  async function probe(rawUrl, cancelToken, { knownArtists = [] } = {}) {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('That does not look like a link.');
    const info = await readJson(['--no-playlist', '-I', '1', '-j', url], cancelToken);
    return probedFrom(info, url, rawUrl, knownArtists);
  }

  /**
   * Keeps, lifts out or converts `src` into `outStem.<ext>` (see formats.js).
   * `src` itself is left alone. Resolves { media, info } where info is what
   * ffprobe said about `src`.
   */
  async function prepare(src, outStem, opts, report, cancelToken, { duration: guess = 0, lead = '', noAudio }) {
    const stopIfCancelled = () => {
      if (cancelToken && cancelToken.cancelled) throw new ProcessCancelledError();
    };
    stopIfCancelled();
    const info = await probeAudio(src, cancelToken);
    stopIfCancelled();
    if (!info.codec) throw new Error(noAudio);
    const plan = planFor(info, opts);
    const duration = info.duration || guess || 0;
    let startText;
    if (plan.action === 'copy') startText = `${lead}${plan.source}: no conversion needed, keeping it as .${plan.ext}`;
    else startText = `${lead}${plan.source}: converting to ${plan.target}...`;
    report('prepare', plan.action === 'copy' ? null : 0, startText);

    const out = `${outStem}.${plan.ext}`;
    await runFfmpeg(['-i', src, ...ffmpegArgsFor(plan), out], duration,
      (frac) => report('prepare', plan.action === 'copy' ? null : frac, startText), cancelToken);

    stopIfCancelled();
    const final = await probeAudio(out, cancelToken);
    stopIfCancelled();
    const summary = plan.action === 'copy'
      ? `Ready: ${plan.source}, kept as .${plan.ext}`
      : `Ready: converted ${plan.source} to ${plan.target}`;
    const media = {
      path: out,
      duration: final.duration || duration,
      ext: plan.ext,
      source: plan.source,
      target: plan.target,
      action: plan.action,
      summary,
    };
    return { media, info };
  }

  async function fetchAndPrepare(probed, opts, report, cancelToken, { exe, dir, stem }) {
    report('download', null, 'Starting download...');
    const result = await runTool(exe, [
      '--no-warnings', ...extraArgs(cancelToken), '--no-playlist', '-I', '1',
      '-f', FORMAT_SELECTOR,
      '--ffmpeg-location', path.dirname(need(ffmpeg, 'ffmpeg')),
      '-o', path.join(dir, `${stem}.src.%(ext)s`),
      '--newline',
      '--progress-template', PROGRESS_TEMPLATE,
      '--retries', '5', '--fragment-retries', '5', '--concurrent-fragments', '4',
      '--force-overwrites',
      probed.url,
    ], (line) => {
      const p = parseProgress(line);
      if (p) report('download', p.frac, p.text);
    }, cancelToken);
    if (result.exitCode !== 0) throw new Error(ytDlpError(result.stderrTail));

    const downloaded = filesStartingWith(dir, `${stem}.src.`)
      .filter((f) => !/\.(part|ytdl|temp)$/i.test(f) && !/\.part-Frag/i.test(f));
    if (!downloaded.length) throw new Error('The download finished but no file turned up.');
    const src = path.join(dir, downloaded[0]);
    try {
      const { media } = await prepare(src, path.join(dir, stem), opts, report, cancelToken,
        { duration: probed.duration, lead: 'Downloaded ', noAudio: 'The download has no audio in it.' });
      return media;
    } finally {
      removeQuietly(src);
    }
  }

  /**
   * Downloads and prepares one song. onProgress(stage, frac, text) where
   * stage is 'download' | 'prepare' and frac is 0..1, or null when unknown.
   * Resolves { path, duration, ext, source, target, action, summary }.
   * `dir` is where it lands (the cache folder unless given).
   */
  async function download(probed, opts, onProgress, cancelToken, { dir = cacheDir() } = {}) {
    const exe = need(ytdlp, 'yt-dlp');
    need(ffmpeg, 'ffmpeg');
    const report = (stage, frac, text) => {
      if (onProgress) onProgress(stage, frac, text);
    };
    const stem = safeFilename(probed.key || 'download', 80).replace(/[^A-Za-z0-9_.-]+/g, '_');
    for (const f of filesStartingWith(dir, stem + '.')) removeQuietly(path.join(dir, f));

    try {
      return await fetchAndPrepare(probed, opts, report, cancelToken, { exe, dir, stem });
    } catch (err) {
      // Cancelled or failed: nothing of this download is worth keeping.
      for (const f of filesStartingWith(dir, stem + '.')) removeQuietly(path.join(dir, f));
      throw err;
    }
  }

  /**
   * A file from the computer ("Open local File(s) / Folder"), prepared into
   * the cache like a download, so it can be previewed, trimmed and saved the
   * same way. The original is not touched. Resolves { media, tags }.
   */
  async function prepareLocal(file, opts, onProgress, cancelToken) {
    const dir = cacheDir();
    const stem = `local-${crypto.randomBytes(5).toString('hex')}`;
    const report = (stage, frac, text) => {
      if (onProgress) onProgress(stage, frac, text);
    };
    try {
      const { media, info } = await prepare(file, path.join(dir, stem), opts, report, cancelToken,
        { noAudio: 'This file has no audio in it.' });
      return { media, tags: info.tags };
    } catch (err) {
      for (const f of filesStartingWith(dir, stem + '.')) removeQuietly(path.join(dir, f));
      throw err;
    }
  }

  /** Empties the download cache. Called at startup: anything in it was abandoned. */
  function clearCache() {
    const dir = cacheDir();
    for (const f of filesStartingWith(dir, '')) removeQuietly(path.join(dir, f));
  }

  /**
   * Cuts [start, end] out of a prepared file into `dest`, with the names in
   * its tags. The audio stream is copied, so saving never costs quality (a
   * cut FLAC is the one exception, encoded again as FLAC: lossless all the
   * same). Resolves { file, duration, format }.
   */
  async function cutSong({ cachePath, start, end, duration, artist, title, mix, sourceUrl }, dest, cancelToken = null) {
    const ext = path.extname(cachePath).slice(1).toLowerCase();
    const cut = [];
    if (start > EDGE) cut.push('-ss', start.toFixed(3));
    if (duration && end < duration - EDGE) cut.push('-to', end.toFixed(3));
    // A copied stream keeps the whole file's length in a FLAC header, so
    // players would show the uncut length.
    const codec = cut.length && ext === 'flac' ? ['-c:a', 'flac', '-compression_level', '5'] : ['-c', 'copy'];
    try {
      await runFfmpeg([...cut, '-i', cachePath, '-map', '0:a:0', ...codec,
        ...tagArgs({ artist, title, mix, sourceUrl }, ext), dest], end - start, null, cancelToken);
    } catch (err) {
      removeQuietly(dest);
      throw err;
    }
    const info = await probeAudio(dest);
    return { file: dest, duration: info.duration || (end - start), format: ext };
  }

  /**
   * A saved song's file trimmed to [start, end] into `dest` (beside it; the
   * caller puts it in its place). Its tags stay as they are; a cover picture
   * in it is not carried over (written in again with its flowid). Copied as
   * it is, FLAC encoded again (see cutSong). Resolves { duration }.
   */
  async function trimFile({ file, start, end, duration }, dest, cancelToken = null) {
    const ext = path.extname(file).slice(1).toLowerCase();
    const cut = [];
    if (start > EDGE) cut.push('-ss', start.toFixed(3));
    if (!duration || end < duration - EDGE) cut.push('-to', end.toFixed(3));
    if (!cut.length) throw new Error('There is nothing to trim.');
    const codec = ext === 'flac' ? ['-c:a', 'flac', '-compression_level', '5'] : ['-c', 'copy'];
    try {
      await runFfmpeg([...cut, '-i', file, '-map', '0:a:0', ...codec, '-map_metadata', '0', dest], end - start, null, cancelToken);
    } catch (err) {
      removeQuietly(dest);
      throw err;
    }
    const info = await probeAudio(dest);
    if (!info.codec) {
      removeQuietly(dest);
      throw new Error('The trimmed file has no audio in it.');
    }
    return { duration: info.duration || (end - start) };
  }

  /**
   * Flat [min0, max0, min1, max1, ...] for the file's waveform, values -1..1.
   * cancel() on the token stops it.
   */
  function peaksFor(filePath, duration, cancelToken = null) {
    return new Promise((resolve, reject) => {
      let exe;
      try {
        exe = need(ffmpeg, 'ffmpeg');
      } catch (err) {
        reject(err);
        return;
      }
      const totalSamples = Math.max(1, Math.round(duration * PEAK_RATE));
      const buckets = Math.max(1, Math.min(PEAK_BUCKETS, totalSamples));
      const perBucket = Math.max(1, Math.ceil(totalSamples / buckets));
      const mins = new Float32Array(buckets);
      const maxs = new Float32Array(buckets);
      const seen = new Uint8Array(buckets);

      const child = spawn(exe, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', filePath,
        '-vn', '-ac', '1', '-ar', String(PEAK_RATE), '-f', 's16le', '-',
      ], { windowsHide: true });
      if (cancelToken) {
        cancelToken.cancel = () => {
          cancelToken.cancelled = true;
          try {
            child.kill();
          } catch {
            // Already gone.
          }
        };
        if (cancelToken.cancelled) child.kill();
      }

      let index = 0;
      let odd = null; // a sample split across two chunks
      const stderr = [];

      child.stdout.on('data', (chunk) => {
        let buf = chunk;
        if (odd) {
          buf = Buffer.concat([odd, chunk]);
          odd = null;
        }
        const usable = buf.length - (buf.length % 2);
        if (usable < buf.length) odd = buf.subarray(usable);
        for (let i = 0; i < usable; i += 2) {
          const v = buf.readInt16LE(i) / 32768;
          const b = Math.min(buckets - 1, Math.floor(index / perBucket));
          if (!seen[b]) {
            seen[b] = 1;
            mins[b] = v;
            maxs[b] = v;
          } else {
            if (v < mins[b]) mins[b] = v;
            if (v > maxs[b]) maxs[b] = v;
          }
          index += 1;
        }
      });

      child.stderr.on('data', (d) => stderr.push(String(d)));
      child.on('error', reject);
      child.on('close', (code) => {
        if (cancelToken && cancelToken.cancelled) {
          reject(new ProcessCancelledError());
          return;
        }
        if (code !== 0 && index === 0) {
          reject(new Error(stderr.join('').trim() || 'ffmpeg could not read any audio.'));
          return;
        }
        const flat = new Array(buckets * 2);
        for (let b = 0; b < buckets; b += 1) {
          flat[b * 2] = Math.round(mins[b] * 1000) / 1000;
          flat[b * 2 + 1] = Math.round(maxs[b] * 1000) / 1000;
        }
        resolve(flat);
      });
    });
  }

  /**
   * A saved song's tags written anew (see tags.js): into `out`, a file
   * beside it that the caller then puts in its place. The audio is copied
   * untouched and the file keeps the tags it has (album, year ...), with
   * meta's names ({ title, artist, mix, sourceUrl }) and flowId over them.
   * picture: the cover to put in (a JPEG); null keeps the file's own.
   * Runs at low priority. Resolves true when written.
   */
  async function rewriteTags(file, out, { meta, flowId = '', picture = null }) {
    const exe = need(ffmpeg, 'ffmpeg');
    const ext = path.extname(file).slice(1).toLowerCase();
    const slow = { timeout: 5 * 60 * 1000 };
    if (!tags.ID_EXTS.has(ext)) {
      // WAV and the like: title and artist only, as when it was saved.
      const r = await ffmpegRun(exe, ['-i', file, '-map', '0:a:0', '-c', 'copy', ...tagArgs(meta, ext), out], slow);
      if (!r.ok) removeQuietly(out);
      return r.ok;
    }
    const info = await probeAudio(file);
    let image = tags.PICTURE_EXTS.has(ext) ? picture : null;
    if (!image && tags.PICTURE_EXTS.has(ext)) {
      // The picture the file has already, as it is.
      const r = await ffmpegRun(exe, ['-i', file, '-an', '-map', '0:v:0?', '-c:v', 'copy', '-frames:v', '1', '-f', 'image2pipe', '-']);
      image = r.ok && imageSize(r.stdout) ? r.stdout : null;
    }
    const ogg = tags.OGG_EXTS.has(ext);
    const png = !!image && image.readUInt32BE(0) === 0x89504e47;
    const metaFile = `${out}.ffmeta`;
    const pictureFile = image && !ogg ? `${out}.picture.${png ? 'png' : 'jpg'}` : null;
    try {
      const block = image && ogg ? tags.oggPictureBlock(image, imageSize(image) || {}) : '';
      fs.writeFileSync(metaFile, tags.ffmetadata(tags.mergedTags(info.tags, { ...meta, flowId }), block));
      if (pictureFile) fs.writeFileSync(pictureFile, image);
      const r = await ffmpegRun(exe, tags.retagArgs({ file, out, ext, metaFile, pictureFile }), slow);
      if (!r.ok) removeQuietly(out);
      return r.ok;
    } finally {
      removeQuietly(metaFile);
      if (pictureFile) removeQuietly(pictureFile);
    }
  }

  return {
    run, probeAudio, runFfmpeg, readJson, probe, probedFrom, prepare, download, prepareLocal, clearCache, cutSong, trimFile, peaksFor,
    rewriteTags,
  };
}

module.exports = {
  createMedia, probedFrom, ytDlpError, parseProgress, FORMAT_SELECTOR, ProcessCancelledError,
};
