'use strict';

// client/libraryMerge.js: a server's changes merged into an app's copy, the
// rows nothing came for kept as they are (4.6). Held against the merge as it
// was before (every row made anew by cleaning the whole merged library):
// value for value the same, over many random changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/libraryModel');
const { mergeChanges, lockRows } = require('../src/client/libraryMerge');

const T = 1700000000000;
const copy = (v) => JSON.parse(JSON.stringify(v));

/** remote.js mergeChanges() as it was before 4.6. */
function mergeAsBefore(lib, c) {
  const goneSongs = new Set((c.deletedSongs || []).map(String));
  const changedSongs = new Map((c.songs || []).map((s) => [String(s.id), s]));
  const songs = [];
  for (const s of lib.songs) {
    if (goneSongs.has(s.id)) continue;
    const now = changedSongs.get(s.id);
    songs.push(now || s);
    changedSongs.delete(s.id);
  }
  songs.push(...changedSongs.values());
  const goneLists = new Set((c.deletedPlaylists || []).map(String));
  const changedLists = new Map((c.playlists || []).map((p) => [String(p.id), p]));
  const playlists = [];
  for (const p of lib.playlists) {
    if (goneLists.has(p.id)) continue;
    playlists.push(changedLists.get(p.id) || p);
    changedLists.delete(p.id);
  }
  playlists.push(...changedLists.values());
  const follows = Array.isArray(c.follows) ? c.follows : lib.follows;
  const groups = Array.isArray(c.groups) ? c.groups : lib.groups;
  const unshared = new Set((c.unshared || []).map(String));
  const changedShared = new Map((c.sharedPlaylists || []).map((p) => [String(p.id), p]));
  const groupFollows = Array.isArray(c.groupFollows) ? c.groupFollows : lib.groupFollows || [];
  const sharedGroups = Array.isArray(c.sharedGroups) ? c.sharedGroups : lib.sharedGroups || [];
  const groupSkips = c.groupSkips && typeof c.groupSkips === 'object' ? c.groupSkips : lib.groupSkips || {};
  const followed = model.followedIds({
    follows, groupFollows, groupSkips, sharedGroups,
  });
  const shared = [];
  for (const p of lib.sharedPlaylists) {
    if (unshared.has(p.id) || !followed.has(p.id)) continue;
    shared.push(changedShared.get(p.id) || p);
    changedShared.delete(p.id);
  }
  shared.push(...changedShared.values());
  return model.sanitize({
    ...lib, songs, playlists, groups, follows, groupFollows, groupSkips, sharedPlaylists: shared, sharedGroups, profileNames: c.profileNames || lib.profileNames,
  });
}

function randomOf(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A song as a server sends it (its shared fields, no stats). */
const sent = (id, n) => ({
  id, file: `Downloads/Song ${id} v${n}.mp3`, title: `Song ${id} v${n}`, artist: `Artist ${n % 4}`, mix: '', album: n % 2 ? 'Album' : '', genre: 'Rock', subGenre: '', infoLooked: true, duration: 100 + (n % 50), format: 'mp3', sourceUrl: '', sourceKey: `k${id}`, sourcePlaylistUrl: '', addedAt: T + n, addedBy: 'default', loudness: -14, cover: 'abcd1234', cut: '', ...(n % 3 ? { lyrics: `l${n}` } : {}),
});

function start() {
  const songs = Array.from({ length: 30 }, (_, i) => sent(`s${i}`, i));
  const entries = (ids) => ids.map((i) => ({ songId: `s${i}`, addedAt: T + i }));
  return lockRows(model.sanitize({
    songs,
    groups: [{ id: 'g1', name: 'One', createdAt: T }, { id: 'g2', name: 'Two', createdAt: T }],
    playlists: [
      { id: 'fav-x', name: 'Favourites', createdAt: T, favourites: true, entries: entries([1, 2]) },
      { id: 'p1', name: 'Rock', createdAt: T, groups: ['g1'], entries: entries([0, 1, 2, 3, 4]) },
      { id: 'p2', name: 'Jazz', createdAt: T, groups: ['g1', 'g2'], entries: entries([5, 6, 7]) },
      { id: 'p3', name: 'Smart', createdAt: T, rules: { match: 'all', conditions: [{ field: 'artist', op: 'contains', value: 'A' }] } },
    ],
    follows: ['sh1'],
    groupFollows: ['sg1'],
    sharedPlaylists: [
      { id: 'sh1', name: 'Theirs', createdAt: T, ownerId: 'o', ownerName: 'O', entries: entries([8, 9, 10]) },
      { id: 'sh2', name: 'In their group', createdAt: T, ownerId: 'o', ownerName: 'O', entries: entries([11, 12]) },
    ],
    sharedGroups: [{ id: 'sg1', name: 'Their group', createdAt: T, ownerId: 'o', ownerName: 'O', playlists: ['sh2'] }],
    profileNames: { default: 'Default / Shared', o: 'O' },
  }));
}

/** A random set of changes as a server could send them (and some it never would). */
function changes(lib, rnd, n) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const some = (share) => rnd() < share;
  const ids = lib.songs.map((s) => s.id);
  const c = { rev: n, songs: [], playlists: [], sharedPlaylists: [], unshared: [], deletedSongs: [], deletedPlaylists: [] };
  const entries = (count) => Array.from({ length: count }, () => ({ songId: some(0.9) && ids.length ? pick(ids) : `ghost${n}`, addedAt: T + n }));
  if (some(0.7) && ids.length) c.songs.push(sent(pick(ids), n));
  if (some(0.3)) c.songs.push(sent(`n${n}`, n));
  // The same again as the copy has it (changes that overlap).
  if (some(0.2) && lib.songs.length) c.songs.push(copy(pick(lib.songs)));
  // One that cannot be kept (no file): it leaves the copy.
  if (some(0.05) && ids.length) c.songs.push({ id: pick(ids), title: 'No file' });
  if (some(0.25) && ids.length) c.deletedSongs.push(pick(ids));
  if (some(0.4) && lib.playlists.length) {
    const p = pick(lib.playlists);
    c.playlists.push({ ...copy(p), name: some(0.5) ? `${p.name}!` : p.name, entries: p.rules ? [] : entries(1 + Math.floor(rnd() * 5)), groups: some(0.5) ? ['g1', 'g9'] : p.groups });
  }
  if (some(0.15)) c.playlists.push({ id: `p${n}`, name: `Made ${n}`, createdAt: T + n, entries: entries(3), groups: ['g2'] });
  if (some(0.1) && lib.playlists.length > 2) c.deletedPlaylists.push(pick(lib.playlists).id);
  if (some(0.15)) c.groups = some(0.5) ? [{ id: 'g1', name: 'One', createdAt: T }] : [{ id: 'g1', name: 'One', createdAt: T }, { id: 'g2', name: 'Two', createdAt: T }, { id: `g${n}`, name: `G${n}`, createdAt: T }];
  if (some(0.15)) c.follows = some(0.5) ? ['sh1'] : ['sh1', `sh${n}`, 'sh3'];
  if (some(0.1)) c.groupFollows = some(0.5) ? [] : ['sg1'];
  if (some(0.1)) c.groupSkips = some(0.5) ? {} : { sg1: ['sh2'] };
  if (some(0.1)) c.sharedGroups = [{ id: 'sg1', name: 'Their group', createdAt: T, ownerId: 'o', ownerName: 'O', playlists: some(0.5) ? ['sh2'] : ['sh2', 'sh3'] }];
  if (some(0.3)) c.sharedPlaylists.push({ id: pick(['sh1', 'sh2', 'sh3', `sh${n}`]), name: `Shared ${n}`, createdAt: T, ownerId: 'o', ownerName: 'O', entries: entries(4) });
  // One with the id of a playlist of the profile's own (never from a server): not taken as another's.
  if (some(0.03)) c.sharedPlaylists.push({ id: 'p1', name: 'Clash', createdAt: T, ownerId: 'o', ownerName: 'O', entries: entries(2) });
  if (some(0.08)) c.unshared.push(pick(['sh1', 'sh2', 'sh3']));
  if (some(0.1)) c.profileNames = { default: 'Default / Shared', o: `O${n}` };
  return c;
}

test('a server\'s changes merged: the same as cleaning the whole merged library, over many random changes', () => {
  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
    const rnd = randomOf(seed);
    let now = start();
    let then = copy(now);
    for (let n = 1; n <= 300; n += 1) {
      const c = changes(now, rnd, n);
      const next = mergeChanges(now, copy(c));
      then = mergeAsBefore(then, copy(c));
      assert.deepEqual(copy(next), copy(then), `seed ${seed}, change ${n}`);
      assert.equal(JSON.stringify(next), JSON.stringify(then), `seed ${seed}, change ${n}: also field for field in the same order`);
      now = next;
    }
  }
});

test('a server\'s changes merged: the rows nothing changed in are the rows they were, and all of them locked', () => {
  const rnd = randomOf(99);
  let lib = start();
  let kept = 0;
  let made = 0;
  for (let n = 1; n <= 300; n += 1) {
    const before = new Map(['songs', 'playlists', 'sharedPlaylists'].flatMap((k) => lib[k].map((row) => [`${k}/${row.id}`, [row, JSON.stringify(row)]])));
    const next = mergeChanges(lib, changes(lib, rnd, n));
    for (const k of ['songs', 'playlists', 'sharedPlaylists']) {
      for (const row of next[k]) {
        assert.ok(Object.isFrozen(row) && (!row.entries || Object.isFrozen(row.entries)) && (!row.stats || Object.isFrozen(row.stats)), `change ${n}: ${k} ${row.id} locked`);
        const [was, text] = before.get(`${k}/${row.id}`) || [];
        if (!was) continue;
        if (JSON.stringify(row) === text) {
          assert.equal(row, was, `change ${n}: ${k} ${row.id} reads the same and is the row it was`);
          kept += 1;
        } else made += 1;
      }
    }
    for (const [row, text] of before.values()) assert.equal(JSON.stringify(row), text, `change ${n}: the copy before was left as it was`);
    lib = next;
  }
  assert.ok(kept > made * 5, `most rows stay (${kept} kept, ${made} made anew)`);
});

test('one song changed among many: one row made, the playlists untouched', () => {
  const lib = start();
  const next = mergeChanges(lib, { rev: 2, songs: [sent('s3', 77)], deletedSongs: [], playlists: [], deletedPlaylists: [], sharedPlaylists: [], unshared: [] });
  assert.equal(next.songs.filter((s, i) => s !== lib.songs[i]).length, 1);
  assert.equal(next.songs[3].title, 'Song s3 v77');
  assert.ok(next.playlists.every((p, i) => p === lib.playlists[i]));
  assert.ok(next.sharedPlaylists.every((p, i) => p === lib.sharedPlaylists[i]));
  // A song deleted: only the playlists that held it are other rows.
  const less = mergeChanges(next, { rev: 3, songs: [], deletedSongs: ['s5'], playlists: [], deletedPlaylists: [], sharedPlaylists: [], unshared: [] });
  assert.equal(less.songs.length, 29);
  assert.deepEqual(less.playlists.map((p, i) => p === next.playlists[i]), [true, true, false, true]);
  assert.deepEqual(less.playlists[2].entries.map((e) => e.songId), ['s6', 's7']);
});
