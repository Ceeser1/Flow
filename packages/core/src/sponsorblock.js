'use strict';

// SponsorBlock (sponsor.ajay.app): the parts of a YouTube video its viewers
// marked, for the trim editor to colour. The same data yt-dlp's
// --sponsorblock-mark reads, asked for here directly: yt-dlp waits up to 80 s
// for an API that does not answer before it prints anything, this gives up
// after a few seconds and the song is trimmed without the colours.
//
// Asked by the first four characters of the video id's SHA-256, as yt-dlp
// does, so the API never learns which video it was.

const crypto = require('crypto');
const { parseYouTubeId } = require('./text');

const API = 'https://sponsor.ajay.app';
const TIMEOUT = 6000;

// What the two settings colour. Sponsors: paid parts, plugs of the channel's
// own things, "like and subscribe". Intros and outros: a music video's
// non-music parts (talk, skits, credits) count as those.
const SPONSOR_CATEGORIES = ['sponsor', 'selfpromo', 'interaction'];
const INTRO_CATEGORIES = ['intro', 'outro', 'music_offtopic'];
const CATEGORIES = [...SPONSOR_CATEGORIES, ...INTRO_CATEGORIES];

/** The YouTube id of a source key ('youtube:ID') or a link, or ''. */
function videoId(key, url) {
  const m = /^youtube:([A-Za-z0-9_-]{11})$/.exec(String(key || ''));
  return m ? m[1] : (parseYouTubeId(url || '') || '');
}

/**
 * The marked parts of one video: [{ start, end, category, kind }] sorted by
 * start, kind 'sponsor' or 'intro'. [] when there are none, or the API
 * cannot be reached (never rejects).
 */
async function segmentsFor(id, { timeout = TIMEOUT } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || ''))) return [];
  const prefix = crypto.createHash('sha256').update(id).digest('hex').slice(0, 4);
  const query = `categories=${encodeURIComponent(JSON.stringify(CATEGORIES))}`
    + `&actionTypes=${encodeURIComponent(JSON.stringify(['skip', 'mute']))}`;
  let list;
  try {
    const res = await fetch(`${API}/api/skipSegments/${prefix}?${query}`, { signal: AbortSignal.timeout(timeout) });
    // 404: no video with this prefix has any.
    if (!res.ok) return [];
    list = await res.json();
  } catch {
    return [];
  }
  const video = Array.isArray(list) ? list.find((v) => v && v.videoID === id) : null;
  return parseSegments(video && video.segments);
}

/** The API's segments as the trim editor draws them. */
function parseSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (const s of segments) {
    if (!s || !Array.isArray(s.segment) || !CATEGORIES.includes(s.category)) continue;
    const start = Number(s.segment[0]);
    const end = Number(s.segment[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({
      start: Math.max(0, start),
      end,
      category: s.category,
      kind: SPONSOR_CATEGORIES.includes(s.category) ? 'sponsor' : 'intro',
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

module.exports = { videoId, segmentsFor, parseSegments, SPONSOR_CATEGORIES, INTRO_CATEGORIES };
