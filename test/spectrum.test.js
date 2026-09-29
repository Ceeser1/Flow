'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Analyser, FFT } = require('../renderer/app/spectrum');

const RATE = 48000;

function sine(hz, length, { amp = 0.5, from = 0 } = {}) {
  const out = new Float32Array(length);
  for (let i = from; i < length; i += 1) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

function mix(...signals) {
  const out = new Float32Array(signals[0].length);
  for (const s of signals) for (let i = 0; i < out.length; i += 1) out[i] += s[i];
  return out;
}

function peakBar(levels, from = 0, to = levels.length) {
  let best = from;
  for (let i = from; i < to; i += 1) if (levels[i] > levels[best]) best = i;
  return best;
}

test('the FFT finds a bin-centred sine in its bin', () => {
  const n = 64;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i += 1) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
  fft.transform(re, im);
  assert.ok(Math.abs(Math.hypot(re[5], im[5]) - n / 2) < 1e-9);
  assert.ok(Math.hypot(re[6], im[6]) < 1e-9);
});

test('the window is short enough to react within 100 ms', () => {
  const a = new Analyser({ sampleRate: RATE, bars: 250 });
  assert.ok(a.n / RATE <= 0.1, `window ${a.n / RATE}s`);
  const b = new Analyser({ sampleRate: 44100, bars: 250 });
  assert.ok(b.n / 44100 <= 0.1, `window ${b.n / 44100}s`);
});

for (const hz of [27.5, 41.2, 55, 98, 146.8, 440, 1000, 3000]) {
  test(`a ${hz} Hz tone peaks at its own bar`, () => {
    const a = new Analyser({ sampleRate: RATE, bars: 250 });
    const levels = a.analyse(sine(hz, a.inputLength));
    const bar = peakBar(levels);
    const want = a.position(hz) - 0.5;
    assert.ok(Math.abs(bar - want) <= 1, `peak at bar ${bar} (${a.barHz(bar).toFixed(1)} Hz), wanted ${want.toFixed(1)}`);
    // A 0.5 amplitude sine is -6 dBFS. Higher up a bar is the average of the
    // several bins it covers, which a lone tone only fills one of.
    if (hz < 600) assert.ok(levels[bar] > -9 && levels[bar] < 0, `level ${levels[bar].toFixed(1)} dB`);
  });
}

test('a bass note stays narrow: half its height within a few bars', () => {
  const a = new Analyser({ sampleRate: RATE, bars: 250 });
  const levels = a.analyse(sine(41.2, a.inputLength));
  const bar = peakBar(levels);
  let width = 0;
  for (let i = 0; i < levels.length; i += 1) if (levels[i] > levels[bar] - 3) width += 1;
  // Without reassignment an 11.7 Hz bin covers about 23 bars at 41 Hz.
  assert.ok(width <= 12, `width ${width} bars`);
});

test('two notes an octave apart in the bass show as two peaks', () => {
  const a = new Analyser({ sampleRate: RATE, bars: 250 });
  const levels = a.analyse(mix(sine(55, a.inputLength), sine(110, a.inputLength)));
  const p1 = a.position(55) - 0.5;
  const p2 = a.position(110) - 0.5;
  const valley = Math.round((p1 + p2) / 2);
  const low = peakBar(levels, 0, valley);
  const high = peakBar(levels, valley, levels.length);
  assert.ok(Math.abs(low - p1) <= 1.5 && Math.abs(high - p2) <= 1.5, `${low}, ${high}`);
  assert.ok(levels[valley] < levels[low] - 12, 'no dip between them');
});

test('silence reads as nothing', () => {
  const a = new Analyser({ sampleRate: RATE, bars: 250 });
  const levels = a.analyse(new Float32Array(a.inputLength));
  assert.ok(Math.max(...levels) < -100);
});

test('a note 60 ms old already shows within 3 dB of its full level', () => {
  const a = new Analyser({ sampleRate: RATE, bars: 250 });
  const steady = a.analyse(sine(110, a.inputLength));
  const bar = peakBar(steady);
  const full = steady[bar];
  const onset = a.inputLength - Math.round(0.06 * RATE);
  const early = a.analyse(sine(110, a.inputLength, { from: onset }));
  assert.ok(early[bar] > full - 3, `${early[bar].toFixed(1)} vs ${full.toFixed(1)}`);
});
