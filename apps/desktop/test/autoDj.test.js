'use strict';

// "Continue with similar songs" (4.0): AutoDJ's picks, and the queue going on
// with them once the list has played through.

const test = require('node:test');
const assert = require('node:assert/strict');
const AutoDJ = require('../renderer/app/autoDj');
const PlayQueue = require('../renderer/app/queue');

const song = (id, artist, extra = {}) => ({ id, artist, title: id, duration: 200, ...extra });
const heard = (sessions, skips = 0, plays = sessions) => ({ stats: { sessions, listened: sessions * 200, plays, skips } });

const LIB = [
  song('porcelain', 'Moby', { genre: 'Electronic', album: 'Play' }),
  song('natural', 'Moby', { genre: 'Electronic', album: 'Play', ...heard(3) }),
  song('bodyrock', 'Moby', { genre: 'Electronic', ...heard(9) }),
  song('teardrop', 'Massive Attack', { genre: 'Trip Hop', ...heard(20) }),
  song('angel', 'Massive Attack, Horace Andy', { genre: 'Trip Hop' }),
  song('roads', 'Portishead', { genre: 'Trip Hop', subGenre: 'Bristol' }),
  song('glory', 'Portishead', { genre: 'Trip Hop', subGenre: 'Bristol', ...heard(1, 5, 1) }),
  song('numb', 'Linkin Park', { genre: 'Nu Metal', ...heard(30) }),
];

test('similar songs: the same artists first, then genre and Info; mostly skipped ones never', () => {
  const after = AutoDJ.similar(LIB, ['porcelain']);
  assert.deepEqual(after.slice(0, 2).sort(), ['bodyrock', 'natural']);
  assert.ok(!after.includes('numb') && !after.includes('teardrop'), 'nothing alike');
  const trip = AutoDJ.similar(LIB, ['roads']);
  assert.equal(trip[0], 'teardrop', 'the same genre, listened to most');
  assert.ok(!trip.includes('glory'), 'skipped early more than heard');
  // The duet counts for Massive Attack.
  assert.equal(AutoDJ.similar(LIB, ['teardrop'], new Set(['roads']))[0], 'angel');
  // Played lately or queued: left out.
  assert.ok(!AutoDJ.similar(LIB, ['porcelain'], new Set(['natural'])).includes('natural'));
  // The same songs heard give the same order (a copy of the queue picks the same).
  assert.deepEqual(AutoDJ.similar(LIB, ['roads', 'teardrop']), AutoDJ.similar(LIB, ['roads', 'teardrop']));
  // Nothing alike at all: what is listened to most.
  assert.equal(AutoDJ.similar([...LIB, song('lone', 'Nobody')], ['lone'])[0], 'numb');
});

test('the queue: the list to its end, then similar songs; a song of the list picked goes back to it', () => {
  const list = ['porcelain', 'natural'];
  const q = new PlayQueue(() => 0, 20);
  q.continueWith = (seeds, avoid) => AutoDJ.similar(LIB, seeds, avoid);
  assert.equal(q.start('pl', list, 'porcelain'), 'porcelain');
  assert.equal(q.auto[0], 'natural');
  assert.ok(q.dj.has(q.auto[1]), 'after the list: similar songs');
  assert.equal(q.auto[1], 'bodyrock', 'Moby again');
  assert.ok(!q.auto.includes('porcelain'), 'not the list over again');
  q.next(list);
  q.next(list);
  assert.equal(q.currentId, 'bodyrock');
  assert.equal(q.djOn, true);
  // A copy (the phone's look-ahead) goes on the same way.
  const copy = new PlayQueue(() => 0, 20);
  copy.restore(q.snapshot());
  copy.continueWith = q.continueWith;
  assert.deepEqual(copy.next(list), q.next(list));
  // Picked by hand from the list: the list again.
  q.jump('porcelain', list);
  assert.equal(q.auto[0], 'natural', 'the list again from there');
  assert.ok(q.dj.has(q.auto[1]), 'and similar songs after its end once more');
  // Off: lists start over as before.
  const plain = new PlayQueue(() => 0, 20);
  plain.start('pl', list, 'porcelain');
  plain.next(list);
  assert.equal(plain.next(list), 'porcelain');
});

test('with shuffle: similar songs once every song of the list had its turn', () => {
  const list = ['roads', 'teardrop'];
  const q = new PlayQueue(() => 0, 20);
  q.shuffle = true;
  q.continueWith = (seeds, avoid) => AutoDJ.similar(LIB, seeds, avoid);
  q.start('pl', list);
  assert.equal(q.currentId, 'roads');
  assert.equal(q.auto[0], 'teardrop');
  assert.ok(q.dj.has(q.auto[1]));
  assert.ok(!list.includes(q.auto[1]));
});
