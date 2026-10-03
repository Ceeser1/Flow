'use strict';

// Cover art (cover.js): the pictures are made with ffmpeg here, the
// downloads and the YouTube Music search are fakes. Skipped without ffmpeg
// (the desktop app's bundled one, or one on the PATH).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cover = require('../src/cover');

function findTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const bundled = path.join(__dirname, '..', '..', '..', 'apps', 'desktop', 'tools', exe);
  if (fs.existsSync(bundled)) return bundled;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

const ffmpeg = findTool('ffmpeg');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cover-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const needs = { skip: !ffmpeg && 'no ffmpeg' };

/** A JPEG made by ffmpeg from a lavfi graph. */
function picture(name, graph) {
  const out = path.join(scratch, `${name}.jpg`);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', graph, '-frames:v', '1', '-q:v', '3', out]);
  return fs.readFileSync(out);
}

// A YouTube Music thumbnail: a busy square in the middle, flat bars beside it.
const topic = () => picture('topic', 'color=c=0x3c3526:s=1280x720[bg];testsrc=s=720x720[fg];[bg][fg]overlay=280:0');
// A music video's thumbnail: busy all over.
const video = () => picture('video', 'testsrc2=s=1280x720');
// hqdefault of a Topic upload: 4:3, black above and below the 16:9 picture.
const letterboxed = () => picture('letterbox',
  'color=c=black:s=480x360[bg];color=c=0x3c3526:s=480x270[mid];testsrc=s=270x270[sq];[mid][sq]overlay=105:0[pic];[bg][pic]overlay=0:45');
const square = () => picture('square', 'testsrc=s=500x500');

test('imageSize reads JPEG, PNG and garbage', needs, () => {
  assert.deepEqual(cover.imageSize(topic()), { width: 1280, height: 720 });
  const png = path.join(scratch, 'p.png');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=33x17', '-frames:v', '1', png]);
  assert.deepEqual(cover.imageSize(fs.readFileSync(png)), { width: 33, height: 17 });
  assert.equal(cover.imageSize(Buffer.from('not a picture at all, really not')), null);
  assert.equal(cover.imageSize(null), null);
});

test('flat side bars are a cover, a video frame is not', needs, async () => {
  assert.equal(await cover.bandsAreFlat(ffmpeg, topic()), true);
  assert.equal(await cover.bandsAreFlat(ffmpeg, video()), false);
  assert.equal(await cover.bandsAreFlat(ffmpeg, square()), false);
  assert.equal(await cover.bandsAreFlat(ffmpeg, letterboxed(), { letterbox: true }), true);
  assert.equal(await cover.bandsAreFlat(ffmpeg, Buffer.from('garbage'.repeat(10))), false);
});

test('makeSquare gives a 512 x 512 JPEG of the middle', needs, async () => {
  const jpeg = await cover.makeSquare(ffmpeg, topic());
  assert.deepEqual(cover.imageSize(jpeg), { width: 512, height: 512 });
  assert.ok(jpeg.length > 1000 && jpeg.length < 120 * 1024);
  const boxed = await cover.makeSquare(ffmpeg, letterboxed(), { letterbox: true });
  assert.deepEqual(cover.imageSize(boxed), { width: 512, height: 512 });
  assert.equal(await cover.makeSquare(ffmpeg, Buffer.from('nope')), null);
});

test('the picture embedded in a song file', needs, async () => {
  const art = path.join(scratch, 'art.jpg');
  fs.writeFileSync(art, square());
  const withArt = path.join(scratch, 'with.mp3');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=1', '-i', art,
    '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-id3v2_version', '3', '-disposition:v', 'attached_pic', withArt]);
  const without = path.join(scratch, 'without.mp3');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=1', without]);
  assert.deepEqual(cover.imageSize(await cover.embeddedCover(ffmpeg, withArt)), { width: 512, height: 512 });
  assert.equal(await cover.embeddedCover(ffmpeg, without), null);
});

test('thumbnail links from yt-dlp info', () => {
  const yt = cover.coverUrlsFromInfo({ extractor_key: 'Youtube', id: 'dQw4w9WgXcQ' });
  assert.deepEqual(yt.map((t) => t.url), [
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg',
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  ]);
  assert.equal(yt[2].letterbox, true);
  const sc = cover.coverUrlsFromInfo({
    extractor_key: 'Soundcloud',
    thumbnails: [
      { url: 'https://i1.sndcdn.com/a-t500x500.webp', width: 500, height: 500 },
      { url: 'https://i1.sndcdn.com/a-t500x500.jpg', width: 500, height: 500 },
      { url: 'https://i1.sndcdn.com/a-small.jpg', width: 100, height: 100 },
    ],
  });
  assert.equal(sc[0].url, 'https://i1.sndcdn.com/a-t500x500.jpg');
  assert.deepEqual(cover.coverUrlsFromInfo(null), []);
  assert.equal(cover.youtubeIdOf('youtube:dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(cover.youtubeIdOf('soundcloud:123'), null);
});

/** A fake web: url -> Buffer (missing: 404). */
function fakeWeb(pages) {
  const asked = [];
  const fetchImage = async (url) => {
    asked.push(url);
    if (!pages[url]) throw new Error('HTTP 404');
    return pages[url];
  };
  return { fetchImage, asked };
}

const thumb = (id, name = 'maxresdefault') => `https://i.ytimg.com/vi/${id}/${name}.jpg`;

test('resolveCover: a Topic upload keeps its own cover, no search', needs, async () => {
  const web = fakeWeb({ [thumb('AAAAAAAAAAA')]: topic() });
  let searched = false;
  const r = await cover.resolveCover({ sourceKey: 'youtube:AAAAAAAAAAA', artist: 'Daft Punk', title: 'Get Lucky', duration: 248 }, {
    ffmpeg, fetchImage: web.fetchImage, searchMusic: async () => { searched = true; return []; },
  });
  assert.equal(r.kind, 'cover');
  assert.deepEqual(cover.imageSize(r.jpeg), { width: 512, height: 512 });
  assert.equal(searched, false);
});

test('resolveCover: a music video finds the album cover on YouTube Music', needs, async () => {
  const web = fakeWeb({ [thumb('VVVVVVVVVVV', 'hq720')]: video(), [thumb('TTTTTTTTTTT')]: topic() });
  const r = await cover.resolveCover({ sourceKey: 'youtube:VVVVVVVVVVV', artist: 'Daft Punk', title: 'Get Lucky', duration: 248 }, {
    ffmpeg,
    fetchImage: web.fetchImage,
    searchMusic: async (track) => {
      assert.equal(track.title, 'Get Lucky');
      assert.equal(track.artists, 'Daft Punk');
      return [{ id: 'RRRRRRRRRRR', title: 'Get Lucky (Remix)', duration: 300 }, { id: 'TTTTTTTTTTT', title: 'Get Lucky', duration: 249.5 }];
    },
  });
  assert.equal(r.kind, 'search');
  // maxresdefault was missing: hq720 was taken instead.
  assert.ok(web.asked.includes(thumb('VVVVVVVVVVV', 'hq720')));
});

test('resolveCover: a hit of another length is not this song; the video frame then', needs, async () => {
  const web = fakeWeb({ [thumb('VVVVVVVVVVV')]: video(), [thumb('TTTTTTTTTTT')]: topic() });
  const r = await cover.resolveCover({ sourceKey: 'youtube:VVVVVVVVVVV', artist: 'Daft Punk', title: 'Get Lucky', duration: 248 }, {
    ffmpeg, fetchImage: web.fetchImage, searchMusic: async () => [{ id: 'TTTTTTTTTTT', title: 'Get Lucky', duration: 369 }],
  });
  assert.equal(r.kind, 'frame');
  assert.ok(!web.asked.includes(thumb('TTTTTTTTTTT')));
});

test('resolveCover: noSearch, failing searches, square artwork, nothing at all', needs, async () => {
  const web = fakeWeb({ [thumb('VVVVVVVVVVV')]: video(), 'https://img.example/art.jpg': square() });
  let searched = false;
  const song = { sourceKey: 'youtube:VVVVVVVVVVV', title: 'Song', duration: 200 };
  const a = await cover.resolveCover({ ...song, noSearch: true }, {
    ffmpeg, fetchImage: web.fetchImage, searchMusic: async () => { searched = true; return []; },
  });
  assert.equal(a.kind, 'frame');
  assert.equal(searched, false);
  const b = await cover.resolveCover(song, { ffmpeg, fetchImage: web.fetchImage, searchMusic: async () => { throw new Error('offline'); } });
  assert.equal(b.kind, 'frame');
  // Another site: its thumbnail from yt-dlp's info.
  const c = await cover.resolveCover({ sourceUrl: 'https://soundcloud.com/x/y', title: 'Song' }, {
    ffmpeg,
    fetchImage: web.fetchImage,
    readInfo: async () => ({ extractor_key: 'Soundcloud', thumbnails: [{ url: 'https://img.example/art.jpg', width: 500, height: 500 }] }),
  });
  assert.equal(c.kind, 'art');
  assert.deepEqual(await cover.resolveCover({ title: 'Song' }, { ffmpeg, fetchImage: web.fetchImage }), { jpeg: null, kind: null, retry: false });
  assert.equal((await cover.resolveCover({ sourceKey: 'youtube:VVVVVVVVVVV' }, { ffmpeg: null })).retry, true);
  // A file with a picture in it, from a hand-dropped file (no source).
  const d = await cover.resolveCover({ title: 'Song' }, { ffmpeg, fetchImage: web.fetchImage, embedded: async () => Buffer.from('jpeg') });
  assert.equal(d.kind, 'embedded');
  // Offline: nothing found, but worth another try.
  const offline = async () => { throw new Error('fetch failed'); };
  const e = await cover.resolveCover({ sourceKey: 'youtube:VVVVVVVVVVV', title: 'Song' }, { ffmpeg, fetchImage: offline });
  assert.deepEqual(e, { jpeg: null, kind: null, retry: true });
  // Only missing pictures (404): nothing, for good.
  const f = await cover.resolveCover({ sourceKey: 'youtube:MMMMMMMMMMM', title: 'Song' }, { ffmpeg, fetchImage: web.fetchImage });
  assert.equal(f.retry, false);
});

test('fetchImage refuses what is not a picture, or too large', async () => {
  const res = (type, body, length) => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'content-type' ? type : (h === 'content-length' ? length : null)) },
    body: [Buffer.from(body)],
  });
  const ok = await cover.fetchImage('https://x.test/a.jpg', { fetchFn: async () => res('image/jpeg', 'abc') });
  assert.equal(ok.toString(), 'abc');
  await assert.rejects(cover.fetchImage('https://x.test/a', { fetchFn: async () => res('text/html', '<html>') }), /Not a picture/);
  await assert.rejects(cover.fetchImage('https://x.test/a', { fetchFn: async () => res('image/png', 'x', '999999999') }), /too large/);
  await assert.rejects(cover.fetchImage('https://x.test/a', { maxBytes: 2, fetchFn: async () => res('image/png', 'xyz') }), /too large/);
  await assert.rejects(cover.fetchImage('file:///etc/passwd'), /Not a web address/);
  await assert.rejects(cover.fetchImage('https://x.test/a', { fetchFn: async () => ({ ok: false, status: 404, headers: { get: () => null } }) }), /404/);
});

test('the store: by id, atomic, swept', () => {
  const dir = path.join(scratch, 'store');
  const store = cover.createCoverStore(dir);
  const v1 = store.write('abc123', Buffer.from('one'));
  const v2 = store.write('abc123', Buffer.from('two'));
  assert.notEqual(v1, v2);
  assert.equal(v2, cover.coverVersion(Buffer.from('two')));
  assert.equal(store.read('abc123').toString(), 'two');
  assert.ok(store.has('abc123'));
  store.write('gone1', Buffer.from('x'));
  fs.writeFileSync(path.join(dir, '.left.tmp'), 'x');
  assert.equal(store.sweep(new Set(['abc123'])), 1);
  assert.deepEqual(store.ids(), ['abc123']);
  assert.deepEqual(fs.readdirSync(dir), ['abc123.jpg']);
  assert.deepEqual(store.size(), { count: 1, bytes: 3 });
  assert.throws(() => store.file('../evil'), /Not a song id/);
  assert.throws(() => store.write('a/b', Buffer.from('x')), /Not a song id/);
  store.remove('abc123');
  assert.equal(store.has('abc123'), false);
});
