'use strict';

// The library as data: songs, playlists and the entries that tie them
// together. Pure (no files, no Electron), pinned by test/libraryModel.test.js.
// src/library.js owns loading, saving and the files on disk.
//
//   song      { id, file, title, artist, mix, duration, format,
//               sourceUrl, sourceKey, sourcePlaylistUrl, addedAt, stats,
//               favouriteAt, loudness, cover }
//   cover is the version of the song's cover file (cover.js), '-' when it
//   was looked for and none found, null when not looked for yet. Only the
//   app or server that keeps the covers sets it (setCover); no command can.
//   sourceUrl is the page the song was downloaded from, sourcePlaylistUrl the
//   playlist it came in with when it was part of a playlist import (else '').
//   stats     { plays, stops, skips, sessions, listened, lastPlayedAt }
//   playlist  { id, name, createdAt, entries: [{ songId, addedAt }], source, shared }
//   source    { url, kind } for a playlist imported from a link, else null.
//             Kept for a later "update from source".
//   shared    true: the other profiles on a Flow Server can see the playlist
//             and follow it. Only its owner can change it.
//
// With profiles (profiles.js) a library also carries what the other profiles
// share with this one:
//   follows          ids of the shared playlists this profile follows
//   playlistListened seconds this profile has listened to each list while it
//                    was the one playing: { [playlistId | 'all' | 'favourites' | 'smart:...']: seconds }.
//                    Per profile, also for a shared list (the owner's is not shared);
//                    unfollowing a shared list deletes it.
//   sharedPlaylists  the other profiles' shared playlists, for reading:
//                    { id, name, createdAt, entries, ownerId, ownerName }
//
// "All Songs" is not stored: it is every song, and a song's addedAt is when it
// was downloaded. Neither is "Favourites": the songs with a favouriteAt, which
// is when they were made one (null for the rest). A playlist entry's addedAt is when it was put in that list.
// Every mutation throws an Error whose message is fit to show the user.

const { comparableUrl } = require('./text');

const ALL_SONGS_ID = 'all';
const ALL_SONGS_NAME = 'All Songs';
const MAX_NAME = 80;

// How one listen of a song is counted, by how much of it was heard (played,
// not skipped over) before the song changed. Under 5 seconds is not counted at
// all (a song that was only clicked past, or loaded and never started). From
// 5 seconds it is a time played (`sessions`), and also: at least 80% of the
// song a full listen (`plays`), less than 30 seconds an early skip, anything
// between a stop.
const PLAYED_SHARE = 0.8;
const EARLY_SKIP_SECONDS = 30;
const MIN_LISTEN_SECONDS = 5;

function emptyStats() {
  return { plays: 0, stops: 0, skips: 0, sessions: 0, listened: 0, lastPlayedAt: null };
}

function cleanStats(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const count = (v) => Math.max(0, Math.floor(Number(v) || 0));
  return {
    plays: count(r.plays),
    stops: count(r.stops),
    skips: count(r.skips),
    sessions: count(r.sessions),
    listened: Math.max(0, Number(r.listened) || 0),
    lastPlayedAt: Number(r.lastPlayedAt) || null,
  };
}

function emptyLibrary() {
  return { version: 1, songs: [], playlists: [], ignoredFiles: [], follows: [], sharedPlaylists: [], playlistListened: {} };
}

/** { listId: seconds }: only sensible ids and positive numbers stay. */
function cleanListened(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, secs] of Object.entries(raw)) {
    const n = Number(secs);
    if (/^[\w:-]{1,64}$/.test(id) && Number.isFinite(n) && n > 0) out[id] = n;
  }
  return out;
}

/** Repairs anything a hand edit or an older version could have left behind. */
function cleanLoudness(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A cover version (a short hash), '-' for none found, else null: not looked for. */
function cleanCover(v) {
  const t = String(v === null || v === undefined ? '' : v);
  return /^(?:[0-9a-f]{4,40}|-)$/.test(t) ? t : null;
}

/**
 * What the song's file carries (tags.js): null, nothing of Flow's (an older
 * song, a file put in by hand); '' a new song whose tags are still to be
 * written; else the cover version written into it with its flowid ('-': none).
 */
function cleanTagged(v) {
  if (v === '') return '';
  return cleanCover(v);
}

/** A list of ids: strings, no empties, no repeats. */
function cleanIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '')).filter(Boolean))];
}

function sanitize(raw) {
  const data = emptyLibrary();
  if (!raw || typeof raw !== 'object') return data;
  const seenSongs = new Set();
  for (const s of Array.isArray(raw.songs) ? raw.songs : []) {
    if (!s || !s.id || !s.file || seenSongs.has(s.id)) continue;
    seenSongs.add(s.id);
    data.songs.push({
      id: String(s.id),
      file: String(s.file),
      title: String(s.title || ''),
      artist: String(s.artist || ''),
      mix: String(s.mix || ''),
      duration: Number(s.duration) || 0,
      format: String(s.format || ''),
      sourceUrl: String(s.sourceUrl || ''),
      sourceKey: String(s.sourceKey || ''),
      sourcePlaylistUrl: String(s.sourcePlaylistUrl || ''),
      addedAt: Number(s.addedAt) || Date.now(),
      stats: cleanStats(s.stats),
      // LUFS, for "Equalize volume"; null until measured (loudness.js).
      loudness: cleanLoudness(s.loudness),
      cover: cleanCover(s.cover),
      tagged: cleanTagged(s.tagged),
      favouriteAt: Number(s.favouriteAt) || null,
    });
  }
  const seenLists = new Set();
  for (const p of Array.isArray(raw.playlists) ? raw.playlists : []) {
    if (!p || !p.id || p.id === ALL_SONGS_ID || seenLists.has(p.id)) continue;
    seenLists.add(p.id);
    const inList = new Set();
    const entries = [];
    for (const e of Array.isArray(p.entries) ? p.entries : []) {
      if (!e || !seenSongs.has(e.songId) || inList.has(e.songId)) continue;
      inList.add(e.songId);
      entries.push({ songId: String(e.songId), addedAt: Number(e.addedAt) || Date.now() });
    }
    data.playlists.push({
      id: String(p.id),
      name: String(p.name || 'Playlist'),
      createdAt: Number(p.createdAt) || Date.now(),
      entries,
      source: p.source && p.source.url ? { url: String(p.source.url), kind: String(p.source.kind || '') } : null,
      shared: p.shared === true,
    });
  }
  data.follows = cleanIds(raw.follows);
  data.playlistListened = cleanListened(raw.playlistListened);
  const seenShared = new Set();
  for (const p of Array.isArray(raw.sharedPlaylists) ? raw.sharedPlaylists : []) {
    if (!p || !p.id || seenShared.has(p.id) || seenLists.has(p.id)) continue;
    seenShared.add(p.id);
    const inList = new Set();
    const entries = [];
    for (const e of Array.isArray(p.entries) ? p.entries : []) {
      if (!e || !seenSongs.has(e.songId) || inList.has(e.songId)) continue;
      inList.add(e.songId);
      entries.push({ songId: String(e.songId), addedAt: Number(e.addedAt) || Date.now() });
    }
    data.sharedPlaylists.push({
      id: String(p.id),
      name: String(p.name || 'Playlist'),
      createdAt: Number(p.createdAt) || Date.now(),
      entries,
      ownerId: String(p.ownerId || ''),
      ownerName: String(p.ownerName || ''),
    });
  }
  if (Array.isArray(raw.ignoredFiles)) {
    data.ignoredFiles = [...new Set(raw.ignoredFiles.map((f) => String(f).toLowerCase()))];
  }
  return data;
}

function songById(data, id) {
  return data.songs.find((s) => s.id === id) || null;
}

function playlistById(data, id) {
  return data.playlists.find((p) => p.id === id) || null;
}

function requirePlaylist(data, id) {
  if (id === ALL_SONGS_ID) throw new Error('All Songs cannot be changed.');
  const p = playlistById(data, id);
  if (!p) throw new Error('That playlist no longer exists.');
  return p;
}

function requireSong(data, id) {
  const s = songById(data, id);
  if (!s) throw new Error('That song no longer exists.');
  return s;
}

/** The name trimmed, or an Error saying why it cannot be used. */
function checkPlaylistName(data, name, exceptId = null) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Please enter a name for the playlist.');
  if (clean.length > MAX_NAME) throw new Error(`Playlist names can be at most ${MAX_NAME} characters.`);
  const lower = clean.toLowerCase();
  if (lower === ALL_SONGS_NAME.toLowerCase()) throw new Error('"All Songs" is already taken.');
  const clash = data.playlists.find((p) => p.id !== exceptId && p.name.toLowerCase() === lower);
  if (clash) throw new Error(`A playlist called "${clash.name}" already exists.`);
  return clean;
}

function createPlaylist(data, name, id, now = Date.now()) {
  const clean = checkPlaylistName(data, name);
  const playlist = { id, name: clean, createdAt: now, entries: [], source: null, shared: false };
  data.playlists.push(playlist);
  return playlist;
}

/** `name`, or "name (2)", "name (3)" ... whichever is free. */
function freePlaylistName(data, name) {
  const base = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME - 5) || 'Imported playlist';
  const taken = (n) => n.toLowerCase() === ALL_SONGS_NAME.toLowerCase()
    || data.playlists.some((p) => p.name.toLowerCase() === n.toLowerCase());
  if (!taken(base)) return base;
  for (let i = 2; ; i += 1) {
    if (!taken(`${base} (${i})`)) return `${base} (${i})`;
  }
}

/** Remembers where an imported playlist came from, unless it already knows. */
function setPlaylistSource(data, id, source) {
  const p = requirePlaylist(data, id);
  if (!p.source && source && source.url) p.source = { url: String(source.url), kind: String(source.kind || '') };
  return p;
}

function renamePlaylist(data, id, name) {
  const p = requirePlaylist(data, id);
  p.name = checkPlaylistName(data, name, id);
  return p;
}

/** Shares a playlist with the other profiles, or no longer. */
function setPlaylistShared(data, id, shared) {
  const p = requirePlaylist(data, id);
  p.shared = !!shared;
  return p;
}

/** A shared playlist of another profile, or null. */
function sharedPlaylistById(data, id) {
  return (data.sharedPlaylists || []).find((p) => p.id === id) || null;
}

/** Follows a playlist another profile shares. Your own cannot be followed. */
function followPlaylist(data, id) {
  if (playlistById(data, id)) throw new Error('Your own playlists are always yours; there is nothing to follow.');
  if (!sharedPlaylistById(data, id)) throw new Error('That playlist is no longer shared.');
  data.follows = cleanIds([...(data.follows || []), id]);
}

function unfollowPlaylist(data, id) {
  data.follows = (data.follows || []).filter((x) => x !== id);
  // What was listened to it goes with the follow.
  if (data.playlistListened) delete data.playlistListened[id];
}

function deletePlaylist(data, id) {
  requirePlaylist(data, id);
  data.playlists = data.playlists.filter((p) => p.id !== id);
  if (data.playlistListened) delete data.playlistListened[id];
}

/**
 * The songs of a playlist that are in no other one: not in another playlist,
 * a playlist followed, or the favourites, and not in `keep` (song ids the
 * caller knows are wanted elsewhere: another profile's on a server).
 */
function songsOnlyIn(data, id, keep = null) {
  const p = playlistById(data, id);
  if (!p) return [];
  const elsewhere = new Set(keep || []);
  for (const q of data.playlists) if (q.id !== id) for (const e of q.entries) elsewhere.add(e.songId);
  for (const q of data.sharedPlaylists || []) for (const e of q.entries || []) elsewhere.add(e.songId);
  const lone = new Set();
  for (const e of p.entries) {
    if (elsewhere.has(e.songId)) continue;
    const s = songById(data, e.songId);
    if (s && !s.favouriteAt) lone.add(s.id);
  }
  return [...lone];
}

function addSong(data, song) {
  song.stats = cleanStats(song.stats);
  song.favouriteAt = Number(song.favouriteAt) || null;
  song.sourcePlaylistUrl = String(song.sourcePlaylistUrl || '');
  song.loudness = cleanLoudness(song.loudness);
  song.cover = cleanCover(song.cover);
  song.tagged = cleanTagged(song.tagged);
  data.songs.push(song);
  const lower = String(song.file).toLowerCase();
  data.ignoredFiles = data.ignoredFiles.filter((f) => f !== lower);
  return song;
}

function updateSong(data, id, patch) {
  const s = requireSong(data, id);
  for (const key of ['title', 'artist', 'mix', 'file', 'duration', 'format']) {
    if (patch[key] !== undefined) s[key] = patch[key];
  }
  if (patch.loudness !== undefined) s.loudness = cleanLoudness(patch.loudness);
  return s;
}

/**
 * The song's cover version (or '-', or null to look again). Never through a
 * command: only whoever keeps the cover files calls it.
 */
function setCover(data, id, version) {
  const s = requireSong(data, id);
  s.cover = cleanCover(version);
  return s;
}

/** What the song's file carries now (see cleanTagged); only whoever writes the files calls it. */
function setTagged(data, id, value) {
  const s = requireSong(data, id);
  s.tagged = cleanTagged(value);
  return s;
}

/** A song whose file wants its tags written: new, cover settled, not written with this cover yet. */
function needsTags(s) {
  return !!s && s.tagged !== null && s.tagged !== undefined && s.cover !== null && s.cover !== undefined && s.tagged !== s.cover;
}

/** Makes a song a favourite or no longer one. Already so: left as it was. */
function setFavourite(data, id, on, now = Date.now()) {
  const s = requireSong(data, id);
  if (on && !s.favouriteAt) s.favouriteAt = now;
  if (!on) s.favouriteAt = null;
  return s;
}

/**
 * Takes a song out of the library and every playlist. With keepFile the file
 * stays in the music folder but is remembered as removed, so the startup scan
 * does not bring it straight back.
 */
function removeSong(data, id, keepFile) {
  const s = requireSong(data, id);
  data.songs = data.songs.filter((x) => x.id !== id);
  for (const p of data.playlists) p.entries = p.entries.filter((e) => e.songId !== id);
  if (keepFile) {
    const lower = s.file.toLowerCase();
    if (!data.ignoredFiles.includes(lower)) data.ignoredFiles.push(lower);
  }
  return s;
}

/**
 * Adds `seconds` to the time listened to a list, when that list was the one
 * playing and the song is in it. A song that only came through the queue
 * from elsewhere passes no list.
 */
function addListenedTo(data, listId, songId, seconds) {
  if (!listId || typeof listId !== 'string' || !(seconds > 0)) return;
  const builtIn = listId === ALL_SONGS_ID || listId === 'favourites' || listId.startsWith('smart:');
  const list = builtIn ? null : (playlistById(data, listId) || sharedPlaylistById(data, listId));
  if (!builtIn && (!list || !list.entries.some((e) => e.songId === songId))) return;
  // Another profile's list only counts while it is followed.
  if (list && !playlistById(data, listId) && !(data.follows || []).includes(listId)) return;
  if (!data.playlistListened || typeof data.playlistListened !== 'object') data.playlistListened = {};
  data.playlistListened[listId] = (data.playlistListened[listId] || 0) + seconds;
}

/**
 * Counts one listen of a song: `listened` seconds heard before it changed,
 * out of `duration`. Returns what it was counted as ('play', 'stop', 'skip'),
 * or null when it was too short to count.
 */
function recordListen(data, songId, { listened, duration, at = Date.now(), contextId = null }) {
  const s = requireSong(data, songId);
  const total = Number(duration) || s.duration || 0;
  const heard = Math.min(Math.max(0, Number(listened) || 0), total || Infinity);
  if (heard < MIN_LISTEN_SECONDS) return null;
  const st = cleanStats(s.stats);
  let kind;
  if (total && heard / total >= PLAYED_SHARE) kind = 'play';
  else if (heard < EARLY_SKIP_SECONDS) kind = 'skip';
  else kind = 'stop';
  if (kind === 'play') st.plays += 1;
  else if (kind === 'skip') st.skips += 1;
  else st.stops += 1;
  st.sessions += 1;
  st.listened += heard;
  st.lastPlayedAt = at;
  s.stats = st;
  addListenedTo(data, contextId, songId, heard);
  return kind;
}

/** Adds one song to several playlists. Lists that already hold it are skipped. */
function addSongToPlaylists(data, songId, playlistIds, now = Date.now()) {
  requireSong(data, songId);
  let added = 0;
  for (const pid of playlistIds || []) {
    const p = requirePlaylist(data, pid);
    if (p.entries.some((e) => e.songId === songId)) continue;
    p.entries.push({ songId, addedAt: now });
    added += 1;
  }
  return added;
}

function addSongsToPlaylist(data, playlistId, songIds, now = Date.now()) {
  const p = requirePlaylist(data, playlistId);
  let added = 0;
  for (const sid of songIds || []) {
    requireSong(data, sid);
    if (p.entries.some((e) => e.songId === sid)) continue;
    p.entries.push({ songId: sid, addedAt: now });
    added += 1;
  }
  return added;
}

function removeFromPlaylist(data, playlistId, songId) {
  const p = requirePlaylist(data, playlistId);
  p.entries = p.entries.filter((e) => e.songId !== songId);
}

/**
 * A song already downloaded from the same source: same yt-dlp key when both
 * have one, otherwise the same page link.
 */
function findBySource(data, { key, url }) {
  if (key) {
    const hit = data.songs.find((s) => s.sourceKey && s.sourceKey === key);
    if (hit) return hit;
  }
  const want = url ? comparableUrl(url) : null;
  if (!want) return null;
  return data.songs.find((s) => s.sourceUrl && comparableUrl(s.sourceUrl) === want) || null;
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A song with the same artist, title and mix, ignoring case. */
function findByMeta(data, { artist, title, mix }, exceptId = null) {
  const a = norm(artist);
  const t = norm(title);
  const m = norm(mix);
  if (!t) return null;
  return data.songs.find((s) => s.id !== exceptId
    && norm(s.artist) === a && norm(s.title) === t && norm(s.mix) === m) || null;
}

module.exports = {
  ALL_SONGS_ID, ALL_SONGS_NAME, MAX_NAME, PLAYED_SHARE, EARLY_SKIP_SECONDS,
  emptyLibrary, emptyStats, sanitize, recordListen, songById, playlistById, checkPlaylistName,
  createPlaylist, renamePlaylist, deletePlaylist, freePlaylistName, setPlaylistSource,
  setPlaylistShared, sharedPlaylistById, followPlaylist, unfollowPlaylist,
  addSong, updateSong, setCover, cleanCover, setTagged, cleanTagged, needsTags, setFavourite, removeSong, songsOnlyIn,
  addSongToPlaylists, addSongsToPlaylist, removeFromPlaylist,
  findBySource, findByMeta,
};
