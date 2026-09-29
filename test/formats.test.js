'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planFor, ffmpegArgsFor, describeSource, estimateMb, clampQuality } = require('../src/formats');

const plan = (codec, formatName, opts) => planFor({ codec, formatName, bitRate: 160000 }, opts);

test('lossy formats that play are copied into their own container', () => {
  assert.deepEqual([plan('opus', 'webm').action, plan('opus', 'webm').ext], ['copy', 'opus']);
  assert.deepEqual([plan('aac', 'mov,mp4,m4a').action, plan('aac', 'mov,mp4,m4a').ext], ['copy', 'm4a']);
  assert.equal(plan('vorbis', 'ogg').ext, 'ogg');
  assert.equal(plan('mp3', 'mp3').ext, 'mp3');
  assert.equal(plan('flac', 'flac').ext, 'flac');
});

test('WAV is kept, AIFF and ALAC become FLAC', () => {
  assert.deepEqual([plan('pcm_s16le', 'wav').action, plan('pcm_s16le', 'wav').ext], ['copy', 'wav']);
  assert.deepEqual([plan('pcm_s16be', 'aiff').action, plan('pcm_s16be', 'aiff').ext], ['flac', 'flac']);
  assert.equal(plan('alac', 'mov,mp4,m4a').action, 'flac');
  assert.equal(plan('wavpack', 'wv').action, 'flac');
});

test('anything unknown becomes MP3 at the chosen quality, 192 by default', () => {
  const p = plan('wmav2', 'asf');
  assert.equal(p.action, 'mp3');
  assert.equal(p.bitrate, 192);
  assert.equal(plan('ac3', 'ac3', { quality: 320 }).bitrate, 320);
});

test('Always convert to MP3 converts everything except MP3 itself', () => {
  const opts = { alwaysMp3: true, quality: 128 };
  assert.equal(plan('opus', 'webm', opts).action, 'mp3');
  assert.equal(plan('opus', 'webm', opts).bitrate, 128);
  assert.equal(plan('pcm_s16le', 'wav', opts).action, 'mp3');
  assert.equal(plan('flac', 'flac', opts).action, 'mp3');
  assert.equal(plan('mp3', 'mp3', opts).action, 'copy');
});

test('quality outside the list falls back to 192', () => {
  assert.equal(clampQuality(100), 192);
  assert.equal(clampQuality('256'), 256);
});

test('ffmpeg arguments', () => {
  assert.ok(ffmpegArgsFor(plan('aac', 'mp4')).includes('+faststart'));
  assert.deepEqual(ffmpegArgsFor(plan('wmav2', 'asf')).slice(-4), ['-c:a', 'libmp3lame', '-b:a', '192k']);
  assert.ok(ffmpegArgsFor(plan('alac', 'mp4')).includes('flac'));
});

test('source descriptions', () => {
  assert.equal(describeSource('opus', 'webm', 159800), 'Opus ~160 kbit/s');
  assert.equal(describeSource('pcm_s24le', 'wav', 0), 'WAV (lossless)');
  assert.equal(describeSource('pcm_s16be', 'aiff', 0), 'AIFF (lossless)');
});

test('size estimate: 192 kbit/s for 3:30 is about 5 MB', () => {
  assert.equal(estimateMb(192, 210).toFixed(1), '5.0');
});
