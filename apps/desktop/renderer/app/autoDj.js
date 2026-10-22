'use strict';

// "Continue with similar songs" (4.0, Settings > General): once the list
// playing has played through, songs like the last ones heard follow instead
// of the list starting over (queue.js asks, PlayQueue.continueWith). Pure, so
// the tests can pin it; the window loads it as a plain script and gets
// `AutoDJ` as a global.
//
// A song is like the ones heard (the seeds, the newest weighing most) for
// each artist they share (an artist line split as SmartLists splits it), the
// same genre, the same Info and the same album (not one that is only the
// song's title). Among songs alike, those listened to more come first, and
// ones mostly skipped early never come. A small mix-up (the same for the same
// songs heard, so a copy of the queue picks the same) keeps it from always
// being the same order. Nothing alike at all: the songs listened to most.

(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./smartLists') : root.SmartLists);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AutoDJ = api;
}(typeof self !== 'undefined' ? self : this, (SmartLists) => {
  const ARTIST = 5;
  const GENRE = 3;
  const INFO = 2;
  const ALBUM = 2;
  const MIX_UP = 2;
  const SEEDS = 5;

  const fold = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const statsOf = (s) => s.stats || {};

  /** How much a song is listened to: full listens, counting the parts (as SmartLists). */
  function taste(s) {
    const st = statsOf(s);
    const sessions = st.sessions || 0;
    const heard = st.listened || 0;
    const share = s.duration > 0 && sessions ? Math.min(1, heard / sessions / s.duration) : 0;
    return Math.log1p(sessions * share);
  }

  /** Skipped early more often than heard to the end, twice or more. */
  function unwanted(s) {
    const st = statsOf(s);
    return (st.skips || 0) >= 2 && (st.skips || 0) > (st.plays || 0);
  }

  /** A number from 0 to 1 for this song and these seeds, always the same for them. */
  function mixUp(id, salt) {
    let h = 2166136261;
    const text = `${id}|${salt}`;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }

  function traits(s) {
    const album = fold(s.album);
    return {
      artists: new Set(SmartLists.artistsOf(s.artist).map(fold)),
      genre: fold(s.genre),
      info: fold(s.subGenre),
      album: album && album !== fold(s.title) ? album : '',
    };
  }

  /**
   * Song ids to play on with, best first: `songs` (the library), `seedIds`
   * (the songs heard last, newest last), `avoid` (a Set: played lately,
   * queued). At most `count`.
   */
  function similar(songs, seedIds, avoid = new Set(), count = 10) {
    const byId = new Map(songs.map((s) => [s.id, s]));
    const seeds = seedIds.slice(-SEEDS).map((id) => byId.get(id)).filter(Boolean).reverse().map(traits);
    const salt = seedIds.slice(-SEEDS).join(',');
    const seedSet = new Set(seedIds);
    const scored = [];
    for (const s of songs) {
      if (avoid.has(s.id) || seedSet.has(s.id) || unwanted(s)) continue;
      const t = traits(s);
      let alike = 0;
      seeds.forEach((seed, k) => {
        const weight = 1 / (1 + 0.6 * k);
        let points = 0;
        for (const a of t.artists) if (seed.artists.has(a)) points += ARTIST;
        if (t.genre && t.genre === seed.genre) points += GENRE;
        if (t.info && t.info === seed.info) points += INFO;
        if (t.album && t.album === seed.album) points += ALBUM;
        alike += weight * points;
      });
      scored.push({ id: s.id, alike, score: alike + taste(s) + MIX_UP * mixUp(s.id, salt) });
    }
    const alike = scored.filter((x) => x.alike > 0);
    const pool = alike.length ? alike : scored.filter((x) => taste(byId.get(x.id)) > 0);
    const list = (pool.length ? pool : scored).sort((a, b) => b.score - a.score);
    return list.slice(0, count).map((x) => x.id);
  }

  return { similar, taste, unwanted };
}));
