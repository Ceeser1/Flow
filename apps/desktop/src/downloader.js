'use strict';

// Link -> audio file in the cache, in three steps the progress frame shows:
//   1. probe:    yt-dlp -j reads the title, length and source id.
//   2. download: yt-dlp fetches the best audio the site has, as it is.
//   3. prepare:  ffmpeg keeps, lifts out or converts it (see formats.js).
// Download and prepare are adapted from LWClipper's src/ytdlp.js.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const tools = require('./tools');
const { runProcess, ProcessCancelledError } = require('./processRunner');
const { runFfmpeg } = require('./ffmpeg');
const { normalizeUrl, sourceKey, safeFilename } = require('@flow/core/text');
const { guessFromInfo } = require('@flow/core/titleParser');
const { planFor, ffmpegArgsFor } = require('@flow/core/formats');

// Best audio, but not YouTube's "-drc" copies: those have their dynamic range
// squashed for loudness normalisation and sound flatter than the original.
const FORMAT_SELECTOR = 'bestaudio[format_id!*=-drc]/bestaudio/best';

const PROGRESS_RE = /^FLOW_DL\t([\d.]+|NA)\t([\d.]+|NA)\t([\d.]+|NA)\t([\d.]+|NA)$/;

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
  if (/Sign in to confirm your age/i.test(text)) return 'This video is age restricted and needs a signed-in account.';
  if (/getaddrinfo|Failed to resolve|Unable to download webpage.*(timed out|Errno)/i.test(text)) {
    return 'Could not reach the site. Please check the internet connection.';
  }
  return text || 'yt-dlp could not read this link.';
}

function requireTools() {
  const ytdlp = tools.findYtDlp();
  const ffmpeg = tools.findFfmpeg();
  if (!ytdlp) throw new Error('yt-dlp.exe was not found. Please reinstall Flow.');
  if (!ffmpeg) throw new Error('ffmpeg.exe was not found. Please reinstall Flow.');
  return { ytdlp, ffmpeg };
}

/** Runs yt-dlp with `args` and parses the JSON it prints. */
async function readJson(args, cancelToken) {
  const { ytdlp } = requireTools();
  let out = '';
  const result = await runProcess(ytdlp, ['--no-warnings', ...args], (line) => {
    if (!out && line.trim().startsWith('{')) out = line.trim();
  }, cancelToken);
  if (result.exitCode !== 0 && !out) throw new Error(ytDlpError(result.stderrTail));
  try {
    return JSON.parse(out);
  } catch {
    throw new Error('Could not read this link.');
  }
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
  };
}

/**
 * Reads one song's link without downloading it. A link into a playlist is read
 * as that one song (or the first entry), never as the whole list: whole lists
 * go through importer.js.
 */
async function probe(rawUrl, cancelToken, { knownArtists = [] } = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error('That does not look like a link.');
  const info = await readJson(['--no-playlist', '-I', '1', '-j', url], cancelToken);
  return probedFrom(info, url, rawUrl, knownArtists);
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

/**
 * Downloads and prepares one song. onProgress(stage, frac, text) where stage is
 * 'download' | 'prepare' and frac is 0..1, or null when unknown. Resolves
 * { path, duration, ext, source, target, action, summary }.
 */
async function download(probed, opts, onProgress, cancelToken) {
  const { ytdlp, ffmpeg } = requireTools();
  const report = (stage, frac, text) => {
    if (onProgress) onProgress(stage, frac, text);
  };
  const dir = paths.cacheDir();
  const stem = safeFilename(probed.key || 'download', 80).replace(/[^A-Za-z0-9_.-]+/g, '_');
  for (const f of filesStartingWith(dir, stem + '.')) removeQuietly(path.join(dir, f));

  try {
    return await fetchAndPrepare(probed, opts, report, cancelToken, { ytdlp, ffmpeg, dir, stem });
  } catch (err) {
    // Cancelled or failed: nothing of this download is worth keeping.
    for (const f of filesStartingWith(dir, stem + '.')) removeQuietly(path.join(dir, f));
    throw err;
  }
}

async function fetchAndPrepare(probed, opts, report, cancelToken, { ytdlp, ffmpeg, dir, stem }) {
  report('download', null, 'Starting download...');
  const result = await runProcess(ytdlp, [
    '--no-warnings', '--no-playlist', '-I', '1',
    '-f', FORMAT_SELECTOR,
    '--ffmpeg-location', path.dirname(ffmpeg),
    '-o', path.join(dir, `${stem}.src.%(ext)s`),
    '--newline',
    '--progress-template',
    'download:FLOW_DL\t%(progress.downloaded_bytes)s\t%(progress.total_bytes_estimate)s\t%(progress.speed)s\t%(progress.eta)s',
    '--retries', '5', '--fragment-retries', '5', '--concurrent-fragments', '4',
    '--force-overwrites',
    probed.url,
  ], (line) => {
    const m = PROGRESS_RE.exec(line);
    if (!m) return;
    const got = parseNum(m[1]);
    const total = parseNum(m[2]);
    const frac = (got !== null && total) ? Math.min(1, got / total) : null;
    report('download', frac, downloadStatusLine(got, total, parseNum(m[3]), parseNum(m[4])));
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
 * Keeps, lifts out or converts `src` into `outStem.<ext>` (see formats.js).
 * `src` itself is left alone. Resolves { media, info } where info is what
 * ffprobe said about `src`.
 */
async function prepare(src, outStem, opts, report, cancelToken, { duration: guess = 0, lead = '', noAudio }) {
  const info = await tools.probeAudio(src);
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

  const final = await tools.probeAudio(out);
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

/**
 * A file from the computer ("Open local File(s) / Folder"), prepared into the
 * cache like a download, so it can be previewed, trimmed and saved the same
 * way. The original is not touched. Resolves { media, tags }.
 */
async function prepareLocal(file, opts, onProgress, cancelToken) {
  const dir = paths.cacheDir();
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
  const dir = paths.cacheDir();
  for (const f of filesStartingWith(dir, '')) removeQuietly(path.join(dir, f));
}

module.exports = { probe, probedFrom, readJson, download, prepareLocal, clearCache, ProcessCancelledError };
