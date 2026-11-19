'use strict';

// Smarter shuffle (5.1.1): no artist twice in a row where the list has
// others, songs mostly skipped early drawn less often, every song still once
// a round.

const test = require('node:test');
const assert = require('node:assert');
const PlayQueue = require('../renderer/app/queue');

function seeded(seed = 7) {
  let n = seed;
  return () => {
    n = (n * 9301 + 49297) % 233280;
    return n / 233280;
  };
}

/** A queue with shuffle and Smarter shuffle over `songs` ({ id: { artist, weight } }). */
function smartQueue(songs, random = seeded()) {
  const q = new PlayQueue(random, 20);
  q.shuffle = true;
  q.smart = (id) => (songs[id] ? { artists: [songs[id].artist], weight: songs[id].weight == null ? 1 : songs[id].weight } : null);
  return q;
}

test('Smarter shuffle never puts the same artist twice in a row while others are left', () => {
  const songs = {};
  const ids = [];
  // Longer than the queue (a shorter list is queued whole, its order kept round after round).
  ['a', 'b', 'c'].forEach((artist) => {
    for (let i = 0; i < 12; i += 1) {
      songs[`${artist}${i}`] = { artist };
      ids.push(`${artist}${i}`);
    }
  });
  for (let seed = 1; seed < 30; seed += 1) {
    const q = smartQueue(songs, seeded(seed));
    const played = [q.start('list', ids)];
    for (let i = 0; i < 100; i += 1) played.push(q.next(ids));
    for (let i = 1; i < played.length; i += 1) {
      assert.notStrictEqual(songs[played[i]].artist, songs[played[i - 1]].artist, `seed ${seed} at ${i}: ${played.join(',')}`);
    }
  }
});

test('Smarter shuffle still plays a list of one artist, and every song once a round', () => {
  const songs = {};
  const ids = [];
  for (let i = 0; i < 8; i += 1) {
    songs[`s${i}`] = { artist: 'solo' };
    ids.push(`s${i}`);
  }
  const q = smartQueue(songs);
  const round = [q.start('list', ids)];
  for (let i = 0; i < 7; i += 1) round.push(q.next(ids));
  assert.deepStrictEqual([...new Set(round)].sort(), ids.slice().sort());
});

test('songs skipped early come later in the round', () => {
  const songs = {};
  const ids = [];
  for (let i = 0; i < 40; i += 1) {
    // Every artist its own, so only the weights matter.
    songs[`s${i}`] = { artist: `artist${i}`, weight: i < 5 ? 0.2 : 1 };
    ids.push(`s${i}`);
  }
  let skippedEarly = 0;
  let tries = 0;
  for (let seed = 1; seed < 60; seed += 1) {
    const q = smartQueue(songs, seeded(seed));
    const first = [q.start('list', ids)];
    for (let i = 0; i < 9; i += 1) first.push(q.next(ids));
    skippedEarly += first.filter((id) => songs[id].weight < 1).length;
    tries += first.length;
  }
  // Drawn plainly, 5 of 40 songs would be an eighth of the first ten; leaned away from, far fewer.
  assert.ok(skippedEarly / tries < 0.06, `share ${skippedEarly / tries}`);
});

test('without Smarter shuffle the draws are the plain ones', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const plain = new PlayQueue(() => 0, 20);
  plain.shuffle = true;
  const smart = smartQueue({ a: { artist: 'x' }, b: { artist: 'y' }, c: { artist: 'z' }, d: { artist: 'w' } }, () => 0);
  assert.strictEqual(plain.start('l', ids), smart.start('l', ids));
  assert.deepStrictEqual(plain.auto, smart.auto);
});

test('shuffleWeight: 1 unless skipped early twice, down to 0.2', () => {
  const weight = PlayQueue.shuffleWeight;
  assert.strictEqual(weight(undefined), 1);
  assert.strictEqual(weight({ skips: 1 }), 1);
  assert.ok(Math.abs(weight({ skips: 4 }) - 0.2) < 1e-9);
  assert.ok(Math.abs(weight({ skips: 9 }) - 0.2) < 1e-9);
  assert.ok(weight({ skips: 2, plays: 10 }) > 0.9);
});

test('a long list is drawn from by sampling, with the same rules', () => {
  const songs = {};
  const ids = [];
  for (let i = 0; i < 3000; i += 1) {
    songs[`s${i}`] = { artist: `artist${i % 7}`, weight: i % 10 === 0 ? 0.2 : 1 };
    ids.push(`s${i}`);
  }
  const q = smartQueue(songs, seeded(3));
  const played = [q.start('list', ids)];
  for (let i = 0; i < 600; i += 1) played.push(q.next(ids));
  for (let i = 1; i < played.length; i += 1) assert.notStrictEqual(songs[played[i]].artist, songs[played[i - 1]].artist);
  assert.strictEqual(new Set(played).size, played.length);
  const low = played.filter((id) => songs[id].weight < 1).length / played.length;
  // A tenth of the list, drawn a fifth as gladly: about 2 %.
  assert.ok(low < 0.05, `share ${low}`);
});
