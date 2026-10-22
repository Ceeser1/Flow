'use strict';

// A song's album and genre where its source gives none: Apple's song search
// (itunes.apple.com/search, no key needed), asked by artist and title. It
// knows nearly every released song, small artists' too, with its album
// (a single's as "Name - Single") and one broad genre (Pop, Dance,
// Hip-Hop/Rap ...). Apple allows about 20 searches a minute, so the filler
// below pauses between songs. A song nothing fits keeps what it has; one
// without an album then takes its title as the album (libraryModel), like
// the many songs that only ever came out as a single.
//
// What Apple leaves empty, Discogs' search fills (api.discogs.com, no key
// needed either, 25 searches a minute): its genre (broad: Electronic, Rock)
// where Apple had none, its first style (Hardstyle, Euro House, Nu Metal) as
// the Info, and the album when Apple had none and the release's tracklist
// holds the song.

const SEARCH_URL = 'https://itunes.apple.com/search';
const DISCOGS_URL = 'https://api.discogs.com';
// Discogs wants a name it can tell apart from other programs.
const DISCOGS_AGENT = 'Flow (+https://github.com/Ceeser1/Flow)';
// 25 a minute: one search every 2.5 s at most, whoever asks.
const DISCOGS_GAP_MS = 2500;
const DISCOGS_RESULTS = 25;
const RESULTS = 10;
const PAUSE_MS = 3500;
// Further apart than this, a result is another recording (a live one, an
// extended mix), not the song.
const MAX_DIFF = 30;
// The filler writes this many songs' findings at a time.
const BATCH = 10;

/** "Ready or Not - Single" -> "Ready or Not": Apple's names for singles and EPs. */
function cleanAlbum(name) {
  return String(name || '').replace(/\s+-\s+(?:Single|EP)\s*$/i, '').trim();
}

/** Lower case, no accents, no bracketed parts ("(feat. ...)", "[Remix]"), words only. */
function fold(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ARTIST_SPLIT = /\s*(?:,|&|\+|\/|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i;

/** The artists of "A, B & C feat. D" one by one, folded. */
function artistSet(text) {
  return new Set(String(text || '').split(ARTIST_SPLIT).map(fold).filter(Boolean));
}

const OTHER_VERSION = /\b(remix|mix|edit|live|acoustic|instrumental|karaoke|cover|remaster(?:ed)?|version|sped up|slowed)\b/i;
// Albums of other recordings of the song (a concert, a remix album).
const OTHER_ALBUM = /\b(live|remixes|karaoke|tribute|lullaby|instrumentals?)\b/i;
const SINGLE = /\s+-\s+(?:Single|EP)\s*$/i;
const REISSUE = /\b(deluxe|edition|anniversary|remaster(?:ed)?|expanded|bonus)\b/i;
// The artist's own album over a best-of of theirs, and far over a sampler of many.
const BEST_OF = /\b(greatest hits|hits|best of|collection|essentials|anthology|soundtrack)\b/i;
const SAMPLER = /^various artists$/i;

/** The words in a title's brackets: "Numb (Live)" -> "live". */
function bracketWords(title) {
  return (String(title || '').match(/[([][^)\]]*[)\]]/g) || []).map((b) => fold(b.slice(1, -1))).join(' ');
}

/**
 * How well one of Apple's results fits the song, or -1 when it is not the
 * song: the same title (brackets aside), an artist in common, and a length
 * within MAX_DIFF when both are known. Higher is better: the same version
 * (Mix or none), the length closer, then an album over a single of the
 * same recording, the album as it came out over a later edition, a
 * best-of or a sampler of many artists.
 */
function scoreResult(song, r) {
  if (!r || r.wrapperType !== 'track' || r.kind !== 'song') return -1;
  if (fold(r.trackName) !== fold(song.title)) return -1;
  const want = artistSet(song.artist);
  if (want.size) {
    const got = artistSet(r.artistName);
    if (![...want].some((a) => got.has(a))) return -1;
  }
  let score = 10;
  const d = Number(song.duration) || 0;
  const len = (Number(r.trackTimeMillis) || 0) / 1000;
  if (d && len) {
    const diff = Math.abs(d - len);
    if (diff > MAX_DIFF) return -1;
    score += Math.max(0, 5 - diff / 3);
  }
  // A Mix asked for is in the result's brackets; none asked for, none there.
  const mix = fold(song.mix);
  const brackets = bracketWords(r.trackName);
  const album = String(r.collectionName || '');
  if (mix ? brackets.includes(mix) : !OTHER_VERSION.test(brackets) && !OTHER_ALBUM.test(album)) score += 5;
  if (!SINGLE.test(album)) score += 2;
  if (REISSUE.test(album)) score -= 1;
  if (BEST_OF.test(album)) score -= 2;
  if (SAMPLER.test(String(r.collectionArtistName || '').trim())) score -= 4;
  return score;
}

/** The best fitting of Apple's results as { album, genre }, or null. */
function pickResult(song, results) {
  let best = null;
  let bestScore = -1;
  for (const r of results || []) {
    const s = scoreResult(song, r);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  if (!best) return null;
  return { album: cleanAlbum(best.collectionName), genre: String(best.primaryGenreName || '').trim() };
}

/**
 * The album and genre of { artist, title, mix, duration } by Apple's search:
 * { album, genre }, each '' when nothing fits. Throws when Apple cannot be
 * reached or refuses (tried again later).
 */
async function lookupApple(song, { fetch: get = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const title = String(song.title || '').trim();
  if (!title) return { album: '', genre: '' };
  const term = [song.artist, title].filter(Boolean).join(' ');
  const url = `${SEARCH_URL}?media=music&entity=song&country=US&lang=en_us&limit=${RESULTS}&term=${encodeURIComponent(term)}`;
  const res = await get(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Apple's search answered ${res.status}`);
  const data = await res.json();
  return pickResult(song, data && data.results) || { album: '', genre: '' };
}

const DISCOGS_VARIOUS = /^various$/i;

/** "Linkin Park - Meteora" -> { artists: 'Linkin Park', release: 'Meteora' }; Discogs' "Broiler (2)" and "Name*" plain. */
function discogsTitle(title) {
  const text = String(title || '');
  const cut = text.indexOf(' - ');
  if (cut < 0) return null;
  return {
    artists: text.slice(0, cut).replace(/\s*\(\d+\)/g, '').replace(/\*/g, '').trim(),
    release: text.slice(cut + 3).trim(),
  };
}

/**
 * How well one of Discogs' results (a release or master holding a track of
 * the song's title) fits the song, or -1: an artist in common, not a
 * sampler of many. Higher is better: the same version (a live album or a
 * remix one is another), an album over a single, a compilation, a promo
 * or a later edition.
 */
function scoreDiscogs(song, r) {
  const name = r && discogsTitle(r.title);
  if (!name || DISCOGS_VARIOUS.test(name.artists)) return -1;
  const want = artistSet(song.artist);
  if (want.size) {
    const got = artistSet(name.artists);
    if (![...want].some((a) => got.has(a))) return -1;
  }
  let score = 10;
  const mix = fold(song.mix);
  if (mix ? fold(name.release).includes(mix) : !OTHER_VERSION.test(name.release) && !OTHER_ALBUM.test(name.release)) score += 5;
  const formats = (Array.isArray(r.format) ? r.format : []).map((f) => String(f).toLowerCase());
  if (formats.includes('album')) score += 2;
  if (formats.includes('compilation')) score -= 2;
  if (formats.some((f) => f === 'promo' || f === 'sampler' || f === 'mixed')) score -= 3;
  if (REISSUE.test(name.release)) score -= 1;
  if (BEST_OF.test(name.release)) score -= 2;
  return score;
}

/** The best fitting of Discogs' results, the first of equals (Discogs' order), or null. */
function pickDiscogs(song, results) {
  let best = null;
  let bestScore = -1;
  for (const r of results || []) {
    const s = scoreDiscogs(song, r);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

let discogsNext = 0;

/** One answer of Discogs', DISCOGS_GAP_MS after the one before. Throws on a refusal (too many: 429). */
async function askDiscogs(url, { fetch: get = globalThis.fetch, timeoutMs = 15000, gapMs = DISCOGS_GAP_MS } = {}) {
  const now = Date.now();
  const wait = discogsNext - now;
  discogsNext = Math.max(now, discogsNext) + gapMs;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const res = await get(url, { headers: { 'User-Agent': DISCOGS_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Discogs answered ${res.status}`);
  return res.json();
}

/**
 * The genre, style (as subGenre) and, when the song has no album, album of
 * { artist, title, mix, album } by Discogs' search: the original releases
 * (masters) first, else the releases. The album only when the release's
 * tracklist holds the title. { album, genre, subGenre }, each '' when
 * nothing fits. Throws when Discogs cannot be reached or refuses.
 */
async function lookupDiscogs(song, opts = {}) {
  const none = { album: '', genre: '', subGenre: '' };
  const title = String(song.title || '').trim();
  if (!title) return none;
  const artist = String(song.artist || '').split(ARTIST_SPLIT)[0].trim();
  for (const type of ['master', 'release']) {
    const query = `type=${type}&per_page=${DISCOGS_RESULTS}&track=${encodeURIComponent(title)}`
      + (artist ? `&artist=${encodeURIComponent(artist)}` : '');
    const data = await askDiscogs(`${DISCOGS_URL}/database/search?${query}`, opts);
    const best = pickDiscogs(song, data && data.results);
    if (!best) continue;
    const first = (list) => String((Array.isArray(list) && list[0]) || '').trim();
    const out = { album: '', genre: first(best.genre), subGenre: first(best.style) };
    const url = String(best.resource_url || '');
    if (!song.album && url.startsWith(`${DISCOGS_URL}/`)) {
      const release = await askDiscogs(url, opts);
      const tracks = Array.isArray(release && release.tracklist) ? release.tracklist : [];
      if (tracks.some((t) => fold(t && t.title) === fold(title))) out.album = discogsTitle(best.title).release;
    }
    return out;
  }
  return none;
}

/** `meta` with the album, genre and sub-genre of `found` where it has none of its own. */
function fillInfo(meta, found) {
  const f = found || {};
  const m = meta || {};
  return {
    ...m, album: m.album || f.album || '', genre: m.genre || f.genre || '', subGenre: m.subGenre || f.subGenre || '',
  };
}

/**
 * What { artist, title, mix, duration, album?, genre?, subGenre? } lacks:
 * Apple's album and genre when it lacks either, then Discogs' for what is
 * still empty (the Info always is after Apple). { album, genre, subGenre },
 * '' where nothing was found. Throws when neither could be asked, or, with
 * `strict` (the filler, which tries again later), when either could not.
 */
async function lookupInfo(song, opts = {}) {
  const { apple = lookupApple, discogs = lookupDiscogs, strict = false } = opts;
  let found = { album: '', genre: '', subGenre: '' };
  let failed = null;
  if (!song.album || !song.genre) {
    try {
      found = fillInfo(found, await apple(song, opts));
    } catch (err) {
      failed = err;
    }
  }
  const known = fillInfo(song, found);
  if (!known.album || !known.genre || !known.subGenre) {
    try {
      found = fillInfo(found, await discogs(known, opts));
    } catch (err) {
      failed = failed || err;
    }
  }
  if (failed && (strict || !(found.album || found.genre || found.subGenre))) throw failed;
  return found;
}

/**
 * Looks up the album, genre and Info of the songs that never were (a library
 * from before, files put into the music folder), one after another in the
 * background. nextSong(tried) -> a song not looked up yet whose id is not in
 * `tried`, or null; save([{ id, album, genre, subGenre }]) writes a few
 * findings at a time (libraryModel.setInfo). A song Apple or Discogs could
 * not be asked about is tried again at the next start.
 */
function createInfoFiller({ nextSong, save, lookup = lookupInfo, pauseMs = PAUSE_MS, log = () => {} }) {
  const tried = new Set();
  let running = false;
  let again = false;
  let stopped = false;
  let current = Promise.resolve();

  async function work() {
    let found = [];
    const flush = () => {
      if (!found.length) return;
      const batch = found;
      found = [];
      try {
        save(batch);
      } catch (err) {
        log(`Albums and genres: ${err.message}`);
      }
    };
    try {
      do {
        again = false;
        for (let s = nextSong(tried); s && !stopped; s = nextSong(tried)) {
          tried.add(s.id);
          // All known already (its file's tags): nothing to ask.
          if (s.album && s.genre && s.subGenre) {
            found.push({ id: s.id, album: s.album, genre: s.genre, subGenre: s.subGenre || '' });
            continue;
          }
          try {
            found.push({ id: s.id, ...fillInfo(s, await lookup(s, { strict: true })) });
          } catch (err) {
            log(`No album or genre for ${s.title}: ${err.message}`);
          }
          if (found.length >= BATCH) flush();
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, pauseMs));
        }
      } while (again && !stopped);
    } finally {
      flush();
      running = false;
    }
  }

  return {
    run() {
      if (stopped) return current;
      if (running) {
        again = true;
        return current;
      }
      running = true;
      current = work().catch((err) => log(`Albums and genres: ${err.message}`));
      return current;
    },
    stop() {
      stopped = true;
      return current;
    },
  };
}

module.exports = {
  PAUSE_MS, cleanAlbum, scoreResult, pickResult, lookupApple, scoreDiscogs, pickDiscogs, lookupDiscogs, lookupInfo, fillInfo,
  createInfoFiller,
};
