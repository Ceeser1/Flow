'use strict';

// A song's lyrics (4.0) from LRCLIB (lrclib.net): free, no key, lines with
// their times (LRC) for many songs, plain text for more. A song LRCLIB has
// not: lyrics.ovh's (api.lyrics.ovh, free, no key), the words without their
// times. Asked by a Flow Server for its songs (kept with them, as covers
// are) and by the apps themselves for songs of their own.
//
// What a lookup answers, and what is kept:
//   { found, synced: [{ t, text }] | null, plain, instrumental, source }
// source: where the words came from, "LRCLIB", "lyrics.ovh", or "own" for
// lyrics written or edited in Flow (4.0.1, ownLyrics: `own` set, kept for
// good, never looked up again, whatever the song is renamed to).
// synced: each line with the second it starts at (an own line also with the
// second it ends at, `end`, when it was given one). Lines in step with the
// song only when its length is LRCLIB's within SYNC_SLACK seconds (a song
// trimmed differently would be out of step): else only the plain text.

const { agentName } = require('./agent');

const BASE = 'https://lrclib.net/api';
const OVH = 'https://api.lyrics.ovh/v1';
// The sources asked: 1 LRCLIB, 2 then lyrics.ovh. A song none of them had,
// kept from fewer, is asked again.
const SOURCES = 2;
const SYNC_SLACK = 4;
// A song looked up and not found is asked again after this long.
const NOT_FOUND_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
// Not on LRCLIB with lyrics.ovh out of reach (`partial`): after this long.
const PARTIAL_RETRY_MS = 60 * 60 * 1000;

// Own lyrics: at most this many lines, each this long, none past this second.
const OWN_LINES = 1000;
const OWN_TEXT = 500;
const OWN_MAX_T = 24 * 60 * 60;

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
    found: true, synced, plain: text, instrumental, source: 'LRCLIB',
  };
}

/** lyrics.ovh's words as shown: no "[Chorus]" or "[Chester Bennington]" lines, no French heading, one empty line at most. */
function ovhText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  if (/^paroles de la chanson .+ par /i.test(lines[0] || '')) lines.shift();
  return lines.filter((l) => !/^\s*\[[^\]]*\]\s*$/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
 * A song's lyrics from LRCLIB, else lyrics.ovh's words: { artist, title,
 * album, duration }. Resolves NONE when there are none (with `partial` when
 * lyrics.ovh could not be asked); rejects when LRCLIB cannot be reached.
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
      headers: agent ? { 'User-Agent': agentName(), Accept: 'application/json' } : { Accept: 'application/json' },
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
  // Not on LRCLIB: lyrics.ovh, which needs the artist.
  if (!artist) return NONE;
  const names = [artist];
  if (firstArtist(artist) && firstArtist(artist) !== artist) names.push(firstArtist(artist));
  try {
    for (const name of names) {
      const res = await get(`${OVH}/${encodeURIComponent(name)}/${encodeURIComponent(title)}`, {
        headers: agent ? { 'User-Agent': agentName(), Accept: 'application/json' } : { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`lyrics.ovh answered ${res.status}.`);
      const plain = ovhText((await res.json()).lyrics);
      if (plain) {
        return {
          found: true, synced: null, plain, instrumental: false, source: 'lyrics.ovh',
        };
      }
    }
  } catch {
    return { ...NONE, partial: true };
  }
  return NONE;
}

/**
 * Lyrics written or edited by hand (4.0.1) as kept: `rows` [{ t, end, text }]
 * in any order, t and end in seconds or null (none given). Every line with
 * words has its start time, or none has (then only the words are kept). Null
 * when no line has words (the song's own lyrics then go: looked up again).
 * Throws an Error fit to show when only some lines have their times.
 */
function ownLyrics(rows) {
  const time = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null
    : Math.round(Math.min(OWN_MAX_T, Math.max(0, Number(v))) * 1000) / 1000);
  const list = (Array.isArray(rows) ? rows : []).slice(0, OWN_LINES).map((r) => ({
    t: time(r && r.t),
    end: time(r && r.end),
    text: String((r && r.text) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, OWN_TEXT),
  }));
  const worded = list.filter((r) => r.text);
  if (!worded.length) return null;
  const timed = worded.filter((r) => r.t !== null);
  if (!timed.length) {
    // Only the words: the empty lines between verses stay, not at either end.
    const plain = list.map((r) => r.text).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return {
      found: true, synced: null, plain, instrumental: false, source: 'own', own: true,
    };
  }
  if (timed.length < worded.length) throw new Error('Give every line with words its "From" time, or leave every time empty.');
  // An empty line with a time is a pause; one without, nothing.
  const synced = list.filter((r) => r.t !== null).sort((a, b) => a.t - b.t)
    .map((r) => (r.end !== null && r.end > r.t ? { t: r.t, end: r.end, text: r.text } : { t: r.t, text: r.text }));
  return {
    found: true, synced, plain: synced.map((l) => l.text).join('\n').trim(), instrumental: false, source: 'own', own: true,
  };
}

/** What a song's lyrics depend on: looked up again when it changes (renamed, trimmed). */
function lyricsKey(song) {
  return `${fold(song.artist)}|${fold(song.title)}|${Math.round(Number(song.duration) || 0)}`;
}

/** A lookup's answer as kept for `song`. */
function toKeep(found, song, now = Date.now()) {
  return {
    ...found, key: lyricsKey(song), sources: SOURCES, at: now,
  };
}

/** A kept answer (toKeep) that still stands for `song`. */
function stillGood(kept, song, now = Date.now()) {
  if (kept && kept.own) return true;
  if (!kept || kept.key !== lyricsKey(song)) return false;
  if (kept.found) return true;
  if (!(Number(kept.sources) >= SOURCES)) return false;
  return now - (Number(kept.at) || 0) < (kept.partial ? PARTIAL_RETRY_MS : NOT_FOUND_RETRY_MS);
}

/** A kept answer never to be looked up again while `song` keeps its names: found, or by every source not. */
function settled(kept, song) {
  if (kept && kept.own) return true;
  return !!kept && kept.key === lyricsKey(song) && (kept.found || (Number(kept.sources) >= SOURCES && !kept.partial));
}

/** A kept answer cleaned up, as handed out. */
function clean(kept) {
  if (!kept || !kept.found) return { ...NONE };
  const synced = Array.isArray(kept.synced)
    ? kept.synced.filter((l) => l && Number.isFinite(Number(l.t))).map((l) => (Number(l.end) > Number(l.t)
      ? { t: Number(l.t), end: Number(l.end), text: String(l.text || '') }
      : { t: Number(l.t), text: String(l.text || '') }))
    : null;
  const own = kept.own === true;
  return {
    found: true,
    synced: synced && synced.length ? synced : null,
    plain: String(kept.plain || ''),
    instrumental: kept.instrumental === true,
    source: own ? 'own' : kept.source === 'lyrics.ovh' ? 'lyrics.ovh' : 'LRCLIB',
    ...(own ? { own } : {}),
  };
}

module.exports = {
  parseLrc, lineAt, pick, fromRecord, ovhText, lookupLyrics, ownLyrics, lyricsKey, toKeep, stillGood, settled, clean, firstArtist,
  NONE, SOURCES, NOT_FOUND_RETRY_MS, PARTIAL_RETRY_MS,
};
