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
// music folder for 30 days, in case an app deleted it by mistake, and the
// song with it (trash.js), so an admin can put it back as it was.
//
// A song trimmed in an app (trimSong) has its file cut here; the uncut file
// goes to the trash too. song.cut says which trim it is, so the apps' copies
// of the uncut file are replaced.
//
// An app's upload is taken in as it comes and converted afterwards, in the
// background once no upload has come in for a while (a whole batch first):
// Ogg Vorbis always into MP3, and everything by the app's "Upload songs to
// the server as MP3" choice (meta.convert, from a phone). The jobs are kept in
// <home>/convert-queue.json, so a restart carries on.
//
// The Statistics (3.6): each owner's totals (@flow/core/listening) start at 0
// the first time the server runs 3.6. A profile's listen counts for the
// Default / Shared too, the server's total, unless the app was a Jam member
// (recordListen's jamMember): in a Jam only the host's listen counts there,
// once for the song played. A Jam member on the Default counts nowhere.
//
// Covers (@flow/core/cover) live in <home>/covers/<song id>.jpg, outside the
// music folder; song.cover is the file's version. A song's cover goes with
// the song. Songs without one get one in the background, one at a time.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const model = require('@flow/core/libraryModel');
const { applyCommand } = require('@flow/core/commands');
const prof = require('@flow/core/profiles');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');
const { createTrash } = require('./trash');
const { parseTitle } = require('@flow/core/titleParser');
const { sourceKeyFromUrl, songFileStem, isNameOnlyList, splitSongPath } = require('@flow/core/text');
const { AUDIO_EXTS, planFor, ffmpegArgsFor, clampQuality } = require('@flow/core/formats');
const cover = require('@flow/core/cover');
const { createMedia } = require('@flow/core/media');
const { flowIdText, parseFlowId, ID_EXTS } = require('@flow/core/tags');
const tools = require('./tools');

const SEEN_KEEP = 5000;
const TOUCHED_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
// A file younger than this may still be being copied in.
const SETTLE_MS = 2000;
const COVER_PAUSE_MS = 1000;
// Uploads are converted once none has come in for this long.
const CONVERT_QUIET_MS = 15000;
// How many folders deep the music folder is looked through.
const SCAN_DEPTH = 16;
// With separate folders (server.json separateFolders): the apps' uploads, the server's downloads.
const UPLOADS_DIR = 'Uploads';
const DOWNLOADS_DIR = 'Downloads';
// Commands an app may send. addSong is only ever the app's own preview of an
// upload; the upload itself adds the song here.
const ALLOWED = new Set(['createPlaylist', 'renamePlaylist', 'deletePlaylist', 'setPlaylistSource',
  'addSongToPlaylists', 'addSongsToPlaylist', 'removeFromPlaylist', 'deleteSong', 'editSong',
  'setFavourite', 'setLoudness', 'setDuration', 'recordListen', 'setPlaylistShared', 'followPlaylist', 'unfollowPlaylist']);

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
      if (depth < SCAN_DEPTH) out.push(...listAudioFiles(full, depth + 1));
    } else if (AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The songs from before (never written: tagged null) whose files can carry
 * a flowid, for flow-server tag-songs. WAV cannot.
 */
function songsToTag(data) {
  return data.songs.filter((s) => s.tagged === null && ID_EXTS.has(String(s.format || path.extname(s.file).slice(1)).toLowerCase())
    && fs.existsSync(s.file));
}

/**
 * coverDeps: what finding covers uses instead of the internet and yt-dlp
 * ({ fetchImage, readInfo, searchMusic }; the tests' fakes). Left out: the
 * real ones.
 */
function createLibrary(config, log = () => {}, { coverDeps = null, convertQuietMs = CONVERT_QUIET_MS } = {}) {
  const musicDir = config.musicDir;
  const covers = cover.createCoverStore(path.join(config.home, 'covers'));
  const trash = createTrash({ dir: path.join(musicDir, '.flow-trash'), indexFile: path.join(config.home, 'trash.json'), log });
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
  const startedStatistics = prof.startStatistics(data, profiles);
  // When the server was set up, for the Default's Statistics: on one from
  // before 3.6, when its oldest song came.
  if (!config.get().createdAt) {
    const oldest = data.songs.reduce((min, s) => Math.min(min, s.addedAt || Infinity), Infinity);
    config.set({ createdAt: Number.isFinite(oldest) ? oldest : Date.now() });
  }

  function save() {
    writeJsonAtomic(config.libraryFile, { ...data, profiles });
    const cutoff = Date.now() - TOUCHED_KEEP_MS;
    for (const [k, at] of Object.entries(state.touched)) if (!(at > cutoff)) delete state.touched[k];
    state.seen = state.seen.slice(-SEEN_KEEP);
    seen.clear();
    for (const cid of state.seen) seen.add(cid);
    writeJsonAtomic(config.stateFile, state);
  }

  /** One change: applied, saved, and the revision moved on. A song gone takes its cover along. */
  function mutate(fn) {
    const before = data.songs.filter((s) => s.cover && s.cover !== cover.NO_COVER).map((s) => s.id);
    const result = fn(data);
    prof.prune(data, profiles);
    state.rev += 1;
    save();
    if (before.length) {
      const now = new Set(data.songs.map((s) => s.id));
      for (const id of before) if (!now.has(id)) covers.remove(id);
    }
    for (const l of listeners) l(state.rev);
    return result;
  }
  if (startedStatistics) save();

  // ---- files ----

  function relative(file) {
    const rel = path.relative(musicDir, file);
    return rel.startsWith('..') ? path.basename(file) : rel.split(path.sep).join('/');
  }

  /** A free path for "stem.ext" in `dir` (the music folder), or beside `current`, which may keep its name. */
  function uniquePath(stem, ext, current = null, dir = musicDir) {
    if (current) dir = path.dirname(current);
    const same = (a, b) => !!b && path.resolve(a) === path.resolve(b);
    let candidate = path.join(dir, `${stem}.${ext}`);
    for (let n = 2; fs.existsSync(candidate) && !same(candidate, current); n += 1) {
      candidate = path.join(dir, `${stem} (${n}).${ext}`);
    }
    return candidate;
  }

  /** A file to the trash; `record`: its song as it was (captureSong, with `by`), to be put back. */
  function toTrash(file, record = null) {
    trash.put(file, record);
  }

  /** The trash's files older than 30 days go for good; `all`: every one (an admin's Empty trash). */
  function emptyTrash(all = false) {
    return trash.empty(all);
  }

  /**
   * A song as it is everywhere, kept with its file in the trash: its entry,
   * each profile's stats and favourite of it, and the playlists it is in
   * (where in them). Null when there is no such song.
   */
  function captureSong(id) {
    const song = model.songById(data, id);
    if (!song) return null;
    const lists = [];
    const look = (owner, playlists) => {
      for (const pl of playlists) {
        const index = pl.entries.findIndex((e) => e.songId === id);
        if (index >= 0) lists.push({ owner, playlistId: pl.id, addedAt: pl.entries[index].addedAt, index });
      }
    };
    look(prof.DEFAULT_OWNER, data.playlists);
    const own = {};
    for (const [pid, p] of Object.entries(profiles)) {
      look(pid, p.playlists);
      if (p.songs[id]) own[pid] = JSON.parse(JSON.stringify(p.songs[id]));
    }
    return { song: JSON.parse(JSON.stringify(song)), own, lists };
  }

  /** What is in the trash, newest first (trash.js list), and whether each can come back as it was. */
  function trashList() {
    return trash.list().map((t) => ({ ...t, restorable: !!t.song && !model.songById(data, t.song.id) }));
  }

  /**
   * Puts a file from the trash back. One whose song was kept comes back as
   * that song: its id, names, stats, favourites and places in the playlists
   * that still exist (its cover is looked for again). Any other (deleted
   * before 3.5, an uncut file, or its song is back already) comes back as a
   * new song, found by the folder scan. Resolves { songId } or { scanned }.
   */
  async function restoreFromTrash(name) {
    const t = trash.get(name);
    if (!t) throw new Error('That file is no longer in the trash.');
    const e = t.entry;
    if (e && e.song && !model.songById(data, e.song.id)) {
      const old = String(e.song.file || '');
      const ext = (path.extname(old) || path.extname(t.originalName)).slice(1);
      const before = path.dirname(old);
      const inside = old && !path.relative(musicDir, before).startsWith('..') && fs.existsSync(before);
      const dest = uniquePath(path.basename(old || t.originalName, `.${ext}`), ext, null, inside ? before : musicDir);
      fs.renameSync(t.file, dest);
      trash.forget(name);
      const [song] = model.sanitize({ songs: [{ ...e.song, file: dest, cover: null }] }).songs;
      mutate((d) => {
        d.songs.push(song);
        const putBack = (playlists, l) => {
          const pl = playlists.find((x) => x.id === l.playlistId);
          if (!pl || pl.entries.some((x) => x.songId === song.id)) return;
          pl.entries.splice(Math.min(Number(l.index) || 0, pl.entries.length), 0, { songId: song.id, addedAt: Number(l.addedAt) || Date.now() });
        };
        for (const l of e.lists || []) {
          if (l.owner === prof.DEFAULT_OWNER) putBack(d.playlists, l);
          else if (profiles[l.owner]) putBack(profiles[l.owner].playlists, l);
        }
        for (const [pid, own] of Object.entries(e.own || {})) if (profiles[pid]) profiles[pid].songs[song.id] = own;
      });
      log(`Put back from the trash: ${path.basename(dest)}`);
      queueCovers();
      return { songId: song.id };
    }
    const ext = path.extname(t.originalName).slice(1);
    const dest = uniquePath(path.basename(t.originalName, `.${ext}`), ext, null, musicDir);
    fs.renameSync(t.file, dest);
    trash.forget(name);
    log(`Put back from the trash as a new song: ${path.basename(dest)}`);
    return { scanned: await scan({ complete: [dest] }) };
  }

  // ---- what the apps see ----

  /** Profile id -> name, for the owners of the playlists others share. */
  function profileNames() {
    return { [prof.DEFAULT_OWNER]: prof.DEFAULT_NAME, ...Object.fromEntries(config.get().profiles.map((p) => [p.id, p.name])) };
  }

  /**
   * The library as sent to an app signed in to `profileId` (null: none):
   * paths inside the music folder, not the server's own, and the profiles'
   * names for who added the songs.
   */
  function snapshot(profileId = null) {
    const names = profileNames();
    const v = prof.view(data, profiles, profileId, names);
    return {
      ...v,
      songs: v.songs.map((s) => ({ ...s, file: relative(s.file) })),
      ignoredFiles: [],
      profileNames: names,
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

  /**
   * Why `profileId` (null: the Default / Shared) may not delete `song` for
   * everyone, or ''. Only with the admins' rule songDelete 'owner': then the
   * profile that added it and the admins may; a song nobody added (put in
   * by hand, from before) or whose profile is gone, anyone.
   */
  function deleteRefusal(song, profileId, admin) {
    if (!song || admin || config.get().songDelete !== 'owner') return '';
    const by = song.addedBy;
    if (!by || by === (profileId || prof.DEFAULT_OWNER)) return '';
    const owner = by === prof.DEFAULT_OWNER ? prof.DEFAULT_NAME : (config.get().profiles.find((p) => p.id === by) || {}).name;
    if (!owner) return '';
    return `"${song.title || 'This song'}" was added by ${owner}. On this server only ${owner} or an admin can delete it.`;
  }

  /** A profile's numbers for the admins (profiles.js ownerSummary). */
  function summary(profileId) {
    return prof.ownerSummary(data, profiles, profileId);
  }

  /**
   * Deletes every song a profile added, for everyone (an admin deleting the
   * profile with its songs): their files go to the trash. Resolves how many.
   */
  function deleteSongsOf(profileId, by = null) {
    const ids = data.songs.filter((s) => s.addedBy === profileId).map((s) => s.id);
    if (!ids.length) return 0;
    const at = Date.now();
    const { results } = runCommands(ids.map((songId, i) => ({ cid: `admin-${at}-${i}`, at, type: 'deleteSong', songId })), null, { by, admin: true });
    return results.filter((r) => r.ok && !r.skipped).length;
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
  function runCommands(commands, profileId = null, { by = null, admin = false } = {}) {
    checkProfile(profileId);
    // Who deleted what goes to the trash with it: the profile (an admin
    // deleting another's songs says so).
    const deletedBy = by || profileId || prof.DEFAULT_OWNER;
    const results = [];
    const toBin = [];
    const retags = [];
    // Listens of a profile that count for the Default too.
    const forDefault = [];
    const list = (Array.isArray(commands) ? commands : []).slice(0, 5000);
    let applied = 0;
    let remembered = 0;
    let others = null;
    const ctx = {
      keepSongs: () => others || (others = prof.songsOfOthers(data, profiles, profileId)),
      deleteRefusal: (song) => deleteRefusal(song, profileId, admin),
    };
    const apply = (d) => {
      for (const c of list) {
        const cid = String((c && c.cid) || '');
        if (cid && seen.has(cid)) {
          results.push({ cid, ok: true, skipped: 'repeat' });
          continue;
        }
        try {
          if (!c || !ALLOWED.has(c.type)) throw new Error(`Unknown command "${String(c && c.type)}".`);
          if (c.type === 'recordListen' && c.jamMember && !profileId) {
            results.push({ cid, ok: true, skipped: 'jam' });
            if (cid) {
              seen.add(cid);
              state.seen.push(cid);
              remembered += 1;
            }
            continue;
          }
          // The songs about to be deleted, as they are everywhere, for the trash.
          let kept = [];
          if (c.type === 'deleteSong') kept = [captureSong(String(c.songId || ''))];
          else if (c.type === 'deletePlaylist' && c.deleteSongs) {
            const pl = model.playlistById(d, String(c.playlistId || ''));
            kept = pl ? pl.entries.map((e) => captureSong(e.songId)) : [];
          }
          const keptOf = (id) => kept.find((k) => k && k.song.id === id) || null;
          const r = applyCommand(d, c, state.touched, profileId, ctx);
          if (profileId && c.type === 'recordListen' && !c.jamMember && !r.skipped && r.value) forDefault.push(c);
          if (!r.skipped && c.type === 'deleteSong') toBin.push({ file: r.value.file, record: keptOf(r.value.id) });
          const gone = !r.skipped && c.type === 'deletePlaylist' ? r.value : [];
          for (const s of gone) toBin.push({ file: s.file, record: keptOf(s.id) });
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
          // The app takes its copies of these away at once.
          if (gone.length) out.deletedSongs = gone.map((s) => s.id);
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
    const v = prof.view(data, profiles, profileId, profileNames());
    apply(v);
    // Only a change moves the revision on: commands that were all skipped or
    // refused must not make every app fetch the library again for nothing.
    if (applied) {
      mutate((d) => {
        prof.absorb(d, profiles, profileId, v);
        for (const c of forDefault) {
          if (!model.songById(d, String(c.songId))) continue;
          model.recordListen(d, String(c.songId), { listened: c.listened, duration: c.duration, at: Number(c.at) || Date.now(), tz: c.tz });
        }
      });
    }
    else if (remembered) save();
    for (const t of toBin) toTrash(t.file, t.record && { ...t.record, by: deletedBy });
    for (const id of retags) queueRetag(id);
    return { rev: state.rev, results };
  }

  // ---- covers ----

  /** { file, version } of a song's cover, or null. */
  function coverOf(id) {
    const s = model.songById(data, id);
    if (!s || !s.cover || s.cover === cover.NO_COVER || !covers.has(id)) return null;
    return { file: covers.file(id), version: s.cover };
  }

  /**
   * A JPEG as the song's cover (an app's upload, a download's). With
   * `onlyIfNone`, a song that has one keeps it. Resolves the version, or null.
   */
  function setCover(id, jpeg, { onlyIfNone = false } = {}) {
    const s = model.songById(data, id);
    if (!s || !jpeg) return null;
    if (onlyIfNone && s.cover && s.cover !== cover.NO_COVER && covers.has(id)) return s.cover;
    const version = covers.write(id, jpeg);
    if (model.songById(data, id)) mutate((d) => model.setCover(d, id, version));
    else covers.remove(id);
    // Into its file too (new songs, songs written before).
    queueLoudness();
    return version;
  }

  /** How many songs have a cover, and how many are still to be looked at. */
  function coverCounts() {
    let have = 0;
    let todo = 0;
    for (const s of data.songs) {
      if (s.cover && s.cover !== cover.NO_COVER) have += 1;
      else if (!s.cover) todo += 1;
    }
    return { total: data.songs.length, have, todo };
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
   * Where a new song's file goes: "Artist - Title (Mix).ext" in the music
   * folder, or with separate folders in Uploads/ (`from` 'upload', an app's)
   * or Downloads/ (the server's). With keepFolders an upload keeps its place
   * in the app's music folder (meta.path), folders and file name, inside that.
   */
  function placeFor(meta, ext, from) {
    const cfg = config.get();
    let dir = cfg.separateFolders ? path.join(musicDir, from === 'download' ? DOWNLOADS_DIR : UPLOADS_DIR) : musicDir;
    let stem = songFileStem(meta.artist, meta.title, meta.mix);
    const kept = from === 'upload' && cfg.keepFolders ? splitSongPath(meta.path) : null;
    if (kept) {
      dir = path.join(dir, ...kept.folders);
      if (kept.name) stem = kept.name;
    }
    fs.mkdirSync(dir, { recursive: true });
    return uniquePath(stem, ext, null, dir);
  }

  /**
   * Takes in an uploaded file (already written to `tmp` inside the music
   * folder) as a song. The id is the app's own when it is free, so the app's
   * playlists keep pointing at it. Its favourite and stats are those of the
   * profile it came from, and so are the playlists it goes into, at
   * `playlistAt` (else the time it was added). That profile is who added it.
   * `from`: 'upload' (an app's) or 'download' (the server's own), for where
   * its file goes (placeFor).
   */
  function addUploaded(tmp, requestedId, meta, playlistIds, profileId = null, { playlistAt, from = 'upload' } = {}) {
    checkProfile(profileId);
    const ext = String(meta.format || path.extname(tmp).slice(1)).toLowerCase();
    const title = String(meta.title || '').trim() || 'Untitled';
    const artist = String(meta.artist || '').trim();
    const mix = String(meta.mix || '').trim();
    const dest = placeFor({ ...meta, title, artist, mix }, ext, from);
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
      addedBy: profileId || prof.DEFAULT_OWNER,
      loudness: meta.loudness,
      favouriteAt: meta.favouriteAt,
      stats: meta.stats,
      // Its file gets this server's flowid and its cover once that is settled.
      tagged: '',
      // Trimmed in the app before it came up: its copies there are this file.
      cut: model.cleanCut(meta.cut),
    };
    mutate((d) => {
      const v = prof.view(d, profiles, profileId, profileNames());
      model.addSong(v, song);
      const lists = (Array.isArray(playlistIds) ? playlistIds : []).map(String).filter((pid) => model.playlistById(v, pid));
      model.addSongToPlaylists(v, id, lists, Number(playlistAt) || song.addedAt);
      prof.absorb(d, profiles, profileId, v);
    });
    if (song.loudness === null || song.loudness === undefined) queueLoudness();
    if (from === 'upload') queueConvert(id, meta.convert);
    // The app's cover comes right after (PUT .../cover); the search waits a moment for it.
    setTimeout(queueCovers, 5000).unref();
    return model.songById(data, id);
  }

  /**
   * The playlist a download is saved into, in the profile's own lists: the
   * one `mergeInto` names, else a new one called `name` (with a number when
   * taken). Made at once, in one change, so two devices finishing songs of
   * the same batch cannot make it twice. Returns its id.
   */
  function importPlaylist(profileId, { name, mergeInto = null, source = null }) {
    checkProfile(profileId);
    let id = null;
    mutate((d) => {
      const v = prof.view(d, profiles, profileId, profileNames());
      let p = mergeInto ? model.playlistById(v, mergeInto) : null;
      if (!p) p = model.createPlaylist(v, model.freePlaylistName(v, name), newId());
      if (source && source.url) model.setPlaylistSource(v, p.id, source);
      id = p.id;
      prof.absorb(d, profiles, profileId, v);
    });
    return id;
  }

  /** A song into the profile's playlists, at the time `at` (where they sort it). */
  function addToPlaylists(profileId, songId, playlistIds, at) {
    checkProfile(profileId);
    mutate((d) => {
      const v = prof.view(d, profiles, profileId, profileNames());
      if (!model.songById(v, songId)) return;
      const lists = (playlistIds || []).map(String).filter((pid) => model.playlistById(v, pid));
      model.addSongToPlaylists(v, songId, lists, at);
      prof.absorb(d, profiles, profileId, v);
    });
  }

  // ---- the folder scan ----

  /**
   * The song a new file is, when its own file is gone (renamed or moved by
   * hand): the one its flowid names (this server's only), else the one of
   * the same format and length (with several, the one of the same names).
   * A flowid naming a song whose file is still there makes the file a copy:
   * a song of its own.
   */
  function movedFrom(fresh, gone) {
    const fid = fresh.flowId;
    if (fid && fid.library === config.get().id) {
      const named = gone.find((g) => g.id === fid.songId);
      if (named) return named;
      if (model.songById(data, fid.songId)) return null;
    }
    // Without ffprobe nothing has a length to go by.
    if (!(fresh.duration > 0)) return null;
    const same = gone.filter((g) => g.format === fresh.format && Math.abs((g.duration || 0) - fresh.duration) < 0.05);
    if (same.length === 1) return same[0];
    const fold = (t) => String(t || '').toLowerCase();
    return same.find((g) => fold(g.title) === fold(fresh.title) && fold(g.artist) === fold(fresh.artist)) || null;
  }

  /**
   * Songs put into the music folder by hand (over the network, a USB stick)
   * are added, songs whose file is gone are dropped, and songs renamed or
   * moved there keep their id (their playlists, cover and stats). The
   * folder itself missing (an unplugged drive) drops nothing.
   */
  async function scan({ complete = [] } = {}) {
    if (!fs.existsSync(musicDir)) return { added: 0, removed: 0, moved: 0 };
    // Files known to be whole (one put back from the trash) need not settle first.
    const whole = new Set(complete.map((f) => path.resolve(f)));
    const known = new Set(data.songs.map((s) => s.file));
    const ignored = new Set(data.ignoredFiles);
    const fresh = [];
    let unsettled = 0;
    for (const file of listAudioFiles(musicDir)) {
      if (known.has(file) || ignored.has(file.toLowerCase())) continue;
      try {
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs < SETTLE_MS && !whole.has(path.resolve(file))) {
          unsettled += 1;
          continue;
        }
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
          flowId: parseFlowId(t),
        });
      } catch {
        // Unreadable; left for the next scan.
      }
    }
    // Gone: its file missing while the music folder is there (a song in a
    // subfolder deleted by hand too).
    const gone = data.songs.filter((s) => !fs.existsSync(s.file));
    const moves = [];
    const left = [...gone];
    for (const s of [...fresh]) {
      const from = movedFrom(s, left);
      if (!from) continue;
      moves.push({ id: from.id, file: s.file });
      left.splice(left.indexOf(from), 1);
      fresh.splice(fresh.indexOf(s), 1);
    }
    // A file still being copied in may be one of these songs, moved: they
    // wait for the next scan.
    if (unsettled) left.length = 0;
    if (!fresh.length && !left.length && !moves.length) return { added: 0, removed: 0, moved: 0 };
    mutate((d) => {
      const nowKnown = new Set(d.songs.map((s) => s.file));
      for (const m of moves) {
        const s = model.songById(d, m.id);
        if (s && !fs.existsSync(s.file) && !nowKnown.has(m.file)) model.updateSong(d, m.id, { file: m.file });
      }
      for (const s of fresh) {
        if (nowKnown.has(s.file)) continue;
        const { flowId, ...song } = s;
        // A copy of one of this server's songs: its file gets its own flowid.
        if (flowId && flowId.library === config.get().id) song.tagged = '';
        model.addSong(d, song);
      }
      for (const s of left) if (model.songById(d, s.id) && !fs.existsSync(s.file)) model.removeSong(d, s.id, false);
    });
    if (fresh.length) {
      log(`Music folder: ${fresh.length} added`);
      queueLoudness();
      queueCovers();
    }
    if (moves.length) log(`Music folder: ${moves.length} renamed or moved`);
    if (left.length) log(`Music folder: ${left.length} removed`);
    return { added: fresh.length, removed: left.length, moved: moves.length };
  }

  // ---- background work with ffmpeg: loudness and tags ----

  let working = false;
  const retagQueue = new Set();
  const tagFailed = new Set(); // songs whose tags could not be written: tried again at the next start
  const noLoudness = new Set();
  let stopped = false;
  // Song id -> how often its file was cut while running: background work on
  // a file (tags, loudness) that was cut meanwhile is thrown away.
  const fileGen = new Map();
  const genOf = (id) => fileGen.get(id) || 0;
  let trims = Promise.resolve();

  // Covers have a loop of their own: they mostly wait for the internet,
  // which must not hold up the loudness (or the other way round).
  let coverWorking = false;
  let coverAgain = false;
  // The loops running: stop() waits for them (an ffmpeg still writing holds its files).
  let coverRun = Promise.resolve();
  let workRun = Promise.resolve();
  const coverLater = new Set(); // could not be reached: tried again at the next start
  const media = createMedia({
    ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, ytdlp: tools.ytdlp, cacheDir: () => config.home, lowPriority: true,
  });
  const lookups = coverDeps || cover.lookupsFor(media);

  function queueCovers() {
    if (!tools.ffmpeg() || stopped) return;
    if (coverWorking) {
      coverAgain = true;
      return;
    }
    coverRun = coverWork().catch((err) => log(`Covers: ${err.message}`));
  }

  /**
   * Looks for a cover (cover.resolveCover) without keeping it: for a song,
   * or a download still waiting to be finished. s: { sourceKey, sourceUrl,
   * sourcePlaylistUrl, artist, title, duration, thumbnails?, file? }.
   */
  async function lookForCover(s, cancelled = () => false) {
    const ffmpeg = tools.ffmpeg();
    return cover.resolveCover({
      sourceKey: s.sourceKey,
      sourceUrl: s.sourceUrl,
      artist: s.artist,
      title: s.title,
      duration: s.duration,
      thumbnails: s.thumbnails,
      // A Spotify (Deezer, Amazon Music) import's song is YouTube Music's own already: no search.
      noSearch: isNameOnlyList(s.sourcePlaylistUrl),
    }, {
      ffmpeg,
      ...lookups,
      embedded: () => (s.file && fs.existsSync(s.file) ? cover.embeddedCover(ffmpeg, s.file) : null),
      cancelled: () => stopped || cancelled(),
    });
  }

  /** One song's cover, found and kept. */
  async function findCover(s) {
    const r = await lookForCover(s);
    if (stopped || !model.songById(data, s.id)) return;
    const now = model.songById(data, s.id);
    if (now.cover) return; // one arrived meanwhile (an upload)
    if (r.jpeg) setCover(s.id, r.jpeg);
    else if (r.retry) coverLater.add(s.id);
    else {
      mutate((d) => model.setCover(d, s.id, cover.NO_COVER));
      // A new song's flowid goes into its file now.
      queueLoudness();
    }
  }

  async function coverWork() {
    coverWorking = true;
    try {
      do {
        coverAgain = false;
        while (!stopped && tools.ffmpeg()) {
          const next = data.songs.find((s) => !s.cover && !coverLater.has(s.id));
          if (!next) break;
          try {
            await findCover(next);
          } catch (err) {
            coverLater.add(next.id);
            log(`No cover for ${next.title}: ${err.message}`);
          }
          // A moment between songs: hundreds of lookups in a row must not
          // get the server's downloads rate-limited by YouTube.
          await new Promise((resolve) => setTimeout(resolve, lookups.pauseMs ?? COVER_PAUSE_MS));
        }
      } while (coverAgain && !stopped);
    } finally {
      coverWorking = false;
    }
  }

  /** At the start: covers of songs that are gone, away; songs whose cover file is missing, looked for again. */
  function checkCovers() {
    covers.sweep(new Set(data.songs.map((s) => s.id)));
    const lost = data.songs.filter((s) => s.cover && s.cover !== cover.NO_COVER && !covers.has(s.id)).map((s) => s.id);
    if (lost.length) mutate((d) => {
      for (const id of lost) if (model.songById(d, id)) model.setCover(d, id, null);
    });
  }

  function queueRetag(id) {
    if (!tools.ffmpeg()) return;
    retagQueue.add(id);
    queueLoudness();
  }

  // The background work with ffmpeg: renamed songs' tags, new songs' tags
  // and covers into their files, loudness.
  function queueLoudness() {
    // A loop running looks at the songs again after each one.
    if (tools.ffmpeg() && !working && !stopped) workRun = work().catch((err) => log(`Background work: ${err.message}`));
  }

  /**
   * The song's file written anew (media.rewriteTags): its names, this
   * server's flowid and its cover (none here: the file keeps its own), into
   * a copy beside it put in its place. A song renamed gets this at once; a
   * new one once its cover is settled. Not again this run when it fails.
   */
  async function tagFile(s) {
    const file = s.file;
    const coverNow = s.cover;
    const gen = genOf(s.id);
    const out = path.join(path.dirname(file), `.flow-retag-${crypto.randomBytes(6).toString('hex')}${path.extname(file)}`);
    let ok = false;
    try {
      const picture = coverNow && coverNow !== cover.NO_COVER ? covers.read(s.id) : null;
      ok = await media.rewriteTags(file, out, {
        meta: { title: s.title, artist: s.artist, mix: s.mix, sourceUrl: s.sourceUrl },
        flowId: flowIdText(config.get().id, s.id),
        picture,
      });
      // Renamed or gone meanwhile: written again later, or not at all.
      const now = model.songById(data, s.id);
      ok = ok && !stopped && !!now && now.file === file && genOf(s.id) === gen;
      if (ok) fs.renameSync(out, file);
    } catch (err) {
      ok = false;
      log(`Could not write the tags of ${file}: ${err.message}`);
    } finally {
      fs.rmSync(out, { force: true });
    }
    if (stopped) return;
    if (!ok) {
      // Cut meanwhile: written again from the cut file.
      if (genOf(s.id) !== gen) queueRetag(s.id);
      else tagFailed.add(s.id);
      return;
    }
    // A cover still being looked for: written again once it is known.
    mutate((d) => {
      if (model.songById(d, s.id)) model.setTagged(d, s.id, coverNow === null ? '' : coverNow);
    });
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
          if (s && fs.existsSync(s.file)) await tagFile(s);
          continue;
        }
        const toTag = data.songs.find((s) => model.needsTags(s) && !tagFailed.has(s.id) && fs.existsSync(s.file));
        if (toTag) {
          await tagFile(toTag);
          continue;
        }
        // Done but for songs whose cover is still being looked for, or whose file could not be written.
        if (tagPass && !data.songs.some((s) => s.tagged === '' && s.cover !== null && !tagFailed.has(s.id) && fs.existsSync(s.file))) {
          log(`tag-songs: done (${tagPass} ${tagPass === 1 ? 'song' : 'songs'})`);
          tagPass = 0;
        }
        const next = data.songs.find((s) => s.loudness === null && !noLoudness.has(s.id) && fs.existsSync(s.file));
        if (!next) break;
        const gen = genOf(next.id);
        const lufs = await tools.measureLoudness(next.file);
        // Stopped meanwhile: the library is not written any more.
        if (stopped) break;
        // Cut meanwhile: measured again.
        if (genOf(next.id) !== gen) continue;
        if (lufs === null) noLoudness.add(next.id);
        else if (model.songById(data, next.id)) mutate((d) => model.updateSong(d, next.id, { loudness: lufs }));
      }
    } finally {
      working = false;
    }
  }

  // ---- trims ----

  /**
   * A song trimmed in an app: its file cut to [start, end] (seconds) and put
   * in place of the uncut one, which goes to the trash. `base` is the cut the
   * app trimmed from and `cut` the new one's id. One at a time. Resolves
   * { song } or { skipped }: 'gone' (deleted), 'repeat' (this trim is in
   * already), 'changed' (trimmed by another app since: this one is not
   * applied, the apps' copies follow the server's).
   */
  function trimSong(id, { start, end, base = '', cut } = {}) {
    const run = trims.then(() => trimNow(String(id), {
      start: Number(start), end: Number(end), base: model.cleanCut(base), cut: model.cleanCut(cut),
    }));
    trims = run.catch(() => {});
    return run;
  }

  async function trimNow(id, { start, end, base, cut }) {
    const s = model.songById(data, id);
    if (!s) return { skipped: 'gone' };
    if (!cut) throw new Error('The trim has no id.');
    if (s.cut === cut) return { skipped: 'repeat', song: s };
    if (s.cut !== base) return { skipped: 'changed', song: s };
    if (!tools.ffmpeg()) throw new Error('This server cannot trim songs: it needs ffmpeg (sudo apt install ffmpeg).');
    if (!fs.existsSync(s.file)) throw new Error('The song file is missing on the server.');
    const duration = s.duration > 0 ? s.duration : (await media.probeAudio(s.file)).duration || 0;
    if (!(start >= 0) || !(end > start) || (duration && start >= duration)) throw new Error('That trim is outside the song.');
    const file = s.file;
    const out = path.join(path.dirname(file), `.flow-trim-${crypto.randomBytes(6).toString('hex')}${path.extname(file)}`);
    let len;
    try {
      ({ duration: len } = await media.trimFile({ file, start, end: duration ? Math.min(end, duration) : end, duration }, out));
      const now = model.songById(data, id);
      if (!now || now.file !== file) return { skipped: 'gone' };
      fileGen.set(id, genOf(id) + 1);
      toTrash(file);
      fs.renameSync(out, file);
    } finally {
      fs.rmSync(out, { force: true });
    }
    mutate((d) => {
      if (!model.songById(d, id)) return;
      model.updateSong(d, id, { duration: len, cut, loudness: null });
      // Its flowid and cover go into the cut file again.
      if (model.songById(d, id).tagged !== null) model.setTagged(d, id, '');
    });
    noLoudness.delete(id);
    tagFailed.delete(id);
    queueRetag(id);
    log(`Trimmed: ${[s.artist, s.title].filter(Boolean).join(' - ')} (${start.toFixed(1)} s to ${end.toFixed(1)} s)`);
    return { song: model.songById(data, id) };
  }

  // ---- uploads converted ----

  const convertFile = path.join(config.home, 'convert-queue.json');
  const cleanConvert = (c) => (c && typeof c === 'object'
    ? { alwaysMp3: c.alwaysMp3 === true, quality: clampQuality(c.quality), keepMp3: c.keepMp3 !== false }
    : null);
  // [{ id, opts }]: opts the app's choice, or null (an app that sends none: only Vorbis is converted).
  const savedJobs = readJson(convertFile);
  let convertQueue = (Array.isArray(savedJobs) ? savedJobs : [])
    .filter((j) => j && typeof j.id === 'string')
    .map((j) => ({ id: j.id, opts: cleanConvert(j.opts) }));
  let uploadsActive = 0;
  let lastUpload = 0;
  let convertTimer = null;
  let converting = false;
  let convertRun = Promise.resolve();
  // Left from before a restart: on with them once the library is up.
  setImmediate(() => scheduleConvert());

  function saveConvertQueue() {
    try {
      if (convertQueue.length) writeJsonAtomic(convertFile, convertQueue);
      else fs.rmSync(convertFile, { force: true });
    } catch (err) {
      log(`Could not save the uploads still to convert: ${err.message}`);
    }
  }

  /** An upload's file coming in (http.js): the conversions wait until the batch is in. */
  function uploadStarted() {
    uploadsActive += 1;
    lastUpload = Date.now();
  }

  function uploadEnded() {
    uploadsActive = Math.max(0, uploadsActive - 1);
    lastUpload = Date.now();
    scheduleConvert();
  }

  /**
   * An uploaded song to look at once the batch is in. Only an MP3 choice or
   * an Ogg file can come to anything (an MP3 kept, an M4A or FLAC without
   * the choice: nothing to do).
   */
  function queueConvert(id, convert) {
    const opts = cleanConvert(convert);
    const s = model.songById(data, id);
    if (!s || (!(opts && opts.alwaysMp3) && !['ogg', 'oga'].includes(String(s.format).toLowerCase()))) return;
    convertQueue = convertQueue.filter((j) => j.id !== id);
    convertQueue.push({ id, opts });
    saveConvertQueue();
    scheduleConvert();
  }

  function scheduleConvert() {
    if (!convertQueue.length || converting || stopped) return;
    clearTimeout(convertTimer);
    const wait = Math.max(0, lastUpload + convertQuietMs - Date.now());
    convertTimer = setTimeout(() => {
      if (uploadsActive) return; // the one coming in reschedules when it ends
      if (Date.now() - lastUpload < convertQuietMs) scheduleConvert();
      else convertRun = convertWork().catch((err) => log(`Converting uploads: ${err.message}`));
    }, wait);
    convertTimer.unref();
  }

  async function convertWork() {
    if (converting || stopped) return;
    converting = true;
    try {
      // A new batch coming in meanwhile goes in first: the rest waits for it.
      while (!stopped && convertQueue.length && !uploadsActive) {
        const job = convertQueue[0];
        const run = trims.then(() => convertNow(job));
        trims = run.catch(() => {});
        try {
          await run;
        } catch (err) {
          const s = model.songById(data, job.id);
          log(`Could not convert ${s ? [s.artist, s.title].filter(Boolean).join(' - ') : job.id}: ${err.message}`);
        }
        if (stopped) break;
        convertQueue = convertQueue.filter((j) => j !== job);
        saveConvertQueue();
      }
    } finally {
      converting = false;
      if (!stopped) scheduleConvert();
    }
  }

  /**
   * One uploaded song's file into MP3 when the plan says so (formats.planFor,
   * as for a download), put beside the old one, which goes to the trash.
   * Its flowid and cover are written into the new file afterwards.
   */
  async function convertNow({ id, opts }) {
    const s = model.songById(data, id);
    if (!s || !fs.existsSync(s.file) || !tools.ffmpeg()) return;
    const info = await media.probeAudio(s.file);
    if (!info.codec) return;
    const plan = planFor(info, opts || {});
    if (plan.action !== 'mp3' || stopped) return;
    const file = s.file;
    const gen = genOf(id);
    const out = path.join(path.dirname(file), `.flow-convert-${crypto.randomBytes(6).toString('hex')}.mp3`);
    let dest;
    let duration;
    try {
      await media.runFfmpeg(['-i', file, ...ffmpegArgsFor(plan), out], info.duration || s.duration || 0, null);
      const final = await media.probeAudio(out);
      if (!final.codec) throw new Error('the converted file has no audio in it');
      duration = final.duration || s.duration;
      // Deleted, renamed or cut meanwhile: left as it is now.
      const now = model.songById(data, id);
      if (stopped || !now || now.file !== file || genOf(id) !== gen) return;
      dest = uniquePath(path.basename(file, path.extname(file)), 'mp3', null, path.dirname(file));
      fs.renameSync(out, dest);
      fileGen.set(id, gen + 1);
      toTrash(file);
    } finally {
      fs.rmSync(out, { force: true });
    }
    mutate((d) => {
      if (!model.songById(d, id)) return;
      model.updateSong(d, id, { file: dest, format: 'mp3', duration });
      if (model.songById(d, id).tagged !== null) model.setTagged(d, id, '');
    });
    tagFailed.delete(id);
    queueRetag(id);
    log(`Converted: ${[s.artist, s.title].filter(Boolean).join(' - ')} (${plan.source} to ${plan.target})`);
  }

  /** A song's waveform (media.peaksFor), the last few kept by song and cut. */
  const peakCache = new Map();
  async function songPeaks(id) {
    const s = model.songById(data, id);
    if (!s || !fs.existsSync(s.file)) return null;
    if (!tools.ffmpeg()) throw new Error('This server cannot draw waveforms: it needs ffmpeg (sudo apt install ffmpeg).');
    const key = `${id}:${s.cut}:${genOf(id)}`;
    if (!peakCache.has(key)) {
      const duration = s.duration > 0 ? s.duration : (await media.probeAudio(s.file)).duration || 0;
      if (!(duration > 0)) throw new Error('The song length is not known.');
      const job = media.peaksFor(s.file, duration);
      peakCache.set(key, job);
      job.catch(() => peakCache.delete(key));
      while (peakCache.size > 8) peakCache.delete(peakCache.keys().next().value);
    }
    return peakCache.get(key);
  }

  // ---- flow-server tag-songs ----

  let tagPass = 0; // songs a tag-songs pass marked, until they are all written

  /**
   * flow-server tag-songs asked (server.json's tagSongs): the songs from
   * before are marked to be written like new ones, their flowid and cover
   * into their files, one at a time in the background. The marks are in the
   * library, so a restart carries on.
   */
  function checkTagRequest() {
    if (stopped || !config.get().tagSongs) return;
    config.set({ tagSongs: false });
    const ids = songsToTag(data).map((s) => s.id);
    if (!ids.length) {
      log('tag-songs: every song\'s file is written already');
      return;
    }
    mutate((d) => {
      for (const id of ids) if (model.songById(d, id)) model.setTagged(d, id, '');
    });
    tagPass = ids.length;
    log(`tag-songs: writing the tags of ${ids.length} ${ids.length === 1 ? 'song' : 'songs'} into their files`);
    queueLoudness();
  }

  emptyTrash();
  checkCovers();

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
    // Something the apps show changed without the library doing so (a profile renamed).
    touch: () => mutate(() => {}),
    createProfile,
    deleteProfile,
    summary,
    deleteSongsOf,
    runCommands,
    trimSong,
    songPeaks,
    existingFor,
    addUploaded,
    uploadStarted,
    uploadEnded,
    importPlaylist,
    addToPlaylists,
    scan,
    queueLoudness,
    queueCovers,
    checkTagRequest,
    lookForCover,
    coverOf,
    setCover,
    coverCounts,
    covers,
    emptyTrash,
    trashList,
    restoreFromTrash,
    onChange: (fn) => listeners.push(fn),
    /** Stops the background work: resolves once what was running has ended. */
    stop() {
      stopped = true;
      clearTimeout(convertTimer);
      return Promise.all([workRun, coverRun, convertRun]).then(() => {});
    },
  };
}

module.exports = { createLibrary, listAudioFiles, songsToTag };
