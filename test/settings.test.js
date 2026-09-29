'use strict';

// The Settings window's rules: which MP3s are encoded again, the next song a
// transition starts early, moving the save folder, reading a song's loudness,
// and what a settings file may hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { planFor } = require('../src/formats');
const PlayQueue = require('../renderer/app/queue');
const { checkTarget, planMoves } = require('../src/relocate');
const { parseLoudness } = require('../src/loudness');
const settings = require('../src/settings');
const m = require('../src/libraryModel');

test('an MP3 is only encoded again when "Ignore files already in .mp3" is unticked', () => {
  const mp3 = { codec: 'mp3', formatName: 'mp3', bitRate: 320000 };
  assert.equal(planFor(mp3, {}).action, 'copy');
  assert.equal(planFor(mp3, { alwaysMp3: true, quality: 128 }).action, 'copy');
  assert.equal(planFor(mp3, { alwaysMp3: true, quality: 128, keepMp3: true }).action, 'copy');
  const again = planFor(mp3, { alwaysMp3: true, quality: 128, keepMp3: false });
  assert.equal(again.action, 'mp3');
  assert.equal(again.bitrate, 128);
  // Without "Always convert" the tick changes nothing.
  assert.equal(planFor(mp3, { alwaysMp3: false, keepMp3: false }).action, 'copy');
  // Other formats are converted either way.
  assert.equal(planFor({ codec: 'opus' }, { alwaysMp3: true, keepMp3: true }).action, 'mp3');
});

test('peek names the song next() will give, without moving on', () => {
  const q = new PlayQueue();
  const ids = ['a', 'b', 'c'];
  q.start('all', ids, 'b');
  assert.equal(q.peek(ids), 'c');
  assert.equal(q.peek(ids), 'c');
  assert.equal(q.currentId, 'b');
  assert.equal(q.next(ids), 'c');
  assert.equal(q.peek(ids), 'a'); // the end wraps round

  // Shuffle: the peeked song is the one that follows, and take() (what the
  // transition does when it takes over) keeps the round intact.
  let seed = 1;
  const s = new PlayQueue(() => ((seed = (seed * 16807) % 2147483647) / 2147483647));
  s.setShuffle(true);
  const list = ['a', 'b', 'c', 'd', 'e'];
  s.start('all', list, 'a');
  const played = ['a'];
  for (let i = 0; i < 4; i += 1) {
    const peek = s.peek(list);
    assert.equal(s.peek(list), peek);
    s.take(peek, list);
    played.push(peek);
  }
  assert.deepEqual([...played].sort(), list, 'every song once before any repeats');
  const one = new PlayQueue();
  one.setShuffle(true);
  one.start('x', ['a']);
  assert.equal(one.peek(['a']), 'a', 'a one-song list repeats itself');
});

test('the save folder can move anywhere but into or around itself', () => {
  const old = path.resolve('C:/Music/YPlayer');
  assert.doesNotThrow(() => checkTarget(old, path.resolve('D:/Songs')));
  assert.throws(() => checkTarget(old, path.resolve('C:/music/yplayer')), /already/);
  assert.throws(() => checkTarget(old, path.resolve('C:/Music/YPlayer/Sub')), /inside/);
  assert.throws(() => checkTarget(old, path.resolve('C:/Music')), /contain/);
  assert.throws(() => checkTarget(old, ''), /choose/);
  // A sibling whose name starts the same is not inside.
  assert.doesNotThrow(() => checkTarget(old, path.resolve('C:/Music/YPlayer2')));
});

test('moved files keep their subfolders, and a name taken gets a number', () => {
  const old = path.resolve('C:/Old');
  const neu = path.resolve('D:/New');
  const files = ['A - One.mp3', 'Sub/B - Two.opus', 'A - Three.m4a', 'Sub/A - One.mp3'].map((f) => path.join(old, f));
  const taken = new Set([path.join(neu, 'A - Three.m4a').toLowerCase()]);
  const plan = planMoves(files, old, neu, (p) => taken.has(p));
  assert.deepEqual(plan.map((x) => path.relative(neu, x.to)), [
    'A - One.mp3', path.join('Sub', 'B - Two.opus'), 'A - Three (2).m4a', path.join('Sub', 'A - One.mp3'),
  ]);
});

test('the loudness is read from the summary of ffmpeg\'s ebur128', () => {
  const out = `[Parsed_ebur128_0 @ 0x1] t: 2.9  TARGET:-23 LUFS  M: -12.1 S: -13.0  I: -12.5 LUFS  LRA: 0.0 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -9.8 LUFS
    Threshold: -19.9 LUFS

  Loudness range:
    LRA:         5.1 LU`;
  assert.equal(parseLoudness(out), -9.8);
  // Silence reads as the meter's floor: nothing to go by.
  assert.equal(parseLoudness('Summary:\n  Integrated loudness:\n    I:         -70.0 LUFS'), null);
  assert.equal(parseLoudness('No such file'), null);
});

test('a song\'s loudness is kept, and only as a number', () => {
  const data = m.sanitize({ songs: [
    { id: 'a', file: 'a.mp3', loudness: -11.2 },
    { id: 'b', file: 'b.mp3' },
    { id: 'c', file: 'c.mp3', loudness: 'loud' },
  ] });
  assert.deepEqual(data.songs.map((s) => s.loudness), [-11.2, null, null]);
  m.updateSong(data, 'b', { loudness: -8 });
  assert.equal(m.songById(data, 'b').loudness, -8);
});

test('settings are kept within their ranges', () => {
  const s = settings.clean({
    crossfadeSeconds: 25, cloudsIntensity: 0, eqHeight: 250, eqShineSpread: '70', eqColors: 'plaid',
    crossfade: false, normalize: 'yes', musicDir: 42, visualizer: 'lightning',
  });
  assert.equal(s.crossfadeSeconds, 10);
  assert.equal(s.cloudsIntensity, 1);
  assert.equal(s.eqHeight, 100);
  assert.equal(s.eqVisibility, 50);
  assert.equal(s.flashOn, false);
  assert.equal(s.flashTriggers, 33);
  assert.equal(s.flashRange, 10);
  assert.equal(s.eqShineSpread, 70);
  assert.equal(s.eqColors, 'rainbow');
  // Not built yet: the default instead.
  assert.equal(s.visualizer, 'bars');
  assert.equal(s.crossfade, false);
  assert.equal(s.normalize, true);
  assert.equal(s.musicDir, '');
  // Nothing saved yet: the defaults of the design.
  const d = settings.clean(null);
  assert.equal(d.crossfade, true);
  assert.equal(d.crossfadeSeconds, 3);
  assert.equal(d.normalize, true);
  assert.equal(d.alwaysMp3, false);
  assert.equal(d.keepMp3, true);
  assert.equal(d.cloudsIntensity, 50);
  assert.equal(d.cloudsBassAmount, 50);
  assert.equal(d.eqColors, 'rainbow');
  assert.equal(settings.clean({ visualizer: 'waveform' }).visualizer, 'waveform');
  assert.equal(settings.clean({ visualizer: 'flow' }).visualizer, 'flow');
});
