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
    // Songs that were there before are not written by themselves (flow-server tag-songs does that).
    assert.equal(songs.Teardrop.tagged, null);
    const full = (id) => server.library.data.songs.find((s) => s.id === id).file;
    assert.equal(tagsOf(full(songs.Teardrop.id)).flowid, undefined);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/** A file's tags (lower-case keys) and whether it carries a picture. */
function tagsOf(file) {
  const info = JSON.parse(execFileSync(path.join(tools, `ffprobe${EXE}`), ['-v', 'error',
    '-show_entries', 'format_tags:stream=codec_type:stream_disposition=attached_pic', '-of', 'json', file]));
  const out = {};
  for (const [k, v] of Object.entries((info.format || {}).tags || {})) out[k.toLowerCase()] = v;
  out.picture = (info.streams || []).some((s) => s.disposition && s.disposition.attached_pic);
  return out;
}

test('a new song\'s file gets the server\'s flowid and its cover once found; a rename keeps both', needs, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-tags-job-'));
  const topic = path.join(root, 'topic.jpg');
  run(['-f', 'lavfi', '-i', 'color=c=0x3c3526:s=1280x720[bg];testsrc=s=720x720[fg];[bg][fg]overlay=280:0', '-frames:v', '1', topic]);
  const song = path.join(root, 'song.mp3');
  run(['-f', 'lavfi', '-i', 'sine=d=2', '-metadata', 'title=Glory Box', '-metadata', 'album=Dummy', song]);
  const coverDeps = {
    fetchImage: async () => fs.readFileSync(topic),
    readInfo: async () => { throw new Error('not available'); },
    searchMusic: async (track) => [{ id: 'CCCCCCCCCCC', title: track.title, duration: track.duration }],
    pauseMs: 0,
  };
  const server = await startServer({
    home: path.join(root, 'home'), music: path.join(root, 'music'), port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null, coverDeps,
  });
  const base = `http://127.0.0.1:${server.port}`;
  // The library as the server holds it (the apps get the files' names only).
  const songOf = async (id) => server.library.data.songs.find((s) => s.id === id);
  try {
    const meta = { title: 'Glory Box', artist: 'Portishead', format: 'mp3', duration: 2 };
    const put = await fetch(`${base}/api/songs/g1?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: 'PUT', body: fs.readFileSync(song) });
    assert.equal(put.status, 200);
    // The search waits a moment for an app's own cover (5 s), then finds one; then the file is written.
    const done = await waitFor(async () => {
      const s = await songOf('g1');
      return s && s.cover && s.tagged === s.cover && s;
    }, 'the tags', 30000);
    const id = server.config.get().id;
    let t = tagsOf(done.file);
    assert.equal(t.flowid, `${id}:g1`);
    assert.equal(t.title, 'Glory Box');
    assert.equal(t.artist, 'Portishead');
    assert.equal(t.album, 'Dummy');
    assert.equal(t.picture, true);

    const r = await fetch(`${base}/api/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ cid: 'e1', at: Date.now(), type: 'editSong', songId: 'g1', artist: 'Portishead', title: 'Roads', mix: 'Live' }] }),
    });
    assert.equal(r.status, 200);
    const renamed = await waitFor(async () => {
      const s = await songOf('g1');
      return s && /Roads/.test(s.file) && fs.existsSync(s.file) && tagsOf(s.file).title === 'Roads' && s;
    }, 'the rename');
    t = tagsOf(renamed.file);
    assert.equal(t.mix, 'Live');
    assert.equal(t.flowid, `${id}:g1`);
    assert.equal(t.album, 'Dummy');
    assert.equal(t.picture, true);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('tag-songs writes the songs from before; a file moved by hand keeps its song by its flowid, a copy is a song of its own', needs, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-relink-'));
  const home = path.join(root, 'home');
  const music = path.join(root, 'music');
  fs.mkdirSync(music, { recursive: true });
  run(['-f', 'lavfi', '-i', 'sine=d=2', '-metadata', 'title=Unfinished Sympathy', '-metadata', 'artist=Massive Attack', path.join(music, 'a.mp3')]);
  run(['-f', 'lavfi', '-i', 'sine=d=2', '-metadata', 'title=Safe From Harm', '-metadata', 'artist=Massive Attack', path.join(music, 'b.mp3')]);
  const settle = (file) => {
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file, old, old);
  };
  for (const f of fs.readdirSync(music)) settle(path.join(music, f));
  const coverDeps = {
    fetchImage: async () => { throw new Error('HTTP 404'); },
    readInfo: async () => { throw new Error('not available'); },
    searchMusic: async () => [],
    pauseMs: 0,
  };
  const cli = (...args) => execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'main.js'), ...args, '--home', home, '--music', music], { encoding: 'utf8' });
  const server = await startServer({ home, music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null, coverDeps });
  const base = `http://127.0.0.1:${server.port}`;
  const byTitle = () => Object.fromEntries(server.library.data.songs.map((s) => [s.title, s]));
  try {
    await waitFor(() => server.library.data.songs.length === 2 && server.library.data.songs.every((s) => s.cover), 'the covers looked for');
    assert.ok(server.library.data.songs.every((s) => s.tagged === null));

    const dry = cli('tag-songs', '--dry-run');
    assert.match(dry, /a\.mp3/);
    assert.match(dry, /2 files would get/);
    assert.equal(server.library.data.songs.every((s) => s.tagged === null), true, 'a dry run changes nothing');
    assert.match(cli('tag-songs'), /2 files get/);
    // The running server takes it within a few seconds.
    await waitFor(() => server.library.data.songs.every((s) => s.tagged === '-'), 'the songs written', 30000);
    const id = server.config.get().id;
    const { 'Unfinished Sympathy': one, 'Safe From Harm': two } = byTitle();
    assert.equal(tagsOf(one.file).flowid, `${id}:${one.id}`);
    assert.equal(tagsOf(two.file).flowid, `${id}:${two.id}`);
    assert.equal(server.config.get().tagSongs, false);
    assert.match(cli('tag-songs'), /Nothing to write/);

    // Moved into a folder and shortened: no longer the same length, found by its flowid only.
    fs.mkdirSync(path.join(music, 'Bristol'));
    const moved = path.join(music, 'Bristol', 'Moved.mp3');
    run(['-i', one.file, '-t', '1', '-c', 'copy', moved]);
    fs.rmSync(one.file);
    // A copy beside its song, and a file from another library.
    const copy = path.join(music, 'b copy.mp3');
    fs.copyFileSync(two.file, copy);
    const foreign = path.join(music, 'c.mp3');
    run(['-f', 'lavfi', '-i', 'sine=d=3', '-metadata', 'title=Teardrop', '-metadata', `flowid=ffffffffffffffffffffffff:${one.id}`, foreign]);
    for (const f of [moved, copy, foreign]) settle(f);

    const r = await (await fetch(`${base}/api/rescan`, { method: 'POST' })).json();
    assert.deepEqual([r.added, r.removed, r.moved], [2, 0, 1]);
    const now = byTitle();
    assert.equal(now['Unfinished Sympathy'].id, one.id);
    assert.equal(now['Unfinished Sympathy'].file, moved);
    const copies = server.library.data.songs.filter((s) => s.title === 'Safe From Harm');
    assert.equal(copies.length, 2);
    const theCopy = copies.find((s) => s.file === copy);
    assert.notEqual(theCopy.id, two.id);
    assert.equal(theCopy.tagged, '', 'the copy gets a flowid of its own');
    assert.equal(now.Teardrop.tagged, null, 'another library\'s file is left as it is');
    await waitFor(() => server.library.data.songs.find((s) => s.id === theCopy.id).tagged === '-', 'the copy written', 30000);
    assert.equal(tagsOf(copy).flowid, `${id}:${theCopy.id}`);
    assert.equal(tagsOf(two.file).flowid, `${id}:${two.id}`);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
