'use strict';

// Uploads converted into MP3 by the server (library.js), with real ffmpeg:
// the app's "Upload songs to the server as MP3" choice (meta.convert), Ogg
// Vorbis always, only once the batch is in, and on after a restart. Skipped
// without ffmpeg (the desktop app's bundled one, or one on the PATH).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer } = require('../src/server');

const EXE = process.platform === 'win32' ? '.exe' : '';

function ffmpegDir() {
  const bundled = path.join(__dirname, '..', '..', 'desktop', 'tools');
  if (fs.existsSync(path.join(bundled, `ffmpeg${EXE}`)) && fs.existsSync(path.join(bundled, `ffprobe${EXE}`))) return bundled;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, `ffmpeg${EXE}`)) && fs.existsSync(path.join(dir, `ffprobe${EXE}`))) return dir;
  }
  return null;
}

const tools = ffmpegDir();
process.env.FLOW_SERVER_FFMPEG = tools || 'off';
process.env.FLOW_SERVER_YTDLP = 'off';
const needs = { skip: !tools && 'no ffmpeg' };

function make(file, codec) {
  execFileSync(path.join(tools, `ffmpeg${EXE}`), ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=f=440:d=2', ...codec, file]);
  return fs.readFileSync(file);
}

/** Codec and bit rate (kbit/s) of a file. */
function probe(file) {
  const out = JSON.parse(execFileSync(path.join(tools, `ffprobe${EXE}`), ['-v', 'error',
    '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,bit_rate', '-of', 'json', file]));
  return { codec: out.streams[0].codec_name, kbps: Math.round(Number(out.streams[0].bit_rate) / 1000) };
}

async function waitFor(fn, what, ms = 20000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function upload(base, id, meta, body) {
  const r = await fetch(`${base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: 'PUT', body });
  return { status: r.status, json: await r.json() };
}

function start(root, convertQuietMs) {
  return startServer({
    home: path.join(root, 'home'), music: path.join(root, 'music'), port: 0, host: '127.0.0.1',
    detectTailscale: async () => null, discoveryPort: null, convertQuietMs,
    coverDeps: { fetchImage: async () => { throw new Error('HTTP 404'); }, readInfo: async () => { throw new Error('no'); }, searchMusic: async () => [], pauseMs: 0 },
  });
}

test('uploads become MP3 after the batch: by the app\'s choice, Ogg Vorbis always', needs, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-convert-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  const flac = make(path.join(src, 'a.flac'), ['-c:a', 'flac']);
  const vorbis = make(path.join(src, 'b.ogg'), ['-c:a', 'libvorbis']);
  const mp3 = make(path.join(src, 'c.mp3'), ['-c:a', 'libmp3lame', '-b:a', '256k']);
  const m4a = make(path.join(src, 'd.m4a'), ['-c:a', 'aac']);
  const server = await start(root, 1500);
  const base = `http://127.0.0.1:${server.port}`;
  const song = (id) => server.library.data.songs.find((s) => s.id === id);
  try {
    const phone = { alwaysMp3: true, quality: 128, keepMp3: true };
    assert.equal((await upload(base, 'flac1', { title: 'Porcelain', artist: 'Moby', format: 'flac', duration: 2, convert: phone }, flac)).status, 200);
    // Not yet: the batch is still coming in.
    assert.equal(song('flac1').format, 'flac');
    assert.equal((await upload(base, 'ogg1', { title: 'Windowlicker', artist: 'Aphex Twin', format: 'ogg', duration: 2 }, vorbis)).status, 200);
    assert.equal((await upload(base, 'mp31', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 2, convert: phone }, mp3)).status, 200);
    assert.equal((await upload(base, 'm4a1', { title: 'Angel', artist: 'Massive Attack', format: 'm4a', duration: 2 }, m4a)).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'home', 'convert-queue.json')));
    assert.equal(song('flac1').format, 'flac');

    await waitFor(() => song('flac1').format === 'mp3' && song('ogg1').format === 'mp3', 'the conversions');
    // The phone's 128 kbit/s; Vorbis from an app without a choice at 192.
    assert.deepEqual(probe(song('flac1').file), { codec: 'mp3', kbps: 128 });
    assert.equal(path.basename(song('flac1').file), 'Moby - Porcelain.mp3');
    assert.deepEqual(probe(song('ogg1').file), { codec: 'mp3', kbps: 192 });
    // An MP3 with "Ignore files already in .mp3", and an M4A without a choice: as they came.
    assert.equal(song('mp31').format, 'mp3');
    assert.equal(probe(song('mp31').file).kbps, 256);
    assert.equal(song('m4a1').format, 'm4a');
    // The originals in the trash, the queue done, and the files tagged anew.
    const trash = fs.readdirSync(path.join(root, 'music', '.flow-trash'));
    assert.ok(trash.some((f) => f.endsWith('Moby - Porcelain.flac')));
    assert.ok(trash.some((f) => f.endsWith('Aphex Twin - Windowlicker.ogg')));
    await waitFor(() => !fs.existsSync(path.join(root, 'home', 'convert-queue.json')), 'the queue to be done');
    const lib = (await (await fetch(`${base}/api/library`)).json()).library;
    assert.equal(lib.songs.find((s) => s.id === 'flac1').format, 'mp3');
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('uploads still to convert carry on after a restart', needs, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-convert-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const wav = make(path.join(root, 'src', 'a.wav'), ['-c:a', 'pcm_s16le']);
  let server = await start(root, 60000);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await upload(base, 'wav1', { title: 'Avril 14th', artist: 'Aphex Twin', format: 'wav', duration: 2, convert: { alwaysMp3: true, quality: 160 } }, wav)).status, 200);
    await server.close();
    server = await start(root, 60000);
    // Nothing coming in after a restart: on with it at once.
    const song = () => server.library.data.songs.find((s) => s.id === 'wav1');
    await waitFor(() => song().format === 'mp3', 'the conversion after the restart');
    assert.deepEqual(probe(song().file), { codec: 'mp3', kbps: 160 });
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
