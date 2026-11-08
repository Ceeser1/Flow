'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/libraryPatch');

const SPEC = { songs: 'list', playlists: 'list', 'stats.songs': 'map' };

function lib() {
  return {
    version: 1,
    songs: [
      { id: 'a', title: 'One', stats: { plays: 1 }, tagged: 'x' },
      { id: 'b', title: 'Two', stats: { plays: 0 } },
      { id: 'c', title: 'Three', stats: { plays: 2 }, lyrics: 'l1' },
    ],
    playlists: [{ id: 'p', name: 'Mine', entries: [{ songId: 'a', addedAt: 1 }] }],
    follows: ['s1'],
    stats: { rev: 3, songs: { a: { plays: 1 }, b: { plays: 2 } } },
  };
}

const copy = (v) => JSON.parse(JSON.stringify(v));

/** Each change made to a copy: the steps from the first bring it back exactly. */
function roundTrip(change, opts = {}) {
  const was = lib();
  const now = copy(was);
  change(now);
  const steps = P.diff(was, now, SPEC, opts);
  const got = P.apply(was, steps);
  assert.deepEqual(copy(got), copy(now));
  return steps;
}

test('nothing changed: no steps', () => {
  assert.deepEqual(P.diff(lib(), lib(), SPEC), []);
});

test('a song changed: only that song travels, the others stay the same objects', () => {
  const was = lib();
  const now = copy(was);
  now.songs[1].title = 'Two (new)';
  const steps = P.diff(was, now, SPEC);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0][0], 'list');
  assert.deepEqual(steps[0][2].put.map((s) => s.id), ['b']);
  assert.equal(steps[0][2].order, undefined);
  const got = P.apply(was, steps);
  assert.equal(got.songs[1].title, 'Two (new)');
  assert.equal(got.songs[0], was.songs[0]);
  assert.equal(got.playlists, was.playlists);
  assert.notEqual(got.songs, was.songs);
  assert.equal(was.songs[1].title, 'Two', 'the old value is left as it was');
});

test('added, removed, reordered and nested changes all come back', () => {
  roundTrip((n) => n.songs.push({ id: 'd', title: 'Four' }));
  roundTrip((n) => n.songs.splice(1, 1));
  roundTrip((n) => n.songs.reverse());
  roundTrip((n) => { n.songs.unshift({ id: 'z', title: 'First' }); n.songs.splice(2, 1); });
  roundTrip((n) => { n.songs[0].stats.plays = 5; });
  roundTrip((n) => { n.playlists[0].entries.push({ songId: 'b', addedAt: 2 }); });
  roundTrip((n) => { n.follows = []; delete n.version; n.extra = { x: 1 }; });
  roundTrip((n) => { n.stats.songs.c = { plays: 1 }; delete n.stats.songs.a; n.stats.rev = 4; });
  roundTrip((n) => { n.songs = []; n.playlists = []; });
});

test('a field only some songs have, gained or lost, is seen', () => {
  const lost = roundTrip((n) => { delete n.songs[2].lyrics; });
  assert.deepEqual(lost[0][2].put.map((s) => s.id), ['c']);
  const gained = roundTrip((n) => { n.songs[1].lyrics = 'l2'; });
  assert.deepEqual(gained[0][2].put.map((s) => s.id), ['b']);
  roundTrip((n) => { n.songs[1].brandNew = true; });
});

test('ignored fields alone are no change', () => {
  assert.deepEqual(roundTripSteps((n) => { n.songs[0].tagged = 'y'; }), []);
  function roundTripSteps(change) {
    const was = lib();
    const now = copy(was);
    change(now);
    return P.diff(was, now, SPEC, { ignore: ['tagged'] });
  }
});

for (const plain of [false, true]) {
  test(`the differ tells only the changes since the last, and its copy stays its own${plain ? ' (compared without code made from text)' : ''}`, () => {
    P.plainCompare(plain);
    try {
      differRounds();
    } finally {
      P.plainCompare(false);
    }
  });
}

function differRounds() {
  const d = P.createDiffer(SPEC, { ignore: ['tagged'] });
  const v = lib();
  assert.equal(d.next(v), null, 'the first is told whole');
  assert.ok(d.started());
  v.songs[0].title = 'changed in place';
  const steps = d.next(v);
  assert.deepEqual(steps[0][2].put.map((s) => s.id), ['a']);
  assert.deepEqual(d.next(v), [], 'told already');
  const w = copy(v);
  w.songs[2].lyrics = 'l9';
  w.songs[1].title = 'x';
  delete w.songs[2].stats;
  assert.deepEqual(d.next(w)[0][2].put.map((s) => s.id).sort(), ['b', 'c']);
  // Many rounds of random changes: applied one after another, the window's copy ends equal.
  let mine = copy(w);
  let cur = copy(w);
  d.reset(cur);
  for (let r = 0; r < 200; r += 1) {
    const n = copy(cur);
    const k = r % 5;
    if (k === 0) n.songs.push({ id: `n${r}`, title: `T${r}`, ...(r % 3 ? { lyrics: 'x' } : {}) });
    if (k === 1 && n.songs.length) n.songs.splice(r % n.songs.length, 1);
    if (k === 2 && n.songs.length) n.songs[r % n.songs.length].title += '!';
    if (k === 3) n.songs.sort((a, b) => (a.title < b.title ? -1 : 1));
    if (k === 4) n.stats.songs[`s${r}`] = { plays: r };
    const steps = d.next(n);
    mine = P.apply(mine, steps);
    cur = n;
  }
  assert.deepEqual(copy(mine), copy(cur));
}
