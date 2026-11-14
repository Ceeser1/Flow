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

test('a spec path with * stands for any key: each profile songs as a map', () => {
  const spec = { songs: 'list', 'profiles.*.songs': 'map' };
  const was = { songs: [{ id: 'a' }], profiles: { p1: { name: 'Anna', songs: { a: { plays: 1 }, b: { plays: 2 } } }, p2: { name: 'Ben', songs: {} } } };
  const now = copy(was);
  now.profiles.p1.songs.a.plays = 3;
  now.profiles.p2.name = 'Benjamin';
  now.profiles.p3 = { name: 'New', songs: { a: { plays: 0 } } };
  const steps = P.diff(was, now, spec);
  assert.deepEqual(steps.map((s) => [s[0], s[1].join('.')]), [['map', 'profiles.p1.songs'], ['set', 'profiles.p2.name'], ['set', 'profiles.p3']]);
  assert.deepEqual(Object.keys(steps[0][2].put), ['a']);
  assert.deepEqual(copy(P.apply(was, steps)), now);
});

test('keys with dots in them are kept apart (paths are arrays)', () => {
  const spec = { 'm.*.x': 'map' };
  const was = { m: { 'a.b': { x: { k: 1 } } } };
  const now = { m: { 'a.b': { x: { k: 2 } } } };
  const steps = P.diff(was, now, spec);
  assert.deepEqual(steps[0][1], ['m', 'a.b', 'x']);
  assert.deepEqual(P.apply(was, steps), now);
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

// ---- rows kept themselves, locked (4.6) ----

const ROWS = ['songs', 'playlists', 'stats.songs', 'profiles.*.songs'];
const ROWS_SPEC = { ...SPEC, 'profiles.*.songs': 'map' };

/** A small random number source, the same every run. */
function randomOf(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random change to `v`, made as an owner of locked rows makes it: the row replaced, never written to. */
function changeRows(v, rnd, r) {
  const pick = (n) => Math.floor(rnd() * n);
  const k = pick(12);
  const songs = v.songs;
  if (k === 0) songs.push({ id: `n${r}`, title: `T${r}`, stats: { plays: 0 }, ...(r % 3 ? { lyrics: 'x' } : {}) });
  else if (k === 1 && songs.length) songs.splice(pick(songs.length), 1);
  else if (k === 2 && songs.length) {
    const i = pick(songs.length);
    songs[i] = { ...songs[i], title: `${songs[i].title}!` };
  } else if (k === 3 && songs.length) {
    const i = pick(songs.length);
    songs[i] = { ...songs[i], stats: { plays: (songs[i].stats ? songs[i].stats.plays : 0) + 1 } };
  } else if (k === 4) v.songs = songs.slice().sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  // A map of rows is kept itself, locked: another map in its place.
  else if (k === 5) v.stats.songs = { ...v.stats.songs, [`s${pick(8)}`]: { plays: r } };
  else if (k === 6) {
    const less = { ...v.stats.songs };
    delete less[`s${pick(8)}`];
    v.stats.songs = less;
  } else if (k === 7 && songs.length) {
    // Another object with the same in it: no change.
    const i = pick(songs.length);
    songs[i] = copy(songs[i]);
  } else if (k === 8) {
    const p = v.playlists[0];
    v.playlists[0] = { ...p, entries: [...p.entries, { songId: `n${r}`, addedAt: r }] };
  } else if (k === 9) v.follows = [...v.follows, `f${r}`];
  else if (k === 10) {
    const id = `pr${pick(3)}`;
    if (!v.profiles[id]) v.profiles[id] = { songs: {}, name: id };
    // Now and then the same map again (nothing of it to tell), else another with one more in it.
    if (r % 3) v.profiles[id].songs = { ...v.profiles[id].songs, [`s${pick(8)}`]: { stats: { plays: r } } };
    v.profiles[id].name = `${id}-${r}`;
  } else if (k === 11) delete v.profiles[`pr${pick(3)}`];
}

test('rows kept themselves: the same steps as with a copy of everything, over many random changes', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const rnd = randomOf(seed);
    const v = { ...lib(), profiles: {} };
    const whole = P.createDiffer(ROWS_SPEC);
    const rows = P.createDiffer(ROWS_SPEC, { rows: ROWS });
    whole.reset(v);
    rows.reset(v);
    let mine = copy(v);
    for (let r = 0; r < 400; r += 1) {
      changeRows(v, rnd, r);
      const a = whole.next(v);
      const b = rows.next(v);
      assert.deepEqual(b, a, `seed ${seed}, round ${r}`);
      mine = P.apply(mine, b);
      // Now and then nothing changed in between.
      if (r % 7 === 0) assert.deepEqual(rows.next(v), [], `seed ${seed}, round ${r}: told already`);
    }
    assert.deepEqual(copy(mine), copy(v), `seed ${seed}: the steps applied end the same`);
  }
});

test('rows kept themselves are locked: a write to one throws, a row put in its place is told', () => {
  const v = lib();
  const d = P.createDiffer(SPEC, { rows: ['songs', 'playlists', 'stats.songs'] });
  d.reset(v);
  assert.ok(Object.isFrozen(v.songs[0]) && Object.isFrozen(v.songs[0].stats), 'a song and what is in it');
  assert.ok(Object.isFrozen(v.playlists[0].entries) && Object.isFrozen(v.playlists[0].entries[0]), 'a playlist\'s entries');
  assert.ok(Object.isFrozen(v.stats.songs.a) && Object.isFrozen(v.stats.songs), 'a map of rows and its values');
  assert.ok(!Object.isFrozen(v.songs) && !Object.isFrozen(v.stats) && !Object.isFrozen(v), 'not the lists of rows, nor what holds them');
  assert.throws(() => { v.stats.songs.c = { plays: 5 }; }, TypeError);
  assert.throws(() => { v.songs[0].title = 'written into'; }, TypeError);
  assert.throws(() => { v.songs[0].stats.plays = 9; }, TypeError);
  assert.throws(() => { v.playlists[0].entries.push({ songId: 'b', addedAt: 2 }); }, TypeError);
  assert.equal(v.songs[0].title, 'One');
  assert.deepEqual(d.next(v), []);
  // The list is the owner's to change: a row in another's place, one more, one less.
  v.songs[1] = { ...v.songs[1], title: 'Two again' };
  v.songs.push({ id: 'd', title: 'Four' });
  v.songs.splice(0, 1);
  const steps = d.next(v);
  assert.deepEqual(steps[0][2].put.map((s) => s.id), ['b', 'd']);
  assert.deepEqual(steps[0][2].gone, ['a']);
  // What was told is locked now too, and the steps hold copies, not the rows.
  assert.ok(Object.isFrozen(v.songs[0]) && Object.isFrozen(v.songs[2]));
  assert.ok(!Object.isFrozen(steps[0][2].put[0]) && steps[0][2].put[0] !== v.songs[0]);
  // The rest is still compared by what is in it, written to as ever.
  v.follows.push('s2');
  v.stats.rev = 4;
  assert.deepEqual(d.next(v).map((s) => s[1].join('.')).sort(), ['follows', 'stats.rev']);
  // A map of rows: another one in its place is told by what differs in it, the same one not at all.
  v.stats.songs = { ...v.stats.songs, c: { plays: 5 } };
  const told = d.next(v);
  assert.deepEqual(told, [['map', ['stats', 'songs'], { put: { c: { plays: 5 } }, gone: [] }]]);
  assert.ok(Object.isFrozen(v.stats.songs));
  const less = { ...v.stats.songs };
  delete less.a;
  v.stats.songs = less;
  assert.deepEqual(d.next(v), [['map', ['stats', 'songs'], { put: {}, gone: ['a'] }]]);
  assert.deepEqual(d.next(v), []);
});

test('rows kept themselves: equal rows that are other objects are taken without a step, then alike at once', () => {
  const v = lib();
  const d = P.createDiffer(SPEC, { rows: ['songs', 'playlists', 'stats.songs'] });
  // As after loading: what is kept was read from the file, the owner's rows are made from it anew.
  d.reset(copy(v));
  assert.deepEqual(d.next(v), [], 'the same in it: nothing to tell');
  assert.ok(v.songs.every((s) => Object.isFrozen(s)), 'and the owner\'s rows are the ones kept now');
  v.songs[2] = { ...v.songs[2], lyrics: 'l2' };
  assert.deepEqual(d.next(v)[0][2].put.map((s) => s.id), ['c']);
});

test('lock() locks all the way down and leaves what is locked alone; a copy of a locked row is free', () => {
  const row = { id: 'a', stats: { plays: 1 }, entries: [{ songId: 'x' }], none: null };
  assert.equal(P.lock(row), row);
  assert.ok(Object.isFrozen(row) && Object.isFrozen(row.stats) && Object.isFrozen(row.entries) && Object.isFrozen(row.entries[0]));
  assert.equal(P.lock(row), row);
  assert.equal(P.lock(null), null);
  assert.equal(P.lock(5), 5);
  const c = P.clone(row);
  c.stats.plays = 2;
  c.entries.push({ songId: 'y' });
  assert.equal(row.stats.plays, 1);
  assert.deepEqual(c, { id: 'a', stats: { plays: 2 }, entries: [{ songId: 'x' }, { songId: 'y' }], none: null });
});

test('clone() leaves undefined out and copies every level', () => {
  const v = { a: 1, b: undefined, c: { d: undefined, e: [1, undefined, { f: undefined, g: 2 }] } };
  const c = P.clone(v);
  assert.deepEqual(Object.keys(c), ['a', 'c']);
  assert.deepEqual(Object.keys(c.c), ['e']);
  assert.deepEqual(c.c.e, [1, null, { g: 2 }]);
  assert.notEqual(c.c, v.c);
  assert.notEqual(c.c.e[2], v.c.e[2]);
});
