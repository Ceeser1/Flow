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
//   profiles  { [profileId]: { playlists: [...], songs: { [songId]: { stats, favouriteAt } } } }
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
  const { playlists } = model.sanitize({ songs: data.songs, playlists: r.playlists });
  const known = new Set(data.songs.map((s) => s.id));
  const songs = {};
  const own = r.songs && typeof r.songs === 'object' ? r.songs : {};
  for (const [id, entry] of Object.entries(own)) {
    if (!known.has(id) || !entry || typeof entry !== 'object') continue;
    const clean = model.sanitize({ songs: [{ id, file: 'x', stats: entry.stats, favouriteAt: entry.favouriteAt }] }).songs[0];
    const kept = { stats: clean.stats, favouriteAt: clean.favouriteAt };
    if (hasOwn(kept)) songs[id] = kept;
  }
  return { playlists, songs };
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

/** The library as one profile sees it; no profile (null) is `data` itself. */
function view(data, profiles, profileId) {
  if (!profileId) return data;
  const p = profiles[profileId] || { playlists: [], songs: {} };
  return {
    ...data,
    songs: data.songs.map((s) => {
      const own = p.songs[s.id];
      return { ...s, stats: own ? { ...own.stats } : model.emptyStats(), favouriteAt: own ? own.favouriteAt : null };
    }),
    playlists: p.playlists,
  };
}

/**
 * Puts a profile's view, changed by commands, back: the songs' shared fields
 * into `data`, the rest into the profile. Songs the view no longer has are
 * taken out everywhere (prune()).
 */
function absorb(data, profiles, profileId, v) {
  if (!profileId) {
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
  profiles[profileId] = { playlists: v.playlists, songs: own };
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
  profiles[profileId] = { playlists, songs: {} };
}

/** Deletes a profile's playlists, favourites and stats. The songs stay. */
function removeProfile(profiles, profileId) {
  delete profiles[profileId];
}

module.exports = { sanitizeProfiles, view, absorb, prune, addProfile, removeProfile };
