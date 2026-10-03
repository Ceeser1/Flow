'use strict';

// Listening statistics (src/libraryModel.js), the Your listening trend lists
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

test('a full listen is 80%, an early skip 5 to 30 s, a stop between', () => {
  const data = lib();
  assert.equal(m.recordListen(data, 's1', { listened: 160, duration: 200, at: 5 }), 'play');
  assert.equal(m.recordListen(data, 's1', { listened: 159, duration: 200, at: 6 }), 'stop');
  assert.equal(m.recordListen(data, 's1', { listened: 30, duration: 200, at: 7 }), 'stop');
  assert.equal(m.recordListen(data, 's1', { listened: 29.9, duration: 200, at: 8 }), 'skip');
  const st = m.songById(data, 's1').stats;
  assert.deepEqual({ ...st, listened: Math.round(st.listened) },
    { plays: 1, stops: 2, skips: 1, sessions: 4, listened: 379, lastPlayedAt: 8 });
});

test('a short song heard to the end is a play, not an early skip', () => {
  const data = lib();
  assert.equal(m.recordListen(data, 's1', { listened: 20, duration: 25 }), 'play');
});

test('under 5 seconds counts as nothing, and what is heard is capped at the length', () => {
  const data = lib();
  assert.equal(m.recordListen(data, 's1', { listened: 0.5, duration: 200 }), null);
  assert.equal(m.recordListen(data, 's1', { listened: 4.9, duration: 200 }), null);
  assert.deepEqual(m.songById(data, 's1').stats, m.emptyStats());
  // From 5 s it is a time played and, below 30 s, an early skip as well.
  assert.equal(m.recordListen(data, 's1', { listened: 5, duration: 200 }), 'skip');
  assert.equal(m.songById(data, 's1').stats.sessions, 1);
  assert.equal(m.songById(data, 's1').stats.skips, 1);
  data.songs[0].stats = m.emptyStats();
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

test('each trend list is a fifth of the library', () => {
  const data = lib(10);
  const lists = SmartLists.compute(data.songs, mine(data));
  assert.equal(lists['smart:stale'].length, 2);
  // Nothing played yet: nothing is most or least listened.
  assert.equal(lists['smart:most'].length, 0);
  assert.equal(lists['smart:least'].length, 0);
  assert.equal(lists['smart:artists-most'].length, 0);
  // The one artist is a fifth of one artist: all ten songs.
  assert.equal(lists['smart:artists-least'].length, 10);
  assert.equal(SmartLists.compute(lib(1).songs, mine(lib(1)))['smart:stale'].length, 1);
  assert.equal(SmartLists.compute([], [])['smart:stale'].length, 0);
});

test('most listened songs go by times played * share of the song heard', () => {
  const data = lib(10);
  // s3: 4 plays of the whole song = 4. s7: 10 plays of a quarter = 2.5. s9: 2 halves = 1.
  withStats(data, 's3', { sessions: 4, plays: 4, listened: 800 });
  withStats(data, 's7', { sessions: 10, skips: 10, listened: 500 });
  withStats(data, 's9', { sessions: 2, stops: 2, listened: 200 });
  const lists = SmartLists.compute(data.songs, mine(data));
  assert.deepEqual(lists['smart:most'], ['s3', 's7']);
});

test('least listened songs have the shortest average listen, as a share of the song', () => {
  const data = lib(10);
  withStats(data, 's2', { sessions: 1, plays: 1, listened: 200 });
  withStats(data, 's4', { sessions: 3, skips: 3, listened: 30 }); // 10 s of 200
  withStats(data, 's6', { sessions: 1, stops: 1, listened: 100 });
  m.songById(data, 's8').duration = 20;
  withStats(data, 's8', { sessions: 2, skips: 2, listened: 12 }); // 6 s, but of 20
  const lists = SmartLists.compute(data.songs, mine(data));
  // Never-heard songs have no average: they are Long time no see.
  assert.deepEqual(lists['smart:least'], ['s4', 's8']);
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
  assert.deepEqual(SmartLists.LISTS.map((l) => l.name), [
    'Most listened artists', 'Most listened songs', 'Least skipped songs', 'Long time no see',
    'Most skipped songs', 'Least listened songs', 'Least listened artists',
  ]);
});

test('only songs in one of your own playlists count, All Songs does not', () => {
  const data = lib(10);
  // s9 and s10 are the most played but in no playlist.
  withStats(data, 's9', { plays: 9, sessions: 9, listened: 1800 });
  withStats(data, 's10', { plays: 8, sessions: 8, listened: 1600 });
  withStats(data, 's1', { plays: 2, sessions: 2, listened: 400 });
  withStats(data, 's2', { plays: 1, sessions: 1, listened: 200 });
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

test('least skipped songs are heard in full most of the times played', () => {
  const data = lib(10);
  withStats(data, 's1', { plays: 1, sessions: 1, listened: 200 }); // 1 of 1
  withStats(data, 's2', { plays: 9, sessions: 10, skips: 1, listened: 1810 }); // 9 of 10
  withStats(data, 's3', { plays: 2, sessions: 8, skips: 6, listened: 520 });
  const lists = SmartLists.compute(data.songs, mine(data));
  assert.deepEqual(lists['smart:skipped-least'], ['s2', 's1']);
});

test('an artist line splits at ",", "ft", "feat." and "x"', () => {
  assert.deepEqual(SmartLists.artistsOf('Daft Punk, Pharrell Williams'), ['Daft Punk', 'Pharrell Williams']);
  assert.deepEqual(SmartLists.artistsOf('Calvin Harris ft Rihanna'), ['Calvin Harris', 'Rihanna']);
  assert.deepEqual(SmartLists.artistsOf('Calvin Harris ft. Rihanna'), ['Calvin Harris', 'Rihanna']);
  assert.deepEqual(SmartLists.artistsOf('Avicii feat. Aloe Blacc'), ['Avicii', 'Aloe Blacc']);
  assert.deepEqual(SmartLists.artistsOf('Martin Garrix x Dua Lipa'), ['Martin Garrix', 'Dua Lipa']);
  assert.deepEqual(SmartLists.artistsOf('Kygo X Whitney Houston, Kygo'), ['Kygo', 'Whitney Houston']);
  assert.deepEqual(SmartLists.artistsOf('Earth, Wind (feat. Fire)'), ['Earth', 'Wind', 'Fire']);
  // Not a separator inside a name.
  assert.deepEqual(SmartLists.artistsOf('Xavier Rudd'), ['Xavier Rudd']);
  assert.deepEqual(SmartLists.artistsOf('Simon & Garfunkel'), ['Simon & Garfunkel']);
  assert.deepEqual(SmartLists.artistsOf(''), []);
});

test('the artist lists hold every song of a fifth of the artists', () => {
  const data = lib(10);
  const artist = {
    s1: 'Muse', s2: 'Muse', s3: 'Muse ft Queen', s4: 'Queen', s5: 'Adele',
    s6: 'Adele', s7: 'Coldplay', s8: 'Coldplay x Rihanna', s9: 'Moby', s10: 'Moby',
  };
  for (const s of data.songs) s.artist = artist[s.id];
  // Muse 3 + 1, Queen 1 + 1, Adele 1 (Coldplay, Rihanna, Moby never heard). Six artists: a fifth is one.
  withStats(data, 's1', { sessions: 3, plays: 3, listened: 600 });
  withStats(data, 's3', { sessions: 1, plays: 1, listened: 200 });
  withStats(data, 's4', { sessions: 1, plays: 1, listened: 200 });
  withStats(data, 's5', { sessions: 1, plays: 1, listened: 200 });
  const lists = SmartLists.compute(data.songs, mine(data));
  assert.deepEqual(lists['smart:artists-most'], ['s1', 's3', 's2']);
  // Rihanna: one song, never heard.
  assert.deepEqual(lists['smart:artists-least'], ['s8']);
});

function withLists(data) {
  const now = Date.now();
  m.createPlaylist(data, 'Mine', 'p1', now);
  m.addSongToPlaylists(data, 's1', ['p1']);
  data.sharedPlaylists.push({ id: 'ps', name: 'Theirs', createdAt: now, entries: [{ songId: 's2', addedAt: now }], ownerId: 'o', ownerName: 'Anna' });
  return data;
}

test('time listened counts for the list that was playing, if the song is in it', () => {
  const data = withLists(lib(3));
  const listen = (songId, listened, contextId) => m.recordListen(data, songId, { listened, duration: 200, contextId });
  listen('s1', 60, 'p1');
  listen('s1', 40, 'p1');
  assert.equal(data.playlistListened.p1, 100);
  // Queued from elsewhere: s2 is not in Mine, so Mine gets nothing.
  listen('s2', 50, 'p1');
  assert.equal(data.playlistListened.p1, 100);
  // Under 5 s counts as nothing; All Songs and the built-in lists count as such.
  listen('s1', 4, 'p1');
  listen('s1', 30, 'all');
  listen('s1', 20, 'smart:most');
  assert.deepEqual(data.playlistListened, { p1: 100, all: 30, 'smart:most': 20 });
  // A made-up list is nothing.
  listen('s1', 30, 'nope');
  assert.equal(data.playlistListened.nope, undefined);
});

test("another profile's list counts only while it is followed, and unfollowing deletes it", () => {
  const data = withLists(lib(3));
  const listen = (songId, listened, contextId) => m.recordListen(data, songId, { listened, duration: 200, contextId });
  listen('s2', 60, 'ps');
  assert.equal(data.playlistListened.ps, undefined, 'not followed');
  m.followPlaylist(data, 'ps');
  listen('s2', 60, 'ps');
  assert.equal(data.playlistListened.ps, 60);
  m.unfollowPlaylist(data, 'ps');
  assert.equal(data.playlistListened.ps, undefined);
});

test('deleting a playlist deletes what was listened to it', () => {
  const data = withLists(lib(3));
  m.recordListen(data, 's1', { listened: 60, duration: 200, contextId: 'p1' });
  m.deletePlaylist(data, 'p1');
  assert.equal(data.playlistListened.p1, undefined);
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
