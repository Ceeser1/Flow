'use strict';

// Spotify playlists and albums, by way of YouTube. Spotify's audio is copy
// protected and yt-dlp does not read it, so only the track list comes from
// Spotify: its public embed page (open.spotify.com/embed/...) carries the
// name, and every song's title, artists and exact length, without a login.
// Each song is then looked up on YouTube: first YouTube Music's song search,
// whose results are the album audio at the album length, then, if that finds
// nothing close, the ordinary YouTube search with every result scored.
//
// The embed page is not an official interface. If Spotify changes it, reading
// fails with a message saying so rather than with nonsense.

const SPOTIFY_RE = /^(?:https?:\/\/)?(?:open|play)\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{10,})/i;
const SPOTIFY_URI_RE = /^spotify:(playlist|album):([A-Za-z0-9]{10,})$/i;

/** { type: 'playlist' | 'album', id } for a Spotify link, or null. */
function parseSpotifyUrl(text) {
  const t = String(text || '').trim();
  const m = SPOTIFY_RE.exec(t) || SPOTIFY_URI_RE.exec(t);
  return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
}

function isSpotifyTrackUrl(text) {
  return /^(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\//i.test(String(text || '').trim());
}

/**
 * The embed page's data: { name, type, tracks: [{ title, artists, duration,
 * playable }] }, duration in seconds.
 */
function parseEmbedPage(html) {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(String(html || ''));
  if (!m) throw new Error('Spotify\'s page could not be read. Spotify may have changed it.');
  let entity;
  try {
    entity = JSON.parse(m[1]).props.pageProps.state.data.entity;
  } catch {
    throw new Error('Spotify\'s page could not be read. Spotify may have changed it.');
  }
  if (!entity || !Array.isArray(entity.trackList)) {
    throw new Error('This Spotify link has no songs that can be read. Is the playlist public?');
  }
  return {
    name: String(entity.name || entity.title || 'Spotify playlist'),
    type: String(entity.type || ''),
    tracks: entity.trackList.map((t) => ({
      title: String(t.title || '').trim(),
      artists: String(t.subtitle || '').replace(/\s*,\s*/g, ', ').trim(),
      duration: (Number(t.duration) || 0) / 1000,
      playable: t.isPlayable !== false,
    })).filter((t) => t.title),
  };
}

/** Fetches and reads a playlist or album. */
async function fetchSpotify({ type, id }) {
  let res;
  try {
    res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'Accept-Language': 'en',
      },
    });
  } catch {
    throw new Error('Could not reach Spotify. Please check the internet connection.');
  }
  if (res.status === 404) throw new Error('Nothing was found at this Spotify link. Is the playlist public?');
  if (!res.ok) throw new Error(`Spotify refused the request (error ${res.status}). Try again later.`);
  return parseEmbedPage(await res.text());
}

// ---- matching a Spotify song to a YouTube upload ----

// Versions that are a different recording, or a worse copy, than the song on
// Spotify. They only count against a result when Spotify's own title does not
// say the same.
const OTHER_VERSION = [
  'lyrics', 'lyric', 'live', 'cover', 'remix', 'sped up', 'slowed', 'nightcore', 'reverb',
  '8d', 'karaoke', 'instrumental', 'reaction', 'tutorial', 'loop', 'bass boosted',
  'acoustic', 'hour', 'hours', 'extended', 'mashup', 'edit', 'version', 'concert', 'fan made',
  'performance', 'session', 'sessions', 'tiny desk', 'hootenanny', 'songline', 'unplugged',
];

/**
 * Whether a channel is the artist's own: the same name, give or take
 * "- Topic", "VEVO" or "Official". "Bad Bunny jr" is not Bad Bunny.
 */
function channelIsArtist(artist, channel) {
  const squash = (t) => fold(t).replace(/ /g, '');
  const ch = squash(String(channel || '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s+(official|music|tv|records)$/i, ''));
  const a = squash(artist);
  return !!a && ch === a;
}

function fold(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function hasWord(haystack, word) {
  return (` ${haystack} `).includes(` ${word} `);
}

/** Spotify's title without the parts a YouTube title rarely repeats. */
function searchTitle(title) {
  return String(title || '')
    .replace(/\s*[([](?:feat\.?|ft\.?|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?.*$/i, '')
    .trim();
}

/** The YouTube search for one song: first artist and title. */
function searchQuery(track) {
  const first = String(track.artists || '').split(',')[0].trim();
  return `${first} - ${searchTitle(track.title)}`;
}

/**
 * How well a YouTube result fits a Spotify song: higher is better. Length
 * weighs most, since a music video with an intro or a lyrics upload that was
 * sped up shows there first.
 */
function scoreMatch(track, cand) {
  const title = fold(cand.title);
  const channel = String(cand.channel || cand.uploader || '');
  const artists = String(track.artists || '').split(',').map((a) => a.trim()).filter(Boolean);
  const want = fold(searchTitle(track.title));
  const spotifyTitle = fold(track.title);
  let score = 0;

  const diff = cand.duration ? Math.abs(cand.duration - track.duration) : 60;
  score -= Math.min(60, diff * 2);

  const fromArtist = artists.some((a) => channelIsArtist(a, channel));
  if (fromArtist) score += 25;
  if (fromArtist && /-\s*topic$/i.test(channel)) score += 10;
  if (want && title.includes(want)) score += 15;
  if (artists.some((a) => title.includes(fold(a)))) score += 8;
  score -= otherVersionWords(title, spotifyTitle) * 30;
  return { score, diff, fromArtist };
}

/** How many "other version" words a title has that Spotify's title does not. */
function otherVersionWords(title, spotifyTitle) {
  let n = 0;
  for (const word of OTHER_VERSION) {
    if (hasWord(title, word) && !hasWord(spotifyTitle, word)) n += 1;
  }
  return n;
}

/**
 * YouTube Music's song search lists album audio, best first, but with titles
 * only. The first result that is this song and not another version of it.
 */
function pickMusicResult(track, entries) {
  const want = fold(searchTitle(track.title));
  const spotifyTitle = fold(track.title);
  if (!want) return null;
  const usable = (entries || []).filter((e) => e && e.id && fold(e.title));
  // A result holding the whole title ("Song" for "Song").
  for (const e of usable) {
    const title = fold(e.title);
    if (title.includes(want) && !otherVersionWords(title, spotifyTitle)) return e;
  }
  // A shorter one ("Song" for "Song - From the film"), unless what it leaves
  // out makes it another version ("Song" for "Song - Club Remix").
  for (const e of usable) {
    const title = fold(e.title);
    if (want.includes(title) && !otherVersionWords(spotifyTitle, title)) return e;
  }
  return null;
}

/** YouTube Music's search, limited to songs. */
function musicSearchUrl(track) {
  return `https://music.youtube.com/search?q=${encodeURIComponent(searchQuery(track))}#songs`;
}

/**
 * The best of the search results. quality: 'good' (within 5 s, and from the
 * artist or naming the song), 'shaky' (within 20 s, worth a look), or 'none'.
 */
function pickMatch(track, candidates) {
  let best = null;
  for (const cand of candidates || []) {
    if (!cand || !cand.id) continue;
    const s = scoreMatch(track, cand);
    if (!best || s.score > best.score) best = { ...s, cand };
  }
  if (!best) return { quality: 'none', cand: null, diff: null };
  const title = fold(best.cand.title);
  const namesSong = title.includes(fold(searchTitle(track.title)));
  let quality;
  if (best.diff <= 5 && (best.fromArtist || namesSong) && best.score > -10) quality = 'good';
  else if (best.diff <= 20) quality = 'shaky';
  else quality = 'none';
  return { quality, cand: best.cand, diff: best.diff };
}

module.exports = {
  parseSpotifyUrl, isSpotifyTrackUrl, parseEmbedPage, fetchSpotify,
  searchQuery, searchTitle, scoreMatch, pickMatch, pickMusicResult, musicSearchUrl, channelIsArtist,
};
