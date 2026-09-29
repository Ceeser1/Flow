'use strict';

// Audio peaks for the trim editor's waveform, adapted from LWClipper's
// src/waveform.js. ffmpeg decodes the audio to 8 kHz mono and every bucket keeps
// only its lowest and highest sample, so the renderer gets a few tens of KB
// however long the song is. Only one song is ever in the editor, so there is no
// cache: loading another song kills the analysis in flight.

const { spawn } = require('child_process');
const tools = require('./tools');

const RATE = 8000;
const BUCKETS = 6400;

let currentChild = null;

function abort() {
  if (!currentChild) return;
  try {
    currentChild.kill();
  } catch {
    // Already gone.
  }
  currentChild = null;
}

/** Flat [min0, max0, min1, max1, ...] for the file, values -1..1. */
function peaksFor(filePath, duration) {
  abort();
  return new Promise((resolve, reject) => {
    const ffmpeg = tools.findFfmpeg();
    if (!ffmpeg) return reject(new Error('ffmpeg.exe was not found. Please reinstall Flow.'));

    const totalSamples = Math.max(1, Math.round(duration * RATE));
    const buckets = Math.max(1, Math.min(BUCKETS, totalSamples));
    const perBucket = Math.max(1, Math.ceil(totalSamples / buckets));
    const mins = new Float32Array(buckets);
    const maxs = new Float32Array(buckets);
    const seen = new Uint8Array(buckets);

    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', filePath,
      '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-',
    ], { windowsHide: true });
    currentChild = child;

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
      if (currentChild === child) currentChild = null;
      if (code !== 0 && index === 0) {
        return reject(new Error(stderr.join('').trim() || 'ffmpeg could not read any audio.'));
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

module.exports = { peaksFor, abort };
