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
const { parseCost, parseNmMetered } = require('../src/network');
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
  // Flow (Settings) is gone: one saved falls back to Bars.
  assert.equal(settings.clean({ visualizer: 'flow' }).visualizer, 'bars');
  // Ferrofluid is gone too.
  assert.equal(settings.clean({ visualizer: 'ferrofluid' }).visualizer, 'bars');
  assert.equal(d.ffSpikes, undefined);
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
  assert.equal(d.ltRainAmount, 50);
  assert.equal(settings.clean({ ltRainAmount: 0 }).ltRainAmount, 0);
  assert.equal(settings.clean({ ltRainAmount: 140 }).ltRainAmount, 100);
  assert.equal(settings.clean({ ltStrikes: 3 }).ltStrikes, 25);
  assert.equal(settings.clean({ ltStrikes: 133 }).ltStrikes, 135);
  assert.equal(settings.clean({ ltStrikes: null }).ltStrikes, 100);
  assert.equal(settings.clean({ ltFlashAmount: 0 }).ltFlashAmount, 0);
  assert.equal(settings.clean({ eqColors: 'greyscale' }).eqColors, 'greyscale');
  // The clouds: rainbow and half as many by default; amount in steps of 10, 0 allowed.
  assert.equal(d.cloudsColors, 'rainbow');
  assert.equal(d.cloudsAmount, 50);
  assert.equal(d.trendMenuOpen, false);
  assert.equal(d.showTrend, true);
  assert.equal(settings.clean({ showTrend: false }).showTrend, false);
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
  // Administration's parts opened (all shut at first).
  assert.deepEqual(d.adminOpen, []);
  assert.deepEqual(settings.clean({ adminOpen: ['trash', 'trash', 'Trash', 3, '', 'uploads'] }).adminOpen, ['trash', 'uploads']);
  assert.deepEqual(settings.clean({ adminOpen: 'trash' }).adminOpen, []);
  assert.equal(settings.clean({ settingsCategory: 'App' }).settingsCategory, 'App');
  assert.equal(settings.clean({ settingsCategory: 7 }).settingsCategory, '');
  // Bars' colours: Lime by default, the old Winamp and Equalizer left behind.
  assert.equal(d.brColors, 'lime');
  assert.equal(settings.clean({ brColors: 'ice' }).brColors, 'ice');
  assert.equal(settings.clean({ brColors: 'classic' }).brColors, 'lime');
  assert.equal(settings.clean({ brColors: 'equalizer' }).brColors, 'lime');
  // Own colours after the schemes: blue by default; Orb's Ember, Ice and
  // White and Halo's Warm white became own ones.
  for (const [scheme, key] of [['brColors', 'brColor'], ['rdColor', 'rdOwnColor'], ['skColors', 'skColor'], ['obColors', 'obColor'],
    ['vnColors', 'vnColor'], ['stColors', 'stColor'], ['raColors', 'raColor'], ['szInk', 'szColor'], ['hlColors', 'hlColor']]) {
    assert.equal(d[key], '#3484f4');
    assert.equal(settings.clean({ [scheme]: 'custom' })[scheme], 'custom');
  }
  const ember = settings.clean({ obColors: 'ember' });
  assert.equal(ember.obColors, 'custom');
  assert.equal(ember.obColor, '#ff8a33');
  assert.equal(settings.clean({ obColors: 'rainbow' }).obColors, 'rainbow');
  const warm = settings.clean({ hlColors: 'white', hlColor: '#00ff00' });
  assert.equal(warm.hlColors, 'custom');
  assert.equal(warm.hlColor, '#ffbd80');
  // Halo's cover and background: the song's by default, or a picture picked (its path kept).
  assert.equal(d.hlCover, 'original');
  assert.equal(d.hlBack, 'cover');
  assert.equal(d.hlCoverFile, '');
  assert.equal(d.hlWiggle, true);
  assert.equal(d.hlPulse, true);
  // Halo's Spin is gone: a saved one is dropped.
  assert.equal(d.hlSpin, undefined);
  assert.equal('hlSpin' in settings.clean({ hlSpin: true }), false);
  // Halo's sparks: 0-200% in steps of 5, 100% by default (10% what there were before).
  assert.equal(d.hlSparkAmount, 100);
  assert.equal(settings.clean({ hlSparkAmount: 0 }).hlSparkAmount, 0);
  assert.equal(settings.clean({ hlSparkAmount: 12 }).hlSparkAmount, 10);
  assert.equal(settings.clean({ hlSparkAmount: 500 }).hlSparkAmount, 200);
  assert.equal(settings.clean({ hlCover: 'pick', hlCoverFile: 'C:\\Flow\\Visualizer\\halo-cover-x.jpg' }).hlCoverFile, 'C:\\Flow\\Visualizer\\halo-cover-x.jpg');
  assert.equal(settings.clean({ hlCover: 'other' }).hlCover, 'original');
  assert.equal(settings.clean({ hlBackFile: 7 }).hlBackFile, '');
  assert.equal(settings.clean({ hlBackFile: 'x'.repeat(1001) }).hlBackFile, '');
  // Waveform: rainbow bars by default.
  assert.equal(d.wfColors, 'rainbow');
  assert.equal(d.wfStyle, 'bars');
  assert.equal(settings.clean({ wfStyle: 'wave', wfColors: 'blue' }).wfStyle, 'wave');
  assert.equal(settings.clean({ wfColors: 'black' }).wfColors, 'rainbow');
  // Its own colour: blue by default; the old one-colour schemes become one.
  assert.equal(d.wfColor, '#3484f4');
  const red = settings.clean({ wfColors: 'red' });
  assert.equal(red.wfColors, 'custom');
  assert.equal(red.wfColor, '#ed1d1d');
  assert.equal(settings.clean({ wfColors: 'custom', wfColor: '#00FF80' }).wfColor, '#00ff80');
  assert.equal(settings.clean({ wfColors: 'custom', wfColor: 'nope' }).wfColor, '#3484f4');
  // Nebula is Kaleidoscope, its own look first and chosen by default; Aurora
  // Waves is Aurora; Liquid and Mandala (its looks, then their own) are gone.
  assert.equal(settings.clean({ visualizer: 'nebula' }).visualizer, 'kaleidoscope');
  assert.equal(d.ksLook, 'kaleido');
  assert.equal(settings.clean({ ksLook: 'liquid' }).ksLook, 'kaleido');
  assert.equal(settings.clean({ ksLook: 'auto' }).ksLook, 'auto');
  assert.equal(settings.clean({ ksLook: 'starburst' }).ksLook, 'starburst');
  assert.equal(settings.clean({ visualizer: 'mandala' }).visualizer, 'bars');
  assert.equal(settings.clean({ visualizer: 'liquid' }).visualizer, 'bars');
  assert.equal(settings.clean({ visualizer: 'aurorawaves' }).visualizer, 'aurora');
  assert.equal(d.lqTrails, undefined);
  // The visualizers' categories: a Random each, and which are folded shut.
  assert.equal(settings.clean({ visualizer: 'random-worlds' }).visualizer, 'random-worlds');
  assert.equal(settings.clean({ visualizer: 'random-nope' }).visualizer, 'bars');
  assert.deepEqual(d.vizCollapsed, []);
  assert.deepEqual(settings.clean({ vizCollapsed: ['trippy', 'trippy', 'nope', 3, 'worlds'] }).vizCollapsed, ['trippy', 'worlds']);
  assert.deepEqual(settings.clean({ vizCollapsed: 'trippy' }).vizCollapsed, []);
  // Aurora's Glare: 50-150%, 100% by default.
  assert.equal(d.auGlare, 100);
  assert.equal(settings.clean({ auGlare: 20 }).auGlare, 50);
  assert.equal(settings.clean({ auGlare: 151 }).auGlare, 150);
  assert.equal(settings.clean({ ksTrails: 7 }).ksTrails, 25);
  // Inferno's burning forest: on by default.
  assert.equal(d.ifForest, true);
  assert.equal(settings.clean({ ifForest: false }).ifForest, false);
  // Stained Glass: the cover's colours and the torches by default.
  assert.equal(d.sgGlass, 'cover');
  assert.equal(settings.clean({ sgGlass: 'cold' }).sgGlass, 'cold');
  assert.equal(settings.clean({ sgGlass: 'blue' }).sgGlass, 'cover');
  assert.equal(d.sgTorches, true);
  assert.equal(settings.clean({ sgTorches: false }).sgTorches, false);
  // Fountain Show: rainbow lamps, the bass in the middle, 40 jets, 1 G, ripples on.
  assert.equal(d.fnColors, 'rainbow');
  assert.equal(d.fnLayout, 'middle');
  assert.equal(settings.clean({ fnLayout: 'right' }).fnLayout, 'middle');
  assert.equal(d.fnJets, 40);
  assert.equal(settings.clean({ fnJets: 70 }).fnJets, 64);
  assert.equal(d.fnGravity, 100);
  assert.equal(settings.clean({ fnGravity: 30 }).fnGravity, 50);
  assert.equal(settings.clean({ fnGravity: 117 }).fnGravity, 115);
  assert.equal(d.fnRipples, true);
  assert.equal(d.fnBursts, undefined);
  // The render scales: 75% by default; Disco's put to 75% once also where
  // 100% was saved, after that left as chosen.
  for (const key of ['dcScale', 'lhScale', 'ntScale', 'bhScale', 'ifScale']) {
    assert.equal(d[key], '75');
    assert.equal(settings.clean({ [key]: '50', dcScale75: true })[key], '50');
    assert.equal(settings.clean({ [key]: '60', dcScale75: true })[key], '75');
  }
  assert.equal(settings.clean({ dcScale: '100' }).dcScale, '75');
  assert.equal(settings.clean({ dcScale: '50' }).dcScale75, true);
  assert.equal(settings.clean({ dcScale: '100', dcScale75: true }).dcScale, '100');
  assert.equal(settings.clean(settings.clean({ dcScale: '100' })).dcScale, '75');
  // Seismograph: green grid paper, a colour for each of 8 pens, the paper at 100%.
  assert.equal(d.szPaper, 'green');
  assert.equal(settings.clean({ szPaper: 'pink' }).szPaper, 'green');
  assert.equal(d.szInk, 'classic');
  assert.equal(d.szPens, 8);
  assert.equal(settings.clean({ szPens: 20 }).szPens, 12);
  assert.equal(d.szSpeed, 100);
  assert.equal(settings.clean({ szSpeed: 30 }).szSpeed, 50);
  // Not Spectrogram's speed (sgSpeed).
  assert.equal(d.sgSpeed, 100);
  assert.equal(settings.clean({ ifForest: 'no' }).ifForest, true);
});

test('the sound equalizer: 16 flat bands by default, 8 to 48, Custom points within 12 dB', () => {
  const d = settings.clean({});
  assert.equal(d.soundEqBands, 16);
  assert.equal(d.soundEqPreset, 'standard');
  assert.deepEqual(d.soundEqCustom, []);
  assert.equal(settings.clean({ soundEqBands: 4 }).soundEqBands, 8);
  assert.equal(settings.clean({ soundEqBands: 64 }).soundEqBands, 64);
  assert.equal(settings.clean({ soundEqBands: 80 }).soundEqBands, 64);
  assert.equal(settings.clean({ soundEqBands: '20.4' }).soundEqBands, 20);
  assert.equal(settings.clean({ soundEqBands: 'many' }).soundEqBands, 16);
  assert.equal(settings.clean({ soundEqPreset: 'bass' }).soundEqPreset, 'bass');
  assert.equal(settings.clean({ soundEqPreset: 'loud' }).soundEqPreset, 'standard');
  const own = [20, -20, 1.234, 0, 0, 0, 0, '3'];
  assert.deepEqual(settings.clean({ soundEqCustom: own }).soundEqCustom, [12, -12, 1.2, 0, 0, 0, 0, 3]);
  assert.deepEqual(settings.clean({ soundEqCustom: [1, 2, 3] }).soundEqCustom, []);
  assert.deepEqual(settings.clean({ soundEqCustom: new Array(8).fill('x') }).soundEqCustom, []);
  assert.deepEqual(settings.clean({ soundEqCustom: 'loud' }).soundEqCustom, []);
});

test('a metered connection is told apart from a free one', () => {
  assert.equal(parseCost('Unrestricted|False|False\r\n'), false);
  assert.equal(parseCost('Fixed|False|False'), true);
  assert.equal(parseCost('Variable|False|False'), true);
  assert.equal(parseCost('Unrestricted|True|False'), true);
  assert.equal(parseCost('Unrestricted|False|True'), true);
  assert.equal(parseCost('none'), false);
  assert.equal(parseCost(''), false);
  // NetworkManager on Linux: 1 yes, 3 guessed yes (a phone's hotspot); 2 and 4 no, 0 unknown.
  assert.equal(parseNmMetered('u 1\n'), true);
  assert.equal(parseNmMetered('u 3'), true);
  assert.equal(parseNmMetered('u 2'), false);
  assert.equal(parseNmMetered('u 4'), false);
  assert.equal(parseNmMetered('u 0'), false);
  assert.equal(parseNmMetered(''), false);
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
  // The names given to servers here: tidied, empty ones dropped.
  assert.deepEqual(s.serverNames, {});
  assert.deepEqual(settings.clean({ serverNames: { s1: '  Pi   Upstairs ', s2: '', s3: 5, '': 'x' } }).serverNames, { s1: 'Pi Upstairs' });
  assert.deepEqual(settings.clean({ serverNames: ['Pi'] }).serverNames, {});
});
