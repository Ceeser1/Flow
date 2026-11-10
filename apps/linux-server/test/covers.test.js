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

const putCover = (base, id, body, size = '') => fetch(`${base}/api/songs/${id}/cover${size ? `?size=${size}` : ''}`, { method: 'PUT', body });
const songOf = async (base, id) => (await (await fetch(`${base}/api/library`)).json()).library.songs.find((s) => s.id === id);

/** The smallest "WebP" (VP8) whose size can be read. */
function fakeWebp(fill = 1, w = 512, h = 512) {
  const b = Buffer.alloc(300, fill);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(292, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8 ', 12, 'ascii');
  b.writeUInt32LE(280, 16);
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
  b.writeUInt16LE(w, 26);
  b.writeUInt16LE(h, 28);
  return b;
}

test('an app\'s cover in two sizes: kept by song id, served with its version, several in one answer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-covers-'));
  const dirs = { home: path.join(root, 'home'), music: path.join(root, 'music') };
  let { server, base } = await start(dirs);
  const big = (id) => path.join(dirs.home, 'covers', 'high_res', `${id}.webp`);
  const small = (id) => path.join(dirs.home, 'covers', 'thumbnails', `${id}.webp`);
  try {
    await uploadSong(base, 'song01', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330 });
    assert.equal((await songOf(base, 'song01')).cover, null);
    assert.equal((await fetch(`${base}/api/songs/song01/cover`)).status, 404);

    // The app's own 512 WebP, kept as it is; its thumbnail right after.
    assert.equal((await (await putCover(base, 'song01', fakeWebp(9, 128, 128), 'small')).json()).cover, null, 'no cover yet: nothing to go with');
    assert.ok(!fs.existsSync(small('song01')));
    const first = await putCover(base, 'song01', fakeWebp(1));
    assert.equal(first.status, 200);
    const { cover: version } = await first.json();
    assert.match(version, /^[0-9a-f]{10}$/);
    assert.equal((await songOf(base, 'song01')).cover, version);
    assert.deepEqual(fs.readFileSync(big('song01')), fakeWebp(1));
    assert.equal((await putCover(base, 'song01', fakeWebp(2, 100, 100), 'small')).status, 415, 'a thumbnail is 128 x 128');
    assert.equal((await (await putCover(base, 'song01', fakeWebp(2, 128, 128), 'small')).json()).cover, version);
    assert.deepEqual(fs.readFileSync(small('song01')), fakeWebp(2, 128, 128));

    const got = await fetch(`${base}/api/songs/song01/cover?v=${version}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/webp');
    assert.equal(got.headers.get('etag'), `"${version}"`);
    assert.match(got.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), fakeWebp(1));
    const thumb = await fetch(`${base}/api/songs/song01/cover?v=${version}&size=small`);
    assert.equal(thumb.headers.get('etag'), `"${version}-s"`);
    assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), fakeWebp(2, 128, 128));
    assert.match((await fetch(`${base}/api/songs/song01/cover`)).headers.get('cache-control'), /no-cache/);
    const same = await fetch(`${base}/api/songs/song01/cover`, { headers: { 'If-None-Match': `"${version}"` } });
    assert.equal(same.status, 304);

    // A song with a cover keeps it: another app's comes too late.
    const second = await (await putCover(base, 'song01', fakeWebp(3))).json();
    assert.equal(second.cover, version);
    // A rename keeps it too: covers go by id.
    await fetch(`${base}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ cid: 'c1', type: 'editSong', songId: 'song01', title: 'Angel', artist: 'Massive Attack', at: Date.now() }] }),
    });
    assert.equal((await songOf(base, 'song01')).cover, version);
    assert.equal((await putCover(base, 'song01x', fakeWebp())).status, 404);
    await uploadSong(base, 'song02', { title: 'Unfinished Sympathy', artist: 'Massive Attack', format: 'mp3' });
    assert.equal((await putCover(base, 'song02', Buffer.from('<html>no</html>'))).status, 415);
    assert.equal((await putCover(base, 'song02', Buffer.alloc(5 * 1024 * 1024, 0xff))).status, 413);
    assert.equal((await putCover(base, 'song02', fakeJpeg(4, 300, 300))).status, 415, 'without ffmpeg only a 512 x 512 picture');
    // Without ffmpeg a 512 x 512 JPEG is kept as it is (shown for both sizes).
    const kept = await (await putCover(base, 'song02', fakeJpeg(4))).json();
    assert.match(kept.cover, /^[0-9a-f]{10}$/);
    const jpeg = await fetch(`${base}/api/songs/song02/cover?size=small`);
    assert.equal(jpeg.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(`${base}/api/songs/..%2Fsecret/cover`)).status, 404);

    // Several in one answer: what a list shows, unknown ones left out.
    const { unpackCovers } = require('@flow/core/coverPack');
    const r = await fetch(`${base}/api/covers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['song01', 'nothing', 'song02', '../x'], size: 'small' }) });
    const items = unpackCovers(new Uint8Array(await r.arrayBuffer()));
    assert.deepEqual(items.map((x) => [x.id, x.v]), [['song01', version], ['song02', kept.cover]]);
    assert.deepEqual(Buffer.from(items[0].bytes), fakeWebp(2, 128, 128));
    assert.deepEqual(Buffer.from(items[1].bytes), fakeJpeg(4));

    // Deleted: the cover goes with the song.
    await fetch(`${base}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ cid: 'c2', type: 'deleteSong', songId: 'song01', at: Date.now() }] }),
    });
    assert.ok(!fs.existsSync(big('song01')));
    assert.ok(!fs.existsSync(small('song01')));

    // At the start: a cover of no song is swept, a missing file is looked for
    // again, one from before 4.3.1 (<id>.jpg) is still shown until it is made into the two.
    await server.close();
    fs.writeFileSync(path.join(dirs.home, 'covers', 'high_res', 'orphan.webp'), fakeWebp());
    fs.writeFileSync(path.join(dirs.home, 'covers', 'orphan.jpg'), fakeJpeg());
    fs.rmSync(big('song02'));
    ({ server, base } = await start(dirs));
    assert.ok(!fs.existsSync(path.join(dirs.home, 'covers', 'high_res', 'orphan.webp')));
    assert.ok(!fs.existsSync(path.join(dirs.home, 'covers', 'orphan.jpg')));
    assert.equal((await songOf(base, 'song02')).cover, null);
    await putCover(base, 'song02', fakeJpeg(5));
    const v2 = (await songOf(base, 'song02')).cover;
    await server.close();
    fs.renameSync(big('song02'), path.join(dirs.home, 'covers', 'song02.jpg'));
    ({ server, base } = await start(dirs));
    assert.equal((await songOf(base, 'song02')).cover, v2, 'the same picture keeps its version');
    assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/songs/song02/cover?size=small`)).arrayBuffer()), fakeJpeg(5));
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
