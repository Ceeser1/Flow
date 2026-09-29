'use strict';

// Whole playlists: a YouTube playlist, a SoundCloud set, a Bandcamp album, or
// a Spotify playlist or album by way of YouTube.
//
//   list()      reads the list without downloading anything and marks what is
//               already in the library; the Add Songs page shows a checklist.
//   download()  fetches the chosen songs one after another into the cache,
//               where the page lets each be trimmed and renamed.
//   finish()    ("Finish all") saves them all into All Songs and the playlist.
//
// One at a time on purpose: many downloads at once is what gets a client
// throttled. Only the Spotify lookups run four at a time, since a search is
// small.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const downloader = require('./downloader');
const exporter = require('./exporter');
const library = require('./library');
const model = require('./libraryModel');
const spotify = require('./spotify');
const { parseTitle, cleanUploader } = require('./titleParser');
const { normalizeListUrl, sourceKey } = require('./text');
const { LOCAL_EXTS } = require('./formats');

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
function groupToken() {
  const subs = new Set();
  const group = {
    cancelled: false,
    cancel() {
      group.cancelled = true;
      for (const t of subs) {
        if (t.cancel) t.cancel();
        else t.cancelled = true;
      }
    },
    sub() {
      const t = { cancelled: group.cancelled };
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
  const t = group.sub();
  try {
    return await fn(t);
  } finally {
    group.done(t);
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

// ---- listing ----

/** A yt-dlp playlist (YouTube, SoundCloud, Bandcamp ...) as checklist items. */
async function listWithYtDlp(url, group, onProgress) {
  onProgress({ phase: 'listing', text: 'Reading the playlist...' });
  // A YouTube Mix is made up as it goes and runs to hundreds of songs: only
  // its start is taken.
  const mix = /[?&]list=RD/.test(url);
  const range = mix ? ['-I', `1:${MIX_LIMIT}`] : [];
  const read = (flat) => withSub(group, (t) => downloader.readJson(
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

  const data = library.get();
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

function asCandidate(e) {
  return {
    id: e.id,
    title: String(e.title || ''),
    channel: String(e.channel || e.uploader || ''),
    duration: Number(e.duration) || 0,
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
    const res = await withSub(group, (t) => downloader.readJson(
      ['--flat-playlist', '-J', '-I', `1:${SEARCH_RESULTS}`, spotify.musicSearchUrl(track)], t));
    const hit = spotify.pickMusicResult(track, (res.entries || []).filter(Boolean));
    if (hit) {
      let cand = asCandidate(hit);
      if (!cand.duration || !cand.channel) {
        const info = await withSub(group, (t) => downloader.readJson(
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

  const res = await withSub(group, (t) => downloader.readJson(
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
  const data = library.get();
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
          const same = model.findBySource(library.get(), { key: it.key });
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
  if (listing.single) return { single: true, probed: downloader.probedFrom(listing.info, url, rawUrl, knownArtists) };
  return listing;
}

// ---- importing: download everything, then save it all at once ----
//
// Downloads land in the cache, where each song can still be trimmed and
// renamed on the Add Songs page; "Finish all" then saves them into the music
// folder and the library in one go. Until then nothing is in the library, and
// closing the app asks first, since the cache is emptied at the next start.

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
 * Downloads the chosen new songs into the cache, one after another.
 * items: [{ index, title, url, meta? }]; a ready song comes with
 * song { url, key, title, meta, artistFromChannel } for saving it later, and
 * an upload the library already has is reported as 'library' (see eachItem).
 */
function download(items, opts, group, onProgress, { knownArtists = [] } = {}) {
  return eachItem(items, group, onProgress, async (it, report) => {
    const probed = await withSub(group, (t) => downloader.probe(it.url, t, { knownArtists }));
    // Another link to an upload the library already has.
    const same = model.findBySource(library.get(), { key: probed.key, url: probed.url });
    if (same) return { existingId: same.id };
    const media = await withSub(group, (t) => downloader.download(probed, opts,
      (stage, frac, text) => report(frac, text), t));
    const fromSource = it.meta && it.meta.title;
    return {
      media,
      song: {
        url: probed.url,
        key: probed.key,
        title: probed.title,
        meta: fromSource ? it.meta : { artist: probed.guess.artist, title: probed.guess.title, mix: probed.guess.mix },
        artistFromChannel: !fromSource && !!probed.guess.artistFromChannel,
      },
    };
  });
}

// ---- local files ----
//
// "Open local File(s) / Folder" on the Add Songs page goes through the same
// steps as a playlist: each file is prepared into the cache (kept, or
// converted when it does not play as it is, or to MP3 when that is set), can
// be trimmed and renamed there, and "Finish all" saves them into All Songs.
// The originals are only touched then, and only with "Move Originals".

const LOCAL_DEPTH = 4;

// Every file listLocal() handed out this session, lower-cased: "Move
// Originals" deletes nothing else, whatever the window asks for.
const localListed = new Set();

function isLocalFile(name) {
  return !name.startsWith('.yplayer-') && LOCAL_EXTS.includes(path.extname(name).slice(1).toLowerCase());
}

/** True for Flow's own music folder and anything inside it: those songs are the library's already. */
function inMusicDir(p) {
  const music = path.resolve(paths.musicDir()).toLowerCase();
  const full = path.resolve(p).toLowerCase();
  return full === music || full.startsWith(music.endsWith(path.sep) ? music : music + path.sep);
}

/**
 * The openable files in `dir`: its own first, by name, then each subfolder's.
 * Flow's music folder is left out when it is one of the subfolders.
 */
function findLocalFiles(dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const files = entries.filter((e) => e.isFile() && isLocalFile(e.name)).map((e) => path.join(dir, e.name));
  if (depth < LOCAL_DEPTH) {
    for (const e of entries) {
      const sub = path.join(dir, e.name);
      if (e.isDirectory() && !inMusicDir(sub)) files.push(...findLocalFiles(sub, depth + 1));
    }
  }
  return files;
}

/**
 * The files picked (and those in the folders picked) as a listing shaped like
 * a playlist's: { local: true, source, sourceUrl, name, truncated, items }.
 * A file that is already a library song is marked `existing`.
 */
function listLocal(picked) {
  const files = [];
  let folder = '';
  let fromMusicDir = 0;
  for (const p of picked || []) {
    const full = path.resolve(String(p || ''));
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (inMusicDir(full)) {
      if (st.isDirectory()) {
        const own = full.toLowerCase() === path.resolve(paths.musicDir()).toLowerCase();
        throw new Error(`${own ? 'This is Flow\'s own music folder' : 'This folder is inside Flow\'s own music folder'} `
          + `(${paths.musicDir()}). Its songs are already in your library.`);
      }
      fromMusicDir += 1;
      continue;
    }
    if (st.isDirectory()) {
      folder = full;
      files.push(...findLocalFiles(full));
    } else if (st.isFile()) {
      files.push(full);
    }
  }
  const seen = new Set();
  const unique = files.filter((f) => !seen.has(f.toLowerCase()) && seen.add(f.toLowerCase()));
  if (!unique.length) {
    if (fromMusicDir) {
      throw new Error(`${fromMusicDir === 1 ? 'This file is' : 'These files are'} already in Flow's own music folder `
        + `(${paths.musicDir()}), so ${fromMusicDir === 1 ? 'it is' : 'they are'} in your library.`);
    }
    throw new Error(folder ? 'No audio or video files were found in this folder.' : 'The file could not be opened.');
  }
  const bySong = new Map(library.get().songs.map((s) => [path.resolve(s.file).toLowerCase(), s]));
  const items = unique.map((file, index) => {
    localListed.add(file.toLowerCase());
    return {
      index,
      title: path.basename(file),
      duration: 0,
      path: file,
      url: '',
      key: '',
      status: 'ok',
      note: '',
      existing: existingInfo(bySong.get(file.toLowerCase())),
    };
  });
  let name = `${unique.length} files`;
  if (folder) name = path.basename(folder) || folder;
  else if (unique.length === 1) name = path.basename(unique[0]);
  return { local: true, source: 'Local', sourceUrl: '', name, truncated: false, items };
}

/**
 * Prepares the chosen local files into the cache, one after another.
 * items: [{ index, title, path }]; a ready song comes with song { url, key,
 * title, meta, artistFromChannel, originalPath }, its names from the file's
 * tags or name (see eachItem).
 */
function prepareLocal(items, opts, group, onProgress) {
  return eachItem(items, group, onProgress, async (it, report) => {
    const { media, tags } = await withSub(group, (t) => downloader.prepareLocal(it.path, opts,
      (stage, frac, text) => report(frac, text), t));
    const found = library.metaFromFile(it.path, tags);
    return {
      media,
      song: {
        url: found.sourceUrl,
        key: found.sourceKey,
        title: found.title,
        meta: { artist: found.artist, title: found.title, mix: found.mix },
        artistFromChannel: false,
        originalPath: it.path,
      },
    };
  });
}

/**
 * "Move Originals": deletes the file a song was saved from. Only a file that
 * listLocal() handed out and that is no library song's own. True when it is
 * gone (or already was).
 */
function removeOriginal(file) {
  const full = path.resolve(String(file || ''));
  const lower = full.toLowerCase();
  if (!localListed.has(lower)) return false;
  if (library.get().songs.some((s) => path.resolve(s.file).toLowerCase() === lower)) return false;
  try {
    fs.rmSync(full);
    return true;
  } catch (err) {
    return err.code === 'ENOENT';
  }
}

/**
 * Saves the downloaded songs, each with its own cut and names, and puts them
 * and the library songs chosen into the playlist, in the source's order.
 * job: { name, mergeInto, source: { url, kind }, entries } where an entry is
 * { existingId } or { cachePath, start, end, duration, meta, sourceUrl,
 * sourceKey }, top first. Resolves { playlistId, name, saved, fromLibrary,
 * failed: [{ title, reason }] }.
 *
 * Local files (job.local) go into All Songs only, with no playlist. Their
 * entries carry originalPath, and with job.move each original is deleted once
 * its song is saved; summary.kept lists those that could not be.
 */
async function finish(job, onProgress) {
  let playlistId = null;
  let playlistName = '';
  if (!job.local) {
    library.mutate((d) => {
      let p = job.mergeInto ? model.playlistById(d, job.mergeInto) : null;
      if (!p) p = model.createPlaylist(d, model.freePlaylistName(d, job.name), library.newId());
      model.setPlaylistSource(d, p.id, job.source);
      playlistId = p.id;
      playlistName = p.name;
    });
  }

  // The list shows newest first, so the first song gets the latest "Added"
  // time, one second apart, and the playlist reads top to bottom as the source.
  const base = Date.now();
  const addedAt = (position) => base - position * 1000;
  const summary = { playlistId, name: playlistName, saved: 0, fromLibrary: 0, failed: [], kept: [] };
  const toSave = job.entries.filter((e) => !e.existingId).length;
  let number = 0;

  for (let position = 0; position < job.entries.length; position += 1) {
    const e = job.entries[position];
    if (e.existingId && !playlistId) {
      summary.fromLibrary += 1;
      continue;
    }
    if (e.existingId) {
      library.mutate((d) => {
        if (!model.songById(d, e.existingId)) return;
        model.addSongToPlaylists(d, e.existingId, [playlistId], addedAt(position));
        summary.fromLibrary += 1;
      });
      continue;
    }
    number += 1;
    const meta = e.meta || {};
    onProgress({ phase: 'saving', number, total: toSave, title: [meta.artist, meta.title].filter(Boolean).join(' - ') });
    try {
      await library.quietly(async () => {
        const saved = await exporter.saveSong({
          cachePath: e.cachePath, start: e.start, end: e.end, duration: e.duration,
          artist: meta.artist || '', title: meta.title || 'Untitled', mix: meta.mix || '',
          sourceUrl: e.sourceUrl,
        });
        const song = {
          id: library.newId(),
          file: saved.file,
          artist: meta.artist || '',
          title: meta.title || 'Untitled',
          mix: meta.mix || '',
          duration: saved.duration,
          format: saved.format,
          sourceUrl: e.sourceUrl || '',
          sourceKey: e.sourceKey || '',
          sourcePlaylistUrl: (job.source && job.source.url) || '',
          addedAt: Date.now(),
        };
        library.mutate((d) => {
          model.addSong(d, song);
          if (playlistId && model.playlistById(d, playlistId)) {
            model.addSongToPlaylists(d, song.id, [playlistId], addedAt(position));
          }
        });
      });
      try {
        fs.rmSync(e.cachePath, { force: true });
      } catch {
        // The startup sweep of the cache gets it.
      }
      summary.saved += 1;
      if (job.local && job.move && e.originalPath && !removeOriginal(e.originalPath)) {
        summary.kept.push(e.originalPath);
      }
    } catch (err) {
      summary.failed.push({ title: meta.title || '', reason: (err && err.message) || 'failed' });
    }
  }
  return summary;
}

module.exports = { list, download, listLocal, prepareLocal, finish, groupToken };
