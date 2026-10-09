'use strict';

// Ogg Vorbis as Opus for the iPhone (vorbis.js), with the machine's own
// ffmpeg; skipped without one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createVorbis, isVorbis } = require('../src/vorbis');
const { onPath } = require('../src/tools');

const ffmpeg = onPath('ffmpeg');

function make(file, codec, hz = 440) {
  execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2`, '-c:a', codec, file]);
}

test('a Vorbis song goes as an Opus copy, made once; others as they are', { skip: !ffmpeg && 'no ffmpeg here' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-vorbis-test-'));
  try {
    const music = path.join(root, 'music');
    fs.mkdirSync(music);
    const vorbisFile = path.join(music, 'a.ogg');
    const opusFile = path.join(music, 'b.ogg');
    const mp3 = path.join(music, 'c.mp3');
    make(vorbisFile, 'libvorbis');
    make(opusFile, 'libopus');
    make(mp3, 'libmp3lame');
    assert.equal(isVorbis(vorbisFile), true);
    assert.equal(isVorbis(opusFile), false);
    assert.equal(isVorbis(mp3), false);
    assert.equal(isVorbis(path.join(music, 'none.ogg')), false);

    const logged = [];
    const v = createVorbis({ home: () => root, ffmpeg: () => ffmpeg, log: (m) => logged.push(m) });
    assert.equal(await v.playable('b', opusFile), opusFile);
    assert.equal(await v.playable('c', mp3), mp3);

    // Asked for three times at once (an app's Range requests): one conversion.
    const [first, second, third] = await Promise.all([1, 2, 3].map(() => v.playable('a', vorbisFile)));
    assert.equal(second, first);
    assert.equal(third, first);
    assert.notEqual(first, vorbisFile);
    assert.equal(path.dirname(first), path.join(root, 'converted'));
    const head = fs.readFileSync(first).subarray(0, 80).toString('latin1');
    assert.match(head, /^OggS/);
    assert.match(head, /OpusHead/);
    assert.equal(logged.filter((m) => /Converted/.test(m)).length, 1);
    assert.equal(await v.playable('a', vorbisFile), first);
    assert.equal(logged.filter((m) => /Converted/.test(m)).length, 1);

    // The song's file changed (trimmed): a new copy, the old one gone.
    make(vorbisFile, 'libvorbis', 660);
    fs.utimesSync(vorbisFile, new Date(), new Date(Date.now() + 5000));
    const again = await v.playable('a', vorbisFile);
    assert.notEqual(again, first);
    assert.equal(fs.existsSync(again), true);
    assert.equal(fs.existsSync(first), false);

    // Without ffmpeg: as it is.
    const none = createVorbis({ home: () => root, ffmpeg: () => null });
    assert.equal(await none.playable('a', vorbisFile), vorbisFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
