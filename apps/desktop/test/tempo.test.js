'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Tempo = require('../renderer/app/tempo');

/**
 * Feeds `seconds` of frames at `fps` with a jump on every beat of `bpm`
 * (starting `offset` seconds in), a little on the off-beats and some noise.
 * Returns the tempo and the times its beats ticked.
 */
function run({ bpm, fps = 60, seconds = 20, offset = 0.1, offbeat = 0.3, noise = 0.05, seed = 1 }) {
  const tempo = new Tempo();
  const period = 60 / bpm;
  let r = seed;
  const rand = () => {
    r = (r * 16807) % 2147483647;
    return r / 2147483647;
  };
  const ticks = [];
  const dt = 1 / fps;
  for (let f = 0; f * dt < seconds; f += 1) {
    const t0 = f * dt;
    const t1 = t0 + dt;
    let flux = noise * rand();
    // A beat (or off-beat) inside this frame jumps.
    const k0 = Math.ceil((t0 - offset) / (period / 2));
    for (let k = k0; offset + (k * period) / 2 < t1; k += 1) {
      if (k < 0) continue;
      flux += k % 2 === 0 ? 1 : offbeat;
    }
    tempo.push(flux, dt);
    if (tempo.tick) ticks.push(t1);
  }
  return { tempo, ticks, period };
}

/** How far each tick after `from` seconds is from its nearest beat, in ms. */
function offsets(ticks, period, offset, from = 10) {
  return ticks.filter((t) => t > from).map((t) => {
    let d = (((t - offset) % period) + period) % period;
    if (d > period / 2) d -= period;
    return d * 1000;
  });
}

for (const fps of [60, 144]) {
  for (const bpm of [92, 128, 150, 174]) {
    test(`finds ${bpm} BPM at ${fps} fps and ticks on the beats`, () => {
      const { tempo, ticks, period } = run({ bpm, fps });
      // Above 160 the half is as good a guess (drum and bass is felt either way).
      const ok = (b) => Math.abs(tempo.bpm / b - 1) < 0.01;
      assert.ok(ok(bpm) || (bpm > 160 && ok(bpm / 2)), `bpm ${tempo.bpm}`);
      assert.ok(tempo.confidence > 0.5, `confidence ${tempo.confidence}`);
      const off = offsets(ticks, period, 0.1);
      assert.ok(off.length > 10);
      // Within a frame and a bit of where the beats are (it runs 10 ms ahead).
      for (const o of off) assert.ok(Math.abs(o) < 1000 / fps + 15, `tick ${o.toFixed(1)} ms off`);
    });
  }
}

test('every beat ticks exactly once', () => {
  const { ticks, period } = run({ bpm: 120, seconds: 30 });
  const late = ticks.filter((t) => t > 10);
  for (let i = 1; i < late.length; i += 1) {
    const gap = late[i] - late[i - 1];
    assert.ok(Math.abs(gap / period - 1) < 0.1, `gap ${gap}`);
  }
});

test('noise without a beat is not sure of a tempo', () => {
  const { tempo } = run({ bpm: 120, offbeat: 0, noise: 1, offset: 1e9 });
  assert.ok(tempo.confidence < 0.3, `confidence ${tempo.confidence}`);
});

test('a song changing tempo is followed', () => {
  const tempo = new Tempo();
  const dt = 1 / 60;
  let next = 0;
  for (let t = 0; t < 40; t += dt) {
    const period = t < 20 ? 60 / 100 : 60 / 140;
    let flux = 0;
    if (t >= next) {
      flux = 1;
      next += period;
    }
    tempo.push(flux, dt);
  }
  assert.ok(Math.abs(tempo.bpm - 140) < 2, `bpm ${tempo.bpm}`);
});

test('silence after a beat lets the sureness fall', () => {
  const { tempo } = run({ bpm: 128 });
  const before = tempo.confidence;
  for (let i = 0; i < 60 * 12; i += 1) tempo.push(0, 1 / 60);
  assert.ok(tempo.confidence < before * 0.5, `confidence ${tempo.confidence}`);
});
