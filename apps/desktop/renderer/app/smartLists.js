'use strict';

// The "Listen behaviour" lists: made from the listening statistics, never
// edited by hand. Pure, so test/smartLists.test.js can pin them; the window
// loads it as a plain script and gets `SmartLists` as a global.
//
// They only look at songs that are in one of the profile's own playlists (All
// Songs is everything downloaded, so it says nothing about what is wanted).
// Each holds a fifth of those songs (at least one once there are any):
//   Most listened      the most plays, among songs played at least once
//   Least skipped      the fewest early skips (under 30 seconds), among songs
//                      heard at least once: a never-heard song has skipped nothing
//   Long time no see   the longest since last played. A song never played
//                      counts from when it was downloaded, so yesterday's
//                      download is not "long time no see" but one from a
//                      year ago that was never started is.
//   Most skipped       the most early skips, among songs skipped at least once
//   Least listened     the fewest plays, never-played songs included

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartLists = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const SHARE = 0.2;

  const LISTS = [
    { id: 'smart:most', name: 'Most listened' },
    { id: 'smart:skipped-least', name: 'Least skipped' },
    { id: 'smart:stale', name: 'Long time no see' },
    { id: 'smart:skipped-most', name: 'Most skipped' },
    { id: 'smart:least', name: 'Least listened' },
  ];

  const statsOf = (s) => s.stats || {};
  const plays = (s) => statsOf(s).plays || 0;
  const heard = (s) => statsOf(s).listened || 0;
  const skips = (s) => statsOf(s).skips || 0;
  const sessions = (s) => statsOf(s).sessions || 0;
  const lastSeen = (s) => statsOf(s).lastPlayedAt || s.addedAt || 0;

  function size(n) {
    return n ? Math.max(1, Math.round(n * SHARE)) : 0;
  }

  /** The songs that are in at least one of `playlists`. */
  function inPlaylists(songs, playlists) {
    const wanted = new Set();
    for (const p of playlists || []) for (const e of p.entries || []) wanted.add(e.songId);
    return songs.filter((s) => wanted.has(s.id));
  }

  /** { 'smart:most': [songId...], ... } in list order, best match first. */
  function compute(songs, playlists) {
    const own = inPlaylists(songs, playlists);
    const n = size(own.length);
    const most = own
      .filter((s) => plays(s) > 0)
      .sort((a, b) => plays(b) - plays(a) || heard(b) - heard(a) || lastSeen(b) - lastSeen(a))
      .slice(0, n);
    const least = own.slice()
      .sort((a, b) => plays(a) - plays(b) || heard(a) - heard(b) || (a.addedAt || 0) - (b.addedAt || 0))
      .slice(0, n);
    const stale = own.slice()
      .sort((a, b) => lastSeen(a) - lastSeen(b))
      .slice(0, n);
    const skippedLeast = own
      .filter((s) => sessions(s) > 0)
      .sort((a, b) => skips(a) - skips(b) || plays(b) - plays(a) || heard(b) - heard(a))
      .slice(0, n);
    const skippedMost = own
      .filter((s) => skips(s) > 0)
      .sort((a, b) => skips(b) - skips(a) || plays(a) - plays(b) || heard(a) - heard(b))
      .slice(0, n);
    const ids = (list) => list.map((s) => s.id);
    return {
      'smart:most': ids(most),
      'smart:skipped-least': ids(skippedLeast),
      'smart:stale': ids(stale),
      'smart:skipped-most': ids(skippedMost),
      'smart:least': ids(least),
    };
  }

  function isSmart(id) {
    return typeof id === 'string' && id.startsWith('smart:');
  }

  return { LISTS, SHARE, compute, isSmart, size };
}));
