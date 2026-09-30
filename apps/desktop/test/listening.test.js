'use strict';

// Listening statistics (src/libraryModel.js), the Listen behaviour lists
// (renderer/app/smartLists.js) and the "3 days ago" wording (util.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('@flow/core/libraryModel');
const SmartLists = require('../renderer/app/smartLists');
const Util = require('../renderer/app/util');

function lib(count = 1) {
  const data = m.emptyLibrary();
  for (let i = 1; i <= count; i += 1) {
    m.addSong(data, {
      id: 's' + i, file: `C:\\M\\s${i}.mp3`, title: 'T' + i, artist: 'A', mix: '',
      duration: 200, format: 'mp3', sourceUrl: '', sourceKey: '', addedAt: i * 1000,
    });
  }
  return data;
}

test('a listen is a play from 75%, an early skip under 30 s, a stop between', () => {
  const data = lib();
  assert.equal(m.recordListen(data, 's1', { listened: 150, duration: 200, at: 5 }), 'play');
  assert.equal(m.recordListen(data, 's1', { listened: 149, duration: 200, at: 6 }), 'stop');
  assert.equal(m.recordListen(data, 's1', { listened: 30, duration: 200, at: 7 }), 'stop');
  assert.equal(m.recordListen(data, 's1', { listened: 29.9, duration: 200, at: 8 }), 'skip');
  const st = m.songById(data, 's1').stats;
  assert.deepEqual({ ...st, listened: Math.round(st.listened) },
    { plays: 1, stops: 2, skips: 1, sessions: 4, listened: 359, lastPlayedAt: 8 });
});

test('a short song heard to the end is a play, not an early skip', () => {
  const data = lib();
  assert.equal(m.recordListen(data, 's1', { listened: 20, duration: 25 }), 'play');
});

test('under a second is not a listen, and what is heard is capped at the length', () => {
  const data = lib();
  assert.equal(m.recordListen(data, 's1', { listened: 0.5, duration: 200 }), null);
  assert.equal(m.songById(data, 's1').stats.sessions, 0);
  m.recordListen(data, 's1', { listened: 900, duration: 200 });
  assert.equal(m.songById(data, 's1').stats.listened, 200);
});

test('stats survive a reload and repair nonsense', () => {
  const data = lib();
  m.recordListen(data, 's1', { listened: 180, duration: 200, at: 42 });
  const again = m.sanitize(JSON.parse(JSON.stringify(data)));
  assert.equal(again.songs[0].stats.plays, 1);
  assert.equal(again.songs[0].stats.lastPlayedAt, 42);
  const broken = m.sanitize({ songs: [{ id: 'x', file: 'f', stats: { plays: -3, listened: 'lots' } }] });
  assert.deepEqual(broken.songs[0].stats, m.emptyStats());
});

/** One playlist of the profile's own holding these songs (all of them by default). */
function mine(data, ids = data.songs.map((s) => s.id)) {
  return [{ id: 'p1', name: 'Mine', entries: ids.map((songId) => ({ songId, addedAt: 1 })) }];
}

function withStats(data, id, stats) {
  m.songById(data, id).stats = { ...m.emptyStats(), ...stats };
}

test('each Listen behaviour list is a fifth of the library', () => {
  const data = lib(10);
  const lists = SmartLists.compute(data.songs, mine(data));
  assert.equal(lists['smart:least'].length, 2);
  assert.equal(lists['smart:stale'].length, 2);
  // Nothing played yet: nothing is "most listened".
  assert.equal(lists['smart:most'].length, 0);
  assert.equal(SmartLists.compute(lib(1).songs, mine(lib(1)))['smart:least'].length, 1);
  assert.equal(SmartLists.compute([], [])['smart:least'].length, 0);
});

test('most and least listened go by plays, then by time heard', () => {
  const data = lib(10);
  withStats(data, 's3', { plays: 5, listened: 1000 });
  withStats(data, 's7', { plays: 5, listened: 2000 });
  withStats(data, 's9', { plays: 1 });
  for (const id of ['s1', 's2', 's4', 's5', 's6', 's8', 's10']) withStats(data, id, { plays: 2 });
  const lists = SmartLists.compute(data.songs, mine(data));
  assert.deepEqual(lists['smart:most'], ['s7', 's3']);
  assert.deepEqual(lists['smart:least'], ['s9', 's1']);
});

test('long time no see counts a never-played song from its download', () => {
  const data = lib(10);
  const day = 86400000;
  for (const s of data.songs) s.addedAt = 100 * day;
  withStats(data, 's1', { plays: 1, lastPlayedAt: 150 * day });
  m.songById(data, 's2').addedAt = 10 * day; // downloaded long ago, never played
  withStats(data, 's3', { plays: 3, lastPlayedAt: 20 * day });
  const lists = SmartLists.compute(data.songs, mine(data));
  assert.deepEqual(lists['smart:stale'], ['s2', 's3']);
});

test('the lists are in this order', () => {
  assert.deepEqual(SmartLists.LISTS.map((l) => l.name),
    ['Most listened', 'Least skipped', 'Long time no see', 'Most skipped', 'Least listened']);
});

test('only songs in one of your own playlists count, All Songs does not', () => {
  const data = lib(10);
  // s9 and s10 are the most played but in no playlist.
  withStats(data, 's9', { plays: 9, sessions: 9 });
  withStats(data, 's10', { plays: 8, sessions: 8 });
  withStats(data, 's1', { plays: 2, sessions: 2 });
  withStats(data, 's2', { plays: 1, sessions: 1 });
  const own = mine(data, ['s1', 's2', 's3', 's4', 's5']);
  const lists = SmartLists.compute(data.songs, own);
  assert.deepEqual(lists['smart:most'], ['s1']);
  assert.ok(Object.values(lists).every((ids) => ids.every((id) => !['s6', 's7', 's8', 's9', 's10'].includes(id))));
  assert.equal(lists['smart:least'].length, 1, 'a fifth of the five');
  // No playlists, no lists.
  for (const ids of Object.values(SmartLists.compute(data.songs, []))) assert.deepEqual(ids, []);
});

test('most and least skipped count early skips among songs heard', () => {
  const data = lib(10);
  // s1 and s2 heard often, s1 never skipped, s2 skipped a lot; s3 heard once, skipped.
  withStats(data, 's1', { plays: 6, sessions: 6, listened: 1200 });
  withStats(data, 's2', { plays: 1, sessions: 6, skips: 5 });
  withStats(data, 's3', { plays: 0, sessions: 1, skips: 1 });
  withStats(data, 's4', { plays: 3, sessions: 3, listened: 600 });
  const lists = SmartLists.compute(data.songs, mine(data));
  assert.deepEqual(lists['smart:skipped-most'], ['s2', 's3']);
  // Never-heard songs have skipped nothing but are not "least skipped".
  assert.deepEqual(lists['smart:skipped-least'], ['s1', 's4']);
  // Nothing skipped yet: nothing is "most skipped".
  const calm = lib(10);
  withStats(calm, 's1', { plays: 1, sessions: 1 });
  assert.deepEqual(SmartLists.compute(calm.songs, mine(calm))['smart:skipped-most'], []);
});

test('how long ago, in the largest unit that fits', () => {
  const now = Date.UTC(2026, 0, 1);
  const min = 60000;
  assert.equal(Util.fmtAgo(now - 20000, now), 'just now');
  assert.equal(Util.fmtAgo(now - 5 * min, now), '5 minutes ago');
  assert.equal(Util.fmtAgo(now - 60 * min, now), '1 hour ago');
  assert.equal(Util.fmtAgo(now - 3 * 24 * 60 * min, now), '3 days ago');
  assert.equal(Util.fmtAgo(now - 15 * 24 * 60 * min, now), '2 weeks ago');
  assert.equal(Util.fmtAgo(now - 70 * 24 * 60 * min, now), '2 months ago');
  assert.equal(Util.fmtAgo(now - 800 * 24 * 60 * min, now), '2 years ago');
});
