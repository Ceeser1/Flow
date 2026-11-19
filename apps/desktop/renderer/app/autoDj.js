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
  // A radio's neighbourhood: an Info or genre the seed comes with in the library.
  const NEAR = 1;
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

  /** The value most of `values` share (empty ones left out), or ''. */
  function mostOf(values) {
    const count = new Map();
    for (const v of values) if (v) count.set(v, (count.get(v) || 0) + 1);
    let best = '';
    let most = 0;
    for (const [v, n] of count) {
      if (n > most) {
        best = v;
        most = n;
      }
    }
    return best;
  }

  /**
   * Song radio and Artist radio (5.1.2): a list of up to `count` songs like
   * one song ({ songId }: it comes first) or one artist ({ artist }: their
   * genre and Info are what most of their songs have). Alike as for
   * similar(); the seed's own artists make at most a third of a song radio
   * and half of an artist radio, and no artist comes twice in a row where
   * others are left. `salt`: a different one gives another mix of the songs
   * alike (each start of a radio). Empty when nothing is alike.
   */
  function radio(songs, seed, count = 100, salt = '') {
    const byId = new Map(songs.map((s) => [s.id, s]));
    const own = seed && seed.songId ? byId.get(seed.songId) : null;
    let base;
    if (own) {
      base = traits(own);
    } else if (seed && seed.artist) {
      const name = fold(seed.artist);
      const theirs = songs.filter((s) => SmartLists.artistsOf(s.artist).some((a) => fold(a) === name));
      if (!theirs.length) return [];
      base = {
        artists: new Set([name]),
        genre: mostOf(theirs.map((s) => fold(s.genre))),
        info: mostOf(theirs.map((s) => fold(s.subGenre))),
        album: '',
      };
    } else {
      return [];
    }
    const key = `${own ? own.id : fold(seed.artist)}|${salt}`;
    const all = songs.map((s) => ({ s, t: traits(s) }));
    const isMine = (t) => [...t.artists].some((a) => base.artists.has(a));
    // The neighbourhood in this library: the Info and genres that the seed's
    // artists and genre come with (a rare genre still finds its kind: their
    // Hardstyle songs' Info "Hands Up" leads to Dance songs with that Info).
    const nearInfo = new Set();
    const nearGenre = new Set();
    for (const { t } of all) {
      if (!isMine(t) && !(base.genre && t.genre === base.genre)) continue;
      if (t.info) nearInfo.add(t.info);
      if (t.genre) nearGenre.add(t.genre);
    }
    const scored = [];
    for (const { s, t } of all) {
      if (own && s.id === own.id) continue;
      if (unwanted(s)) continue;
      let points = 0;
      const mine = isMine(t);
      for (const a of t.artists) if (base.artists.has(a)) points += ARTIST;
      if (t.genre && t.genre === base.genre) points += GENRE;
      if (t.info && t.info === base.info) points += INFO;
      if (t.album && t.album === base.album) points += ALBUM;
      // One's genre the other's Info (genre House, Info House).
      if ((t.info && t.info === base.genre) || (t.genre && t.genre === base.info)) points += INFO;
      if (t.info && t.info !== base.info && nearInfo.has(t.info)) points += NEAR;
      if (t.genre && t.genre !== base.genre && nearGenre.has(t.genre)) points += NEAR;
      if (points <= 0) continue;
      scored.push({
        id: s.id, mine, artists: t.artists, same: `${fold(s.artist)}|${fold(s.title)}|${fold(s.mix)}`, score: points + taste(s) + MIX_UP * mixUp(s.id, key),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    // A song the library has twice (the same artist, title and mix) once.
    const seen = new Set(own ? [`${fold(own.artist)}|${fold(own.title)}|${fold(own.mix)}`] : []);
    const mineList = [];
    const others = [];
    for (const x of scored) {
      if (seen.has(x.same)) continue;
      seen.add(x.same);
      (x.mine ? mineList : others).push(x);
    }
    // The seed's artists at most a third of a song radio (half of an artist
    // radio) of what is found; with few others alike, still a few of theirs.
    const room = Math.max(0, count - (own ? 1 : 0));
    const ratio = own ? 1 / 2 : 1;
    const mineMost = Math.min(Math.round(room * (own ? 1 / 3 : 1 / 2)), Math.max(5, Math.round(Math.min(others.length, room) * ratio)));
    const mineTake = mineList.slice(0, mineMost);
    const picked = [...mineTake, ...others.slice(0, room - mineTake.length)].sort((a, b) => b.score - a.score);
    // Spread out: each next one, the best left not by an artist of the one before.
    const out = own ? [{ id: own.id, artists: base.artists }] : [];
    const left = picked.slice();
    while (left.length) {
      const before = out.length ? out[out.length - 1].artists : new Set();
      let i = left.findIndex((x) => ![...x.artists].some((a) => before.has(a)));
      if (i < 0) i = 0;
      out.push(left[i]);
      left.splice(i, 1);
    }
    return out.map((x) => x.id);
  }

  return { similar, radio, taste, unwanted };
}));
