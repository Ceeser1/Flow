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
//
// A song trimmed in an app (trimSong) has its file cut here; the uncut file
// goes to the trash too. song.cut says which trim it is, so the apps' copies
// of the uncut file are replaced.
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
const { parseTitle } = require('@flow/core/titleParser');
const { sourceKeyFromUrl, songFileStem } = require('@flow/core/text');
const { AUDIO_EXTS } = require('@flow/core/formats');
const cover = require('@flow/core/cover');
const { createMedia } = require('@flow/core/media');
const { flowIdText, parseFlowId, ID_EXTS } = require('@flow/core/tags');
const tools = require('./tools');

const SEEN_KEEP = 5000;
const TOUCHED_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// A file younger than this may still be being copied in.
const SETTLE_MS = 2000;
const COVER_PAUSE_MS = 1000;
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
      if (depth < 4) out.push(...listAudioFiles(full, depth + 1));
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
function createLibrary(config, log = () => {}, { coverDeps = null } = {}) {
  const musicDir = config.musicDir;
  const covers = cover.createCoverStore(path.join(config.home, 'covers'));
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

  /** Profile id -> name, for the owners of the playlists others share. */
  function profileNames() {
    return Object.fromEntries(config.get().profiles.map((p) => [p.id, p.name]));
  }

  /**
   * The library as sent to an app signed in to `profileId` (null: none):
   * paths inside the music folder, not the server's own.
   */
  function snapshot(profileId = null) {
    const v = prof.view(data, profiles, profileId, profileNames());
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
    let others = null;
    const ctx = { keepSongs: () => others || (others = prof.songsOfOthers(data, profiles, profileId)) };
    const apply = (d) => {
      for (const c of list) {
        const cid = String((c && c.cid) || '');
        if (cid && seen.has(cid)) {
          results.push({ cid, ok: true, skipped: 'repeat' });
          continue;
        }
        try {
          if (!c || !ALLOWED.has(c.type)) throw new Error(`Unknown command "${String(c && c.type)}".`);
          const r = applyCommand(d, c, state.touched, profileId, ctx);
          if (!r.skipped && c.type === 'deleteSong') trash.push(r.value.file);
          const gone = !r.skipped && c.type === 'deletePlaylist' ? r.value : [];
          for (const s of gone) trash.push(s.file);
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
    if (applied) mutate((d) => prof.absorb(d, profiles, profileId, v));
    else if (remembered) save();
    for (const f of trash) toTrash(f);
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
   * Takes in an uploaded file (already written to `tmp` inside the music
   * folder) as a song. The id is the app's own when it is free, so the app's
   * playlists keep pointing at it. Its favourite and stats are those of the
   * profile it came from, and so are the playlists it goes into, at
   * `playlistAt` (else the time it was added).
   */
  function addUploaded(tmp, requestedId, meta, playlistIds, profileId = null, { playlistAt } = {}) {
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
  async function scan() {
    if (!fs.existsSync(musicDir)) return { added: 0, removed: 0, moved: 0 };
    const known = new Set(data.songs.map((s) => s.file));
    const ignored = new Set(data.ignoredFiles);
    const fresh = [];
    let unsettled = 0;
    for (const file of listAudioFiles(musicDir)) {
      if (known.has(file) || ignored.has(file.toLowerCase())) continue;
      try {
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs < SETTLE_MS) {
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
      // A Spotify import's song is YouTube Music's own already: no search.
      noSearch: /spotify\.com/i.test(s.sourcePlaylistUrl || ''),
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
    runCommands,
    trimSong,
    songPeaks,
    existingFor,
    addUploaded,
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
    onChange: (fn) => listeners.push(fn),
    /** Stops the background work: resolves once what was running has ended. */
    stop() {
      stopped = true;
      return Promise.all([workRun, coverRun]).then(() => {});
    },
  };
}

module.exports = { createLibrary, listAudioFiles, songsToTag };
