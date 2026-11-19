'use strict';

// Temporary Playlists (5.2): this session's lists (a song radio, an artist
// radio), kept only in the window until one is saved.

const test = require('node:test');
const assert = require('node:assert/strict');
const TempLists = require('../renderer/app/tempLists');

const radio = (name) => `${name} Radio`;

function fresh() {
  TempLists._lists = [];
  TempLists._count = 0;
  TempLists._listeners = [];
  return TempLists;
}

test('a list is shaped like a playlist under an id of its own, its songs in their order', () => {
  const t = fresh();
  const list = t.add({ title: 'Porcelain', wrap: radio, ids: ['a', 'b', 'c'], seed: { songId: 'a' }, now: 1000 });
  assert.equal(list.id, 'temp:1');
  assert.equal(list.name, 'Porcelain Radio');
  assert.equal(list.isTemp, true);
  assert.deepEqual(list.entries.map((e) => e.songId), ['a', 'b', 'c']);
  // One date for all: a page that sorts newest first (a stable sort) keeps the order made.
  assert.deepEqual([...new Set(list.entries.map((e) => e.addedAt))], [1000]);
  assert.ok(t.isTemp(list.id));
  assert.ok(!t.isTemp('all') && !t.isTemp('session:1') && !t.isTemp(null));
  assert.equal(t.get(list.id), list);
  assert.equal(t.get('temp:9'), null);
});

test('several lists in one session: the newest first, the last made is the latest', () => {
  const t = fresh();
  const a = t.add({ title: 'Moby', wrap: radio, ids: ['a', 'b'] });
  const b = t.add({ title: 'Portishead', wrap: radio, ids: ['c', 'd'] });
  assert.deepEqual(t.all().map((l) => l.id), [b.id, a.id]);
  assert.equal(t.latest(), b);
  t.remove(b.id);
  assert.equal(t.latest(), a);
  // An id is never used twice in a session.
  assert.equal(t.add({ title: 'Air', wrap: radio, ids: ['e', 'f'] }).id, 'temp:3');
});

test('the same radio started again is a new list, "... (2)"; a saved playlist\'s name is not taken either', () => {
  const t = fresh();
  const one = t.add({ title: 'Moby', wrap: radio, ids: ['a', 'b'] });
  const two = t.add({ title: 'Moby', wrap: radio, ids: ['b', 'a'] });
  const three = t.add({ title: 'moby', wrap: radio, ids: ['a', 'b'] });
  assert.deepEqual([one.name, two.name, three.name], ['Moby Radio', 'Moby Radio (2)', 'moby Radio (3)']);
  assert.notEqual(one.id, two.id);
  const saved = new Set(['air radio', 'air radio (2)']);
  const air = t.add({ title: 'Air', wrap: radio, ids: ['a', 'b'], taken: (n) => saved.has(n.toLowerCase()) });
  assert.equal(air.name, 'Air Radio (3)');
});

test('a long title is cut so the name fits a playlist\'s, keeping " Radio" and the number', () => {
  const t = fresh();
  const long = 'A very long song title that goes on and on, far past what a playlist may be called, and then some more';
  const one = t.add({ title: long, wrap: radio, ids: ['a', 'b'] });
  assert.ok(one.name.length <= t.MAX_NAME, one.name);
  assert.ok(one.name.endsWith('… Radio'), one.name);
  assert.ok(one.name.startsWith('A very long song title'), one.name);
  const two = t.add({ title: long, wrap: radio, ids: ['a', 'b'] });
  assert.ok(two.name.length <= t.MAX_NAME, two.name);
  assert.ok(two.name.endsWith('… Radio (2)'), two.name);
  // Exactly as long as allowed: not cut.
  const exact = 'x'.repeat(t.MAX_NAME - ' Radio'.length);
  assert.equal(t.nameFor(exact, radio), `${exact} Radio`);
  assert.equal(t.nameFor(`${exact}y`, radio).length, t.MAX_NAME);
});

test('saving: under its own name, or the next free one when a playlist took it meanwhile', () => {
  const t = fresh();
  const list = t.add({ title: 'Moby', wrap: radio, ids: ['a', 'b'] });
  assert.equal(t.saveName(list), 'Moby Radio');
  const saved = new Set(['moby radio']);
  assert.equal(t.saveName(list, (n) => saved.has(n.toLowerCase())), 'Moby Radio (2)');
  // The other temporary lists' names do not count here: only what is saved.
  const second = t.add({ title: 'Moby', wrap: radio, ids: ['a', 'b'] });
  assert.equal(second.name, 'Moby Radio (2)');
  assert.equal(t.saveName(second), 'Moby Radio (2)');
});

test('a song taken out: the list has new entries (what was worked out for the old ones is not used), listeners are told', () => {
  const t = fresh();
  let told = 0;
  t.onChange(() => { told += 1; });
  const list = t.add({ title: 'Moby', wrap: radio, ids: ['a', 'b', 'c'] });
  assert.equal(told, 1);
  const before = list.entries;
  assert.equal(t.removeSong(list.id, 'b'), true);
  assert.notEqual(list.entries, before);
  assert.deepEqual(before.map((e) => e.songId), ['a', 'b', 'c']);
  assert.deepEqual(list.entries.map((e) => e.songId), ['a', 'c']);
  assert.equal(told, 2);
  // Not in it, or no such list: nothing changes and nobody is told.
  assert.equal(t.removeSong(list.id, 'zzz'), false);
  assert.equal(t.removeSong('temp:99', 'a'), false);
  assert.equal(told, 2);
});

test('thrown away one by one, or all at once (another server or profile)', () => {
  const t = fresh();
  let told = 0;
  const a = t.add({ title: 'Moby', wrap: radio, ids: ['a', 'b'] });
  t.add({ title: 'Air', wrap: radio, ids: ['c', 'd'] });
  t.onChange(() => { told += 1; });
  assert.equal(t.remove(a.id), true);
  assert.equal(t.remove(a.id), false);
  assert.equal(t.get(a.id), null);
  assert.equal(told, 1);
  t.clear();
  assert.deepEqual(t.all(), []);
  assert.equal(t.latest(), null);
  assert.equal(told, 2);
  // Nothing left: nobody is told again.
  t.clear();
  assert.equal(told, 2);
});

test('nothing of it is kept: a list has only what the window holds (no file, no setting)', () => {
  const t = fresh();
  const list = t.add({ title: 'Moby', wrap: radio, ids: ['a', 'b'], seed: { artist: 'Moby' } });
  assert.deepEqual(Object.keys(list).sort(), ['createdAt', 'entries', 'id', 'isTemp', 'name', 'seed', 'title', 'wrap']);
  assert.deepEqual(list.seed, { artist: 'Moby' });
});
