'use strict';

// The "Your listening trend" lists: made from the listening statistics, never
// edited by hand. Pure, so test/listening.test.js can pin them; the window
// loads it as a plain script and gets `SmartLists` as a global.
//
// They only look at songs that are in one of the profile's own playlists (All
// Songs is everything downloaded, so it says nothing about what is wanted).
// A song's listen score is how many times it was heard in full, counting the
// parts: times played * (average listen duration / song duration).
// Each song list holds a fifth of those songs (at least one once there are any):
//   Most listened songs     the highest listen score, among songs heard
//   Least skipped songs     the largest share heard to 80% or more, among songs
//                           heard that far at least once; a song heard in full
//                           once does not beat one heard in full nine times of ten
//   Long time no see        the longest since last played. A song never played
//                           counts from when it was downloaded, so yesterday's
//                           download is not "long time no see" but one from a
//                           year ago that was never started is.
//   Most skipped songs      the most early skips, among songs skipped at least once
//   Least listened songs    the shortest average listen, as a share of the song,
//                           among songs heard
// The artist lists hold every song of a fifth of the artists, by the listen
// scores of their songs added up. A song by more than one artist ("A, B",
// "A ft B", "A feat. B", "A x B") counts for each of them.
//   Most listened artists   the highest, among artists heard
//   Least listened artists  the lowest, artists never heard included

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartLists = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const SHARE = 0.2;

  const LISTS = [
    { id: 'smart:artists-most', name: 'Most listened artists', desc: 'Every song of the fifth of your artists you listen to most' },
    { id: 'smart:most', name: 'Most listened songs', desc: 'Times played, by how much of the song you hear' },
    { id: 'smart:skipped-least', name: 'Least skipped songs', desc: 'Heard to 80% or more most of the times played' },
    { id: 'smart:stale', name: 'Long time no see', desc: 'Not heard for the longest time' },
    { id: 'smart:skipped-most', name: 'Most skipped songs', desc: 'Skipped most often in the first 30 seconds' },
    { id: 'smart:least', name: 'Least listened songs', desc: 'The shortest average listen, for the length of the song' },
    { id: 'smart:artists-least', name: 'Least listened artists', desc: 'Every song of the fifth of your artists you listen to least' },
  ];

  const statsOf = (s) => s.stats || {};
  const plays = (s) => statsOf(s).plays || 0;
  const heard = (s) => statsOf(s).listened || 0;
  const skips = (s) => statsOf(s).skips || 0;
  const sessions = (s) => statsOf(s).sessions || 0;
  const lastSeen = (s) => statsOf(s).lastPlayedAt || s.addedAt || 0;
  const average = (s) => (sessions(s) ? heard(s) / sessions(s) : 0);
  /** The average listen as a share of the song (1 when its length is not known). */
  const share = (s) => (s.duration > 0 ? Math.min(1, average(s) / s.duration) : 1);
  /** Times played * (average listen duration / song duration). */
  const score = (s) => sessions(s) * share(s);
  /** Heard in full against times played, one more play than there was so a single listen weighs little. */
  const fullShare = (s) => plays(s) / (sessions(s) + 1);

  function size(n) {
    return n ? Math.max(1, Math.round(n * SHARE)) : 0;
  }

  const SPLIT = /\s*,\s*|\s+(?:ft|feat|featuring)\.?\s+|\s+x\s+/i;

  /** The artists of an artist line: "A, B", "A ft B", "A feat. B", "A x B". */
  function artistsOf(line) {
    const seen = new Set();
    const out = [];
    for (const part of String(line || '').replace(/[()[\]]/g, ' ').split(SPLIT)) {
      const name = part.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

  /** The songs that are in at least one of `playlists`. */
  function inPlaylists(songs, playlists) {
    const wanted = new Set();
    for (const p of playlists || []) for (const e of p.entries || []) wanted.add(e.songId);
    return songs.filter((s) => wanted.has(s.id));
  }

  /** [{ key, score, songs }] for every artist of `songs`, songs best first. */
  function artists(songs) {
    const byKey = new Map();
    for (const s of songs) {
      for (const name of artistsOf(s.artist)) {
        const key = name.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, { key, score: 0, songs: [] });
        const a = byKey.get(key);
        a.score += score(s);
        a.songs.push(s);
      }
    }
    const list = [...byKey.values()];
    for (const a of list) a.songs.sort((x, y) => score(y) - score(x) || plays(y) - plays(x));
    return list;
  }

  /** Every song of these artists, in their order, each once. */
  function songsOf(list) {
    const seen = new Set();
    const out = [];
    for (const a of list) {
      for (const s of a.songs) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        out.push(s);
      }
    }
    return out;
  }

  /** { 'smart:most': [songId...], ... } in list order, best match first. */
  function compute(songs, playlists) {
    const own = inPlaylists(songs, playlists);
    const n = size(own.length);
    const most = own
      .filter((s) => score(s) > 0)
      .sort((a, b) => score(b) - score(a) || plays(b) - plays(a) || lastSeen(b) - lastSeen(a))
      .slice(0, n);
    const least = own
      .filter((s) => sessions(s) > 0)
      .sort((a, b) => share(a) - share(b) || average(a) - average(b) || (a.addedAt || 0) - (b.addedAt || 0))
      .slice(0, n);
    const stale = own.slice()
      .sort((a, b) => lastSeen(a) - lastSeen(b))
      .slice(0, n);
    const skippedLeast = own
      .filter((s) => plays(s) > 0)
      .sort((a, b) => fullShare(b) - fullShare(a) || plays(b) - plays(a) || skips(a) - skips(b))
      .slice(0, n);
    const skippedMost = own
      .filter((s) => skips(s) > 0)
      .sort((a, b) => skips(b) - skips(a) || plays(a) - plays(b) || heard(a) - heard(b))
      .slice(0, n);

    const all = artists(own);
    const k = size(all.length);
    const artistsMost = all
      .filter((a) => a.score > 0)
      .sort((a, b) => b.score - a.score || b.songs.length - a.songs.length)
      .slice(0, k);
    const artistsLeast = all.slice()
      .sort((a, b) => a.score - b.score || a.songs.length - b.songs.length)
      .slice(0, k);

    const ids = (list) => list.map((s) => s.id);
    return {
      'smart:artists-most': ids(songsOf(artistsMost)),
      'smart:most': ids(most),
      'smart:skipped-least': ids(skippedLeast),
      'smart:stale': ids(stale),
      'smart:skipped-most': ids(skippedMost),
      'smart:least': ids(least),
      'smart:artists-least': ids(songsOf(artistsLeast)),
    };
  }

  function isSmart(id) {
    return typeof id === 'string' && id.startsWith('smart:');
  }

  return { LISTS, SHARE, artistsOf, compute, isSmart, size };
}));
