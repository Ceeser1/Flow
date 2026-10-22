'use strict';

// A song's lyrics (4.0) from LRCLIB (lrclib.net): free, no key, lines with
// their times (LRC) for many songs, plain text for more. Asked by a Flow
// Server for its songs (kept with them, as covers are) and by the apps
// themselves for songs of their own.
//
// What a lookup answers, and what is kept:
//   { found, synced: [{ t, text }] | null, plain, instrumental }
// synced: each line with the second it starts at. Lines in step with the
// song only when its length is LRCLIB's within SYNC_SLACK seconds (a song
// trimmed differently would be out of step): else only the plain text.

const BASE = 'https://lrclib.net/api';
// LRCLIB asks apps to say who they are.
const AGENT = 'Flow (+https://github.com/Ceeser1/Flow)';
const SYNC_SLACK = 4;
// A song looked up and not found is asked again after this long.
const NOT_FOUND_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

const NONE = Object.freeze({
  found: false, synced: null, plain: '', instrumental: false,
});

/** LRC text as [{ t, text }] in time order; a line with several times is there once for each. */
function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [];
    let rest = raw;
    for (;;) {
      const m = /^\s*\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(rest);
      if (!m) break;
      stamps.push(Number(m[1]) * 60 + Number(m[2].replace(':', '.')));
      rest = rest.slice(m[0].length);
    }
    const line = rest.trim();
    for (const t of stamps) out.push({ t: Math.round(t * 100) / 100, text: line });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The line playing at second `t` (its index), or -1 before the first. */
function lineAt(lines, t) {
  if (!Array.isArray(lines) || !lines.length || !(t >= lines[0].t)) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

/** The first of several artists ("Broiler, Tessa Odden", "A feat. B", "A & B"). */
function firstArtist(artist) {
  return String(artist || '').split(/\s*(?:,|;|\s&\s|\sx\s|\s(?:feat\.?|ft\.?|featuring|with|vs\.?)\s)\s*/i)[0].trim();
}

/** One LRCLIB record as kept, for a song `duration` seconds long (0: unknown). */
function fromRecord(r, duration = 0) {
  if (!r || typeof r !== 'object') return NONE;
  const instrumental = r.instrumental === true;
  const plain = String(r.plainLyrics || '').trim();
  const lines = parseLrc(r.syncedLyrics);
  const inStep = !duration || !(Number(r.duration) > 0) || Math.abs(Number(r.duration) - duration) <= SYNC_SLACK;
  const synced = lines.length && inStep ? lines : null;
  const text = plain || (lines.length ? lines.map((l) => l.text).join('\n').trim() : '');
  if (!text && !instrumental) return NONE;
  return {
    found: true, synced, plain: text, instrumental,
  };
}

/**
 * The best of LRCLIB's search results for `song`: the same title and an
 * artist in common, the length closest to the song's, lines with times over
 * plain text. Null when none fits.
 */
function pick(results, { artist, title, duration = 0 }) {
  const wantTitle = fold(title);
  const artists = String(artist || '').split(/\s*(?:,|;|&|\sx\s|\s(?:feat\.?|ft\.?|featuring|with|vs\.?)\s)\s*/i).map(fold).filter(Boolean);
  let best = null;
  let bestScore = -Infinity;
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || (!r.plainLyrics && !r.syncedLyrics && r.instrumental !== true)) continue;
    const t = fold(r.trackName || r.name);
    if (!t || (t !== wantTitle && !t.startsWith(`${wantTitle} `) && !wantTitle.startsWith(`${t} `))) continue;
    const a = fold(r.artistName);
    if (artists.length && !artists.some((x) => a === x || a.includes(x) || x.includes(a))) continue;
    const gap = duration && Number(r.duration) > 0 ? Math.abs(Number(r.duration) - duration) : 0;
    // Another version (a live take, an intro the song has here): its words
    // only (fromRecord drops the times), and only when nothing closer is there.
    const score = (t === wantTitle ? 20 : 0) + (r.syncedLyrics ? 10 : 0) - gap;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/**
 * A song's lyrics from LRCLIB: { artist, title, album, duration }. Resolves
 * NONE when there are none; rejects when LRCLIB cannot be reached.
 * agent: whether to send the User-Agent (a page's fetch cannot).
 */
async function lookupLyrics(song, { fetch: get = globalThis.fetch, timeoutMs = 15000, agent = true } = {}) {
  const title = String(song.title || '').trim();
  const artist = String(song.artist || '').trim();
  const duration = Number(song.duration) || 0;
  if (!title) return NONE;
  const ask = async (route, params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, String(v));
    const res = await get(`${BASE}/${route}?${q}`, {
      headers: agent ? { 'User-Agent': AGENT, Accept: 'application/json' } : { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`LRCLIB answered ${res.status}.`);
    return res.json();
  };
  // Only LRCLIB's search: its /get asks other sites for a song it does not
  // know and keeps what they say under the length asked for, right or not.
  const tries = [{ track_name: title, artist_name: artist }];
  if (firstArtist(artist) && firstArtist(artist) !== artist) tries.push({ track_name: title, artist_name: firstArtist(artist) });
  if (!artist) tries[0] = { q: title };
  for (const params of tries) {
    const found = pick(await ask('search', params), { artist, title, duration });
    if (found) return fromRecord(found, duration);
  }
  return NONE;
}

/** What a song's lyrics depend on: looked up again when it changes (renamed, trimmed). */
function lyricsKey(song) {
  return `${fold(song.artist)}|${fold(song.title)}|${Math.round(Number(song.duration) || 0)}`;
}

/** A kept answer (with { key, at }) that still stands for `song`. */
function stillGood(kept, song, now = Date.now()) {
  if (!kept || kept.key !== lyricsKey(song)) return false;
  return kept.found || now - (Number(kept.at) || 0) < NOT_FOUND_RETRY_MS;
}

/** A kept answer cleaned up, as handed out. */
function clean(kept) {
  if (!kept || !kept.found) return { ...NONE };
  const synced = Array.isArray(kept.synced)
    ? kept.synced.filter((l) => l && Number.isFinite(Number(l.t))).map((l) => ({ t: Number(l.t), text: String(l.text || '') }))
    : null;
  return {
    found: true, synced: synced && synced.length ? synced : null, plain: String(kept.plain || ''), instrumental: kept.instrumental === true,
  };
}

module.exports = {
  parseLrc, lineAt, pick, fromRecord, lookupLyrics, lyricsKey, stillGood, clean, firstArtist, NONE, AGENT, NOT_FOUND_RETRY_MS,
};
