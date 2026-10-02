'use strict';

// Profiles on a Flow Server: people sharing one library. The songs are
// shared (All Songs, their names, files, lengths, loudness and when they were
// added); each profile has its own playlists, favourites and listen stats.
// Pure, like libraryModel.js.
//
//   data      a library as libraryModel.js knows it. It is also the part of
//             no profile, called "Default / Shared": its playlists,
//             favourites and stats are what an app sees while no profile is
//             signed in.
//   profiles  { [profileId]: { playlists: [...], songs: { [songId]: { stats, favouriteAt } }, follows: [playlistId], playlistListened: {...} } }
//
// Playlists can be shared (playlist.shared): the other profiles, and the
// Default, then see them read-only in their view (sharedPlaylists) and can
// follow them (follows). The Default's own follows are data.follows.
//
// A command for a profile runs on view(): an ordinary library made of the
// shared songs with that profile's stats and favourites, and its playlists.
// absorb() then puts each part back where it belongs. A song gone from a view
// (deleted) is gone for everyone.
//
// A new profile starts with a copy of the Default / Shared playlists (each with
// an id of its own). Favourites and stats stay with the Default.

const crypto = require('crypto');
const model = require('./libraryModel');

const randomId = () => crypto.randomBytes(6).toString('hex');

// What a song has once per profile; everything else about it is shared.
const OWN = ['stats', 'favouriteAt'];

function hasOwn(entry) {
  const st = entry.stats || {};
  return !!(entry.favouriteAt || st.sessions || st.plays || st.stops || st.skips || st.listened || st.lastPlayedAt);
}

/** One profile's part, repaired against the library's songs. */
function cleanProfile(data, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  // sanitize() already knows how playlists must look and drops entries for
  // songs that are not there.
  const { playlists, follows, playlistListened } = model.sanitize({
    songs: data.songs, playlists: r.playlists, follows: r.follows, playlistListened: r.playlistListened,
  });
  const known = new Set(data.songs.map((s) => s.id));
  const songs = {};
  const own = r.songs && typeof r.songs === 'object' ? r.songs : {};
  for (const [id, entry] of Object.entries(own)) {
    if (!known.has(id) || !entry || typeof entry !== 'object') continue;
    const clean = model.sanitize({ songs: [{ id, file: 'x', stats: entry.stats, favouriteAt: entry.favouriteAt }] }).songs[0];
    const kept = { stats: clean.stats, favouriteAt: clean.favouriteAt };
    if (hasOwn(kept)) songs[id] = kept;
  }
  return { playlists, songs, follows, playlistListened };
}

/** Every profile's part, repaired. `data` must be sanitized already. */
function sanitizeProfiles(data, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, p] of Object.entries(raw)) {
    if (/^[\w-]{1,64}$/.test(id)) out[id] = cleanProfile(data, p);
  }
  return out;
}

const DEFAULT_OWNER = 'default';
const DEFAULT_NAME = 'Default / Shared';

/**
 * What the other profiles (and the Default) share with `viewerId` (null: the
 * Default): their shared playlists, to read. `names` maps profile ids to names.
 */
function sharedFor(data, profiles, names, viewerId) {
  const out = [];
  const add = (ownerId, ownerName, playlists) => {
    for (const p of playlists) {
      if (!p.shared) continue;
      out.push({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        entries: p.entries.map((e) => ({ ...e })),
        ownerId,
        ownerName,
      });
    }
  };
  if (viewerId) add(DEFAULT_OWNER, DEFAULT_NAME, data.playlists);
  for (const [id, p] of Object.entries(profiles)) {
    if (id !== viewerId) add(id, (names && names[id]) || 'Unknown', p.playlists);
  }
  return out;
}

/**
 * The library as one profile sees it (null: the Default, whose part is `data`
 * itself). `names`: profile id -> name, for the shared playlists' owners.
 */
function view(data, profiles, profileId, names = {}) {
  const sharedPlaylists = sharedFor(data, profiles, names, profileId || null);
  if (!profileId) return { ...data, follows: (data.follows || []).slice(), sharedPlaylists };
  const p = profiles[profileId] || { playlists: [], songs: {}, follows: [], playlistListened: {} };
  return {
    ...data,
    songs: data.songs.map((s) => {
      const own = p.songs[s.id];
      return { ...s, stats: own ? { ...own.stats } : model.emptyStats(), favouriteAt: own ? own.favouriteAt : null };
    }),
    playlists: p.playlists,
    follows: (p.follows || []).slice(),
    playlistListened: { ...(p.playlistListened || {}) },
    sharedPlaylists,
  };
}

/**
 * Puts a profile's view, changed by commands, back: the songs' shared fields
 * into `data`, the rest into the profile. Songs the view no longer has are
 * taken out everywhere (prune()).
 */
function absorb(data, profiles, profileId, v) {
  if (!profileId) {
    // The Default's view is a copy of `data`: what commands changed goes back.
    data.songs = v.songs;
    data.playlists = v.playlists;
    data.ignoredFiles = v.ignoredFiles;
    data.follows = v.follows;
    data.playlistListened = v.playlistListened || {};
    prune(data, profiles);
    return;
  }
  const byId = new Map(data.songs.map((s) => [s.id, s]));
  const songs = [];
  const own = {};
  for (const vs of v.songs) {
    const shared = { ...(byId.get(vs.id) || {}) };
    for (const [key, value] of Object.entries(vs)) if (!OWN.includes(key)) shared[key] = value;
    if (!byId.has(vs.id)) {
      // New to the library through this profile: the Default has not heard it yet.
      shared.stats = model.emptyStats();
      shared.favouriteAt = null;
    }
    songs.push(shared);
    const mine = { stats: vs.stats, favouriteAt: vs.favouriteAt };
    if (hasOwn(mine)) own[vs.id] = mine;
  }
  data.songs = songs;
  data.ignoredFiles = v.ignoredFiles;
  profiles[profileId] = { playlists: v.playlists, songs: own, follows: v.follows, playlistListened: v.playlistListened || {} };
  prune(data, profiles);
}

/** Takes songs no longer in the library out of every playlist and profile. */
function prune(data, profiles) {
  const known = new Set(data.songs.map((s) => s.id));
  const keep = (list) => {
    for (const p of list) p.entries = p.entries.filter((e) => known.has(e.songId));
  };
  keep(data.playlists);
  for (const p of Object.values(profiles)) {
    keep(p.playlists);
    for (const id of Object.keys(p.songs)) if (!known.has(id)) delete p.songs[id];
  }
  // A follow of a playlist that is gone (deleted, or its profile) goes too;
  // one that is only not shared for now waits for it to be shared again.
  const lists = new Set(data.playlists.map((p) => p.id));
  for (const p of Object.values(profiles)) for (const l of p.playlists) lists.add(l.id);
  data.follows = (data.follows || []).filter((id) => lists.has(id));
  for (const p of Object.values(profiles)) p.follows = (p.follows || []).filter((id) => lists.has(id));
  // Time listened to a list goes when the list is gone, or is another
  // profile's and no longer followed (All Songs, Favourites and the Listen
  // behaviour lists are always there).
  for (const owner of [data, ...Object.values(profiles)]) {
    const mine = new Set((owner.playlists || []).map((p) => p.id));
    const followed = new Set(owner.follows || []);
    const kept = {};
    for (const [id, secs] of Object.entries(owner.playlistListened || {})) {
      const builtIn = id === model.ALL_SONGS_ID || id === 'favourites' || id.startsWith('smart:');
      if (builtIn || mine.has(id) || (followed.has(id) && lists.has(id))) kept[id] = secs;
    }
    owner.playlistListened = kept;
  }
}

/**
 * Makes a profile with a copy of the Default / Shared playlists: the same
 * songs in the same order, under new ids, not shared. Favourites and stats
 * start empty. `newId()` makes the ids.
 */
function addProfile(data, profiles, profileId, newId = randomId) {
  if (profiles[profileId]) return;
  const playlists = data.playlists.map((p) => ({
    ...p,
    id: newId(),
    entries: p.entries.map((e) => ({ ...e })),
    source: p.source ? { ...p.source } : null,
    shared: false,
  }));
  profiles[profileId] = { playlists, songs: {}, follows: [], playlistListened: {} };
}

/** Deletes a profile's playlists, favourites and stats. The songs stay. */
function removeProfile(profiles, profileId) {
  delete profiles[profileId];
}

/**
 * The songs every owner but `profileId` (null: the Default / Shared) has in a
 * playlist or among the favourites: what deleting one profile's playlist with
 * its songs must keep.
 */
function songsOfOthers(data, profiles, profileId) {
  const ids = new Set();
  const add = (playlists) => {
    for (const p of playlists || []) for (const e of p.entries) ids.add(e.songId);
  };
  if (profileId) {
    add(data.playlists);
    for (const s of data.songs) if (s.favouriteAt) ids.add(s.id);
  }
  for (const [id, p] of Object.entries(profiles)) {
    if (id === profileId) continue;
    add(p.playlists);
    for (const [sid, own] of Object.entries(p.songs || {})) if (own && own.favouriteAt) ids.add(sid);
  }
  return ids;
}

module.exports = { songsOfOthers, sanitizeProfiles, view, absorb, prune, addProfile, removeProfile, sharedFor, DEFAULT_OWNER, DEFAULT_NAME };
