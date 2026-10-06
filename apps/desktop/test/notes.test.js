'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Notes = require('../renderer/app/notes');

const RATE = 48000;

/** One 16384-sample frame of these notes (MIDI numbers), each with its first overtones. */
function chord(midis, { phase = 0 } = {}) {
  const out = new Float32Array(16384);
  for (const m of midis) {
    const f = Notes.hz(m);
    for (let h = 1; h <= 3; h += 1) {
      const amp = 0.15 / h;
      for (let i = 0; i < out.length; i += 1) out[i] += amp * Math.sin((2 * Math.PI * f * h * (i + phase)) / RATE);
    }
  }
  return out;
}

function top(chroma, n) {
  return Array.from(chroma).map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, n).map((x) => x[1]).sort((a, b) => a - b);
}

test('a single note is found, and named', () => {
  const notes = new Notes({ sampleRate: RATE });
  notes.analyse(chord([69]), 1 / 60);
  assert.equal(notes.strongest, 69);
  assert.equal(Notes.name(notes.strongest), 'A4');
  assert.equal(top(notes.chroma, 1)[0], 9);
});

test('a low bass note is told from its neighbour', () => {
  const notes = new Notes({ sampleRate: RATE });
  notes.analyse(chord([40]), 1 / 60); // E2
  assert.equal(notes.strongest, 40);
  notes.analyse(chord([41]), 1 / 60); // F2
  assert.equal(notes.strongest, 41);
});

test('a C major chord lights C, E and G', () => {
  const notes = new Notes({ sampleRate: RATE });
  notes.analyse(chord([60, 64, 67]), 1 / 60);
  assert.deepEqual(top(notes.chroma, 3), [0, 4, 7]);
});

test('I-IV-V-I in G major is heard as G major', () => {
  const notes = new Notes({ sampleRate: RATE });
  const G = [43, 55, 59, 62];
  const C = [48, 55, 60, 64];
  const D = [50, 54, 57, 62];
  const prog = [G, C, D, G];
  for (let f = 0; f < 60 * 16; f += 1) notes.analyse(chord(prog[Math.floor(f / 60) % 4], { phase: f * 800 }), 1 / 60);
  assert.equal(Notes.keyName(notes.key, notes.minor), 'G major');
});

test('A minor (i-iv-v-i) is heard as A minor', () => {
  const notes = new Notes({ sampleRate: RATE });
  const Am = [45, 57, 60, 64];
  const Dm = [50, 57, 62, 65];
  const Em = [52, 59, 64, 67];
  const prog = [Am, Dm, Em, Am];
  for (let f = 0; f < 60 * 16; f += 1) notes.analyse(chord(prog[Math.floor(f / 60) % 4], { phase: f * 800 }), 1 / 60);
  assert.equal(Notes.keyName(notes.key, notes.minor), 'A minor');
});

test('silence fades everything out', () => {
  const notes = new Notes({ sampleRate: RATE });
  notes.analyse(chord([60]), 1 / 60);
  for (let i = 0; i < 40; i += 1) notes.analyse(null, 1 / 60);
  assert.ok(notes.chroma.every((v) => v < 0.01));
});
