'use strict';

// Deezer playlists, albums and songs, by way of YouTube, the way Spotify lists
// are (spotify.js): Deezer's audio is copy protected and yt-dlp refuses it, so
// only the track list comes from Deezer and each song is then looked up on
// YouTube with spotify.js's matching.
//
// Deezer has a public API (api.deezer.com) that gives a public playlist's or
// an album's songs, with title, artists and exact length, without a login. It
// hands them out a page at a time.

const DEEZER_RE = /^(?:https?:\/\/)?(?:www\.)?deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(playlist|album|track)\/(\d+)/i;
// Share links (link.deezer.com/s/..., deezer.page.link/...) lead to one of the above.
const SHORT_RE = /^(?:https?:\/\/)?(?:link\.deezer\.com|deezer\.page\.link)\/\S+/i;

const API = 'https://api.deezer.com';
const PAGE = 100;
// A runaway list (a page that keeps saying there is more) stops here.
const MAX_SONGS = 5000;

/** { type: 'playlist' | 'album' | 'track', id } or { short: url } for a Deezer link, or null. */
function parseDeezerUrl(text) {
  const t = String(text || '').trim();
  const m = DEEZER_RE.exec(t);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  if (SHORT_RE.test(t)) return { short: /^https?:\/\//i.test(t) ? t : `https://${t}` };
  return null;
}

/** A share link followed to the playlist, album or song it leads to. */
async function resolveShortLink(ref) {
  if (!ref.short) return ref;
  let res;
  try {
    res = await fetch(ref.short, { redirect: 'follow' });
  } catch {
    throw new Error('Could not reach Deezer. Please check the internet connection.');
  }
  const found = parseDeezerUrl(res.url)
    || parseDeezerUrl((/https?:\/\/(?:www\.)?deezer\.com\/[^\s"'<>]+/i.exec(await res.text()) || [''])[0]);
  if (!found || found.short) throw new Error('This Deezer link does not lead to a playlist, album or song.');
  return found;
}

/**
 * A Deezer song as { title, artists, duration, playable }. Always playable:
 * Deezer marks songs it may not play itself (readable: false, often only in
 * some countries), but the song is looked up on YouTube all the same.
 */
function trackOf(t, albumArtist = '') {
  const names = Array.isArray(t.contributors) && t.contributors.length
    ? t.contributors.map((c) => c && c.name)
    : [t.artist && t.artist.name || albumArtist];
  return {
    title: String(t.title || t.title_short || '').trim(),
    artists: [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))].join(', '),
    duration: Number(t.duration) || 0,
    playable: true,
  };
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  } catch {
    throw new Error('Could not reach Deezer. Please check the internet connection.');
  }
  if (!res.ok) throw new Error(`Deezer refused the request (error ${res.status}). Try again later.`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Deezer\'s answer could not be read. Deezer may have changed it.');
  }
  if (data && data.error) {
    if (data.error.code === 800) throw new Error('Nothing was found at this Deezer link. Is the playlist public?');
    if (data.error.code === 4) throw new Error('Deezer asks to wait a moment. Try again in a few seconds.');
    throw new Error(`Deezer refused the request: ${data.error.message || data.error.type || 'unknown error'}.`);
  }
  return data;
}

/**
 * Fetches and reads a playlist, album or song: { name, url, tracks: [{ title,
 * artists, duration, playable }] }. isCancelled() stops the paging early.
 */
async function fetchDeezer(ref, isCancelled = () => false) {
  const url = `https://www.deezer.com/${ref.type}/${ref.id}`;
  const info = await getJson(`${API}/${ref.type}/${ref.id}`);
  if (ref.type === 'track') {
    const t = trackOf(info);
    return { name: `${t.artists} - ${t.title}`, url, tracks: [t] };
  }
  const albumArtist = ref.type === 'album' && info.artist ? String(info.artist.name || '') : '';
  const total = Number(info.nb_tracks) || 0;
  const raw = (info.tracks && Array.isArray(info.tracks.data)) ? [...info.tracks.data] : [];
  // The first songs come along; the rest a page at a time.
  while (raw.length < Math.min(total, MAX_SONGS) && !isCancelled()) {
    const page = await getJson(`${API}/${ref.type}/${ref.id}/tracks?index=${raw.length}&limit=${PAGE}`);
    const data = Array.isArray(page.data) ? page.data : [];
    if (!data.length) break;
    raw.push(...data);
  }
  const tracks = raw.filter(Boolean).map((t) => trackOf(t, albumArtist)).filter((t) => t.title);
  if (!tracks.length) throw new Error('This Deezer list has no songs that can be read.');
  return { name: String(info.title || 'Deezer playlist'), url, tracks };
}

module.exports = { parseDeezerUrl, resolveShortLink, fetchDeezer, trackOf };
