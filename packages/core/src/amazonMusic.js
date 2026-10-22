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
// A playlist someone made (user-playlists/...) is not drawn for search
// engines: Amazon hands them its home page, and its player's own service
// answers only a signed-in visitor. What it does draw is the small card a chat
// app shows for a shared link, asked as Facebook's link preview: the list's
// name and every song's track id in order. Each song is then read from its
// own track page, as above.
//
// Those pages are not an official interface. If Amazon changes them, reading
// fails with a message saying so rather than with nonsense. Catalog pages are
// per country: a link from another country's store may lead to the home page.

const AMAZON_RE = /^(?:https?:\/\/)?(?:music\.amazon\.((?:com?\.)?[a-z]{2,3})|(?:www\.)?amazon\.((?:com?\.)?[a-z]{2,3})\/music\/player)\/(playlists|user-playlists|albums|tracks)\/([A-Za-z0-9_-]{6,})\/?(?:[?#]|$)/i;

const CRAWLER_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
// Track pages read at once for a playlist someone made.
const TRACK_PARALLEL = 4;

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
 * The page's data: { name, type, total, tracks: [{ title, artists, album,
 * duration, playable, id }] }, duration in seconds, total the song count the
 * page gives (null when it gives none).
 */
function parseAmazonPage(html) {
  const header = tagsNamed(html, 'music-detail-header').find((a) => a.headline);
  if (!header) {
    throw new Error('Amazon Music shows nothing at this link. Is the playlist public, and from this country\'s Amazon Music?');
  }
  const pageArtist = cleanArtists(header['primary-text']);
  const type = String(header.label || '').toLowerCase();
  // A playlist row names its album; an album's page only once, at the top.
  const pageAlbum = type === 'album' ? cleanTitle(header.headline) : '';
  const tracks = tagsNamed(html, 'music-image-row|music-text-row')
    .filter((a) => 'data-key' in a && a['primary-text'])
    .map((a) => ({
      title: cleanTitle(a['primary-text']),
      // A playlist row names its artists; an album's or a song's page, once, at the top.
      artists: cleanArtists(a['secondary-text-1']) || pageArtist,
      album: cleanTitle(a['secondary-text-2']) || pageAlbum,
      duration: parseClock(a.duration),
      playable: !/^true$/i.test(a['aria-disabled'] || ''),
      id: trackIdOf(a['primary-href']),
    }))
    .filter((t) => t.title);
  const count = /^\s*(\d[\d.,]*)\s/.exec(header['tertiary-text'] || '');
  const total = type !== 'song' && count ? Number(count[1].replace(/[.,]/g, '')) : null;
  if (!tracks.length) {
    if (total === 0) throw new Error('This Amazon Music list has no songs.');
    throw new Error('Amazon Music\'s page could not be read. Amazon may have changed it.');
  }
  return { name: String(header.headline || 'Amazon Music playlist'), type, total, tracks };
}

/** The value of each <meta> named `name` (property= or name=), in page order. */
function metaValues(html, name) {
  const out = [];
  for (const m of String(html || '').matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const key = /\s(?:property|name)="([^"]*)"/i.exec(tag);
    const value = /\scontent="([^"]*)"/i.exec(tag);
    if (key && value && key[1].toLowerCase() === name) out.push(decodeEntities(value[1]));
  }
  return out;
}

/**
 * The link preview card of a playlist someone made: { name, ids }, ids its
 * songs' track ids in order.
 */
function parsePreviewCard(html) {
  const name = metaValues(html, 'og:title')[0];
  if (!name) {
    throw new Error('Amazon Music shows nothing at this link. Is the playlist public, and from this country\'s Amazon Music?');
  }
  const ids = metaValues(html, 'music:song').map(trackIdOf).filter(Boolean);
  return { name, ids };
}

async function fetchPage(url, userAgent) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': userAgent, 'Accept-Language': 'en' } });
  } catch {
    throw new Error('Could not reach Amazon Music. Please check the internet connection.');
  }
  if (res.status === 404) throw new Error('Nothing was found at this Amazon Music link. Is the playlist public?');
  if (!res.ok) throw new Error(`Amazon Music refused the request (error ${res.status}). Try again later.`);
  return res.text();
}

/** A song's own row on its track page, or null. */
async function fetchTrack(tld, id) {
  const page = parseAmazonPage(await fetchPage(pageUrl({ type: 'track', id, tld }), CRAWLER_UA));
  return page.tracks.find((t) => t.id === id) || null;
}

/**
 * A playlist someone made: its card, then each song's track page, a few at a
 * time. A song whose page cannot be read stays in the list as not playable.
 * onTrack(done, total) after each.
 */
async function fetchUserPlaylist(ref, isCancelled, onTrack) {
  const card = parsePreviewCard(await fetchPage(pageUrl(ref), PREVIEW_UA));
  if (!card.ids.length) throw new Error('This Amazon Music list has no songs.');
  const tracks = new Array(card.ids.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < card.ids.length && !isCancelled()) {
      const n = next;
      next += 1;
      let track = null;
      try {
        track = await fetchTrack(ref.tld, card.ids[n]);
      } catch {
        // Below: kept as not playable.
      }
      tracks[n] = track || { title: `Song ${n + 1}`, artists: '', duration: 0, playable: false, id: card.ids[n] };
      done += 1;
      onTrack(done, card.ids.length);
    }
  };
  await Promise.all(Array.from({ length: TRACK_PARALLEL }, worker));
  if (tracks.every((t) => !t.playable)) throw new Error('Amazon Music\'s song pages could not be read. Amazon may have changed them.');
  return { name: card.name, type: 'playlist', total: tracks.length, tracks };
}

/**
 * Fetches and reads a playlist, album or song. isCancelled() and
 * onTrack(done, total) are for a playlist someone made, read song by song.
 */
async function fetchAmazonMusic(ref, isCancelled = () => false, onTrack = () => {}) {
  if (ref.type === 'user-playlist') return fetchUserPlaylist(ref, isCancelled, onTrack);
  const page = parseAmazonPage(await fetchPage(pageUrl(ref), CRAWLER_UA));
  // A song's page lists its whole album; an album link shared from one of its
  // songs is the album's. Either way: that song.
  const one = ref.type === 'track' ? ref.id : ref.trackId;
  if (one) {
    const song = page.tracks.filter((t) => t.id === one);
    if (song.length) return { ...page, name: `${song[0].artists} - ${song[0].title}`, total: 1, tracks: song };
  }
  return page;
}

module.exports = { parseAmazonMusicUrl, pageUrl, parseAmazonPage, parsePreviewCard, fetchAmazonMusic, cleanArtists };
