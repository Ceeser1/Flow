'use strict';

// A song's album and genre where its source gives none: Apple's song search
// (itunes.apple.com/search, no key needed), asked by artist and title. It
// knows nearly every released song, small artists' too, with its album
// (a single's as "Name - Single") and one broad genre (Pop, Dance,
// Hip-Hop/Rap ...). Apple allows about 20 searches a minute, so the filler
// below pauses between songs. A song nothing fits keeps what it has; one
// without an album then takes its title as the album (libraryModel), like
// the many songs that only ever came out as a single.

const SEARCH_URL = 'https://itunes.apple.com/search';
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

/** The artists of "A, B & C feat. D" one by one, folded. */
function artistSet(text) {
  return new Set(String(text || '').split(/\s*(?:,|&|\+|\/|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)
    .map(fold).filter(Boolean));
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
async function lookupInfo(song, { fetch: get = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const title = String(song.title || '').trim();
  if (!title) return { album: '', genre: '' };
  const term = [song.artist, title].filter(Boolean).join(' ');
  const url = `${SEARCH_URL}?media=music&entity=song&country=US&lang=en_us&limit=${RESULTS}&term=${encodeURIComponent(term)}`;
  const res = await get(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Apple's search answered ${res.status}`);
  const data = await res.json();
  return pickResult(song, data && data.results) || { album: '', genre: '' };
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
 * Looks up the album and genre of the songs that never were (a library from
 * before, files put into the music folder), one after another in the
 * background. nextSong(tried) -> a song not looked up yet whose id is not in
 * `tried`, or null; save([{ id, album, genre }]) writes a few findings at a
 * time (libraryModel.setInfo). A song Apple could not be asked about is
 * tried again at the next start.
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
          // Both known already (its file's tags): nothing to ask.
          if (s.album && s.genre) {
            found.push({ id: s.id, album: s.album, genre: s.genre, subGenre: s.subGenre || '' });
            continue;
          }
          try {
            found.push({ id: s.id, ...fillInfo(s, await lookup(s)) });
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
  PAUSE_MS, cleanAlbum, scoreResult, pickResult, lookupInfo, fillInfo, createInfoFiller,
};
