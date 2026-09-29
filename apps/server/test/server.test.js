'use strict';

// A real server on a free port with its own folders: signing in, the library,
// commands, uploads and streaming with Range.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../src/server');
const configMod = require('../src/config');

// The fake songs below are no real audio: ffprobe would call them broken.
process.env.FLOW_SERVER_FFMPEG = 'off';

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-server-test-'));
  return { root, home: path.join(root, 'home'), music: path.join(root, 'music') };
}

async function withServer(fn, { password } = {}) {
  const dirs = tempDirs();
  if (password) {
    const c = configMod.open({ home: dirs.home, music: dirs.music });
    c.set({ password: configMod.hashPassword(password) });
  }
  const server = await startServer({ home: dirs.home, music: dirs.music, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await fn({ server, base, dirs });
  } finally {
    await server.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
}

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);

async function upload(base, id, meta, body = FAKE_MP3, headers = {}) {
  const r = await fetch(`${base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify(meta))}`, {
    method: 'PUT', body, headers,
  });
  return { status: r.status, json: await r.json() };
}

async function command(base, commands, headers = {}) {
  const r = await fetch(`${base}/api/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ commands }),
  });
  return r.json();
}

test('hello, an upload, and the library it ends up in', async () => {
  await withServer(async ({ base, dirs }) => {
    const hello = await (await fetch(`${base}/api/hello`)).json();
    assert.equal(hello.app, 'flow-server');
    assert.equal(hello.password, false);

    const up = await upload(base, 'abc123', {
      title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330, sourceUrl: 'https://youtu.be/u7K72X4eo_s',
    });
    assert.deepEqual(up.json, { existing: false, id: 'abc123', rev: 1 });
    assert.ok(fs.existsSync(path.join(dirs.music, 'Massive Attack - Teardrop.mp3')));

    const lib = await (await fetch(`${base}/api/library`)).json();
    assert.equal(lib.rev, 1);
    assert.equal(lib.library.songs[0].file, 'Massive Attack - Teardrop.mp3');
    assert.equal((await fetch(`${base}/api/library?since=1`)).status, 204);

    // The same source again is not stored twice.
    const again = await upload(base, 'zzz999', { title: 'Teardrop', format: 'mp3', sourceUrl: 'https://www.youtube.com/watch?v=u7K72X4eo_s' });
    assert.deepEqual(again.json, { existing: true, id: 'abc123', rev: 1 });
    assert.equal(fs.readdirSync(dirs.music).filter((f) => !f.startsWith('.')).length, 1);
  });
});

test('audio is streamed whole or in the part asked for, with CORS', async () => {
  await withServer(async ({ base }) => {
    await upload(base, 's1', { title: 'Windowlicker', artist: 'Aphex Twin', format: 'mp3' });
    const whole = await fetch(`${base}/api/songs/s1/audio`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'audio/mpeg');
    assert.equal(whole.headers.get('access-control-allow-origin'), '*');
    assert.equal((await whole.arrayBuffer()).byteLength, 1000);

    const part = await fetch(`${base}/api/songs/s1/audio`, { headers: { Range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], new Array(10).fill(7));

    const tail = await fetch(`${base}/api/songs/s1/audio`, { headers: { Range: 'bytes=-3' } });
    assert.equal(tail.headers.get('content-range'), 'bytes 997-999/1000');
    assert.equal((await fetch(`${base}/api/songs/s1/audio`, { headers: { Range: 'bytes=5000-' } })).status, 416);
    assert.equal((await fetch(`${base}/api/songs/nope/audio`)).status, 404);
  });
});

test('commands: edits rename the file, deletes go to the trash, repeats count once', async () => {
  await withServer(async ({ base, dirs }) => {
    await upload(base, 's1', { title: 'Windowlicker', artist: 'Aphex Twin', format: 'mp3' });
    const t = Date.now();
    const r1 = await command(base, [
      { cid: 'c1', at: t, type: 'createPlaylist', playlistId: 'p1', name: 'Night' },
      { cid: 'c2', at: t + 1, type: 'addSongsToPlaylist', playlistId: 'p1', songIds: ['s1'] },
      { cid: 'c3', at: t + 2, type: 'editSong', songId: 's1', artist: 'Aphex Twin', title: 'Xtal', mix: '' },
      { cid: 'c4', at: t + 3, type: 'addSong', song: { id: 'x' } },
    ]);
    assert.deepEqual(r1.results.map((r) => r.ok), [true, true, true, false]);
    assert.ok(fs.existsSync(path.join(dirs.music, 'Aphex Twin - Xtal.mp3')));
    assert.ok(!fs.existsSync(path.join(dirs.music, 'Aphex Twin - Windowlicker.mp3')));

    const repeat = await command(base, [{ cid: 'c1', at: t, type: 'createPlaylist', playlistId: 'p1', name: 'Night' }]);
    assert.equal(repeat.results[0].skipped, 'repeat');
    assert.equal(repeat.rev, r1.rev);

    // An edit made earlier (an app that was offline) loses to the one above.
    const stale = await command(base, [{ cid: 'c5', at: t - 50, type: 'editSong', songId: 's1', title: 'Old name' }]);
    assert.equal(stale.results[0].skipped, 'stale');

    await command(base, [{ cid: 'c6', at: t + 100, type: 'deleteSong', songId: 's1' }]);
    assert.ok(!fs.existsSync(path.join(dirs.music, 'Aphex Twin - Xtal.mp3')));
    assert.equal(fs.readdirSync(path.join(dirs.music, '.flow-trash')).length, 1);
    const lib = await (await fetch(`${base}/api/library`)).json();
    assert.equal(lib.library.songs.length, 0);
    assert.equal(lib.library.playlists[0].entries.length, 0);
  });
});

test('with a password only a signed-in device gets in', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await (await fetch(`${base}/api/hello`)).json()).password, true);
    assert.equal((await fetch(`${base}/api/library`)).status, 401);
    const wrong = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: '0000' }) });
    assert.equal(wrong.status, 401);
    // Straight after a wrong one: wait.
    const quick = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: '4711' }) });
    assert.equal(quick.status, 429);
    await new Promise((r) => setTimeout(r, 1100));
    const ok = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: '4711', device: 'Test PC' }) });
    const { token } = await ok.json();
    assert.ok(token);
    assert.equal((await fetch(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    await upload(base, 's1', { title: 'Xtal', format: 'mp3' }, FAKE_MP3, { Authorization: `Bearer ${token}` });
    assert.equal((await fetch(`${base}/api/songs/s1/audio?t=${token}`)).status, 200);
    assert.equal((await fetch(`${base}/api/songs/s1/audio?t=nope`)).status, 401);
  }, { password: '4711' });
});

test('songs dropped into the folder by hand are found, and dropped when deleted', async () => {
  await withServer(async ({ server, base, dirs }) => {
    const file = path.join(dirs.music, 'Portishead - Glory Box.mp3');
    fs.writeFileSync(file, FAKE_MP3);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file, old, old);
    const found = await (await fetch(`${base}/api/rescan`, { method: 'POST' })).json();
    assert.equal(found.added, 1);
    const song = server.library.data.songs[0];
    assert.equal(song.artist, 'Portishead');
    assert.equal(song.title, 'Glory Box');
    fs.rmSync(file);
    const gone = await (await fetch(`${base}/api/rescan`, { method: 'POST' })).json();
    assert.equal(gone.removed, 1);
  });
});
