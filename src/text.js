'use strict';

// Pure text helpers: link keys and filename safety. No Electron or Node
// dependency, so everything here is covered directly by node --test.

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_PATH_ID_RE = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/;
const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);

function toUrl(text) {
  let raw = String(text || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return null;
  if (!raw.includes('//')) raw = 'https://' + raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/** The 11 character video id of a YouTube link, or null for any other link. */
function parseYouTubeId(text) {
  const url = toUrl(text);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  if (host === 'youtu.be') {
    const first = url.pathname.replace(/^\/+/, '').split('/')[0];
    return YT_ID_RE.test(first) ? first : null;
  }
  if (url.pathname.replace(/\/+$/, '') === '/watch') {
    const v = url.searchParams.get('v') || '';
    return YT_ID_RE.test(v) ? v : null;
  }
  const m = YT_PATH_ID_RE.exec(url.pathname);
  return m ? m[1] : null;
}

/** A pasted link cleaned up for yt-dlp, or null when it is not a web link. */
function normalizeUrl(text) {
  const id = parseYouTubeId(text);
  if (id) return 'https://www.youtube.com/watch?v=' + id;
  const url = toUrl(text);
  return url ? url.href : null;
}

/**
 * A pasted link cleaned up for reading as a whole list. Unlike normalizeUrl a
 * YouTube link keeps its `list=`: a Mix only exists as "this video, in this
 * Mix" (watch?v=...&list=RD...), and cutting it down to the video is exactly
 * what makes a list read as one song.
 */
function normalizeListUrl(text) {
  const url = toUrl(text);
  if (!url) return null;
  const list = YT_HOSTS.has(url.hostname.toLowerCase()) ? url.searchParams.get('list') : null;
  if (!list) return normalizeUrl(text);
  const id = parseYouTubeId(text);
  const l = encodeURIComponent(list);
  return id ? `https://www.youtube.com/watch?v=${id}&list=${l}` : `https://www.youtube.com/playlist?list=${l}`;
}

/**
 * The key a song's source is remembered by, so the same song pasted again is
 * recognised. yt-dlp's own extractor name and media id once the link has been
 * read (`Youtube:dQw4w9WgXcQ`, `Soundcloud:123456`). Before that only YouTube
 * links can be keyed, since only for those is the id in the link itself.
 */
function sourceKey(extractor, id) {
  if (!extractor || !id) return null;
  return String(extractor).toLowerCase() + ':' + String(id);
}

function sourceKeyFromUrl(text) {
  const id = parseYouTubeId(text);
  return id ? sourceKey('youtube', id) : null;
}

/**
 * The part of a link that identifies the page, for comparing two links that
 * were not keyed: host without www, the path, no query or fragment. The query
 * on SoundCloud and most other sites is tracking (?si=, ?utm_...), which is
 * what makes two copies of the same link differ.
 */
function comparableUrl(text) {
  const id = parseYouTubeId(text);
  if (id) return 'youtube:' + id;
  const url = toUrl(text);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, '').toLowerCase();
  return host + path;
}

const BAD_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);

/** A string made safe to use as a Windows file name (without extension). */
function safeFilename(name, limit = 150) {
  let cleaned = String(name || '').replace(/\s+/g, ' ');
  cleaned = cleaned.replace(BAD_CHARS_RE, '_').trim().replace(/^\.+|\.+$/g, '');
  cleaned = cleaned.slice(0, limit).trim().replace(/^\.+|[.\s]+$/g, '');
  if (!cleaned) return 'song';
  if (RESERVED.has(cleaned.split('.')[0].toUpperCase())) return '_' + cleaned;
  return cleaned;
}

/** "Artist - Title (Mix)", the name a saved song's file gets. */
function songFileStem(artist, title, mix) {
  const a = String(artist || '').trim();
  const t = String(title || '').trim() || 'Unknown title';
  const m = String(mix || '').trim();
  let stem = a ? `${a} - ${t}` : t;
  if (m) stem += ` (${m})`;
  return safeFilename(stem);
}

module.exports = {
  parseYouTubeId, normalizeUrl, normalizeListUrl, sourceKey, sourceKeyFromUrl, comparableUrl,
  safeFilename, songFileStem,
};
