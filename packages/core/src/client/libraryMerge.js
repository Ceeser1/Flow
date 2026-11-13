'use strict';

// What changed on a Flow Server since an app's copy of its library, merged
// into that copy (4.3: GET /api/library?since=, the live channel). Pure.
//
// Since 4.6 the copy's songs and playlists are locked rows (libraryPatch.js
// lock) and the merge keeps every row nothing came for: only the rows the
// server sent are cleaned (libraryModel.js cleanSong, cleanPlaylist), and a
// playlist that was not sent is cleaned again only where it could come out
// differently (a song of it gone, one of its groups gone). So a star or a
// rename no longer makes every song anew, and whoever keeps what changed
// (the copy's file, the window) tells the rows that stayed by their being
// the same ones. What comes out is, value for value, what cleaning the whole
// merged library gave before (test/libraryMerge.test.js holds the two against
// each other).

const model = require('../libraryModel');
const LibraryPatch = require('../libraryPatch');

const ROWS = ['songs', 'playlists', 'sharedPlaylists'];

/** Every song and playlist of a library locked: they are changed only by other rows put in their place. */
function lockRows(lib) {
  for (const k of ROWS) for (const row of lib[k] || []) LibraryPatch.lock(row);
  return lib;
}

/**
 * `lib` (a copy as kept: clean, its rows locked) with the changes `c` of
 * library.changes() ({ songs, deletedSongs, playlists, deletedPlaylists,
 * follows?, groups?, groupFollows?, groupSkips?, sharedPlaylists, unshared,
 * sharedGroups?, profileNames? }): a new library, its rows locked, the ones
 * nothing changed in being those of `lib`.
 */
function mergeChanges(lib, c) {
  // ---- the songs ----
  const goneSongs = new Set((c.deletedSongs || []).map(String));
  const changedSongs = new Map((c.songs || []).map((s) => [String(s && s.id), s]));
  const songs = [];
  // A song of the copy gone (deleted, or sent as one that cannot be kept): playlists may lose entries.
  let removed = false;
  // Rows taken out that may come again in the same changes (gone and sent at once): the row it was, where it reads the same.
  const out = new Map();
  const asBefore = (kind, clean) => {
    const was = clean ? out.get(`${kind}/${clean.id}`) : null;
    return was && LibraryPatch.same(was, clean) ? was : clean;
  };
  for (const s of lib.songs) {
    if (goneSongs.has(s.id)) {
      removed = true;
      out.set(`song/${s.id}`, s);
      continue;
    }
    const now = changedSongs.get(s.id);
    changedSongs.delete(s.id);
    if (!now) {
      songs.push(s);
      continue;
    }
    const clean = model.cleanSong(now);
    if (!clean) removed = true;
    // Sent again as it is (changes that overlap): the row it was.
    else songs.push(LibraryPatch.same(s, clean) ? s : clean);
  }
  const added = new Set();
  for (const raw of changedSongs.values()) {
    const clean = model.cleanSong(raw);
    // The same id twice in what came (never from a server): the first stands.
    if (!clean || added.has(raw.id)) continue;
    added.add(raw.id);
    songs.push(asBefore('song', clean));
  }
  // Whether the library has a song, looked up only when a playlist must be cleaned.
  let ids = null;
  const hasSong = (id) => {
    if (!ids) ids = new Set(songs.map((s) => s.id));
    return ids.has(id);
  };
  const losesEntries = (p) => removed && (p.entries || []).some((e) => !hasSong(e.songId));

  // ---- everything but the rows, cleaned as ever (small) ----
  const follows = Array.isArray(c.follows) ? c.follows : lib.follows;
  const groupFollows = Array.isArray(c.groupFollows) ? c.groupFollows : lib.groupFollows || [];
  const sharedGroups = Array.isArray(c.sharedGroups) ? c.sharedGroups : lib.sharedGroups || [];
  const groupSkips = c.groupSkips && typeof c.groupSkips === 'object' ? c.groupSkips : lib.groupSkips || {};
  const rest = model.sanitize({
    ...lib,
    songs: [],
    playlists: [],
    sharedPlaylists: [],
    groups: Array.isArray(c.groups) ? c.groups : lib.groups,
    follows,
    groupFollows,
    groupSkips,
    sharedGroups,
    profileNames: c.profileNames || lib.profileNames,
  });
  const groupIds = new Set(rest.groups.map((g) => g.id));
  const groupsCame = Array.isArray(c.groups);

  // ---- the profile's own playlists ----
  const goneLists = new Set((c.deletedPlaylists || []).map(String));
  const changedLists = new Map((c.playlists || []).map((p) => [String(p && p.id), p]));
  const cleanOwn = (p) => (!p || !p.id || p.id === model.ALL_SONGS_ID ? null : model.cleanPlaylist(p, hasSong, groupIds));
  const playlists = [];
  const own = new Set();
  const put = (row) => {
    if (!row || own.has(row.id)) return;
    own.add(row.id);
    playlists.push(row);
  };
  for (const p of lib.playlists) {
    if (goneLists.has(p.id)) {
      out.set(`list/${p.id}`, p);
      continue;
    }
    const now = changedLists.get(p.id);
    changedLists.delete(p.id);
    if (now) {
      const clean = cleanOwn(now);
      put(clean && LibraryPatch.same(p, clean) ? p : clean);
    } else if (losesEntries(p) || (groupsCame && p.groups && p.groups.some((g) => !groupIds.has(g)))) {
      // Not sent, but it would come out differently now: cleaned again.
      put(cleanOwn(p));
    } else put(p);
  }
  for (const raw of changedLists.values()) put(asBefore('list', cleanOwn(raw)));

  // ---- the playlists followed (with their songs; also those of a followed group) ----
  const unshared = new Set((c.unshared || []).map(String));
  const changedShared = new Map((c.sharedPlaylists || []).map((p) => [String(p && p.id), p]));
  const followed = model.followedIds({
    follows, groupFollows, groupSkips, sharedGroups,
  });
  const shared = [];
  const seenShared = new Set();
  const putShared = (row) => {
    // One with the id of a playlist of the profile's own is not another's.
    if (!row || seenShared.has(row.id) || own.has(row.id)) return;
    seenShared.add(row.id);
    shared.push(row);
  };
  const cleanShared = (p) => (!p || !p.id ? null : model.cleanSharedPlaylist(p, hasSong));
  for (const p of lib.sharedPlaylists) {
    if (unshared.has(p.id) || !followed.has(p.id)) {
      out.set(`shared/${p.id}`, p);
      continue;
    }
    const now = changedShared.get(p.id);
    changedShared.delete(p.id);
    if (now) {
      const clean = cleanShared(now);
      putShared(clean && LibraryPatch.same(p, clean) ? p : clean);
    } else if (losesEntries(p)) putShared(cleanShared(p));
    else putShared(p);
  }
  for (const raw of changedShared.values()) putShared(asBefore('shared', cleanShared(raw)));

  return lockRows({
    ...rest, songs, playlists, sharedPlaylists: shared,
  });
}

module.exports = { mergeChanges, lockRows, ROWS };
