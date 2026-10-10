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

// yt-dlp is not shipped with Flow: whoever wants to download puts it into
// Flow's tools folder (%LOCALAPPDATA%\Flow\tools) themselves; Add Songs'
// "Downloads?" says how.
function localYtDlp() {
  return path.join(paths.localToolsDir(), 'yt-dlp.exe');
}

/** yt-dlp.exe in Flow's tools folder, or null. */
function findYtDlp() {
  const local = localYtDlp();
  return fs.existsSync(local) ? local : null;
}

function run(exe, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * YouTube changes often enough that a yt-dlp more than a few weeks old stops
 * working: the one in the tools folder runs `yt-dlp -U` at most once a day,
 * in the background. Never throws: a failed update just leaves the working
 * copy in place.
 */
async function refreshYtDlp() {
  try {
    const local = localYtDlp();
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

/** Flow's tools folder, where yt-dlp.exe goes. */
const toolsDir = () => paths.localToolsDir();

module.exports = { findFfmpeg, findFfprobe, findYtDlp, refreshYtDlp, status, toolsDir };
