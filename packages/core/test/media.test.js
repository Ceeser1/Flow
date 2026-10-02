'use strict';

// The shared media tools (media.js, listing.js): plain Node, so the Flow
// Server can use them. The ffmpeg part runs with the desktop app's bundled
// tools when they are there (or ffmpeg on the PATH), and is skipped otherwise.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createMedia, parseProgress, ytDlpError } = require('../src/media');
const { createLister, groupToken } = require('../src/listing');

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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-media-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('yt-dlp progress lines and errors are read', () => {
  const p = parseProgress('FLOW_DL\t524288\t1048576\t262144\t2');
  assert.equal(p.frac, 0.5);
  assert.match(p.text, /50\.0%/);
  assert.equal(parseProgress('[download] something else'), null);
  assert.equal(ytDlpError(['ERROR: [youtube] x: Private video']), 'This video is private.');
});

test('a missing tool says so, in the words the app chose', async () => {
  const media = createMedia({ ffmpeg: () => null, ffprobe: () => null, ytdlp: () => null, cacheDir: () => scratch, missing: (n) => `no ${n} here` });
  await assert.rejects(media.probe('https://example.com/x', {}), /no yt-dlp here/);
  await assert.rejects(media.probeAudio(path.join(scratch, 'x.mp3')), /no ffprobe here/);
});

test('the lister needs nothing but media and a library', () => {
  const lister = createLister({ media: {}, library: () => ({ songs: [], playlists: [] }) });
  assert.equal(typeof lister.list, 'function');
  assert.equal(typeof groupToken().sub, 'function');
});

test('prepare, cut with tags, and peaks, with real ffmpeg', { skip: !(ffmpeg && ffprobe) && 'no ffmpeg' }, async () => {
  const media = createMedia({ ffmpeg: () => ffmpeg, ffprobe: () => ffprobe, ytdlp: () => null, cacheDir: () => scratch });
  const wav = path.join(scratch, 'tone.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', wav]);

  const { media: prepared } = await media.prepareLocal(wav, { alwaysMp3: true, quality: 128 }, null, {});
  assert.equal(prepared.ext, 'mp3');
  assert.ok(Math.abs(prepared.duration - 5) < 0.2);

  const dest = path.join(scratch, 'Daft Punk - Tone.mp3');
  const saved = await media.cutSong({
    cachePath: prepared.path, start: 1, end: 3, duration: prepared.duration, artist: 'Daft Punk', title: 'Tone', mix: '', sourceUrl: '',
  }, dest);
  assert.ok(Math.abs(saved.duration - 2) < 0.2, `cut to 2 s, got ${saved.duration}`);
  const info = await media.probeAudio(dest);
  assert.equal(info.tags.artist, 'Daft Punk');

  const peaks = await media.peaksFor(dest, saved.duration);
  assert.ok(peaks.length > 100 && peaks.length % 2 === 0);
  // lavfi's sine is at 1/8 of full scale.
  assert.ok(Math.max(...peaks) > 0.1 && Math.max(...peaks) < 0.2, 'the tone is there, at its level');
});
