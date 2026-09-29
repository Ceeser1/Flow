'use strict';

// The "Listen behaviour" lists: made from the listening statistics, never
// edited by hand. Pure, so test/smartLists.test.js can pin them; the window
// loads it as a plain script and gets `SmartLists` as a global.
//
// Each holds a fifth of the library (at least one song once there are any):
//   Most listened      the most plays, among songs played at least once
//   Least listened     the fewest plays, never-played songs included
//   Long time no see   the longest since last played. A song never played
//                      counts from when it was downloaded, so yesterday's
//                      download is not "long time no see" but one from a
//                      year ago that was never started is.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartLists = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const SHARE = 0.2;

  const LISTS = [
    { id: 'smart:most', name: 'Most listened' },
    { id: 'smart:least', name: 'Least listened' },
    { id: 'smart:stale', name: 'Long time no see' },
  ];

  const statsOf = (s) => s.stats || {};
  const plays = (s) => statsOf(s).plays || 0;
  const heard = (s) => statsOf(s).listened || 0;
  const lastSeen = (s) => statsOf(s).lastPlayedAt || s.addedAt || 0;

  function size(n) {
    return n ? Math.max(1, Math.round(n * SHARE)) : 0;
  }

  /** { 'smart:most': [songId...], ... } in list order, best match first. */
  function compute(songs) {
    const n = size(songs.length);
    const most = songs
      .filter((s) => plays(s) > 0)
      .sort((a, b) => plays(b) - plays(a) || heard(b) - heard(a) || lastSeen(b) - lastSeen(a))
      .slice(0, n);
    const least = songs.slice()
      .sort((a, b) => plays(a) - plays(b) || heard(a) - heard(b) || (a.addedAt || 0) - (b.addedAt || 0))
      .slice(0, n);
    const stale = songs.slice()
      .sort((a, b) => lastSeen(a) - lastSeen(b))
      .slice(0, n);
    const ids = (list) => list.map((s) => s.id);
    return { 'smart:most': ids(most), 'smart:least': ids(least), 'smart:stale': ids(stale) };
  }

  function isSmart(id) {
    return typeof id === 'string' && id.startsWith('smart:');
  }

  return { LISTS, SHARE, compute, isSmart, size };
}));
