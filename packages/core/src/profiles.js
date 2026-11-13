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
//   profiles  { [profileId]: { playlists: [...], groups: [...] (4.5), songs: { [songId]: { stats, favouriteAt } }, follows: [playlistId], groupFollows: [groupId], groupSkips: { groupId: [playlistId] } (4.5.3), playlistListened: {...}, listening, statistics } }
//
// Playlists can be shared (playlist.shared): the other profiles, and the
// Default, then see them read-only in their view (sharedPlaylists) and can
// follow them (follows). The Default's own follows are data.follows.
// Groups can be shared too (4.5.3, group.shared): the others see them with
// the shared playlists in them (sharedGroups) and can follow them
// (groupFollows); a followed group's playlists count as followed.
//
// A command for a profile runs on view(): an ordinary library made of the
// shared songs with that profile's stats and favourites, and its playlists.
// absorb() then puts each part back where it belongs. A song gone from a view
// (deleted) is gone for everyone.
//
// A new profile starts with a copy of the Default / Shared playlists (each with
// an id of its own). Favourites and stats stay with the Default.
//
// Favourites (4.3) are a playlist of each owner's own (FAV_PREFIX + owner id,
// favourites: true), shared and followed like any other; a song's favouriteAt
// in a view is when it went into that list. Before 4.3 they were each song's
// favouriteAt (the Default's in data.songs, a profile's in its songs):
// ensureFavourites turns those into the lists once.
//
// Locked rows (4.6, libraryModel.js): a song or playlist that was saved is
// locked and changed by a copy put in its place, and one that did not change
// stays the row it was. absorb() therefore keeps every shared song and every
// own stats entry that came back from the view as it went in, so a command
// of a profile touches the rows it changed and no others.

const crypto = require('crypto');
const model = require('./libraryModel');
const {
  emptyListening, copyListening, listenTotals, emptyStatistics, copyStatistics,
} = require('./listening');

const randomId = () => crypto.randomBytes(6).toString('hex');

// What a song has once per profile; everything else about it is shared.
const OWN = ['stats', 'favouriteAt'];

// The id of an owner's Favourites playlist.
const FAV_PREFIX = 'fav-';
const favId = (ownerId) => `${FAV_PREFIX}${ownerId}`;

function hasOwn(entry) {
  const st = entry.stats || {};
  return !!(entry.favouriteAt || st.sessions || st.plays || st.stops || st.skips || st.listened || st.lastPlayedAt);
}

/** An owner's Favourites playlist made from songs' favouriteAt (by star time): [{ id, favouriteAt }]. */
function favouritesFrom(ownerId, starred, now = Date.now()) {
  const entries = starred.filter((x) => x.favouriteAt).sort((a, b) => a.favouriteAt - b.favouriteAt)
    .map((x) => ({ songId: x.id, addedAt: x.favouriteAt }));
  return {
    id: favId(ownerId), name: 'Favourites', createdAt: entries.length ? entries[0].addedAt : now, entries, source: null, shared: false, rules: null, favourites: true,
  };
}

/**
 * Every owner gets its Favourites playlist (4.3), made once from the songs'
 * favouriteAt; a profile's songs keep only their stats after it, and the
 * Default's songs carry the list's times. Answers whether anything changed.
 */
function ensureFavourites(data, profiles, now = Date.now()) {
  let changed = false;
  if (!model.favouritesList(data)) {
    data.playlists.unshift(favouritesFrom(DEFAULT_OWNER, data.songs, now));
    changed = true;
  }
  syncStars(data.songs, model.favouritesList(data));
  for (const [id, p] of Object.entries(profiles)) {
    if (!model.favouritesList(p)) {
      p.playlists.unshift(favouritesFrom(id, Object.entries(p.songs).map(([sid, e]) => ({ id: sid, favouriteAt: e.favouriteAt })), now));
      changed = true;
    }
    for (const [sid, e] of Object.entries(p.songs)) {
      if (e.favouriteAt === undefined) continue;
      delete e.favouriteAt;
      changed = true;
      if (!hasOwn(e)) delete p.songs[sid];
    }
  }
  return changed;
}

/** Songs' favouriteAt set from a Favourites playlist (when each went in), null for the rest. */
function syncStars(songs, fav) {
  const at = new Map((fav ? fav.entries : []).map((e) => [e.songId, e.addedAt]));
  for (let i = 0; i < songs.length; i += 1) {
    const star = at.get(songs[i].id) || null;
    if (songs[i].favouriteAt !== star) model.rowToChange(songs, i).favouriteAt = star;
  }
}

/** Two flat objects with the same fields holding the same values. */
function flatSame(a, b) {
  let n = 0;
  for (const k in a) {
    if (a[k] !== b[k]) return false;
    n += 1;
  }
  for (const k in b) n -= 1;
  return n === 0;
}

/** One profile's part, repaired against the library's songs. */
function cleanProfile(data, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  // sanitize() already knows how playlists must look and drops entries for
  // songs that are not there.
  const {
    playlists, groups, follows, groupFollows, groupSkips, playlistListened, listening, statistics,
  } = model.sanitize({
    songs: data.songs, playlists: r.playlists, groups: r.groups, follows: r.follows, groupFollows: r.groupFollows, groupSkips: r.groupSkips, playlistListened: r.playlistListened, listening: r.listening, statistics: r.statistics,
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
  return {
    playlists, groups, songs, follows, groupFollows, groupSkips, playlistListened, listening, statistics,
  };
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
        ...(p.favourites ? { favourites: true } : {}),
      });
    }
  };
  if (viewerId) add(DEFAULT_OWNER, DEFAULT_NAME, data.playlists);
  for (const [id, p] of Object.entries(profiles)) {
    if (id !== viewerId) add(id, (names && names[id]) || 'Unknown', p.playlists);
  }
  return out;
}

/** Every owner's part: [ownerId, part], the Default's (`data`) first. */
function everyOwner(data, profiles) {
  return [[DEFAULT_OWNER, data], ...Object.entries(profiles)];
}

/** The ids of every playlist shared now, of any owner. */
function sharedIds(data, profiles) {
  const out = new Set();
  for (const [, part] of everyOwner(data, profiles)) for (const p of part.playlists || []) if (p.shared) out.add(p.id);
  return out;
}

/**
 * The playlists the others see in a shared group (4.5.3): its owner's
 * shared ones in it, and those it follows that are shared now.
 */
function groupLists(part, g, shared) {
  const ids = [];
  for (const p of part.playlists || []) if (model.inGroup(p, g.id) && p.shared) ids.push(p.id);
  for (const id of g.followed || []) if (shared.has(id) && !ids.includes(id)) ids.push(id);
  return ids;
}

/**
 * The groups the other profiles (and the Default) share with `viewerId`
 * (4.5.3; null: the Default; `everyone`: every owner's, for the server to
 * see what changed): [{ id, name, createdAt, ownerId, ownerName, playlists }].
 */
function sharedGroupsFor(data, profiles, names, viewerId, everyone = false) {
  const shared = sharedIds(data, profiles);
  const out = [];
  for (const [ownerId, part] of everyOwner(data, profiles)) {
    if (!everyone && (ownerId === DEFAULT_OWNER ? !viewerId : ownerId === viewerId)) continue;
    const ownerName = ownerId === DEFAULT_OWNER ? DEFAULT_NAME : (names && names[ownerId]) || 'Unknown';
    for (const g of part.groups || []) {
      if (!g.shared) continue;
      out.push({
        id: g.id, name: g.name, createdAt: g.createdAt, ownerId, ownerName, playlists: groupLists(part, g, shared),
      });
    }
  }
  return out;
}

/**
 * The library as one profile sees it (null: the Default, whose part is `data`
 * itself). `names`: profile id -> name, for the shared playlists' owners.
 */
function view(data, profiles, profileId, names = {}) {
  const sharedPlaylists = sharedFor(data, profiles, names, profileId || null);
  const sharedGroups = sharedGroupsFor(data, profiles, names, profileId || null);
  if (!profileId) {
    // The Default's songs carry its stars themselves, as its Favourites list has them.
    syncStars(data.songs, model.favouritesList(data));
    return {
      ...data, groups: data.groups || [], follows: (data.follows || []).slice(), groupFollows: (data.groupFollows || []).slice(), groupSkips: { ...(data.groupSkips || {}) }, statistics: copyStatistics(data.statistics), sharedPlaylists, sharedGroups,
    };
  }
  const p = profiles[profileId] || {
    playlists: [], groups: [], songs: {}, follows: [], groupFollows: [], groupSkips: {}, playlistListened: {}, listening: emptyListening(), statistics: emptyStatistics(),
  };
  const fav = model.favouritesList(p);
  const starred = new Map((fav ? fav.entries : []).map((e) => [e.songId, e.addedAt]));
  return {
    ...data,
    songs: data.songs.map((s) => {
      const own = p.songs[s.id];
      return { ...s, stats: own ? { ...own.stats } : model.emptyStats(), favouriteAt: starred.get(s.id) || null };
    }),
    playlists: p.playlists,
    groups: p.groups || [],
    follows: (p.follows || []).slice(),
    groupFollows: (p.groupFollows || []).slice(),
    groupSkips: { ...(p.groupSkips || {}) },
    playlistListened: { ...(p.playlistListened || {}) },
    listening: copyListening(p.listening),
    statistics: copyStatistics(p.statistics),
    sharedPlaylists,
    sharedGroups,
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
    data.groups = v.groups || [];
    data.ignoredFiles = v.ignoredFiles;
    data.follows = v.follows;
    data.groupFollows = v.groupFollows || [];
    data.groupSkips = v.groupSkips || {};
    data.playlistListened = v.playlistListened || {};
    data.listening = v.listening || emptyListening();
    data.statistics = v.statistics || emptyStatistics();
    prune(data, profiles);
    return;
  }
  const byId = new Map(data.songs.map((s) => [s.id, s]));
  const before = (profiles[profileId] && profiles[profileId].songs) || {};
  const songs = [];
  const own = {};
  // Whether its own entries are all the ones it had (then the map of them stays the one it was).
  let ownAsBefore = true;
  for (const vs of v.songs) {
    const was = byId.get(vs.id);
    // What every profile shares of it, as the view has it now. The same as before: the row it was (4.6).
    let differs = !was;
    if (was) {
      for (const key in vs) {
        if (key !== 'stats' && key !== 'favouriteAt' && vs[key] !== was[key]) {
          differs = true;
          break;
        }
      }
    }
    let shared = was;
    if (differs) {
      shared = { ...(was || {}) };
      for (const key in vs) if (!OWN.includes(key)) shared[key] = vs[key];
      if (!was) {
        // New to the library through this profile: the Default has not heard it yet.
        shared.stats = model.emptyStats();
        shared.favouriteAt = null;
      }
    }
    songs.push(shared);
    // Its star is in the profile's Favourites list. Its stats as they were: the entry it had.
    const old = before[vs.id];
    if (old && !('favouriteAt' in old) && old.stats && vs.stats && flatSame(old.stats, vs.stats)) {
      own[vs.id] = old;
      continue;
    }
    const mine = { stats: vs.stats };
    if (hasOwn(mine)) {
      own[vs.id] = mine;
      ownAsBefore = false;
    } else if (old) ownAsBefore = false;
  }
  data.songs = songs;
  data.ignoredFiles = v.ignoredFiles;
  profiles[profileId] = {
    // Entries of songs gone from the view are still in the map it had: prune() takes them out.
    playlists: v.playlists, groups: v.groups || [], songs: ownAsBefore && profiles[profileId] ? before : own, follows: v.follows, groupFollows: v.groupFollows || [], groupSkips: v.groupSkips || {}, playlistListened: v.playlistListened || {}, listening: v.listening || emptyListening(),
    statistics: v.statistics || emptyStatistics(),
  };
  prune(data, profiles);
}

// The song ids at the last prune() of a library's profiles, in order: while
// they are still there in that order (songs only added at the end), no song
// left, and no playlist or own entry can hold one that is gone.
const prunedAt = new WeakMap();

/** Whether a song left the library (or the songs changed places) since these profiles were pruned last. */
function songLeft(data, profiles) {
  const last = prunedAt.get(profiles);
  const songs = data.songs;
  let left = !last || songs.length < last.length;
  if (!left) {
    for (let i = 0; i < last.length; i += 1) {
      if (songs[i].id !== last[i]) {
        left = true;
        break;
      }
    }
  }
  if (left || songs.length !== last.length) prunedAt.set(profiles, songs.map((s) => s.id));
  return left;
}

/** Takes songs no longer in the library out of every playlist and profile. */
function prune(data, profiles) {
  // The playlists and own entries are looked through only when a song left since the last time (4.6).
  if (songLeft(data, profiles)) {
    const known = new Set(data.songs.map((s) => s.id));
    // Only a playlist that holds a song now gone gets another list of entries (the rest stay the rows they were).
    const keep = (list) => {
      for (const p of list.slice()) {
        if (p.entries.some((e) => !known.has(e.songId))) model.listToChange({ playlists: list }, p).entries = p.entries.filter((e) => known.has(e.songId));
      }
    };
    keep(data.playlists);
    for (const p of Object.values(profiles)) {
      keep(p.playlists);
      // Its own entries of songs gone: another map without them (the one it had may be locked).
      const gone = Object.keys(p.songs).filter((id) => !known.has(id));
      if (gone.length) {
        const songs = { ...p.songs };
        for (const id of gone) delete songs[id];
        p.songs = songs;
      }
    }
  }
  // A follow of a playlist that is gone (deleted, or its profile) goes too;
  // one that is only not shared for now waits for it to be shared again.
  const lists = new Set(data.playlists.map((p) => p.id));
  for (const p of Object.values(profiles)) for (const l of p.playlists) lists.add(l.id);
  data.follows = (data.follows || []).filter((id) => lists.has(id));
  for (const p of Object.values(profiles)) p.follows = (p.follows || []).filter((id) => lists.has(id));
  // And out of the groups it was put into (4.5.1); also one its owner no
  // longer shares (4.5.3: the follow waits, the groups lose it).
  const shared = sharedIds(data, profiles);
  for (const owner of [data, ...Object.values(profiles)]) model.keepFollowedInGroups(owner.groups, owner.follows, shared);
  // A follow of a group that is gone goes too; one only not shared for now
  // waits (4.5.3). Its shared playlists count as followed.
  const groups = new Map();
  for (const [, part] of everyOwner(data, profiles)) for (const g of part.groups || []) groups.set(g.id, [part, g]);
  for (const owner of [data, ...Object.values(profiles)]) {
    owner.groupFollows = (owner.groupFollows || []).filter((id) => groups.has(id) && groups.get(id)[0] !== owner);
    // What it unfollowed inside a group goes with that group's follow.
    const skips = {};
    for (const [id, list] of Object.entries(owner.groupSkips || {})) if (owner.groupFollows.includes(id)) skips[id] = list;
    owner.groupSkips = skips;
  }
  // Time listened to a list goes when the list is gone, or is another
  // profile's and no longer followed (All Songs, Favourites and the Listen
  // behaviour lists are always there).
  for (const owner of [data, ...Object.values(profiles)]) {
    const mine = new Set((owner.playlists || []).map((p) => p.id));
    const followed = new Set(owner.follows || []);
    for (const id of owner.groupFollows) {
      const [part, g] = groups.get(id);
      const skipped = owner.groupSkips[id] || [];
      if (g.shared) for (const pid of groupLists(part, g, shared)) if (!skipped.includes(pid)) followed.add(pid);
    }
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
 * start empty, its Statistics at `now`. `newId()` makes the ids.
 */
function addProfile(data, profiles, profileId, newId = randomId, now = Date.now()) {
  if (profiles[profileId]) return;
  // The groups too (4.5), under new ids, the copied playlists in them.
  const groupIds = new Map();
  const groups = (data.groups || []).map((g) => {
    const id = newId();
    groupIds.set(g.id, id);
    // Without the Default's follows (4.5.1): a new profile follows nothing.
    const copy = { ...g, id };
    delete copy.followed;
    // Not shared, as the copied playlists are not (4.5.3).
    delete copy.shared;
    return copy;
  });
  const playlists = data.playlists.filter((p) => !p.favourites).map((p) => {
    const copy = {
      ...p,
      id: newId(),
      entries: p.entries.map((e) => ({ ...e })),
      source: p.source ? { ...p.source } : null,
      shared: false,
    };
    const inGroups = (p.groups || []).filter((id) => groupIds.has(id)).map((id) => groupIds.get(id));
    delete copy.group;
    if (inGroups.length) copy.groups = inGroups;
    else delete copy.groups;
    return copy;
  });
  playlists.unshift(favouritesFrom(profileId, [], now));
  profiles[profileId] = {
    playlists, groups, songs: {}, follows: [], groupFollows: [], groupSkips: {}, playlistListened: {}, listening: emptyListening(), statistics: emptyStatistics(now),
  };
}

/**
 * The Statistics start (3.6): every owner whose totals have not started yet
 * (a library from before 3.6) starts at 0 now. What 3.5 recorded (the songs'
 * stats, `listening`) is kept but not counted. Answers whether any started.
 */
function startStatistics(data, profiles, now = Date.now()) {
  let started = false;
  for (const owner of [data, ...Object.values(profiles)]) {
    if (owner.statistics && owner.statistics.since) continue;
    owner.statistics = emptyStatistics(now);
    started = true;
  }
  return started;
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

/**
 * One owner's numbers for the server's Administration: the songs it added,
 * and its listens of 30 seconds or more and seconds heard (listenTotals).
 * `ownerId`: a profile, or DEFAULT_OWNER for the Default / Shared.
 */
function ownerSummary(data, profiles, ownerId) {
  const stats = ownerId === DEFAULT_OWNER
    ? data.songs.map((s) => s.stats)
    : Object.values((profiles[ownerId] || {}).songs || {}).map((e) => e.stats);
  return { addedSongs: data.songs.filter((s) => s.addedBy === ownerId).length, ...listenTotals(stats) };
}

/** The playlists of an owner (a profile, or DEFAULT_OWNER), or null for one that is not there. */
function playlistsOf(data, profiles, ownerId) {
  if (ownerId === DEFAULT_OWNER) return data.playlists;
  return profiles[ownerId] ? profiles[ownerId].playlists : null;
}

/** Who has `playlistId`: DEFAULT_OWNER, a profile id, or null for no one. */
function playlistOwner(data, profiles, playlistId) {
  if (data.playlists.some((p) => p.id === playlistId)) return DEFAULT_OWNER;
  for (const [id, p] of Object.entries(profiles)) if (p.playlists.some((l) => l.id === playlistId)) return id;
  return null;
}

/**
 * Every playlist on the server with its owner, for the Administration's All
 * Playlists: [{ id, name, ownerId, songs, seconds, smart, shared }]. A smart
 * playlist's songs are the apps' to work out from its rules (songs and
 * seconds null).
 */
function allPlaylists(data, profiles) {
  const length = new Map(data.songs.map((s) => [s.id, Number(s.duration) || 0]));
  const row = (ownerId, p) => {
    const smart = !!p.rules;
    return {
      id: p.id,
      name: p.name,
      ownerId,
      songs: smart ? null : p.entries.length,
      seconds: smart ? null : Math.round(p.entries.reduce((n, e) => n + (length.get(e.songId) || 0), 0)),
      smart,
      shared: !!p.shared,
    };
  };
  // Each owner's Favourites stays its own: not listed to be given away.
  const ordinary = (p) => !p.favourites;
  return [
    ...data.playlists.filter(ordinary).map((p) => row(DEFAULT_OWNER, p)),
    ...Object.entries(profiles).flatMap(([id, pr]) => pr.playlists.filter(ordinary).map((p) => row(id, p))),
  ];
}

/**
 * Gives a playlist to another owner (a profile, or DEFAULT_OWNER): the same
 * playlist, id, songs, rules, source and sharing, so whoever follows it still
 * does, now in the new owner's playlists (at their end). The new owner no
 * longer follows it (it is its own); a name it has already gets "(2)". The
 * old owner's time listened to it goes (prune), as with any list it lost.
 * Answers its name there; throws for a playlist or owner not there.
 */
function movePlaylist(data, profiles, playlistId, toOwner) {
  const from = playlistOwner(data, profiles, playlistId);
  if (!from) throw new Error('That playlist no longer exists.');
  const target = playlistsOf(data, profiles, toOwner);
  if (!target) throw new Error('That profile no longer exists.');
  const source = playlistsOf(data, profiles, from);
  const playlist = source.find((p) => p.id === playlistId);
  if (playlist.favourites) throw new Error('Favourites always stay with their profile.');
  if (from === toOwner) return playlist.name;
  source.splice(source.indexOf(playlist), 1);
  const name = model.freePlaylistName({ playlists: target }, playlist.name);
  // Under another name there: another row (4.6: the one it was may be locked).
  const moved = name === playlist.name ? playlist : { ...playlist, name };
  target.push(moved);
  const owner = toOwner === DEFAULT_OWNER ? data : profiles[toOwner];
  owner.follows = (owner.follows || []).filter((id) => id !== playlistId);
  prune(data, profiles);
  return moved.name;
}

module.exports = {
  allPlaylists, playlistOwner, movePlaylist, ownerSummary, startStatistics, songsOfOthers, sanitizeProfiles, view, absorb, prune, addProfile, removeProfile, sharedFor, sharedGroupsFor, ensureFavourites, favId, FAV_PREFIX, DEFAULT_OWNER, DEFAULT_NAME,
};
