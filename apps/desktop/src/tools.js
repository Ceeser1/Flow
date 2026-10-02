'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const paths = require('./paths');
const settings = require('./settings');

function onPath(exeName) {
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (!entry.trim()) continue;
    const candidate = path.join(entry.trim().replace(/^"|"$/g, ''), exeName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function bundled(exeName) {
  const file = path.join(paths.bundledToolsDir(), exeName);
  if (fs.existsSync(file)) return file;
  return onPath(exeName);
}

const findFfmpeg = () => bundled('ffmpeg.exe');
const findFfprobe = () => bundled('ffprobe.exe');

function localYtDlp() {
  return path.join(paths.localToolsDir(), 'yt-dlp.exe');
}

/** The updatable copy when there is one, otherwise the bundled yt-dlp. */
function findYtDlp() {
  const local = localYtDlp();
  if (fs.existsSync(local)) return local;
  return bundled('yt-dlp.exe');
}

function run(exe, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function versionOf(exe) {
  if (!exe || !fs.existsSync(exe)) return '';
  const r = await run(exe, ['--version'], 30000);
  return r.ok ? r.stdout.trim() : '';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * YouTube changes often enough that a yt-dlp more than a few weeks old stops
 * working. The installed copy cannot update itself inside Program Files, so
 * the first run copies it to %LOCALAPPDATA%\Flow\tools, and from then on
 * that copy runs `yt-dlp -U` at most once a day, in the background. A newer
 * bundled copy (after installing a new Flow) replaces an older local one.
 * Never throws: a failed update just leaves the working copy in place.
 */
async function refreshYtDlp() {
  try {
    const shipped = bundled('yt-dlp.exe');
    const local = localYtDlp();
    if (shipped && shipped !== local) {
      const [shippedVer, localVer] = await Promise.all([versionOf(shipped), versionOf(local)]);
      // yt-dlp versions are dates (2026.08.19), so they compare as text.
      if (!localVer || (shippedVer && shippedVer > localVer)) {
        fs.copyFileSync(shipped, local);
      }
    }
    if (!fs.existsSync(local)) return;
    if (Date.now() - (settings.get('ytDlpCheckedAt') || 0) < DAY_MS) return;
    settings.set({ ytDlpCheckedAt: Date.now() });
    await run(local, ['-U'], 180000);
  } catch {
    // Offline, blocked, or a scanner holding the file. Try again tomorrow.
  }
}

function status() {
  return {
    ffmpeg: !!findFfmpeg(),
    ffprobe: !!findFfprobe(),
    ytDlp: !!findYtDlp(),
  };
}

module.exports = { findFfmpeg, findFfprobe, findYtDlp, refreshYtDlp, status };
