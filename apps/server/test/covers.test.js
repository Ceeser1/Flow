'use strict';

// Covers on the server: an app's upload, serving with ETag, and a cover going
// with its song. Without ffmpeg (the songs are fakes), so the server never
// looks for covers itself here; covers-job.test.js does that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../src/server');

process.env.FLOW_SERVER_FFMPEG = 'off';

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);

/** The smallest "JPEG" whose size can be read: 512 x 512 unless told. */
function fakeJpeg(fill = 1, w = 512, h = 512) {
  const b = Buffer.alloc(300, fill);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(17, 4);
  b[6] = 8;
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
}

async function start(dirs) {
  const server = await startServer({
    home: dirs.home, music: dirs.music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null,
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

async function uploadSong(base, id, meta) {
  const r = await fetch(`${base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: 'PUT', body: FAKE_MP3 });
  return r.json();
}

const putCover = (base, id, body) => fetch(`${base}/api/songs/${id}/cover`, { method: 'PUT', body });
const songOf = async (base, id) => (await (await fetch(`${base}/api/library`)).json()).library.songs.find((s) => s.id === id);

test('an app\'s cover: kept by song id, served with its version, refused when it is no JPEG', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-covers-'));
  const dirs = { home: path.join(root, 'home'), music: path.join(root, 'music') };
  let { server, base } = await start(dirs);
  try {
    await uploadSong(base, 'song01', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330 });
    assert.equal((await songOf(base, 'song01')).cover, null);
    assert.equal((await fetch(`${base}/api/songs/song01/cover`)).status, 404);

    const first = await putCover(base, 'song01', fakeJpeg(1));
    assert.equal(first.status, 200);
    const { cover: version } = await first.json();
    assert.match(version, /^[0-9a-f]{10}$/);
    assert.equal((await songOf(base, 'song01')).cover, version);
    assert.ok(fs.existsSync(path.join(dirs.home, 'covers', 'song01.jpg')));

    const got = await fetch(`${base}/api/songs/song01/cover?v=${version}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
    assert.equal(got.headers.get('etag'), `"${version}"`);
    assert.match(got.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), fakeJpeg(1));
    assert.match((await fetch(`${base}/api/songs/song01/cover`)).headers.get('cache-control'), /no-cache/);
    const same = await fetch(`${base}/api/songs/song01/cover`, { headers: { 'If-None-Match': `"${version}"` } });
    assert.equal(same.status, 304);

    // A song with a cover keeps it: another app's comes too late.
    const second = await (await putCover(base, 'song01', fakeJpeg(2))).json();
    assert.equal(second.cover, version);
    // A rename keeps it too: covers go by id.
    await fetch(`${base}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ cid: 'c1', type: 'editSong', songId: 'song01', title: 'Angel', artist: 'Massive Attack', at: Date.now() }] }),
    });
    assert.equal((await songOf(base, 'song01')).cover, version);

    assert.equal((await putCover(base, 'song01x', fakeJpeg())).status, 404);
    await uploadSong(base, 'song02', { title: 'Unfinished Sympathy', artist: 'Massive Attack', format: 'mp3' });
    assert.equal((await putCover(base, 'song02', Buffer.from('<html>no</html>'))).status, 415);
    assert.equal((await putCover(base, 'song02', Buffer.alloc(5 * 1024 * 1024, 0xff))).status, 413);
    assert.equal((await fetch(`${base}/api/songs/..%2Fsecret/cover`)).status, 404);

    // Deleted: the cover goes with the song.
    await fetch(`${base}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ cid: 'c2', type: 'deleteSong', songId: 'song01', at: Date.now() }] }),
    });
    assert.ok(!fs.existsSync(path.join(dirs.home, 'covers', 'song01.jpg')));

    // At the start: a cover of no song is swept, a missing file is looked for again.
    await putCover(base, 'song02', fakeJpeg(3));
    await server.close();
    fs.writeFileSync(path.join(dirs.home, 'covers', 'orphan.jpg'), fakeJpeg());
    fs.rmSync(path.join(dirs.home, 'covers', 'song02.jpg'));
    ({ server, base } = await start(dirs));
    assert.ok(!fs.existsSync(path.join(dirs.home, 'covers', 'orphan.jpg')));
    assert.equal((await songOf(base, 'song02')).cover, null);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
