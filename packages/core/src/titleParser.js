'use strict';

// Works out Artist, Title and Mix from what yt-dlp reports about a link.
// Pure, so every rule here is pinned by test/titleParser.test.js.
//
// The order of trust:
//   1. yt-dlp's own `track` and `artist` fields. YouTube Music, "Topic"
//      channels and many music videos carry them, and they are right.
//   2. The "Title · Artist" line of a description YouTube generated itself
//      ("Provided to YouTube by ..."), for the rare case yt-dlp left it unread.
//   3. The title itself: "Artist - Title (Mix)", "Artist 'Title' MV",
//      "“Title” Lyric Video | Film | Studio", "Title by Artist".
//   4. The channel name as the artist, which is usually right on SoundCloud and
//      Bandcamp and at least a start on YouTube. The Add Songs page says so
//      next to the Artist box.
// Whatever comes out is only a suggestion: the Add Songs page shows all three
// in editable boxes before anything is saved.

// Words that make a bracket a mix / version rather than clutter.
const MIX_RE = new RegExp('\\b(' + [
  're-?mix(es)?', 'mix', 'edit', 'vip', 'bootleg', 'extended', 'acoustic', 'live',
  'version', 'ver\\.', 're-?work', 'flip', 'cover', 'instrumental', 'radio', 'club',
  'dub', 'remaster(ed)?', 'mash-?up', 'sped up', 'slowed', 'reverb', 'nightcore',
  'reprise', 'unplugged', 'demo', 'a cappella', 'acapella', 'orchestral', 'piano',
  'mashup', 'refix', 're-?edit', 'medley',
].join('|') + ')\\b', 'i');

// Brackets that say nothing about the song itself.
const NOISE_RE = new RegExp('^\\s*(' + [
  'official', 'video', 'audio', 'music', 'lyrics?', 'lyric video', 'visuali[sz]er',
  'hd', 'hq', '4k', '8k', '1080p', '720p', 'explicit', 'clean', 'free download',
  'free dl', 'out now', 'premiere', 'release', 'videoclip', 'clip officiel', 'm/?v',
  'full song', 'full version', 'with lyrics', 'official music video',
  'official video', 'official audio', 'official lyric video', 'official visualizer',
  'audio only', 'color coded lyrics', 'eng sub', 'sub español', 'legendado',
  'high quality', 'best quality', 'copyright free', 'no copyright', 'ncs release',
  'monstercat release', 'exclusive', 'new', 'hq audio', 'hd audio', 'single',
  'official single', 'new single', 'debut single',
].join('|') + ')\\s*$', 'i');

// Clutter words that can appear together in one bracket, "Official HD Video".
const NOISE_WORD_RE = /\b(official|music|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|8k|explicit|clean|premiere|release|out now|free download|videoclip|full|new|exclusive|with|single|m\/?v)\b/gi;

// Brackets that are clutter even though they contain a mix word, so they are
// weighed before the mix check: "(1 Hour Version)", "[4K Remaster]" (the video
// was remastered, not the song), "(prod. by Somebody)".
const HARD_NOISE_RE = new RegExp('^\\s*(?:' + [
  '\\d+\\s*(?:hours?|hrs?)\\b.*',
  '(?:prod(?:uced)?\\.?(?:\\s+by)?)\\s.+',
  '(?:4k|8k|hd|hq|1080p)\\s+(?:remaster(?:ed)?|upgrade|version|video)',
  'remaster(?:ed)?\\s+in\\s+(?:4k|8k|hd|hq|1080p)',
].join('|') + ')\\s*$', 'i');

// Clutter left at the end of a title without brackets: "Song Official Video".
const TRAILING_WORDS = new Set(['official', 'music', 'video', 'audio', 'lyric', 'lyrics',
  'visualizer', 'visualiser', 'hd', 'hq', '4k', 'mv', 'm/v', 'clip', 'videoclip', 'full',
  'new', 'single', 'teaser', 'performance']);
// At least one of these has to be in the run, or "Song New" would lose "New".
const TRAILING_STRONG = new Set(['official', 'video', 'audio', 'lyric', 'lyrics',
  'visualizer', 'visualiser', 'mv', 'm/v', 'videoclip']);

const FEAT_RE = /\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+([^)\]]+?)\s*[)\]]?\s*$/i;

// " - " style separators split Artist from Title; pipes split the song from
// what the upload is about (a film, a label, the channel) and are read apart.
const DASH_RE = /\s+[-–—~]{1,2}\s+/;
const PIPE_RE = /\s*[|｜]\s*/;

// Quote pairs a title is written in: “Golden”, 'Ditto', ‘Shut Down’, 「...」.
const QUOTES = [['“', '”'], ['"', '"'], ['„', '“'], ['‘', '’'], ["'", "'"],
  ['「', '」'], ['『', '』'], ['«', '»']];

// "Stand by Me" is a title, not "Stand" by an artist called "Me".
const BY_STOP_RE = /^(me|you|your|yours|my|mine|myself|the|us|him|her|them|it|a|an|love|night|day|side|now|this|that|design|default|chance|heart|name)\b/i;

function tidy(text) {
  return String(text || '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—~|:,.]+|[\s\-–—~|:,]+$/g, '')
    .trim();
}

function stripQuotes(text) {
  const t = tidy(text);
  const m = /^["'“”‘’«»「『](.+)["'“”‘’«»」』]$/.exec(t);
  return m ? tidy(m[1]) : t;
}

function isNoise(inner) {
  const text = tidy(inner);
  if (!text) return true;
  if (NOISE_RE.test(text) || HARD_NOISE_RE.test(text)) return true;
  // "Official HD Music Video": nothing left once every clutter word is gone.
  return tidy(text.replace(NOISE_WORD_RE, '').replace(/[&+/,]/g, ' ')) === '';
}

/** Lowercased words, for comparing names loosely. */
function words(text) {
  return String(text || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Whether two names are the same one written differently: "Sony Animation"
 * and "Sony Pictures Animation", "Hans Zimmer" and "hans zimmer". One has to
 * hold every word of the other.
 */
function sameName(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return false;
  const [small, big] = wa.length <= wb.length ? [wa, new Set(wb)] : [wb, new Set(wa)];
  return small.every((w) => big.has(w));
}

/** Removes a clutter run from the end: "Song Official Video" -> "Song". */
function stripTrailingNoise(text) {
  const parts = tidy(text).split(' ');
  let cut = parts.length;
  let strong = false;
  while (cut > 0 && TRAILING_WORDS.has(parts[cut - 1].toLowerCase())) {
    if (TRAILING_STRONG.has(parts[cut - 1].toLowerCase())) strong = true;
    cut -= 1;
  }
  if (!strong || cut === 0) return tidy(text);
  return tidy(parts.slice(0, cut).join(' '));
}

/**
 * Pulls every (...) and [...] out of a title. Mix brackets are kept, noise
 * brackets dropped, and anything else (a subtitle, a year) stays in the title.
 * `latin` says the title is written in Latin letters, which makes a bracket in
 * another script a translation of the name next to it: "NewJeans (뉴진스)".
 */
function extractBrackets(text, latin = false) {
  const mixes = [];
  let feat = '';
  const rest = String(text || '').replace(/\s*[([{【]([^()[\]{}【】]*)[)\]}】]/g, (whole, inner) => {
    const featMatch = /^\s*(?:feat\.?|ft\.?|featuring)\s+(.+)$/i.exec(inner);
    if (featMatch) {
      feat = tidy(featMatch[1]);
      return '';
    }
    if (HARD_NOISE_RE.test(inner)) return '';
    if (latin && !/[A-Za-z]/.test(inner) && /\p{L}/u.test(inner)) return '';
    if (MIX_RE.test(inner)) {
      const cleaned = tidy(inner.replace(/\b(official|video|audio|music video)\b/gi, ''));
      if (cleaned) mixes.push(cleaned);
      return '';
    }
    if (isNoise(inner)) return '';
    return whole;
  });
  return { rest: tidy(rest), mixes, feat };
}

/** Removes a trailing " ft. Somebody" from a text and hands it back separately. */
function splitFeat(text) {
  const m = FEAT_RE.exec(text);
  if (!m) return { text: tidy(text), feat: '' };
  return { text: tidy(text.slice(0, m.index)), feat: tidy(m[1]) };
}

function withFeat(artist, feat) {
  if (!feat) return artist;
  if (!artist) return '';
  if (artist.toLowerCase().includes(feat.toLowerCase())) return artist;
  return `${artist} feat. ${feat}`;
}

/**
 * The first quoted stretch of a text, with what stands before and after it.
 * An ASCII apostrophe only counts as a quote at a word boundary and around at
 * least two characters, so "Rock 'n' Roll" and "Don't" are left alone.
 */
function findQuoted(text) {
  let best = null;
  for (const [open, close] of QUOTES) {
    const o = open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const c = close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[\\s(\\[:\\-–—])${o}([^${o}${c}]{2,}?)${c}(?=$|[\\s)\\]:,.!?\\-–—])`);
    const m = re.exec(text);
    if (!m) continue;
    const start = m.index + m[1].length;
    if (!best || start < best.start) {
      best = {
        start,
        before: tidy(text.slice(0, start)),
        inner: tidy(m[2]),
        after: tidy(text.slice(start + m[0].length - m[1].length)),
      };
    }
  }
  return best;
}

/**
 * What follows a quoted title: clutter ("Official MV") is dropped, a mix goes
 * to the mixes, "from <film>" is dropped, and anything else stays part of the
 * title.
 */
function titleFromQuote(q, mixes) {
  const after = tidy(q.after);
  const cleaned = stripTrailingNoise(after);
  if (!after || isNoise(after) || isNoise(cleaned)) return q.inner;
  if (/^from\b/i.test(after)) return q.inner;
  if (MIX_RE.test(cleaned) && cleaned.split(' ').length <= 5) {
    mixes.push(cleaned);
    return q.inner;
  }
  return tidy(`${q.inner} ${after}`);
}

/**
 * Splits a raw title into its parts. `fallbackArtist` is the channel name,
 * used when the title names no artist. `opts.uploader` (the same channel) is
 * compared against the title's parts, and `opts.knownArtists` (the library's
 * artists) catches "Title - Artist" written the wrong way round.
 * Returns { artist, title, mix, artistFrom: 'title' | 'channel' | '' }.
 */
function analyse(rawTitle, fallbackArtist = '', opts = {}) {
  const uploader = opts.uploader || '';
  const known = new Set((opts.knownArtists || []).map((a) => words(a).join(' ')).filter(Boolean));
  const isArtistLike = (text) => known.has(words(text).join(' ')) || (!!uploader && sameName(text, uploader));

  const latin = /[A-Za-z]/.test(String(rawTitle || '').replace(/[([{【][^)\]}】]*[)\]}】]/g, ''));
  const { rest, mixes, feat: bracketFeat } = extractBrackets(rawTitle, latin);

  // The song is the first pipe segment that is not clutter; the others may
  // name the film or show it is from, the label, or the channel again.
  const segments = rest.split(PIPE_RE).map(tidy).filter(Boolean);
  let main = '';
  const extras = [];
  for (const seg of segments) {
    if (isNoise(seg)) continue;
    if (!main) main = seg;
    else if (MIX_RE.test(seg) && seg.split(' ').length <= 5) mixes.push(seg);
    else if (!sameName(seg, uploader)) extras.push(seg);
  }

  // Drop parts after a separator that are pure clutter ("Song - Official Video")
  // and parts that are mixes written without brackets ("Song - Extended Mix").
  const kept = [];
  for (const raw of main.split(DASH_RE).map(tidy).filter(Boolean)) {
    const part = stripTrailingNoise(raw);
    if (isNoise(part)) continue;
    if (kept.length && MIX_RE.test(part) && part.split(' ').length <= 5) {
      mixes.push(part);
      continue;
    }
    kept.push(part);
  }

  let artist = '';
  let title = '';
  let from = '';
  if (kept.length >= 2) {
    artist = kept[0];
    title = kept.slice(1).join(' - ');
    // "Interstellar Main Theme - Hans Zimmer": the name on the right is one
    // the library already has, or the channel's own.
    if (kept.length === 2 && isArtistLike(kept[1]) && !isArtistLike(kept[0])) {
      artist = kept[1];
      title = kept[0];
    }
    const q = findQuoted(title);
    if (q && !q.before) title = titleFromQuote(q, mixes);
    from = 'title';
  } else {
    const one = kept[0] || '';
    const q = findQuoted(one);
    const by = /^(.+?)\s+by\s+(.+)$/i.exec(one);
    if (q && q.before && !isNoise(q.before)) {
      // "NewJeans 'Ditto' Official MV"
      artist = q.before;
      title = titleFromQuote(q, mixes);
      from = 'title';
    } else if (q) {
      // "“Golden” Official Lyric Video"
      title = titleFromQuote(q, mixes);
    } else if (by && !BY_STOP_RE.test(by[2]) && words(by[2]).length <= 4) {
      // "Levels by Avicii"
      title = by[1];
      artist = by[2];
      from = 'title';
    } else {
      title = one;
    }
    // "Song | Artist", or the film a soundtrack is from.
    if (!artist && extras.length) {
      artist = extras[0];
      from = 'title';
    }
    if (!artist && fallbackArtist) {
      artist = fallbackArtist;
      from = 'channel';
    }
  }

  const t = splitFeat(stripQuotes(title));
  const a = splitFeat(artist);
  // "Artist ft. Other - Song" keeps its feat in the artist where it was written.
  let finalArtist = a.feat ? `${a.text} feat. ${a.feat}` : a.text;
  finalArtist = withFeat(finalArtist, t.feat || bracketFeat);

  return {
    artist: tidy(finalArtist),
    title: tidy(t.text) || tidy(rawTitle),
    mix: tidy(mixes.join(', ')),
    artistFrom: tidy(finalArtist) ? from : '',
  };
}

/**
 * Artist / Title / Mix of a raw title. Exported on its own for the tests and
 * for re-reading the filenames of songs that were copied into the folder by
 * hand.
 */
function parseTitle(rawTitle, fallbackArtist = '', opts = {}) {
  const { artist, title, mix } = analyse(rawTitle, fallbackArtist, opts);
  return { artist, title, mix };
}

/** An uploader name made presentable as an artist. */
function cleanUploader(name) {
  let t = tidy(name);
  t = t.replace(/\s*-\s*topic$/i, '');
  t = t.replace(/vevo$/i, '');
  t = t.replace(/\s+(official|music|records?)$/i, '');
  t = t.replace(/\s*\(official\)$/i, '');
  return tidy(t);
}

function joinArtists(info) {
  if (Array.isArray(info.artists) && info.artists.length) {
    return tidy(info.artists.map(String).join(', '));
  }
  return tidy(info.artist || info.creator || '');
}

/**
 * The "Title · Artist · Artist" line YouTube writes into the descriptions of
 * the uploads it generates itself, right after "Provided to YouTube by ...".
 */
function fromAutoDescription(description) {
  const text = String(description || '');
  if (!/^\s*Provided to YouTube by /i.test(text)) return null;
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.includes(' · '));
  if (!line) return null;
  const [track, ...artists] = line.split(' · ').map(tidy);
  if (!track || !artists.length) return null;
  return { track, artist: artists.join(', ') };
}

/**
 * Artist / Title / Mix from yt-dlp's info JSON, plus `artistFromChannel` when
 * the artist is only the channel's name. `opts.knownArtists` is the library's
 * artists.
 */
function guessFromInfo(info, opts = {}) {
  const i = info || {};
  const uploader = cleanUploader(i.uploader || i.channel || '');
  const auto = fromAutoDescription(i.description);
  const tagArtist = joinArtists(i) || (auto ? auto.artist : '');
  const track = i.track || (auto ? auto.track : '');
  if (track && tagArtist) {
    const { rest, mixes, feat } = extractBrackets(track);
    const t = splitFeat(rest);
    return {
      artist: withFeat(tagArtist, t.feat || feat),
      title: tidy(t.text) || tidy(track),
      mix: tidy(mixes.join(', ')),
      artistFromChannel: false,
    };
  }
  const guess = analyse(i.title || i.fulltitle || '', uploader, {
    uploader,
    knownArtists: opts.knownArtists,
  });
  if (!guess.artist && tagArtist) {
    guess.artist = tagArtist;
    guess.artistFrom = 'title';
  }
  return {
    artist: guess.artist,
    title: guess.title,
    mix: guess.mix,
    artistFromChannel: guess.artistFrom === 'channel',
  };
}

module.exports = { guessFromInfo, parseTitle, cleanUploader, sameName };
