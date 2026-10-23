'use strict';

// A song's lyrics (4.0): looked up once per song, kept in <home>/lyrics.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../src/server');

process.env.FLOW_SERVER_FFMPEG = 'off';

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);

test('the lyrics of a song, looked up once, again when it is renamed; LRCLIB out of reach', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-lyrics-test-'));
  const asked = [];
  let down = false;
  const server = await startServer({
    home: path.join(root, 'home'),
    music: path.join(root, 'music'),
    port: 0,
    host: '127.0.0.1',
    detectTailscale: async () => null,
    discoveryPort: null,
    lookupLyrics: async (song) => {
      asked.push(song.title);
      if (down) throw new TypeError('fetch failed');
      if (song.title === 'Porcelain') return { found: true, synced: [{ t: 12.5, text: 'In my dreams' }], plain: 'In my dreams', instrumental: false };
      return { found: false, synced: null, plain: '', instrumental: false };
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const get = async (route) => {
    const r = await fetch(`${base}${route}`);
    return { status: r.status, json: await r.json() };
  };
  try {
    const hello = (await get('/api/hello')).json;
    assert.ok(hello.features.includes('lyrics'));
    const meta = { title: 'Porcelain', artist: 'Moby', format: 'mp3', duration: 241 };
    await fetch(`${base}/api/songs/aaa111?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: 'PUT', body: FAKE_MP3 });
    const first = await get('/api/songs/aaa111/lyrics');
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.lyrics.synced, [{ t: 12.5, text: 'In my dreams' }]);
    await get('/api/songs/aaa111/lyrics');
    assert.deepEqual(asked, ['Porcelain'], 'kept after the first time');
    assert.ok(fs.existsSync(path.join(root, 'home', 'lyrics', 'aaa111.json')));
    // Renamed: looked up again (none found, which is kept too).
    await fetch(`${base}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ cid: 'r1', at: Date.now(), type: 'editSong', songId: 'aaa111', artist: 'Moby', title: 'Natural Blues' }] }),
    });
    assert.equal((await get('/api/songs/aaa111/lyrics')).json.lyrics.found, false);
    await get('/api/songs/aaa111/lyrics');
    assert.deepEqual(asked, ['Porcelain', 'Natural Blues']);
    assert.equal((await get('/api/songs/nope/lyrics')).status, 404);
    // LRCLIB out of reach: said, nothing kept.
    fs.rmSync(path.join(root, 'home', 'lyrics'), { recursive: true });
    down = true;
    const failed = await get('/api/songs/aaa111/lyrics');
    assert.equal(failed.status, 502);
    assert.match(failed.json.error, /LRCLIB/);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the filler: every song\'s lyrics in the background, once each; again when renamed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-lyrics-test-'));
  const asked = [];
  const server = await startServer({
    home: path.join(root, 'home'),
    music: path.join(root, 'music'),
    port: 0,
    host: '127.0.0.1',
    detectTailscale: async () => null,
    discoveryPort: null,
    fillLyrics: true,
    lyricsPauseMs: 0,
    lookupLyrics: async (song) => {
      asked.push(song.title);
      return { found: song.title === 'Porcelain', synced: null, plain: song.title === 'Porcelain' ? 'In my dreams' : '', instrumental: false };
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const until = async (what) => {
    for (let i = 0; i < 200 && !what(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(what());
  };
  try {
    for (const [id, title] of [['aaa111', 'Porcelain'], ['bbb222', 'Teardrop']]) {
      const meta = { title, artist: title === 'Porcelain' ? 'Moby' : 'Massive Attack', format: 'mp3', duration: 241 };
      await fetch(`${base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: 'PUT', body: FAKE_MP3 });
    }
    await until(() => asked.length >= 2);
    assert.deepEqual([...asked].sort(), ['Porcelain', 'Teardrop']);
    // An app asking afterwards gets the kept answer; none found is not asked again either.
    const r = await (await fetch(`${base}/api/songs/aaa111/lyrics`)).json();
    assert.equal(r.lyrics.plain, 'In my dreams');
    await fetch(`${base}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ cid: 'r1', at: Date.now(), type: 'editSong', songId: 'aaa111', artist: 'Moby', title: 'Natural Blues' }] }),
    });
    await until(() => asked.length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(asked.slice(2), ['Natural Blues']);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the filler with LRCLIB out of reach: stops, waits, that song only at the next start', async () => {
  const { createLyricsStore } = require('../src/lyrics');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-lyrics-test-'));
  const asked = [];
  let down = true;
  const songs = [{ id: 'a1', title: 'Angel', artist: 'Massive Attack' }, { id: 'b2', title: 'Glory Box', artist: 'Portishead' }];
  const make = (failWaitMs) => createLyricsStore({
    dir,
    pauseMs: 0,
    failWaitMs,
    lookup: async (song) => {
      asked.push(song.title);
      if (down) throw new TypeError('fetch failed');
      return { found: false, synced: null, plain: '', instrumental: false };
    },
  });
  try {
    let store = make(60000);
    await store.fill(() => songs);
    assert.deepEqual(asked, ['Angel'], 'stopped at the first failure');
    down = false;
    await store.fill(() => songs);
    assert.deepEqual(asked, ['Angel'], 'waits before trying again');
    store = make(0);
    await store.fill(() => songs);
    await store.fill(() => songs);
    assert.deepEqual(asked, ['Angel', 'Angel', 'Glory Box'], 'a new start asks again, each once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('own lyrics (4.0.1): written in an app, kept for good, taken back to the looked-up ones', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-lyrics-test-'));
  const asked = [];
  const server = await startServer({
    home: path.join(root, 'home'),
    music: path.join(root, 'music'),
    port: 0,
    host: '127.0.0.1',
    detectTailscale: async () => null,
    discoveryPort: null,
    lookupLyrics: async (song) => {
      asked.push(song.title);
      return { found: true, synced: null, plain: 'Looked up', instrumental: false };
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (route, method = 'GET', body = undefined) => {
    const r = await fetch(`${base}${route}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  try {
    assert.ok((await call('/api/hello')).json.features.includes('ownLyrics'));
    const meta = { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330 };
    await fetch(`${base}/api/songs/ccc333?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: 'PUT', body: FAKE_MP3 });
    const lines = [{ t: 61.5, end: 64, text: 'Love, love is a verb' }, { t: 65, end: null, text: 'Love is a doing word' }];
    const put = await call('/api/songs/ccc333/lyrics', 'PUT', { lines });
    assert.equal(put.status, 200);
    assert.equal(put.json.lyrics.source, 'own');
    assert.deepEqual(put.json.lyrics.synced, [{ t: 61.5, end: 64, text: 'Love, love is a verb' }, { t: 65, text: 'Love is a doing word' }]);
    // Renamed: still the own ones, nothing looked up.
    await call('/api/commands', 'POST', { commands: [{ cid: 'r1', at: Date.now(), type: 'editSong', songId: 'ccc333', artist: 'Massive Attack', title: 'Teardrop (Live)' }] });
    assert.equal((await call('/api/songs/ccc333/lyrics')).json.lyrics.own, true);
    assert.deepEqual(asked, []);
    // Only some lines with times: refused.
    const bad = await call('/api/songs/ccc333/lyrics', 'PUT', { lines: [{ t: 1, text: 'a' }, { t: null, text: 'b' }] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /every line/);
    assert.equal((await call('/api/songs/nope/lyrics', 'PUT', { lines })).status, 404);
    // Taken away: looked up again.
    const back = await call('/api/songs/ccc333/lyrics', 'PUT', { lines: null });
    assert.equal(back.json.lyrics.plain, 'Looked up');
    assert.deepEqual(asked, ['Teardrop (Live)']);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lookup running while lyrics are written keeps the written ones', async () => {
  const { createLyricsStore } = require('../src/lyrics');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-lyrics-test-'));
  let answer;
  const store = createLyricsStore({
    dir,
    lookup: () => new Promise((resolve) => {
      answer = resolve;
    }),
  });
  try {
    const song = { id: 'a1', title: 'Angel', artist: 'Massive Attack', duration: 380 };
    const running = store.get(song);
    await store.put(song, [{ t: null, end: null, text: 'Written' }]);
    answer({ found: true, synced: null, plain: 'Looked up', instrumental: false });
    assert.equal((await running).plain, 'Written');
    assert.equal((await store.get(song)).plain, 'Written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
