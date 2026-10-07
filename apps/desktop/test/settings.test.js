'use strict';

// The Settings window's rules: which MP3s are encoded again, the next song a
// transition starts early, moving the save folder, reading a song's loudness,
// and what a settings file may hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { planFor } = require('@flow/core/formats');
const PlayQueue = require('../renderer/app/queue');
const { checkTarget, planMoves } = require('@flow/core/relocate');
const { parseLoudness } = require('../src/loudness');
const { parseCost } = require('../src/network');
const settings = require('../src/settings');
const m = require('@flow/core/libraryModel');

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
  const old = path.resolve('C:/Music/FlowPlayer');
  assert.doesNotThrow(() => checkTarget(old, path.resolve('D:/Songs')));
  assert.throws(() => checkTarget(old, path.resolve('C:/music/flowplayer')), /already/);
  assert.throws(() => checkTarget(old, path.resolve('C:/Music/FlowPlayer/Sub')), /inside/);
  assert.throws(() => checkTarget(old, path.resolve('C:/Music')), /contain/);
  assert.throws(() => checkTarget(old, ''), /choose/);
  // A sibling whose name starts the same is not inside.
  assert.doesNotThrow(() => checkTarget(old, path.resolve('C:/Music/FlowPlayer2')));
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
    crossfade: false, normalize: 'yes', musicDir: 42, visualizer: 'geiss',
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
  assert.equal(settings.clean({ visualizer: 'synthwave' }).visualizer, 'synthwave');
  assert.equal(settings.clean({}).synColor, '#9f38fa');
  assert.equal(settings.clean({ synColor: '#00FF80' }).synColor, '#00ff80');
  assert.equal(settings.clean({ synColor: 'red' }).synColor, '#9f38fa');
  assert.equal(settings.clean({}).synBumps, true);
  assert.equal(settings.clean({ synCarTilt: false }).synCarTilt, false);
  assert.equal(settings.clean({}).synBobbingAmount, 100);
  assert.equal(settings.clean({ synCameraTiltAmount: 0 }).synCameraTiltAmount, 0);
  assert.equal(settings.clean({ synCarTiltAmount: 147 }).synCarTiltAmount, 145);
  assert.equal(settings.clean({ synCarTiltAmount: 900 }).synCarTiltAmount, 200);
  assert.equal(settings.clean({ synBobbingAmount: 'x' }).synBobbingAmount, 100);
  // Inferno's height on its own scale (100% what 200% was), 25-150%.
  assert.equal(settings.clean({}).ifFlameHeight, 100);
  assert.equal(settings.clean({ ifFlameHeight: 10 }).ifFlameHeight, 25);
  assert.equal(settings.clean({ ifFlameHeight: 300 }).ifFlameHeight, 150);
  // Synthwave's Speed: 50-150% in steps of 5, 100% by default.
  assert.equal(settings.clean({}).synSpeed, 100);
  assert.equal(settings.clean({ synSpeed: 33 }).synSpeed, 50);
  assert.equal(settings.clean({ synSpeed: 122 }).synSpeed, 120);
  assert.equal(settings.clean({ synSpeed: 400 }).synSpeed, 150);
  // The visualizers' own (VIZ_OPTIONS): colours, boxes, ranges in their steps, choices.
  assert.equal(settings.clean({ visualizer: 'lightning' }).visualizer, 'lightning');
  assert.equal(d.ltColor, '#a9c4ff');
  assert.equal(settings.clean({ ltColor: '#FFAA00' }).ltColor, '#ffaa00');
  assert.equal(settings.clean({ ltColor: 'blue' }).ltColor, '#a9c4ff');
  assert.equal(d.ltRain, true);
  assert.equal(settings.clean({ ltRain: false }).ltRain, false);
  assert.equal(settings.clean({ ltRain: 'no' }).ltRain, true);
  assert.equal(settings.clean({ ltStrikes: 3 }).ltStrikes, 25);
  assert.equal(settings.clean({ ltStrikes: 133 }).ltStrikes, 135);
  assert.equal(settings.clean({ ltStrikes: null }).ltStrikes, 100);
  assert.equal(settings.clean({ ltFlashAmount: 0 }).ltFlashAmount, 0);
  assert.equal(settings.clean({ eqColors: 'greyscale' }).eqColors, 'greyscale');
  // The clouds: rainbow and half as many by default; amount in steps of 10, 0 allowed.
  assert.equal(d.cloudsColors, 'rainbow');
  assert.equal(d.cloudsAmount, 50);
  assert.equal(d.trendMenuOpen, false);
  assert.equal(settings.clean({ cloudsColors: 'blue' }).cloudsColors, 'blue');
  assert.equal(settings.clean({ cloudsColors: 'greyscale' }).cloudsColors, 'rainbow');
  assert.equal(settings.clean({ cloudsAmount: 0 }).cloudsAmount, 0);
  assert.equal(settings.clean({ cloudsAmount: 74 }).cloudsAmount, 70);
  assert.equal(settings.clean({ cloudsAmount: 400 }).cloudsAmount, 100);
  assert.equal(settings.clean({ cloudsAmount: 'lots' }).cloudsAmount, 50);
  // Settings' folded categories and the phone's last category: kept, tidied.
  assert.deepEqual(d.settingsCollapsed, []);
  assert.equal(d.settingsCategory, '');
  assert.deepEqual(settings.clean({ settingsCollapsed: ['General', 'General', 3, '', 'Flow Server'] }).settingsCollapsed, ['General', 'Flow Server']);
  assert.deepEqual(settings.clean({ settingsCollapsed: 'General' }).settingsCollapsed, []);
  assert.equal(settings.clean({ settingsCategory: 'App' }).settingsCategory, 'App');
  assert.equal(settings.clean({ settingsCategory: 7 }).settingsCategory, '');
  // Bars' colours: Lime by default, the old Winamp and Equalizer left behind.
  assert.equal(d.brColors, 'lime');
  assert.equal(settings.clean({ brColors: 'ice' }).brColors, 'ice');
  assert.equal(settings.clean({ brColors: 'classic' }).brColors, 'lime');
  assert.equal(settings.clean({ brColors: 'equalizer' }).brColors, 'lime');
  // Waveform: rainbow bars by default.
  assert.equal(d.wfColors, 'rainbow');
  assert.equal(d.wfStyle, 'bars');
  assert.equal(settings.clean({ wfStyle: 'wave', wfColors: 'blue' }).wfStyle, 'wave');
  assert.equal(settings.clean({ wfColors: 'black' }).wfColors, 'rainbow');
  // Nebula is Kaleidoscope, its own look first and chosen by default; Aurora
  // Waves, Liquid and Mandala are their own now, no longer its looks.
  assert.equal(settings.clean({ visualizer: 'nebula' }).visualizer, 'kaleidoscope');
  assert.equal(d.ksLook, 'kaleido');
  assert.equal(settings.clean({ ksLook: 'liquid' }).ksLook, 'kaleido');
  assert.equal(settings.clean({ ksLook: 'auto' }).ksLook, 'auto');
  assert.equal(settings.clean({ ksLook: 'starburst' }).ksLook, 'starburst');
  assert.equal(settings.clean({ visualizer: 'mandala' }).visualizer, 'mandala');
  assert.equal(settings.clean({ visualizer: 'aurorawaves' }).visualizer, 'aurorawaves');
  assert.equal(d.lqTrails, 100);
  assert.equal(settings.clean({ awTrails: 7 }).awTrails, 25);
});

test('a metered connection is told apart from a free one', () => {
  assert.equal(parseCost('Unrestricted|False|False\r\n'), false);
  assert.equal(parseCost('Fixed|False|False'), true);
  assert.equal(parseCost('Variable|False|False'), true);
  assert.equal(parseCost('Unrestricted|True|False'), true);
  assert.equal(parseCost('Unrestricted|False|True'), true);
  assert.equal(parseCost('none'), false);
  assert.equal(parseCost(''), false);
});

test('the server settings are kept tidy', () => {
  const s = settings.clean({ serverOn: 'yes', serverHome: '  192.168.0.63:7878 ', serverKeepFiles: 0, serverSecret: 5 });
  assert.equal(s.serverOn, false);
  assert.equal(s.serverHome, '192.168.0.63:7878');
  assert.equal(s.serverRemote, '');
  assert.equal(s.serverKeepFiles, true);
  assert.equal(s.serverAutoSync, true);
  assert.equal(s.serverMetered, false);
  assert.equal(s.serverSecret, '');
  assert.equal(settings.clean({ serverKeepFiles: false }).serverKeepFiles, false);
  // Both addresses are used unless switched off.
  assert.equal(s.serverHomeOn, true);
  assert.equal(s.serverRemoteOn, true);
  const off = settings.clean({ serverHomeOn: false, serverRemoteOn: false });
  assert.equal(off.serverHomeOn, false);
  assert.equal(off.serverRemoteOn, false);
});
