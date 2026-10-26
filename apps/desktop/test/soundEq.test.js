'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SoundEq = require('../renderer/app/soundEq');

const RATE = 48000;

/** The filter's gain (dB) at `hz`, straight from its taps. */
function gainAt(ir, hz) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < ir.length; i += 1) {
    const ph = (-2 * Math.PI * hz * i) / RATE;
    re += ir[i] * Math.cos(ph);
    im += ir[i] * Math.sin(ph);
  }
  return 20 * Math.log10(Math.hypot(re, im));
}

test('the bands run from 20 Hz to 20 kHz, evenly on a log scale', () => {
  const fs = SoundEq.freqs(16);
  assert.equal(fs.length, 16);
  assert.ok(Math.abs(fs[0] - 20) < 1e-9);
  assert.ok(Math.abs(fs[15] - 20000) < 1e-6);
  const ratio = fs[1] / fs[0];
  for (let i = 1; i < fs.length; i += 1) assert.ok(Math.abs(fs[i] / fs[i - 1] - ratio) < 1e-9);
});

test('the curve eases from point to point, flat at each one', () => {
  const pts = [[100, 0], [400, 6]];
  assert.equal(SoundEq.at(pts, 50), 0);
  assert.equal(SoundEq.at(pts, 100), 0);
  assert.ok(Math.abs(SoundEq.at(pts, 200) - 3) < 1e-9);
  assert.equal(SoundEq.at(pts, 400), 6);
  assert.equal(SoundEq.at(pts, 5000), 6);
  // Eased: the first eighth of the way rises less than an eighth of the step.
  assert.ok(SoundEq.at(pts, 100 * 4 ** 0.125) < 6 / 8);
  assert.equal(SoundEq.at([], 1000), 0);
});

test('Standard is flat, Bass Boost lifts up to 250 Hz with its peak at 80 Hz', () => {
  assert.deepEqual(SoundEq.presetGains('standard', 16), new Array(16).fill(0));
  const fs = SoundEq.freqs(16);
  const bass = SoundEq.presetGains('bass', 16);
  assert.equal(bass[0], 4);
  fs.forEach((f, i) => {
    if (f < 250) assert.ok(bass[i] > 0 && bass[i] <= 6);
    else assert.equal(bass[i], 0);
    // Rising up to 80 Hz, falling after it.
    if (i > 0 && f <= 80) assert.ok(bass[i] >= bass[i - 1]);
    if (i > 0 && fs[i - 1] >= 80) assert.ok(bass[i] <= bass[i - 1]);
  });
  assert.equal(SoundEq.at(SoundEq.PRESETS.bass.points, 80), 6);
  // Any number of bands: the same curve.
  assert.equal(SoundEq.presetGains('bass', 48)[0], 4);
  assert.equal(SoundEq.presetGains('bass', 8)[7], 0);
});

test('Subtle holds the bass down, Intimate is a wave with its top at 500 Hz', () => {
  const subtle = SoundEq.PRESETS.subtle.points;
  for (const hz of [20, 50, 80, 150]) assert.ok(SoundEq.at(subtle, hz) < 0);
  const intimate = SoundEq.PRESETS.intimate.points;
  assert.equal(SoundEq.at(intimate, 20), -6);
  assert.equal(SoundEq.at(intimate, 500), 6);
  assert.equal(SoundEq.at(intimate, 20000), -3);
  assert.ok(SoundEq.at(intimate, 100) > -6 && SoundEq.at(intimate, 100) < 6);
  assert.ok(SoundEq.at(intimate, 4000) > -3 && SoundEq.at(intimate, 4000) < 6);
});

test('the settings give the gains shown: a preset, or Custom spread over the bands', () => {
  assert.deepEqual(SoundEq.gainsOf({ soundEqBands: 16, soundEqPreset: 'standard', soundEqCustom: [] }), new Array(16).fill(0));
  assert.equal(SoundEq.gainsOf({ soundEqBands: 24, soundEqPreset: 'bass', soundEqCustom: [] }).length, 24);
  // Custom with none of its own yet: flat.
  assert.deepEqual(SoundEq.gainsOf({ soundEqBands: 8, soundEqPreset: 'custom', soundEqCustom: [] }), new Array(8).fill(0));
  const own = [3, 3, 3, 3, -2, -2, -2, -2];
  assert.deepEqual(SoundEq.gainsOf({ soundEqBands: 8, soundEqPreset: 'custom', soundEqCustom: own }), own);
  assert.equal(SoundEq.gainsOf({ soundEqBands: 16, soundEqPreset: 'custom', soundEqCustom: own }).length, 16);
});

test('more or fewer bands keep the shape of the curve', () => {
  const own = SoundEq.presetGains('intimate', 16);
  const more = SoundEq.resample(own, 48);
  assert.equal(more.length, 48);
  assert.equal(more[0], own[0]);
  assert.equal(more[47], own[15]);
  // Every old point is still on the new curve.
  const pts = SoundEq.pointsOf(more);
  SoundEq.freqs(16).forEach((f, i) => assert.ok(Math.abs(SoundEq.at(pts, f) - own[i]) < 0.35, `${f} Hz`));
  const fewer = SoundEq.resample(own, 8);
  assert.equal(fewer.length, 8);
  assert.deepEqual(SoundEq.resample(own, 16), own);
});

test('the filter sounds as the curve is drawn, between the points too', () => {
  const gains = [6, 6, 4, 0, -3, -3, 0, 2, 5, 5, -6, -6, 0, 3, 3, 1];
  const ir = SoundEq.impulse(gains, RATE);
  assert.equal(ir.length, 16384);
  const pts = SoundEq.pointsOf(gains);
  const fs = SoundEq.freqs(gains.length);
  // At each band and halfway (on the log scale) to the next.
  for (let i = 0; i < fs.length; i += 1) {
    const where = i < fs.length - 1 ? [fs[i], Math.sqrt(fs[i] * fs[i + 1])] : [fs[i]];
    for (const hz of where) {
      const want = SoundEq.at(pts, hz);
      const got = gainAt(ir, hz);
      assert.ok(Math.abs(got - want) < 0.5, `${hz.toFixed(0)} Hz: ${got.toFixed(2)} dB, the curve ${want.toFixed(2)}`);
    }
  }
});

test('the filter holds nothing back: its weight comes at the start', () => {
  const ir = SoundEq.impulse(SoundEq.presetGains('bass', 16), RATE);
  let peak = 0;
  for (let i = 1; i < ir.length; i += 1) if (Math.abs(ir[i]) > Math.abs(ir[peak])) peak = i;
  assert.ok(peak < 48, `peak at sample ${peak}`);
  // A flat curve is a single tap.
  const flat = SoundEq.impulse(new Array(16).fill(0), RATE);
  assert.ok(Math.abs(flat[0] - 1) < 1e-6);
  assert.ok(Math.abs(flat[100]) < 1e-6);
});

test("the phone's player gets the curve at 64 frequencies, between the points too; flat is none", () => {
  assert.deepEqual(SoundEq.sampled(new Array(16).fill(0)), { hz: [], db: [] });
  const gains = SoundEq.presetGains('bass', 16);
  const { hz, db } = SoundEq.sampled(gains);
  assert.equal(hz.length, SoundEq.NATIVE_POINTS);
  assert.equal(db.length, SoundEq.NATIVE_POINTS);
  assert.equal(hz[0], 20);
  assert.equal(hz[hz.length - 1], 20000);
  for (let i = 1; i < hz.length; i += 1) assert.ok(hz[i] > hz[i - 1]);
  // Each one where the drawn line is, not only at the band points.
  const pts = SoundEq.pointsOf(gains);
  hz.forEach((f, i) => assert.ok(Math.abs(db[i] - SoundEq.at(pts, f)) < 0.01, `${f} Hz`));
  assert.ok(Math.max(...db) > 5.5);
  assert.ok(Math.abs(db[db.length - 1]) < 0.01);
});
