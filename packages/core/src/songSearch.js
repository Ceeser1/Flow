'use strict';

// Add Songs with words typed instead of a link ("Linkin Park - Numb"): what
// counts as words, and how the uploads a search finds are ranked. The search
// itself is the lister's (listing.js search); the Add Songs page lists what
// it found and downloads the one picked like a pasted link.
//
// Unlike a Spotify song (spotify.rankMatches) there is no length to compare
// with, so the names decide: how many of the typed words the title and the
// channel have, whether the channel is the artist's (or YouTube's own "Artist
// - Topic" upload of the album), whether the title is another version of the
// song (live, cover, remix ... unless that was typed too), and, last, how far
// an upload's length is from what most uploads of the song last (a music
// video with a long intro, a sped up one).

const { fold, hasWord, channelIsArtist, OTHER_VERSION } = require('./spotify');

const MAX_QUERY = 200;
// Uploads this long are a compilation or a whole album, not the song.
const LONG = 15 * 60;
// Version words that leave the song as it is: only a small step down.
const MILD = new Set(['lyrics', 'lyric']);
const UNAVAILABLE_RE = /^\[(private|deleted|unavailable)( video)?\]$/i;

/**
 * Whether what was typed into the link box is words to search for rather than
 * a link: anything with a space in it, or one word that names no web host
 * ("Numb", not "youtu.be/abc" or "soundcloud.com/artist/song"). Something with
 * "://" in it, or Spotify's own "spotify:" links, is always a link.
 * (The page has a copy of this: AddPage.isSearch.)
 */
function isSearch(text) {
  const t = String(text || '').trim();
  if (!t || t.includes('://') || /^spotify:/i.test(t)) return false;
  if (/\s/.test(t)) return true;
  let host;
  try {
    host = new URL(`https://${t}`).hostname;
  } catch {
    return true;
  }
  return !/\.[a-z]{2,}$/i.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * The typed words: { query, artist, title }. "Artist - Title" is split at the
 * dash; anything else is a title only, with the artist unknown.
 */
function parseQuery(text) {
  const query = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(query);
  if (m) return { query, artist: m[1].trim(), title: m[2].trim() };
  return { query, artist: '', title: query };
}

/** YouTube Music's search for the typed words, limited to songs. */
function musicSearchUrl(query) {
  return `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`;
}

/** The version words a title has that the typed words do not. */
function versionWords(title, asked) {
  const t = fold(title);
  return OTHER_VERSION.filter((w) => hasWord(t, w) && !hasWord(asked, w));
}

/**
 * Of YouTube Music's results (titles only), those that can be the song: their
 * title is the typed title, or is made of typed words only ("Numb" for "numb
 * linkin park"), and is no other version of it. In YouTube Music's order.
 */
function musicHits({ query, title }, entries) {
  const asked = fold(query);
  const words = new Set(asked.split(' '));
  const want = fold(title);
  return (entries || []).filter((e) => {
    const t = e && e.id ? fold(e.title) : '';
    if (!t || versionWords(e.title, asked).length) return false;
    return t === want || t.split(' ').every((w) => words.has(w));
  });
}

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * The uploads a search found, best first. parsed: parseQuery's; candidates:
 * [{ id, title, channel, duration, fromMusic?, order? }], `order` being its
 * place in its own site's results. Each comes back with quality 'good' (the
 * song, from the artist or YouTube Music, or with no artist typed one that
 * names every word), 'shaky' (has most of the words) or 'none', and
 * versions: the version words its title has that were not typed ("live").
 */
function rankSearch(parsed, candidates) {
  const asked = fold(parsed.query);
  const words = [...new Set(asked.split(' ').filter(Boolean))];
  const want = fold(parsed.title);
  const scored = (candidates || []).filter((c) => c && c.id && !UNAVAILABLE_RE.test(String(c.title || '')))
    .map((cand, i) => {
      const channel = String(cand.channel || '');
      const fromArtist = !!parsed.artist && channelIsArtist(parsed.artist, channel);
      // The artist's channel has the artist's words, however it writes them ("HollywoodUndead").
      const hay = ` ${fold(cand.title)} ${fold(channel.replace(/\s*-\s*topic$/i, ''))} ${fromArtist ? fold(parsed.artist) : ''} `;
      const coverage = words.length ? words.filter((w) => hay.includes(` ${w} `)).length / words.length : 0;
      const topic = /-\s*topic$/i.test(channel);
      const versions = versionWords(cand.title, asked);
      const strong = versions.filter((w) => !MILD.has(w)).length;
      let score = 40 * coverage - 0.5 * (cand.order ?? i);
      if (fromArtist) score += 20;
      if (topic && coverage >= 0.5) score += 8;
      if (cand.fromMusic) score += 10;
      if (want && hasWord(fold(cand.title), want)) score += 12;
      score -= strong * 35 + (versions.length - strong) * 5;
      const long = cand.duration > LONG;
      if (long) score -= 40;
      return { cand, score, coverage, fromArtist, topic, versions, strong, long };
    });

  // What most uploads of the song last: one far off is another cut of it.
  const typical = median(scored.filter((s) => s.coverage >= 0.6 && !s.strong && !s.long && s.cand.duration > 0)
    .map((s) => s.cand.duration));
  for (const s of scored) {
    s.diff = typical && s.cand.duration ? Math.abs(s.cand.duration - typical) : null;
    if (s.diff !== null) s.score -= Math.min(20, Math.max(0, s.diff - 6) / 2);
  }

  return scored
    // Stable: of two as good, the one its search put first.
    .sort((a, b) => b.score - a.score)
    .map((s) => {
      const trusted = s.fromArtist || s.topic || s.cand.fromMusic || !parsed.artist;
      let quality = 'none';
      if (s.coverage >= 0.75 && !s.strong && !s.long && trusted && (s.diff === null || s.diff <= 15)) quality = 'good';
      else if (s.coverage >= 0.5) quality = 'shaky';
      return { ...s.cand, quality, versions: s.versions };
    });
}

module.exports = { isSearch, parseQuery, musicSearchUrl, musicHits, rankSearch, MAX_QUERY };
