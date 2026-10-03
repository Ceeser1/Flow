'use strict';

// A saved song's tags written anew (tags.js, media.rewriteTags): with real
// ffmpeg on made-up songs. Skipped without ffmpeg (the desktop app's
// bundled one, or one on the PATH).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const tags = require('../src/tags');
const { createMedia } = require('../src/media');
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
const ffprobe = findTool('ffprobe');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-tags-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const needs = { skip: !(ffmpeg && ffprobe) && 'no ffmpeg' };
const media = createMedia({ ffmpeg: () => ffmpeg, ffprobe: () => ffprobe, ytdlp: () => null, cacheDir: () => scratch });

const run = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** Every tag of the file (stream and file, lower-case keys) and whether it has a picture. */
function read(file) {
  const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format_tags:stream=codec_type:stream_tags:stream_disposition=attached_pic',
    '-of', 'json', file]);
  const info = JSON.parse(out);
  const all = {};
  for (const s of [...(info.streams || []).filter((x) => x.codec_type === 'audio'), info.format || {}]) {
    for (const [k, v] of Object.entries(s.tags || {})) all[k.toLowerCase()] = v;
  }
  const picture = (info.streams || []).some((s) => s.disposition && s.disposition.attached_pic);
  return { tags: all, picture };
}

test('flowid: written as library:song, read back in any case, anything else is no id', () => {
  assert.equal(tags.flowIdText('a1b2', 'c3d4'), 'a1b2:c3d4');
  assert.equal(tags.flowIdText('a b', 'c'), '');
  assert.deepEqual(tags.parseFlowId({ FLOWID: ' srv:abc ' }), { library: 'srv', songId: 'abc' });
  assert.equal(tags.parseFlowId({ flowid: 'just-one' }), null);
  assert.equal(tags.parseFlowId({ title: 'x' }), null);
});

test('the tags a file keeps: its own ones, the names always Flow\'s, source and id only when given', () => {
  const merged = tags.mergedTags({ ALBUM: 'Discovery', date: '2001', title: 'Old', mix: 'Old Mix', comment: 'mine', encoder: 'Lavf', flowid: 'x:y' },
    { title: 'One More Time', artist: 'Daft Punk', mix: '' });
  assert.deepEqual(merged, { album: 'Discovery', date: '2001', comment: 'mine', flowid: 'x:y', title: 'One More Time', artist: 'Daft Punk' });
  assert.equal(tags.mergedTags({ comment: 'a' }, { title: 't', sourceUrl: 'https://x.test/1', flowId: 'l:s' }).comment, 'https://x.test/1');
  assert.equal(tags.ffmetadata({ title: 'A=B;C' }), ';FFMETADATA1\ntitle=A\\=B\\;C\n');
});

test('rewriting keeps the audio and the other tags, sets names and id, puts the cover in (not into M4A)', needs, async () => {
  const jpeg = path.join(scratch, 'cover.jpg');
  run(['-f', 'lavfi', '-i', 'testsrc=s=512x512', '-frames:v', '1', jpeg]);
  const pic = fs.readFileSync(jpeg);
  const codecs = { mp3: 'libmp3lame', flac: 'flac', opus: 'libopus', m4a: 'aac', wav: 'pcm_s16le' };
  for (const [ext, codec] of Object.entries(codecs)) {
    const file = path.join(scratch, `song.${ext}`);
    run(['-f', 'lavfi', '-i', 'sine=d=1', '-c:a', codec, '-metadata', 'title=Old', '-metadata', 'artist=Someone',
      '-metadata', 'album=Discovery', file]);
    const out = path.join(scratch, `.flow-retag-song.${ext}`);
    const ok = await media.rewriteTags(file, out, {
      meta: { title: 'Digital Love', artist: 'Daft Punk', mix: 'Live', sourceUrl: 'https://x.test/2' }, flowId: 'lib1:song1', picture: pic,
    });
    assert.equal(ok, true, ext);
    const got = read(out);
    assert.equal(got.tags.title, 'Digital Love', ext);
    assert.equal(got.tags.artist, 'Daft Punk', ext);
    if (ext === 'wav') {
      assert.equal(got.picture, false);
      continue;
    }
    assert.equal(got.tags.album, 'Discovery', ext);
    assert.equal(got.tags.mix, 'Live', ext);
    assert.equal(got.tags.flowid, 'lib1:song1', ext);
    assert.deepEqual(tags.parseFlowId(got.tags), { library: 'lib1', songId: 'song1' });
    assert.equal(got.picture, ext !== 'm4a', ext);
    if (ext !== 'm4a') {
      // The cover as Flow reads it back.
      const back = await cover.embeddedCover(ffmpeg, out);
      assert.ok(back && back.length > 1000, ext);
    }
  }
});

test('rewriting without a new cover keeps the picture the file has', needs, async () => {
  const jpeg = path.join(scratch, 'own.jpg');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=300x300', '-frames:v', '1', jpeg]);
  for (const ext of ['mp3', 'opus']) {
    const first = path.join(scratch, `own1.${ext}`);
    run(['-f', 'lavfi', '-i', 'sine=d=1', '-c:a', ext === 'mp3' ? 'libmp3lame' : 'libopus', first]);
    const second = path.join(scratch, `own2.${ext}`);
    assert.equal(await media.rewriteTags(first, second, { meta: { title: 'A' }, picture: fs.readFileSync(jpeg) }), true);
    const third = path.join(scratch, `own3.${ext}`);
    assert.equal(await media.rewriteTags(second, third, { meta: { title: 'B', artist: 'C' } }), true);
    const got = read(third);
    assert.equal(got.tags.title, 'B');
    assert.equal(got.picture, true, ext);
  }
});
