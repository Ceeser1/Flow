'use strict';

// Song Transition and Equalize volume on the iPhone: the end of a song played
// on by the tail while the next one fades up (equal power: the two volumes'
// squares add up to 1), and a song turned up (Boost), its peaks measured
// before and after, the limiter keeping a big boost under full scale. The
// test songs peak at 0.088 (a sine of 1/8, -3 dB from mono to stereo).

const { wait, playing, start } = require('./common');

// What the page said it plays, for the steps after.
const seen = {};

const gain = (g) => `await Capacitor.Plugins.FlowAudio.run({ ops: [{ op: 'gain', gain: ${g} }] });`;

module.exports = [
  ...start,
  {
    name: 'Song Transition on (4 s)',
    js: `
      await Store.saveSettings({ crossfade: true, crossfadeSeconds: 4 });
      return [Store.settings.crossfade, Store.settings.crossfadeSeconds, Store.can('songTransition')];
    `,
    expect: (v) => v[0] === true && v[1] === 4 && v[2] === true,
  },
  {
    // A song followed by one iOS plays (no Ogg Vorbis), from 30 s of its 45.
    name: 'near the end of a song',
    js: `
      const ids = Player.idsOf('all');
      const ok = (id) => !!id && !!Store.song(id) && Store.song(id).format !== 'ogg';
      const i = ids.findIndex((id, n) => ok(id) && ok(ids[n + 1]));
      Player.load(ids[i], 'all', { position: 30 });
      ${wait(2000)}
      return { from: Store.song(ids[i]).title, to: Store.song(ids[i + 1]).title, t: Math.round(Player.engine.time) };
    `,
    expect: (v) => {
      Object.assign(seen, v);
      return v.t >= 30;
    },
  },
  { name: 'the end made ready', native: 'effects', waitFor: (v) => v.tail && v.tailReady, timeout: 15000 },
  {
    name: 'the end fades out, the next song in',
    native: 'effects',
    waitFor: (v) => v.tailPlaying && v.fadeIn > 0.1 && v.fadeIn < 0.9,
    timeout: 15000,
    wait: 0,
    shot: '01-transition',
    expect: (v) => v.tailVolume > 0.05 && Math.abs(v.tailVolume ** 2 + v.fadeIn ** 2 - 1) < 0.2,
  },
  { name: 'transition over', native: 'effects', waitFor: (v) => !v.tail && v.fadeIn === 1, timeout: 15000 },
  {
    name: 'on to the next song',
    js: playing,
    expect: (v) => v.now === seen.to && !v.paused && v.t >= 3,
  },
  { name: 'turned up 2x', js: `${gain(2)} ${wait(3000)} return true;`, timeout: 10000 },
  {
    name: 'twice as loud',
    native: 'effects',
    waitFor: (v) => v.peakIn > 0 && v.peakOut > 0,
    timeout: 10000,
    expect: (v) => v.boost === 2 && Math.abs(v.peakOut / v.peakIn - 2) < 0.1,
  },
  // 0.088 x 20 = 1.77: bent down to just under 1.
  { name: 'turned up 20x', js: `${gain(20)} ${wait(3000)} return true;`, timeout: 10000 },
  {
    name: 'held under full scale',
    native: 'effects',
    waitFor: (v) => v.peakIn > 0 && v.peakOut > 0,
    timeout: 10000,
    expect: (v) => v.boost === 20 && v.peakOut > 0.95 && v.peakOut < 1,
  },
  { name: 'not turned up any more', js: `${gain(1)} Player.pause(); ${wait(500)} return Player.engine.paused;` },
];
