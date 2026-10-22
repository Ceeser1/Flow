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

/** A tool's file name: ffmpeg.exe on Windows, plain ffmpeg elsewhere. */
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

const findFfmpeg = () => bundled(exe('ffmpeg'));
const findFfprobe = () => bundled(exe('ffprobe'));

// yt-dlp is not shipped with Flow: whoever wants to download puts it into
// Flow's tools folder (%LOCALAPPDATA%\Flow\tools) themselves; Add Songs'
// "Downloads?" says how. On Linux its release file is yt-dlp_linux (plain
// yt-dlp, which needs Python, is taken too), and a file downloaded is not yet
// allowed to run: Flow allows it.
function ytDlpNames() {
  return process.platform === 'linux' ? ['yt-dlp', 'yt-dlp_linux'] : [exe('yt-dlp')];
}

function runnable(file) {
  if (process.platform === 'win32') return;
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      // Left as it is: running it says why.
    }
  }
}

/** yt-dlp(.exe) in Flow's tools folder, or null. */
function findYtDlp() {
  for (const name of ytDlpNames()) {
    const local = path.join(paths.localToolsDir(), name);
    if (fs.existsSync(local)) {
      runnable(local);
      return local;
    }
  }
  return null;
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
    const local = findYtDlp();
    if (!local) return;
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

/** Flow's tools folder, where yt-dlp(.exe) goes. */
const toolsDir = () => paths.localToolsDir();

module.exports = { exe, findFfmpeg, findFfprobe, findYtDlp, refreshYtDlp, status, toolsDir };
