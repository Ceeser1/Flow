'use strict';

// ffmpeg and ffprobe, when the machine has them (sudo apt install ffmpeg). The
// server works without: songs found in the folder by hand then get their
// names from the file name and no length until an app plays them, renamed
// songs keep their old tags, and loudness is left to the apps.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { parseLoudness, tagArgs } = require('@flow/core/tags');

function onPath(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir.trim()) continue;
    const candidate = path.join(dir.trim().replace(/^"|"$/g, ''), exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// FLOW_SERVER_FFMPEG=off runs without them even when they are there (the tests).
const found = {};
function find(name) {
  if (process.env.FLOW_SERVER_FFMPEG === 'off') return null;
  if (!(name in found)) found[name] = onPath(name);
  return found[name];
}

const ffmpeg = () => find('ffmpeg');
const ffprobe = () => find('ffprobe');

/** { duration, codec, tags } of an audio file; { duration: 0, tags: {} } without ffprobe. */
function probe(file) {
  return new Promise((resolve) => {
    const exe = ffprobe();
    if (!exe) return resolve({ duration: 0, codec: '', tags: {}, probed: false });
    execFile(exe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve({ duration: 0, codec: '', tags: {}, probed: true });
        try {
          const info = JSON.parse(stdout);
          const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
          const tags = {};
          for (const [k, v] of Object.entries((info.format && info.format.tags) || {})) tags[k.toLowerCase()] = v;
          resolve({
            duration: Number(info.format && info.format.duration) || 0,
            codec: audio ? audio.codec_name : '',
            tags,
            probed: true,
          });
        } catch {
          resolve({ duration: 0, codec: '', tags: {}, probed: true });
        }
      });
  });
}

function run(args, timeout = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const exe = ffmpeg();
    if (!exe) return resolve({ ok: false, stderr: '' });
    const proc = spawn(exe, ['-hide_banner', '-nostats', '-nostdin', '-y', ...args]);
    try {
      os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      // Normal priority then.
    }
    const err = [];
    const timer = setTimeout(() => proc.kill(), timeout);
    proc.stderr.on('data', (d) => err.push(String(d)));
    proc.on('error', () => resolve({ ok: false, stderr: '' }));
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr: err.join('') });
    });
  });
}

/** The song's loudness in LUFS, or null. */
async function measureLoudness(file) {
  const r = await run(['-i', file, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']);
  return parseLoudness(r.stderr);
}

/** Writes new tags into a file (through a copy beside it). Resolves true when done. */
async function retag(file, meta) {
  if (!ffmpeg()) return false;
  const ext = path.extname(file).slice(1).toLowerCase();
  const tmp = path.join(path.dirname(file), `.flow-retag-${Date.now()}.${ext}`);
  const r = await run(['-i', file, '-map', '0:a:0', '-c', 'copy', ...tagArgs(meta, ext), tmp]);
  if (!r.ok) {
    fs.rmSync(tmp, { force: true });
    return false;
  }
  fs.renameSync(tmp, file);
  return true;
}

module.exports = { ffmpeg, ffprobe, probe, measureLoudness, retag, onPath };
