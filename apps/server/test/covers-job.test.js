'use strict';

// The server finding covers by itself (library.js), with real ffmpeg and
// real songs in the music folder; the web and YouTube Music are fakes. Skipped
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
const ffmpeg = tools && path.join(tools, `ffmpeg${EXE}`);
const needs = { skip: !tools && 'no ffmpeg' };

function run(args) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
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

test('songs without a cover get one: their thumbnail, the picture in the file, else none', needs, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-covers-job-'));
  const music = path.join(root, 'music');
  fs.mkdirSync(music, { recursive: true });
  const topic = path.join(root, 'topic.jpg');
  run(['-f', 'lavfi', '-i', 'color=c=0x3c3526:s=1280x720[bg];testsrc=s=720x720[fg];[bg][fg]overlay=280:0', '-frames:v', '1', topic]);
  const tone = ['-f', 'lavfi', '-i', 'sine=d=1'];
  run([...tone, '-metadata', 'title=Teardrop', '-metadata', 'artist=Massive Attack',
    '-metadata', 'comment=https://www.youtube.com/watch?v=AAAAAAAAAAA', path.join(music, 'a.mp3')]);
  run([...tone, '-i', topic, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata', 'title=Angel', '-metadata', 'artist=Massive Attack', path.join(music, 'b.mp3')]);
  run([...tone, '-metadata', 'title=Nothing', '-metadata', 'artist=Nobody', path.join(music, 'c.mp3')]);
  run([...tone, '-metadata', 'title=Away', '-metadata', 'comment=https://www.youtube.com/watch?v=BBBBBBBBBBB', path.join(music, 'd.mp3')]);
  // Older than the scan's wait for files still being copied in.
  const old = new Date(Date.now() - 60000);
  for (const f of fs.readdirSync(music)) fs.utimesSync(path.join(music, f), old, old);

  const asked = [];
  const coverDeps = {
    async fetchImage(url) {
      asked.push(url);
      if (url.includes('AAAAAAAAAAA')) return fs.readFileSync(topic);
      if (url.includes('BBBBBBBBBBB')) throw new Error('fetch failed');
      throw new Error('HTTP 404');
    },
    readInfo: async () => { throw new Error('not available'); },
    searchMusic: async () => [],
    pauseMs: 0,
  };
  const server = await startServer({
    home: path.join(root, 'home'), music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null, coverDeps,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const byTitle = async () => {
      const lib = (await (await fetch(`${base}/api/library`)).json()).library;
      return Object.fromEntries(lib.songs.map((s) => [s.title, s]));
    };
    const songs = await waitFor(async () => {
      const s = await byTitle();
      return s.Teardrop && s.Teardrop.cover && s.Angel && s.Angel.cover && s.Nothing && s.Nothing.cover && s;
    }, 'the covers');
    assert.match(songs.Teardrop.cover, /^[0-9a-f]{10}$/);
    assert.match(songs.Angel.cover, /^[0-9a-f]{10}$/);
    assert.equal(songs.Nothing.cover, '-');
    // Could not be reached: not marked, tried again at the next start.
    assert.equal(songs.Away.cover, null);
    assert.ok(asked.some((u) => u.includes('BBBBBBBBBBB')));

    const got = await fetch(`${base}/api/songs/${songs.Teardrop.id}/cover`);
    assert.equal(got.status, 200);
    const jpeg = Buffer.from(await got.arrayBuffer());
    assert.equal(jpeg[0], 0xff);
    assert.equal(jpeg[1], 0xd8);
    assert.deepEqual(server.library.coverCounts(), { total: 4, have: 2, todo: 1 });
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
