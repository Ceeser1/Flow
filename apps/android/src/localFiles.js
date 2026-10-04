'use strict';

// Songs of the phone's own, through Add Songs' "Open local File(s) / Folder":
// the same steps as the desktop's (apps/desktop/src/importer.js), answered
// without ffmpeg. Picked with Android's picker (FlowNative.pickAudio), each
// file is copied into the import folder with its names and picture read by Android
// (FlowNative.importAudio), and "Finish all" moves it into Flow's Music
// folder and Local Files. Nothing is converted or cut on the phone: a file
// Android cannot play is refused, and a song is saved whole (caps.localTrim).
// With a Flow Server the songs saved go up to it as on the desktop
// (remote.pushImport), when transfers are allowed (serverMetered).

const model = require('@flow/core/libraryModel');
const { metaFromFile } = require('@flow/core/fileMeta');
const { songFileStem } = require('@flow/core/text');
const { randomHex } = require('@flow/core/client/common');

/**
 * plugin: FlowNative; fs, path: the phone's files (native.js); stageDir:
 * where files wait until saved (in Flow's files, not its cache: Android would
 * count a file moved out of the cache as cache still);
 * library, covers, exporter, remote: the clients'; progress(p, run): an
 * import:progress event for the window; onStaged(info): a prepared file's
 * picture is there (the window's onCoverStaged).
 */
function createLocalFiles({ plugin, fs, path, stageDir, library, covers, exporter, remote, progress, onStaged }) {
  // Picks handed to the window, until it lists them: 'pick-<n>' -> the picker's answer.
  const picks = new Map();
  let pickNo = 0;
  // A file prepared in the import folder -> its picture beside it ({ cachePath, file, version }).
  const staged = new Map();
  // The running task (listing, preparing): cancelled by cancelImport.
  let task = null;

  /**
   * The library song a prepared file already is: the same names and length
   * (to a second). Picked files are copies, so their place says nothing (the
   * desktop goes by it). The library is the server's while one is used.
   */
  function sameSong(meta, duration) {
    const songs = remote.active() ? remote.view().songs : library.get().songs;
    return songs.find((s) => model.sameNames(s, meta) && Math.abs((Number(s.duration) || 0) - duration) <= 1) || null;
  }

  /** Android's picker; resolves ['pick-<n>'] for listLocal, or null when nothing was picked. */
  async function pick(folder) {
    const r = await plugin.pickAudio({ folder });
    if (!r || r.cancelled || !(r.items || []).length) {
      if (r && !r.cancelled && folder) throw new Error('No audio files were found in this folder.');
      return null;
    }
    pickNo += 1;
    const id = `pick-${pickNo}`;
    picks.set(id, { ...r, folder });
    return [id];
  }

  /** The picked files as a listing shaped like a playlist's (importer.listLocal). */
  function listLocal(picked) {
    const items = [];
    let name = '';
    let truncated = false;
    for (const id of picked || []) {
      const p = picks.get(String(id));
      picks.delete(String(id));
      if (!p) continue;
      if (p.folder) name = p.name || 'Folder';
      if (p.truncated) truncated = 'files';
      for (const f of p.items) {
        items.push({
          index: items.length, title: f.name, duration: 0, path: f.uri, url: '', key: '', status: 'ok', note: '', existing: null,
        });
      }
    }
    if (!items.length) throw new Error('The file could not be opened.');
    if (!name) name = items.length === 1 ? items[0].title : `${items.length} files`;
    return { local: true, source: 'Local', sourceUrl: '', name, truncated, items };
  }

  /**
   * Copies the chosen files into the import folder one after another, telling the
   * window as listing.eachItem does ({ phase: 'item' | 'download', ... }).
   */
  async function prepareLocal(items, run) {
    const mine = { cancelled: false };
    task = mine;
    const summary = { ready: 0, fromLibrary: 0, failed: 0, cancelled: false };
    try {
      for (let n = 0; n < items.length; n += 1) {
        const it = items[n];
        if (mine.cancelled) {
          summary.cancelled = true;
          break;
        }
        progress({ phase: 'item', index: it.index, status: 'current' }, run);
        progress({ phase: 'download', index: it.index, number: n + 1, total: items.length, title: it.title, frac: null, text: 'Copying...' }, run);
        const stem = path.join(stageDir, `local-${randomHex(5)}`);
        try {
          const r = await plugin.importAudio({ uri: it.path, stem, cover: `${stem}.jpg` });
          if (mine.cancelled) {
            discard(r.path);
            discard(`${stem}.jpg`);
            summary.cancelled = true;
            break;
          }
          const found = metaFromFile(it.title, { title: r.title, artist: r.artist });
          const there = sameSong(found, r.duration);
          if (there) {
            // In the library already: it goes along from there (a playlist made of these gets it).
            discard(r.path);
            discard(`${stem}.jpg`);
            summary.fromLibrary += 1;
            progress({ phase: 'item', index: it.index, status: 'library', existingId: there.id }, run);
            continue;
          }
          if (r.cover) staged.set(r.path, { cachePath: r.path, file: `${stem}.jpg`, version: randomHex(4) });
          summary.ready += 1;
          progress({
            phase: 'item',
            index: it.index,
            status: 'ready',
            media: { path: r.path, duration: r.duration, format: r.format, local: true },
            song: {
              url: '', key: '', title: found.title, meta: { artist: found.artist, title: found.title, mix: found.mix }, artistFromChannel: false, originalPath: it.path,
            },
          }, run);
          if (r.cover) onStaged(staged.get(r.path));
        } catch (err) {
          if (mine.cancelled) {
            summary.cancelled = true;
            progress({ phase: 'item', index: it.index, status: 'cancelled' }, run);
            break;
          }
          summary.failed += 1;
          progress({ phase: 'item', index: it.index, status: 'failed', reason: (err && err.message) || 'failed' }, run);
        }
      }
    } finally {
      if (task === mine) task = null;
    }
    return summary;
  }

  function cancel() {
    if (task) task.cancelled = true;
    task = null;
  }

  /** A prepared file the window let go of (and its picture). Only the import folder's. */
  function discard(cachePath) {
    const p = String(cachePath || '');
    if (!p.startsWith(`${stageDir}/`)) return;
    const s = staged.get(p);
    staged.delete(p);
    for (const f of [p, s && s.file]) {
      try {
        if (f && fs.exists(f)) fs.remove(f);
      } catch {
        // Emptied at the next start anyway.
      }
    }
  }

  /**
   * "Finish all" (or one song): the prepared files into the Music folder and
   * Local Files, as importer.finish, saved whole. Resolves its summary.
   */
  function saveLocal(job, onProgress) {
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
    const base = Number(job.base) || Date.now();
    const addedAt = (position) => base - position * 1000;
    const summary = { playlistId, name: playlistName, saved: 0, songIds: [], times: {}, fromLibrary: 0, failed: [], kept: [] };
    const toSave = job.entries.filter((e) => !e.existingId).length;
    const listsOf = (d) => [...new Set([playlistId, ...(job.playlistIds || [])])].filter((id) => id && model.playlistById(d, id));
    let number = 0;
    job.entries.forEach((e, i) => {
      const position = Number.isInteger(e.position) ? e.position : i;
      if (e.existingId) {
        library.mutate((d) => {
          if (!model.songById(d, e.existingId)) return;
          model.addSongToPlaylists(d, e.existingId, listsOf(d), addedAt(position));
          summary.times[e.existingId] = addedAt(position);
          summary.fromLibrary += 1;
        });
        return;
      }
      number += 1;
      const meta = e.meta || {};
      onProgress({ phase: 'saving', number, total: toSave, title: [meta.artist, meta.title].filter(Boolean).join(' - ') });
      try {
        const cachePath = String(e.cachePath || '');
        if (!cachePath.startsWith(`${stageDir}/`) || !fs.exists(cachePath)) throw new Error('Its file is gone.');
        const format = path.extname(cachePath).slice(1).toLowerCase();
        const dest = exporter.uniquePath(songFileStem(meta.artist || '', meta.title || 'Untitled', meta.mix || ''), format);
        fs.mkdir(path.dirname(dest));
        fs.rename(cachePath, dest);
        const id = library.newId();
        const pic = staged.get(cachePath);
        staged.delete(cachePath);
        const cover = pic && fs.exists(pic.file) ? covers.localStore().take(id, pic.file) : '';
        library.mutate((d) => {
          model.addSong(d, {
            id,
            file: dest,
            artist: meta.artist || '',
            title: meta.title || 'Untitled',
            mix: meta.mix || '',
            duration: Number(e.duration) || 0,
            format,
            sourceUrl: e.sourceUrl || '',
            sourceKey: e.sourceKey || '',
            sourcePlaylistUrl: (job.source && job.source.url) || '',
            addedAt: Date.now(),
          });
          if (cover) model.setCover(d, id, cover);
          model.addSongToPlaylists(d, id, listsOf(d), addedAt(position));
        });
        if (cover) covers.tell(covers.LOCAL, [id]);
        summary.songIds.push(id);
        summary.times[id] = addedAt(position);
        summary.saved += 1;
      } catch (err) {
        summary.failed.push({ title: meta.title || '', reason: (err && err.message) || 'failed' });
      }
    });
    return summary;
  }

  /**
   * As the desktop's finishImport (main.js): without a server into Local
   * Files; with one into Local Files first, then up to the server.
   */
  function finish(job, onProgress) {
    if (!remote.active()) return saveLocal(job, onProgress);
    const existingIds = job.entries.filter((e) => e.existingId).map((e) => e.existingId);
    const ownList = job.mergeInto && model.playlistById(library.get(), job.mergeInto) ? job.mergeInto : null;
    const localJob = { ...job, mergeInto: ownList, playlistIds: [], entries: job.entries.filter((e) => !e.existingId) };
    const summary = saveLocal(localJob, onProgress);
    const base = Number(job.base) || Date.now();
    job.entries.forEach((e, i) => {
      if (e.existingId) summary.times[e.existingId] = base - (Number.isInteger(e.position) ? e.position : i) * 1000;
    });
    remote.pushImport({
      localPlaylistId: summary.playlistId,
      mergeInto: ownList ? null : (job.mergeInto || null),
      existingIds,
      playlistIds: job.playlistIds || [],
      songIds: summary.songIds,
      times: summary.times,
    });
    summary.fromLibrary = existingIds.length;
    return summary;
  }

  return {
    pick, listLocal, prepareLocal, cancel, discard, finish,
    stagedCover: (cachePath) => staged.get(String(cachePath || '')) || null,
  };
}

module.exports = { createLocalFiles };
