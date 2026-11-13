'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJournal, LIBRARY_SPEC, KEY } = require('../src/journalFile');

/** Files in memory, as the journal's io; counts what was written. */
function memIo({ append = true } = {}) {
  const files = new Map();
  const io = {
    files,
    wrote: 0,
    appended: 0,
    read: (n) => (files.has(n) ? JSON.parse(files.get(n)) : null),
    write: (n, v) => {
      io.wrote += 1;
      files.set(n, JSON.stringify(v));
    },
    readText: (n) => (files.has(n) ? files.get(n) : null),
    writeText: (n, t) => {
      io.wrote += 1;
      files.set(n, t);
    },
    remove: (n) => files.delete(n),
  };
  if (append) {
    io.appendText = (n, t) => {
      io.appended += 1;
      files.set(n, (files.get(n) || '') + t);
    };
  }
  return io;
}

function lib(n = 50) {
  const songs = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Song ${i}`, stats: { plays: 0 } }));
  return {
    version: 1, songs, playlists: [{ id: 'p', name: 'P', entries: [{ songId: 's1', addedAt: 1 }] }], follows: [], listening: { days: {}, songMonths: {} }, statistics: { days: {}, sessions: {}, months: {} },
  };
}
const copy = (v) => JSON.parse(JSON.stringify(v));

test('changes go into the log, and loading puts them back on the whole', () => {
  const io = memIo();
  const j = createJournal(io, 'library.json', LIBRARY_SPEC);
  assert.equal(j.load(), null);
  const v = lib();
  j.save(v);
  assert.equal(io.files.has('library.json.log'), true);
  const wholeWrites = io.wrote;
  v.songs[3].title = 'Renamed';
  j.save(v);
  v.playlists[0].entries.push({ songId: 's2', addedAt: 2 });
  v.listening.songMonths['2026-11'] = { s3: 120 };
  j.save(v);
  j.save(v); // nothing changed: nothing written
  assert.equal(io.wrote, wholeWrites, 'the whole was not written again');
  assert.equal(io.appended, 3, 'the log started, then two changes');
  const again = createJournal(io, 'library.json', LIBRARY_SPEC).load();
  assert.deepEqual(again, copy(v));
  assert.equal(again[KEY], undefined, 'the journal id is not part of the value');
});

test('a last line cut off is left out, the changes before it stand', () => {
  const io = memIo();
  const j = createJournal(io, 'x.json', LIBRARY_SPEC);
  const v = lib();
  j.save(v);
  v.songs[0].title = 'One';
  j.save(v);
  const kept = copy(v);
  v.songs[1].title = 'Two';
  j.save(v);
  const log = io.files.get('x.json.log');
  io.files.set('x.json.log', log.slice(0, log.length - 7));
  assert.deepEqual(createJournal(io, 'x.json', LIBRARY_SPEC).load(), kept);
});

test('a log that belongs to another whole is not applied', () => {
  const io = memIo();
  const j = createJournal(io, 'x.json', LIBRARY_SPEC);
  const v = lib();
  j.save(v);
  v.songs[0].title = 'Changed';
  j.save(v);
  const oldLog = io.files.get('x.json.log');
  j.saveWhole(v); // a new whole and its log
  const whole = copy(v);
  // As when the program stopped after the whole and before the log started over.
  io.files.set('x.json.log', oldLog.replace(/"journal":"[^"]+"/, '"journal":"other"'));
  assert.deepEqual(createJournal(io, 'x.json', LIBRARY_SPEC).load(), whole);
});

test('the whole is written again once the log has grown to a share of it', () => {
  const io = memIo();
  const j = createJournal(io, 'x.json', LIBRARY_SPEC, { logShare: 0.25, logMin: 0 });
  const v = lib(20);
  j.save(v);
  for (let i = 0; i < 40; i += 1) {
    v.songs[i % 20].title = `T${i}`;
    j.save(v);
  }
  assert.ok(j.stats().whole >= 2, 'written whole again');
  assert.ok(j.stats().logBytes <= j.stats().wholeBytes * 0.25 + 400);
  assert.deepEqual(createJournal(io, 'x.json', LIBRARY_SPEC).load(), copy(v));
});

test('a file from before (no journal), and an app that cannot add to a file', () => {
  const io = memIo();
  io.files.set('x.json', JSON.stringify(lib(3)));
  const j = createJournal(io, 'x.json', LIBRARY_SPEC);
  const v = j.load();
  assert.equal(v.songs.length, 3);
  v.songs[0].title = 'New';
  j.save(v);
  assert.deepEqual(createJournal(io, 'x.json', LIBRARY_SPEC).load(), copy(v));

  const plain = memIo({ append: false });
  const k = createJournal(plain, 'y.json', LIBRARY_SPEC);
  const w = lib(3);
  k.save(w);
  w.songs[1].title = 'Changed';
  k.save(w);
  assert.equal(plain.files.has('y.json.log'), false);
  assert.deepEqual(plain.read('y.json'), copy(w), 'written whole, as before');
});

test('the name may be given later, by a function', () => {
  const io = memIo();
  let dir = 'a';
  const j = createJournal(io, () => `${dir}/x.json`, LIBRARY_SPEC);
  dir = 'b';
  j.save(lib(2));
  assert.ok(io.files.has('b/x.json') && io.files.has('b/x.json.log'));
});

// ---- rows kept themselves, locked (4.6) ----

test('with rows kept themselves the files end the same as with a copy of everything', () => {
  const ROWS = ['songs', 'playlists'];
  const a = memIo();
  const b = memIo();
  const whole = createJournal(a, 'library.json', LIBRARY_SPEC, { logMin: 4000 });
  const rows = createJournal(b, 'library.json', LIBRARY_SPEC, { logMin: 4000, rows: ROWS });
  const v = lib(60);
  whole.save(v);
  rows.save(v);
  assert.ok(Object.isFrozen(v.songs[0]), 'a saved row is locked');
  let wholes = 0;
  for (let r = 0; r < 300; r += 1) {
    const k = r % 6;
    const i = (r * 7) % v.songs.length;
    // As an owner of locked rows changes them: another row in its place.
    if (k === 0) v.songs[i] = { ...v.songs[i], title: `Song ${i} v${r}` };
    if (k === 1) v.songs[i] = { ...v.songs[i], stats: { plays: r } };
    if (k === 2) v.songs.push({ id: `n${r}`, title: `New ${r}`, stats: { plays: 0 } });
    if (k === 3) v.songs.splice(i, 1);
    if (k === 4) v.playlists[0] = { ...v.playlists[0], entries: [...v.playlists[0].entries, { songId: v.songs[i].id, addedAt: r }] };
    if (k === 5) {
      v.follows.push(`f${r}`);
      v.listening.days[`d${r % 9}`] = r;
    }
    whole.save(v);
    rows.save(v);
    const strip = (t) => t.replace(/"_journal":"[^"]*"/, '').replace(/"journal":"[^"]*"/, '');
    assert.equal(strip(b.files.get('library.json')), strip(a.files.get('library.json')), `round ${r}: the whole`);
    assert.equal(strip(b.files.get('library.json.log')), strip(a.files.get('library.json.log')), `round ${r}: the log`);
    if (rows.stats().whole > wholes) wholes = rows.stats().whole;
  }
  assert.ok(wholes > 1, 'the whole was written again in between');
  assert.ok(rows.stats().lines > 50, 'and lines were added');
  // Read again, it is what was saved.
  const again = createJournal(b, 'library.json', LIBRARY_SPEC, { rows: ROWS }).load();
  assert.deepEqual(again, JSON.parse(JSON.stringify(v)));
});

test('with rows kept themselves: what load() gives is locked, and rows made from it anew are saved without a line', () => {
  const io = memIo();
  const first = createJournal(io, 'library.json', LIBRARY_SPEC, { rows: ['songs', 'playlists'] });
  first.save(lib(20));
  const j = createJournal(io, 'library.json', LIBRARY_SPEC, { rows: ['songs', 'playlists'] });
  const raw = j.load();
  assert.ok(Object.isFrozen(raw.songs[0]) && Object.isFrozen(raw.playlists[0].entries));
  // The owner makes its rows from what was read (libraryModel.sanitize does).
  const mine = { ...raw, songs: raw.songs.map((s) => ({ ...s, stats: { ...s.stats } })), playlists: raw.playlists.map((p) => ({ ...p, entries: p.entries.map((e) => ({ ...e })) })) };
  const before = io.appended;
  j.save(mine);
  assert.equal(io.appended, before, 'the same in them: no line');
  mine.songs[3] = { ...mine.songs[3], title: 'Changed' };
  j.save(mine);
  assert.equal(io.appended, before + 1);
  assert.match(io.files.get('library.json.log').trim().split('\n').pop(), /"Changed"/);
  assert.equal(createJournal(io, 'library.json', LIBRARY_SPEC).load().songs[3].title, 'Changed');
});
