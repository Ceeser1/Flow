'use strict';

// The server's library: library.json (the same as an app's, plus each
// profile's playlists, favourites and stats: @flow/core/profiles), the music
// folder it describes, and state.json beside it:
//
//   rev      goes up by one with every change, so an app can ask "anything
//            new since 41?" instead of fetching the whole library each time.
//   touched  last-change times for last-change-wins (commands.js).
//   seen     the ids of the latest commands, so one sent twice counts once.
//
// A deleted song's file is not gone at once: it goes to .flow-trash in the
// music folder for 30 days, in case an app deleted it by mistake.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const model = require('@flow/core/libraryModel');
const { applyCommand } = require('@flow/core/commands');
const prof = require('@flow/core/profiles');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');
const { parseTitle } = require('@flow/core/titleParser');
const { sourceKeyFromUrl, songFileStem } = require('@flow/core/text');
const { AUDIO_EXTS } = require('@flow/core/formats');
const tools = require('./tools');

const SEEN_KEEP = 5000;
const TOUCHED_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// A file younger than this may still be being copied in.
const SETTLE_MS = 2000;
// Commands an app may send. addSong is only ever the app's own preview of an
// upload; the upload itself adds the song here.
const ALLOWED = new Set(['createPlaylist', 'renamePlaylist', 'deletePlaylist', 'setPlaylistSource',
  'addSongToPlaylists', 'addSongsToPlaylist', 'removeFromPlaylist', 'deleteSong', 'editSong',
  'setFavourite', 'setLoudness', 'setDuration', 'recordListen']);

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function listAudioFiles(dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.flow-')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 4) out.push(...listAudioFiles(full, depth + 1));
    } else if (AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function createLibrary(config, log = () => {}) {
  const musicDir = config.musicDir;
  const trashDir = path.join(musicDir, '.flow-trash');
  const raw = readJson(config.libraryFile);
  let data = model.sanitize(raw);
  const profiles = prof.sanitizeProfiles(data, raw && raw.profiles);
  const rawState = readJson(config.stateFile) || {};
  const state = {
    rev: Math.max(0, Math.floor(Number(rawState.rev) || 0)),
    touched: rawState.touched && typeof rawState.touched === 'object' ? rawState.touched : {},
    seen: Array.isArray(rawState.seen) ? rawState.seen.map(String) : [],
  };
  const seen = new Set(state.seen);
  const listeners = [];

  function save() {
    writeJsonAtomic(config.libraryFile, { ...data, profiles });
    const cutoff = Date.now() - TOUCHED_KEEP_MS;
    for (const [k, at] of Object.entries(state.touched)) if (!(at > cutoff)) delete state.touched[k];
    state.seen = state.seen.slice(-SEEN_KEEP);
    seen.clear();
    for (const cid of state.seen) seen.add(cid);
    writeJsonAtomic(config.stateFile, state);
  }

  /** One change: applied, saved, and the revision moved on. */
  function mutate(fn) {
    const result = fn(data);
    prof.prune(data, profiles);
    state.rev += 1;
    save();
    for (const l of listeners) l(state.rev);
    return result;
  }

  // ---- files ----

  function relative(file) {
    const rel = path.relative(musicDir, file);
    return rel.startsWith('..') ? path.basename(file) : rel.split(path.sep).join('/');
  }

  /** A free path for "stem.ext" in the music folder, or beside `current`, which may keep its name. */
  function uniquePath(stem, ext, current = null) {
    const dir = current ? path.dirname(current) : musicDir;
    const same = (a, b) => !!b && path.resolve(a) === path.resolve(b);
    let candidate = path.join(dir, `${stem}.${ext}`);
    for (let n = 2; fs.existsSync(candidate) && !same(candidate, current); n += 1) {
      candidate = path.join(dir, `${stem} (${n}).${ext}`);
    }
    return candidate;
  }

  function toTrash(file) {
    try {
      if (!fs.existsSync(file)) return;
      fs.mkdirSync(trashDir, { recursive: true });
      const dest = path.join(trashDir, `${Date.now()}-${path.basename(file)}`);
      fs.renameSync(file, dest);
    } catch (err) {
      log(`Could not move ${file} to the trash: ${err.message}`);
    }
  }

  function emptyTrash() {
    let names = [];
    try {
      names = fs.readdirSync(trashDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - TRASH_KEEP_MS;
    for (const name of names) {
      const full = path.join(trashDir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch {
        // Gone already.
      }
    }
  }

  // ---- what the apps see ----

  /**
   * The library as sent to an app signed in to `profileId` (null: none):
   * paths inside the music folder, not the server's own.
   */
  function snapshot(profileId = null) {
    const v = prof.view(data, profiles, profileId);
    return {
      ...v,
      songs: v.songs.map((s) => ({ ...s, file: relative(s.file) })),
      ignoredFiles: [],
    };
  }

  // ---- profiles ----

  function checkProfile(profileId) {
    if (profileId && !profiles[profileId]) throw new Error('That profile no longer exists.');
  }

  /** A profile with a copy of the Default / Shared playlists. */
  function createProfile(profileId) {
    if (profiles[profileId]) return;
    mutate((d) => prof.addProfile(d, profiles, profileId, newId));
  }

  function deleteProfile(profileId) {
    if (!profiles[profileId]) return;
    mutate(() => {
      prof.removeProfile(profiles, profileId);
      for (const key of Object.keys(state.touched)) if (key.startsWith(`${profileId}/`)) delete state.touched[key];
    });
  }

  function songFile(id) {
    const s = model.songById(data, id);
    return s ? s.file : null;
  }

  // ---- commands ----

  /**
   * Applies a batch of commands in order. Answers one result per command:
   * { cid, ok, skipped?, value?, error? }. A song renamed gets its file renamed
   * to match; a deleted one's file goes to the trash.
   */
  function runCommands(commands, profileId = null) {
    checkProfile(profileId);
    const results = [];
    const trash = [];
    const retags = [];
    const list = (Array.isArray(commands) ? commands : []).slice(0, 5000);
    let applied = 0;
    let remembered = 0;
    const apply = (d) => {
      for (const c of list) {
        const cid = String((c && c.cid) || '');
        if (cid && seen.has(cid)) {
          results.push({ cid, ok: true, skipped: 'repeat' });
          continue;
        }
        try {
          if (!c || !ALLOWED.has(c.type)) throw new Error(`Unknown command "${String(c && c.type)}".`);
          const r = applyCommand(d, c, state.touched, profileId);
          if (!r.skipped && c.type === 'deleteSong') trash.push(r.value.file);
          if (!r.skipped && c.type === 'editSong') {
            const song = r.value;
            const ext = path.extname(song.file).slice(1).toLowerCase();
            const dest = uniquePath(songFileStem(song.artist, song.title, song.mix), ext, song.file);
            if (path.resolve(dest) !== path.resolve(song.file) && fs.existsSync(song.file)) {
              try {
                fs.renameSync(song.file, dest);
                song.file = dest;
              } catch (err) {
                log(`Could not rename ${song.file}: ${err.message}`);
              }
            }
            retags.push(song.id);
          }
          const out = { cid, ok: true };
          if (!r.skipped) applied += 1;
          if (r.skipped) out.skipped = r.skipped;
          else if (typeof r.value === 'string' || typeof r.value === 'number') out.value = r.value;
          results.push(out);
        } catch (err) {
          results.push({ cid, ok: false, error: (err && err.message) || String(err) });
        }
        if (cid) {
          seen.add(cid);
          state.seen.push(cid);
          remembered += 1;
        }
      }
    };
    const v = prof.view(data, profiles, profileId);
    apply(v);
    // Only a change moves the revision on: commands that were all skipped or
    // refused must not make every app fetch the library again for nothing.
    if (applied) mutate((d) => prof.absorb(d, profiles, profileId, v));
    else if (remembered) save();
    for (const f of trash) toTrash(f);
    for (const id of retags) queueRetag(id);
    return { rev: state.rev, results };
  }

  // ---- uploads ----

  /**
   * An upload of a song that is here already, or null: the same id (sent
   * twice), the same source, or the same artist, title and mix at the same
   * length (a copy of a song the server found in its folder).
   */
  function existingFor(id, meta) {
    const same = model.songById(data, id);
    if (same) return same;
    if (meta.sourceKey || meta.sourceUrl) {
      const hit = model.findBySource(data, { key: meta.sourceKey, url: meta.sourceUrl });
      if (hit) return hit;
    }
    const byName = model.findByMeta(data, { artist: meta.artist, title: meta.title, mix: meta.mix });
    const d = Number(meta.duration) || 0;
    if (byName && (!d || !byName.duration || Math.abs(byName.duration - d) < 2)) return byName;
    return null;
  }

  /**
   * Takes in an uploaded file (already written to `tmp` inside the music
   * folder) as a song. The id is the app's own when it is free, so the app's
   * playlists keep pointing at it. Its favourite and stats are those of the
   * profile it came from, and so are the playlists it goes into.
   */
  function addUploaded(tmp, requestedId, meta, playlistIds, profileId = null) {
    checkProfile(profileId);
    const ext = String(meta.format || path.extname(tmp).slice(1)).toLowerCase();
    const title = String(meta.title || '').trim() || 'Untitled';
    const artist = String(meta.artist || '').trim();
    const mix = String(meta.mix || '').trim();
    const dest = uniquePath(songFileStem(artist, title, mix), ext);
    fs.renameSync(tmp, dest);
    const id = requestedId && !model.songById(data, requestedId) ? requestedId : newId();
    const song = {
      id,
      file: dest,
      title,
      artist,
      mix,
      duration: Number(meta.duration) || 0,
      format: ext,
      sourceUrl: String(meta.sourceUrl || ''),
      sourceKey: String(meta.sourceKey || ''),
      sourcePlaylistUrl: String(meta.sourcePlaylistUrl || ''),
      addedAt: Number(meta.addedAt) || Date.now(),
      loudness: meta.loudness,
      favouriteAt: meta.favouriteAt,
      stats: meta.stats,
    };
    mutate((d) => {
      const v = prof.view(d, profiles, profileId);
      model.addSong(v, song);
      const lists = (Array.isArray(playlistIds) ? playlistIds : []).map(String).filter((pid) => model.playlistById(v, pid));
      model.addSongToPlaylists(v, id, lists, song.addedAt);
      prof.absorb(d, profiles, profileId, v);
    });
    if (song.loudness === null) queueLoudness();
    return model.songById(data, id);
  }

  // ---- the folder scan ----

  /**
   * Songs put into the music folder by hand (over the network, a USB stick)
   * are added, songs whose file is gone are dropped. The folder itself
   * missing (an unplugged drive) drops nothing.
   */
  async function scan() {
    if (!fs.existsSync(musicDir)) return { added: 0, removed: 0 };
    const known = new Set(data.songs.map((s) => s.file));
    const ignored = new Set(data.ignoredFiles);
    const fresh = [];
    for (const file of listAudioFiles(musicDir)) {
      if (known.has(file) || ignored.has(file.toLowerCase())) continue;
      try {
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs < SETTLE_MS) continue;
        const info = await tools.probe(file);
        if (info.probed && !info.codec) continue;
        const fromName = parseTitle(path.basename(file, path.extname(file)));
        const t = info.tags;
        const comment = t.comment || t.purl || '';
        const sourceUrl = /^https?:\/\//i.test(comment) ? comment : '';
        fresh.push({
          id: newId(),
          file,
          title: t.title || fromName.title,
          artist: t.artist || t.album_artist || fromName.artist,
          mix: t.mix || (t.title ? '' : fromName.mix),
          duration: info.duration,
          format: path.extname(file).slice(1).toLowerCase(),
          sourceUrl,
          sourceKey: sourceKeyFromUrl(sourceUrl) || '',
          addedAt: Math.round(st.birthtimeMs || st.mtimeMs) || Date.now(),
        });
      } catch {
        // Unreadable; left for the next scan.
      }
    }
    const gone = data.songs.filter((s) => !fs.existsSync(s.file) && fs.existsSync(path.dirname(s.file)));
    if (!fresh.length && !gone.length) return { added: 0, removed: 0 };
    mutate((d) => {
      const nowKnown = new Set(d.songs.map((s) => s.file));
      for (const s of fresh) if (!nowKnown.has(s.file)) model.addSong(d, s);
      for (const s of gone) if (model.songById(d, s.id) && !fs.existsSync(s.file)) model.removeSong(d, s.id, false);
    });
    if (fresh.length) {
      log(`Music folder: ${fresh.length} added`);
      queueLoudness();
    }
    if (gone.length) log(`Music folder: ${gone.length} removed`);
    return { added: fresh.length, removed: gone.length };
  }

  // ---- background work with ffmpeg: loudness and tags ----

  let working = false;
  const retagQueue = new Set();
  const noLoudness = new Set();
  let stopped = false;

  function queueRetag(id) {
    if (!tools.ffmpeg()) return;
    retagQueue.add(id);
    work();
  }

  function queueLoudness() {
    if (tools.ffmpeg()) work();
  }

  async function work() {
    if (working || stopped) return;
    working = true;
    try {
      while (!stopped) {
        const retagId = retagQueue.values().next().value;
        if (retagId) {
          retagQueue.delete(retagId);
          const s = model.songById(data, retagId);
          if (s && fs.existsSync(s.file)) await tools.retag(s.file, s);
          continue;
        }
        const next = data.songs.find((s) => s.loudness === null && !noLoudness.has(s.id) && fs.existsSync(s.file));
        if (!next) break;
        const lufs = await tools.measureLoudness(next.file);
        if (lufs === null) noLoudness.add(next.id);
        else if (model.songById(data, next.id)) mutate((d) => model.updateSong(d, next.id, { loudness: lufs }));
      }
    } finally {
      working = false;
    }
  }

  emptyTrash();

  return {
    musicDir,
    get rev() {
      return state.rev;
    },
    get data() {
      return data;
    },
    snapshot,
    songFile,
    profileIds: () => Object.keys(profiles),
    createProfile,
    deleteProfile,
    runCommands,
    existingFor,
    addUploaded,
    scan,
    queueLoudness,
    emptyTrash,
    onChange: (fn) => listeners.push(fn),
    stop() {
      stopped = true;
    },
  };
}

module.exports = { createLibrary, listAudioFiles };
