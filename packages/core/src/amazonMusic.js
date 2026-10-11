'use strict';

// Amazon Music playlists, albums and songs, by way of YouTube, the way Spotify
// lists are (spotify.js): Amazon's audio is copy protected and yt-dlp refuses
// it, so only the track list comes from Amazon and each song is then looked up
// on YouTube with spotify.js's matching.
//
// Amazon Music's web player builds its pages in the browser, but hands search
// engines the page already drawn: asked as Googlebot, a playlist's page holds
// every song as a <music-image-row> (an album's as <music-text-row>) with its
// title, artists, album and length in attributes, without a login.
//
// That page is not an official interface. If Amazon changes it, reading fails
// with a message saying so rather than with nonsense. Catalog pages are per
// country: a link from another country's store may lead to the home page.

const AMAZON_RE = /^(?:https?:\/\/)?(?:music\.amazon\.((?:com?\.)?[a-z]{2,3})|(?:www\.)?amazon\.((?:com?\.)?[a-z]{2,3})\/music\/player)\/(playlists|user-playlists|albums|tracks)\/([A-Za-z0-9_-]{6,})\/?(?:[?#]|$)/i;

const CRAWLER_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/**
 * { type: 'playlist' | 'user-playlist' | 'album' | 'track', id, tld, trackId,
 * query } for an Amazon Music link, or null. trackId: the one song of an
 * album link shared from a song (?trackAsin=...).
 */
function parseAmazonMusicUrl(text) {
  const t = String(text || '').trim();
  const m = AMAZON_RE.exec(t);
  if (!m) return null;
  let params;
  try {
    params = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  const type = m[3].toLowerCase().replace(/s$/, '');
  return {
    type,
    id: m[4],
    tld: (m[1] || m[2]).toLowerCase(),
    trackId: type === 'album' ? (params.get('trackAsin') || '') : '',
    // A shared playlist of someone's own may need its share id to be shown.
    query: type === 'user-playlist' ? params.toString() : '',
  };
}

/** The link to the list itself, on Amazon Music's own site. */
function pageUrl(ref) {
  const url = `https://music.amazon.${ref.tld}/${ref.type}s/${ref.id}`;
  return ref.query ? `${url}?${ref.query}` : url;
}

function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') {
      const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }[k];
  });
}

/** Every <tag ...> of this name in the page, as { attribute: value }. */
function tagsNamed(html, names) {
  const re = new RegExp(`<(?:${names})((?:\\s+[a-z0-9-]+(?:="[^"]*")?)*)\\s*/?>`, 'gi');
  const out = [];
  for (const m of String(html || '').matchAll(re)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-z0-9-]+)(?:="([^"]*)")?/gi)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] || '');
    out.push(attrs);
  }
  return out;
}

/** "03:40" or "1:02:03" in seconds. */
function parseClock(text) {
  const parts = String(text || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((s, n) => s * 60 + n, 0);
}

/** Amazon's "A feat. B" as Spotify's "A, B"; "A & B" stays, as for "Simon & Garfunkel". */
function cleanArtists(text) {
  return String(text || '').split(/\s+(?:feat\.?|ft\.|featuring)\s+|\s*,\s*/i)
    .map((a) => a.trim()).filter(Boolean).join(', ');
}

/** "Song [Explicit]" is the same song as "Song". */
function cleanTitle(text) {
  return String(text || '').replace(/\s*\[(?:explicit|clean)\]\s*$/i, '').trim();
}

function trackIdOf(href) {
  const m = /[?&]trackAsin=([A-Za-z0-9]+)|\/tracks\/([A-Za-z0-9]+)/.exec(String(href || ''));
  return m ? (m[1] || m[2]) : '';
}

/**
 * The page's data: { name, type, total, tracks: [{ title, artists, duration,
 * playable, id }] }, duration in seconds, total the song count the page
 * gives (null when it gives none).
 */
function parseAmazonPage(html) {
  const header = tagsNamed(html, 'music-detail-header').find((a) => a.headline);
  if (!header) {
    throw new Error('Amazon Music shows nothing at this link. Is the playlist public, and from this country\'s Amazon Music?');
  }
  const pageArtist = cleanArtists(header['primary-text']);
  const tracks = tagsNamed(html, 'music-image-row|music-text-row')
    .filter((a) => 'data-key' in a && a['primary-text'])
    .map((a) => ({
      title: cleanTitle(a['primary-text']),
      // A playlist row names its artists; an album's or a song's page, once, at the top.
      artists: cleanArtists(a['secondary-text-1']) || pageArtist,
      duration: parseClock(a.duration),
      playable: !/^true$/i.test(a['aria-disabled'] || ''),
      id: trackIdOf(a['primary-href']),
    }))
    .filter((t) => t.title);
  const type = String(header.label || '').toLowerCase();
  const count = /^\s*(\d[\d.,]*)\s/.exec(header['tertiary-text'] || '');
  const total = type !== 'song' && count ? Number(count[1].replace(/[.,]/g, '')) : null;
  if (!tracks.length) {
    if (total === 0) throw new Error('This Amazon Music list has no songs.');
    throw new Error('Amazon Music\'s page could not be read. Amazon may have changed it.');
  }
  return { name: String(header.headline || 'Amazon Music playlist'), type, total, tracks };
}

/** Fetches and reads a playlist, album or song. */
async function fetchAmazonMusic(ref) {
  let res;
  try {
    res = await fetch(pageUrl(ref), { headers: { 'User-Agent': CRAWLER_UA, 'Accept-Language': 'en' } });
  } catch {
    throw new Error('Could not reach Amazon Music. Please check the internet connection.');
  }
  if (res.status === 404) throw new Error('Nothing was found at this Amazon Music link. Is the playlist public?');
  if (!res.ok) throw new Error(`Amazon Music refused the request (error ${res.status}). Try again later.`);
  const page = parseAmazonPage(await res.text());
  // An album link shared from one of its songs: that song.
  if (ref.trackId) {
    const one = page.tracks.filter((t) => t.id === ref.trackId);
    if (one.length) return { ...page, name: `${one[0].artists} - ${one[0].title}`, total: one.length, tracks: one };
  }
  return page;
}

module.exports = { parseAmazonMusicUrl, pageUrl, parseAmazonPage, fetchAmazonMusic, cleanArtists };
