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
