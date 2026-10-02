'use strict';

// Whole playlists and local files on the Add Songs page.
//
//   list()      reads the list without downloading anything and marks what is
//               already in the library; the Add Songs page shows a checklist.
//   download()  fetches the chosen songs one after another into the cache,
//               where the page lets each be trimmed and renamed.
//   finish()    ("Finish all") saves them all into All Songs and the playlist.
//
// Reading lists and downloading are @flow/core/listing (shared with the Flow
// Server); local files and saving are the desktop app's own.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const media = require('./media');
const exporter = require('./exporter');
const library = require('./library');
const model = require('@flow/core/libraryModel');
const {
  createLister, groupToken, cancelled, withSub, eachItem, existingInfo, removeQuietly,
} = require('@flow/core/listing');
const { scanFolder, MAX_FILES } = require('./localScan');

const lister = createLister({ media, library: () => library.get() });
const { list, download } = lister;

// ---- importing: download everything, then save it all at once ----
//
// Downloads land in the cache, where each song can still be trimmed and
// renamed on the Add Songs page; "Finish all" then saves them into the music
// folder and the library in one go. Until then nothing is in the library, and
// closing the app asks first, since the cache is emptied at the next start.

// ---- local files ----
//
// "Open local File(s) / Folder" on the Add Songs page goes through the same
// steps as a playlist: each file is prepared into the cache (kept, or
// converted when it does not play as it is, or to MP3 when that is set), can
// be trimmed and renamed there, and "Finish all" saves them into All Songs.
// The originals are only touched then, and only with "Move Originals".

// Every file listLocal() handed out this session, lower-cased: "Move
// Originals" deletes nothing else, whatever the window asks for.
const localListed = new Set();

/** True for Flow's own music folder and anything inside it: those songs are the library's already. */
function inMusicDir(p) {
  const music = path.resolve(paths.musicDir()).toLowerCase();
  const full = path.resolve(p).toLowerCase();
  return full === music || full.startsWith(music.endsWith(path.sep) ? music : music + path.sep);
}

/**
 * The files picked (and those in the folders picked) as a listing shaped like
 * a playlist's: { local: true, source, sourceUrl, name, truncated, items }.
 * A file picked by name is tried whatever its extension; a folder is looked
 * through for audio and video files only (localScan.js), with
 * { phase: 'scanning', found, dir } now and then. A file that is already a
 * library song is marked `existing`. truncated is 'files' when the folder
 * held more than MAX_FILES.
 */
async function listLocal(picked, group, onProgress) {
  const files = [];
  let folder = '';
  let fromMusicDir = 0;
  let truncated = false;
  for (const p of picked || []) {
    if (group.cancelled) throw cancelled();
    const full = path.resolve(String(p || ''));
    let st;
    try {
      st = await fs.promises.stat(full);
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
      const before = files.length;
      onProgress({ phase: 'scanning', found: before, dir: full });
      const found = await scanFolder(full, {
        token: group,
        skip: inMusicDir,
        limit: MAX_FILES - before,
        onProgress: (n, dir) => onProgress({ phase: 'scanning', found: before + n, dir }),
      });
      files.push(...found.files);
      if (found.truncated) truncated = 'files';
    } else if (st.isFile()) {
      files.push(full);
    }
  }
  if (group.cancelled) throw cancelled();
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
  return { local: true, source: 'Local', sourceUrl: '', name, truncated, items };
}

/**
 * Prepares the chosen local files into the cache, one after another.
 * items: [{ index, title, path }]; a ready song comes with song { url, key,
 * title, meta, artistFromChannel, originalPath }, its names from the file's
 * tags or name (see eachItem).
 */
function prepareLocal(items, opts, group, onProgress) {
  return eachItem(items, group, onProgress, async (it, report) => {
    const { media: file, tags } = await withSub(group, (t) => media.prepareLocal(it.path, opts,
      (stage, frac, text) => report(frac, text), t));
    const found = library.metaFromFile(it.path, tags);
    return {
      media: file,
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
 * job: { name, playlist, mergeInto, playlistIds, base, source: { url, kind },
 * entries } where an entry is { existingId } or { cachePath, start, end,
 * duration, meta, sourceUrl, sourceKey }, each with its `position` in the
 * whole list (else its place in entries). Resolves { playlistId, name, saved,
 * songIds, times, fromLibrary, failed: [{ title, reason }] }, where times
 * holds the time each song was put into the playlists.
 *
 * The songs of one import may be saved a few at a time ("Finish this song"):
 * the job then keeps its `base` time, and the playlist the first call made
 * comes back as mergeInto. Playlists list the newest first, and every song
 * gets base - position seconds, so the playlist reads as the source whatever
 * order the songs were saved in.
 *
 * A playlist named job.name is made (or job.mergeInto taken) unless
 * job.playlist is false, which it is for local files (job.local) unless
 * "Create new Playlist" was ticked. Every song also joins the existing
 * playlists in job.playlistIds ("Add to Playlist"), in the same order.
 * Local entries carry originalPath, and with job.move each original is
 * deleted once its song is saved; summary.kept lists those that could not be.
 */
async function finish(job, onProgress) {
  let playlistId = null;
  let playlistName = '';
  const makeList = job.playlist === undefined ? !job.local : !!job.playlist;
  if (makeList) {
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
  const base = Number(job.base) || Date.now();
  const addedAt = (position) => base - position * 1000;
  const summary = { playlistId, name: playlistName, saved: 0, songIds: [], times: {}, fromLibrary: 0, failed: [], kept: [] };
  const toSave = job.entries.filter((e) => !e.existingId).length;
  const listsOf = (d) => [...new Set([playlistId, ...(job.playlistIds || [])])]
    .filter((id) => id && model.playlistById(d, id));
  let number = 0;

  for (let i = 0; i < job.entries.length; i += 1) {
    const e = job.entries[i];
    const position = Number.isInteger(e.position) ? e.position : i;
    if (e.existingId) {
      library.mutate((d) => {
        if (!model.songById(d, e.existingId)) return;
        model.addSongToPlaylists(d, e.existingId, listsOf(d), addedAt(position));
        summary.times[e.existingId] = addedAt(position);
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
          model.addSongToPlaylists(d, song.id, listsOf(d), addedAt(position));
        });
        summary.songIds.push(song.id);
        summary.times[song.id] = addedAt(position);
      });
      removeQuietly(e.cachePath);
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

module.exports = { list, download, listLocal, prepareLocal, finish, groupToken, eachItem };
