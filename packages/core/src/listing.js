'use strict';

// Reading whole playlists, shared by the desktop app and the Flow Server: a
// YouTube playlist, a SoundCloud set, a Bandcamp album, or a Spotify playlist
// or album by way of YouTube. Each app makes a lister with createLister(),
// handing over its media tools (media.js) and its library, so songs it
// already has are marked.
//
//   list()      reads the list without downloading anything and marks what is
//               already in the library.
//   download()  fetches the chosen songs one after another into the cache.
//
// One at a time on purpose: many downloads at once is what gets a client
// throttled. Only the Spotify lookups run four at a time, since a search is
// small.

const fs = require('fs');
const model = require('./libraryModel');
const spotify = require('./spotify');
const { parseTitle, cleanUploader } = require('./titleParser');
const { normalizeListUrl, sourceKey } = require('./text');

const SEARCH_RESULTS = 5;
const SEARCH_PARALLEL = 4;
// The embed page has been seen to stop at this many songs.
const SPOTIFY_PAGE_LIMIT = 100;
const MIX_LIMIT = 50;

/**
 * A cancel token for work that runs several processes, possibly at once:
 * cancel() stops every one of them. `sub()` hands out the token each process
 * is run with.
 */
function groupToken(ytdlpArgs = null) {
  const subs = new Set();
  const group = {
    cancelled: false,
    // What every yt-dlp run of the group gets on top (one server download's cookies).
    ytdlpArgs,
    cancel() {
      group.cancelled = true;
      for (const t of subs) {
        if (t.cancel) t.cancel();
        else t.cancelled = true;
      }
    },
    sub() {
      const t = { cancelled: group.cancelled, ytdlpArgs: group.ytdlpArgs };
      subs.add(t);
      return t;
    },
    done(t) {
      subs.delete(t);
    },
  };
  return group;
}

function cancelled() {
  const err = new Error('Cancelled.');
  err.cancelled = true;
  return err;
}

async function withSub(group, fn) {
  // Nothing new is started once the import is cancelled.
  if (group.cancelled) throw cancelled();
  const t = group.sub();
  try {
    return await fn(t);
  } finally {
    group.done(t);
  }
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Still open somewhere; the startup sweep of the cache gets it.
  }
}

const UNAVAILABLE_RE = /^\[(private|deleted|unavailable)( video)?\]$/i;

/** A song the library already has: same source, else same names. */
function existingSong(data, { url, key, meta }) {
  const bySource = (key || url) ? model.findBySource(data, { key, url }) : null;
  if (bySource) return bySource;
  if (meta && meta.title) return model.findByMeta(data, meta);
  return null;
}

function existingInfo(song) {
  if (!song) return null;
  return { id: song.id, artist: song.artist, title: song.title, mix: song.mix };
}

function asCandidate(e) {
  return {
    id: e.id,
    title: String(e.title || ''),
    channel: String(e.channel || e.uploader || ''),
    duration: Number(e.duration) || 0,
  };
}

/**
 * Runs `fetchOne(item, report)` for each item, one after another, and tells
 * the window about each. fetchOne resolves { media, song } or, for a song the
 * library already has, { existingId }. onProgress:
 *   { phase: 'item', index, status: 'current' | 'failed' | 'cancelled', reason? }
 *   { phase: 'item', index, status: 'ready', media, song } once in the cache
 *   { phase: 'item', index, status: 'library', existingId }
 *   { phase: 'download', index, number, total, title, frac, text } meanwhile.
 * Resolves { ready, fromLibrary, failed, cancelled }.
 */
async function eachItem(items, group, onProgress, fetchOne) {
  const summary = { ready: 0, fromLibrary: 0, failed: 0, cancelled: false };
  for (let n = 0; n < items.length; n += 1) {
    const it = items[n];
    if (group.cancelled) {
      summary.cancelled = true;
      break;
    }
    const report = (frac, text) => onProgress({
      phase: 'download', index: it.index, number: n + 1, total: items.length, title: it.title, frac, text,
    });
    onProgress({ phase: 'item', index: it.index, status: 'current' });
    report(null, 'Reading...');
    try {
      const got = await fetchOne(it, report);
      if (group.cancelled) {
        // Ready just as the import was cancelled: the window has let go of
        // it already, so its file goes now.
        if (got.media) removeQuietly(got.media.path);
        summary.cancelled = true;
        break;
      }
      if (got.existingId) {
        summary.fromLibrary += 1;
        onProgress({ phase: 'item', index: it.index, status: 'library', existingId: got.existingId });
        continue;
      }
      summary.ready += 1;
      onProgress({ phase: 'item', index: it.index, status: 'ready', media: got.media, song: got.song });
    } catch (err) {
      if (group.cancelled) {
        summary.cancelled = true;
        onProgress({ phase: 'item', index: it.index, status: 'cancelled' });
        break;
      }
      summary.failed += 1;
      onProgress({ phase: 'item', index: it.index, status: 'failed', reason: (err && err.message) || 'failed' });
    }
  }
  return summary;
}

/**
 * media: what createMedia() made; library(): the library data songs are
 * looked up in (the server passes the profile's view).
 */
function createLister({ media, library }) {
  /** A yt-dlp playlist (YouTube, SoundCloud, Bandcamp ...) as checklist items. */
  async function listWithYtDlp(url, group, onProgress) {
    onProgress({ phase: 'listing', text: 'Reading the playlist...' });
    // A YouTube Mix is made up as it goes and runs to hundreds of songs: only
    // its start is taken.
    const mix = /[?&]list=RD/.test(url);
    const range = mix ? ['-I', `1:${MIX_LIMIT}`] : [];
    const read = (flat) => withSub(group, (t) => media.readJson(
      [...(flat ? ['--flat-playlist'] : []), '--yes-playlist', ...range, '-J', url], t));
    let info = await read(true);
    if (info._type !== 'playlist') return { single: true, info };

    let entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
    if (entries.some((e) => /Tab$/i.test(String(e.ie_key || '')) || e._type === 'playlist')) {
      throw new Error('This link holds several lists (a channel?). Open the list you want, e.g. its Videos tab, and paste that link.');
    }
    // SoundCloud's quick listing often leaves the titles out; read it fully then.
    const untitled = entries.filter((e) => !e.title).length;
    if (entries.length && untitled > entries.length / 2) {
      onProgress({ phase: 'listing', text: `Reading ${entries.length} songs...` });
      info = await read(false);
      entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
    }

    const data = library();
    const items = entries.map((e, index) => {
      const title = String(e.title || e.fulltitle || `Song ${index + 1}`);
      const link = e.webpage_url || e.url || '';
      const key = e.id ? sourceKey(e.ie_key || e.extractor_key || info.extractor_key || '', e.id) : '';
      const unavailable = UNAVAILABLE_RE.test(title.trim());
      const uploader = cleanUploader(e.channel || e.uploader || '');
      const meta = parseTitle(title, uploader, { uploader });
      return {
        index,
        title,
        duration: Number(e.duration) || 0,
        url: link,
        key,
        status: unavailable || !link ? 'unavailable' : 'ok',
        note: unavailable ? title.replace(/[[\]]/g, '') : '',
        existing: unavailable ? null : existingInfo(existingSong(data, { url: link, key, meta })),
      };
    });
    return {
      source: String(info.extractor_key || info.extractor || 'playlist').replace(/Tab$|Playlist$|Set$/i, '') || 'Playlist',
      sourceUrl: info.webpage_url || url,
      name: String(info.title || 'Imported playlist'),
      truncated: mix && items.length >= MIX_LIMIT ? 'mix' : false,
      items,
    };
  }

  /**
   * The YouTube upload for one Spotify song: { quality, cand, diff }.
   *   1. YouTube Music's song search. Its first fitting result is nearly always
   *      the album audio; the search gives titles only, so its length is read
   *      once to be sure.
   *   2. If that finds nothing within 5 seconds, the ordinary search, with every
   *      result scored (spotify.pickMatch).
   */
  async function matchOnYouTube(track, group) {
    let fromMusic = null;
    try {
      const res = await withSub(group, (t) => media.readJson(
        ['--flat-playlist', '-J', '-I', `1:${SEARCH_RESULTS}`, spotify.musicSearchUrl(track)], t));
      const hit = spotify.pickMusicResult(track, (res.entries || []).filter(Boolean));
      if (hit) {
        let cand = asCandidate(hit);
        if (!cand.duration || !cand.channel) {
          const info = await withSub(group, (t) => media.readJson(
            ['--no-playlist', '-j', `https://www.youtube.com/watch?v=${hit.id}`], t));
          cand = asCandidate({ ...info, id: hit.id });
        }
        const diff = Math.abs(cand.duration - track.duration);
        fromMusic = { quality: diff <= 5 ? 'good' : (diff <= 20 ? 'shaky' : 'none'), cand, diff };
        if (fromMusic.quality === 'good') return fromMusic;
      }
    } catch {
      if (group.cancelled) throw cancelled();
      // YouTube Music did not answer; the ordinary search still may.
    }

    const res = await withSub(group, (t) => media.readJson(
      ['--flat-playlist', '-J', `ytsearch${SEARCH_RESULTS}:${spotify.searchQuery(track)}`], t));
    const pick = spotify.pickMatch(track, (res.entries || []).filter(Boolean).map(asCandidate));
    const rank = { good: 2, shaky: 1, none: 0 };
    if (fromMusic && rank[fromMusic.quality] >= rank[pick.quality] && fromMusic.diff <= (pick.diff ?? Infinity)) {
      return fromMusic;
    }
    return pick;
  }

  /** A Spotify playlist or album, each song looked up on YouTube. */
  async function listSpotify(ref, url, group, onProgress) {
    onProgress({ phase: 'listing', text: 'Reading the Spotify playlist...' });
    const page = await spotify.fetchSpotify(ref);
    if (group.cancelled) throw cancelled();
    const tracks = page.tracks;
    const data = library();
    const items = tracks.map((t, index) => {
      const meta = parseTitle(`${t.artists} - ${t.title}`);
      return {
        index,
        title: [t.artists, t.title].filter(Boolean).join(' - '),
        duration: t.duration,
        meta,
        spotify: { title: t.title, artists: t.artists, duration: t.duration },
        url: '',
        key: '',
        status: t.playable ? 'pending' : 'unavailable',
        note: t.playable ? '' : 'not playable on Spotify',
        match: null,
        existing: existingInfo(existingSong(data, { meta })),
      };
    });

    // Songs the library has by name need no search.
    const todo = items.filter((it) => it.status === 'pending' && !it.existing);
    for (const it of items) if (it.status === 'pending' && it.existing) it.status = 'ok';
    let done = 0;
    const total = todo.length;
    onProgress({ phase: 'matching', done, total });

    const next = () => todo.shift();
    const worker = async () => {
      for (let it = next(); it; it = next()) {
        if (group.cancelled) throw cancelled();
        let pick = null;
        try {
          pick = await matchOnYouTube(it.spotify, group);
        } catch (err) {
          if (group.cancelled) throw cancelled();
          it.status = 'notfound';
          it.note = err.message;
        }
        if (it.status === 'pending') {
          if (!pick || !pick.cand || pick.quality === 'none') {
            it.status = 'notfound';
            it.note = pick && pick.cand ? `closest upload is ${Math.round(pick.diff)} s off` : 'nothing found on YouTube';
            if (pick && pick.cand) it.match = { ...pick.cand, diff: pick.diff, quality: 'none' };
          } else {
            it.status = 'ok';
            it.match = { ...pick.cand, diff: pick.diff, quality: pick.quality };
            it.url = `https://www.youtube.com/watch?v=${pick.cand.id}`;
            it.key = sourceKey('Youtube', pick.cand.id);
            // The very upload may already be in the library under other names.
            const same = model.findBySource(library(), { key: it.key });
            if (same) it.existing = existingInfo(same);
          }
        }
        done += 1;
        onProgress({ phase: 'matching', done, total, title: it.title });
      }
    };
    await Promise.all(Array.from({ length: SEARCH_PARALLEL }, worker));

    return {
      source: 'Spotify',
      sourceUrl: `https://open.spotify.com/${ref.type}/${ref.id}`,
      name: page.name,
      truncated: tracks.length >= SPOTIFY_PAGE_LIMIT ? 'spotify' : false,
      items,
    };
  }

  /**
   * Reads a playlist link. Resolves { single: true, probed } when the link is
   * one song after all, or the listing: { source, sourceUrl, name, truncated,
   * items: [{ index, title, duration, url, key, status, note, meta?, spotify?,
   * match?, existing? }] }. status is 'ok', 'unavailable' or 'notfound'.
   */
  async function list(rawUrl, group, onProgress, { knownArtists = [] } = {}) {
    const ref = spotify.parseSpotifyUrl(rawUrl);
    if (ref) return listSpotify(ref, rawUrl, group, onProgress);
    if (spotify.isSpotifyTrackUrl(rawUrl)) {
      throw new Error('Single Spotify songs cannot be downloaded. Paste a Spotify playlist or album link, or the song\'s YouTube link.');
    }
    const url = normalizeListUrl(rawUrl);
    if (!url) throw new Error('That does not look like a link.');
    const listing = await listWithYtDlp(url, group, onProgress);
    if (listing.single) return { single: true, probed: media.probedFrom(listing.info, url, rawUrl, knownArtists) };
    return listing;
  }

  /**
   * Downloads the chosen new songs into the cache, one after another.
   * items: [{ index, title, url, meta? }]; a ready song comes with
   * song { url, key, title, meta, artistFromChannel } for saving it later, and
   * an upload the library already has is reported as 'library' (see eachItem).
   */
  function download(items, opts, group, onProgress, { knownArtists = [] } = {}) {
    return eachItem(items, group, onProgress, async (it, report) => {
      const probed = await withSub(group, (t) => media.probe(it.url, t, { knownArtists }));
      // Another link to an upload the library already has.
      const same = model.findBySource(library(), { key: probed.key, url: probed.url });
      if (same) return { existingId: same.id };
      const file = await withSub(group, (t) => media.download(probed, opts,
        (stage, frac, text) => report(frac, text), t));
      const fromSource = it.meta && it.meta.title;
      return {
        media: file,
        song: {
          url: probed.url,
          key: probed.key,
          title: probed.title,
          meta: fromSource ? it.meta : { artist: probed.guess.artist, title: probed.guess.title, mix: probed.guess.mix },
          artistFromChannel: !fromSource && !!probed.guess.artistFromChannel,
          // For its cover (@flow/core/cover): a Spotify song's upload was
          // found by YouTube Music's search already.
          thumbnails: probed.thumbnails,
          noSearch: !!fromSource,
        },
      };
    });
  }

  return { list, download, listWithYtDlp, listSpotify, matchOnYouTube };
}

module.exports = {
  createLister, groupToken, cancelled, withSub, eachItem, existingSong, existingInfo, removeQuietly,
};
