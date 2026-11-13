'use strict';

// Locked rows (4.6): a song or playlist that was saved or sent is locked, and
// every change is made to a copy put in its place (libraryModel.js
// songToChange, listToChange). Here every command and every other change of
// the model runs on a library whose rows are locked and on one whose rows
// are not: both must end the same, no locked row may be written to (that
// throws), and a row nothing changed in must stay the row it was.

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/libraryModel');
const prof = require('../src/profiles');
const { lock } = require('../src/libraryPatch');
const { applyCommand, COMMAND_TYPES } = require('../src/commands');

const T = 1700000000000;
const text = (v) => JSON.stringify(v);
const copy = (v) => JSON.parse(text(v));

function library() {
  const song = (n, extra = {}) => ({
    id: `s${n}`, file: `/music/Song ${n}.mp3`, title: `Song ${n}`, artist: `Artist ${n % 3}`, duration: 200, format: 'mp3', addedAt: T + n, sourceKey: `k${n}`, ...extra,
  });
  return model.sanitize({
    songs: [song(1, { favouriteAt: T + 50 }), song(2), song(3), song(4, { album: 'Album', infoLooked: true }), song(5), song(6), song(7, { duration: 0 }), song(8, { cover: 'abcd1234', tagged: 'abcd1234' })],
    groups: [{ id: 'g1', name: 'Moods', createdAt: T }, { id: 'g2', name: 'Shared ones', createdAt: T, shared: true, followed: ['sh1'] }],
    playlists: [
      { id: 'fav-default', name: 'Favourites', createdAt: T, favourites: true, entries: [{ songId: 's1', addedAt: T + 50 }] },
      { id: 'p1', name: 'Rock', createdAt: T, groups: ['g1'], entries: [{ songId: 's1', addedAt: T }, { songId: 's2', addedAt: T }, { songId: 's3', addedAt: T }] },
      { id: 'p2', name: 'Jazz', createdAt: T, entries: [{ songId: 's3', addedAt: T }, { songId: 's4', addedAt: T }] },
      { id: 'p3', name: 'Smart', createdAt: T, rules: { match: 'all', conditions: [{ field: 'artist', op: 'contains', value: 'Artist' }], sort: 'added', limit: 0 } },
      { id: 'p4', name: 'Empty', createdAt: T, entries: [] },
      { id: 'p5', name: 'Lone', createdAt: T, groups: ['g1'], entries: [{ songId: 's8', addedAt: T }] },
    ],
    follows: ['sh1'],
    sharedPlaylists: [
      { id: 'sh1', name: 'Theirs', createdAt: T, ownerId: 'x', ownerName: 'X', entries: [{ songId: 's5', addedAt: T }] },
      { id: 'sh2', name: 'Theirs too', createdAt: T, ownerId: 'x', ownerName: 'X', entries: [{ songId: 's6', addedAt: T }] },
    ],
    sharedGroups: [{ id: 'sg1', name: 'Their group', createdAt: T, ownerId: 'x', ownerName: 'X', playlists: ['sh2'] }],
  });
}

const ROWS = ['songs', 'playlists', 'sharedPlaylists'];
/** Every row locked, as after a save. */
function lockRows(d) {
  for (const k of ROWS) for (const row of d[k] || []) lock(row);
  return d;
}
const rowsOf = (d) => ROWS.flatMap((k) => (d[k] || []).map((row) => [k, row]));

/**
 * Runs `change` on a library with free rows and on one with locked rows
 * (locked again after each step, as after a save): the same result, the
 * same library, the locked rows as they were, and every row that reads the
 * same after as before is the row it was.
 */
function bothWays(steps, name) {
  const free = library();
  const locked = lockRows(library());
  steps.forEach((change, n) => {
    const before = rowsOf(locked).map(([k, row]) => [k, row, text(row)]);
    let a;
    let b;
    let failedA = null;
    let failedB = null;
    try {
      a = change(free);
    } catch (err) {
      failedA = err.message;
    }
    try {
      b = change(locked);
    } catch (err) {
      failedB = err.message;
    }
    assert.equal(failedB, failedA, `${name} #${n}: fails the same way`);
    assert.equal(text(b), text(a), `${name} #${n}: the same result`);
    assert.deepEqual(copy(locked), copy(free), `${name} #${n}: the same library`);
    const now = new Map(rowsOf(locked).map(([k, row]) => [`${k}/${row.id}`, row]));
    for (const [k, row, was] of before) {
      assert.equal(text(row), was, `${name} #${n}: the locked ${k} row ${row.id} was left as it was`);
      const after = now.get(`${k}/${row.id}`);
      if (after && text(after) === was) assert.equal(after, row, `${name} #${n}: ${k} row ${row.id} did not change and is the row it was`);
    }
    lockRows(locked);
  });
  return { free, locked };
}

const cmd = (type, args) => (d) => {
  const r = applyCommand(d, { type, at: T + 1000, ...args }, null, null, { keepSongs: () => new Set(['s8']) });
  // A row handed back is told by what is in it.
  return r;
};

const COMMANDS = {
  createPlaylist: [cmd('createPlaylist', { playlistId: 'np', name: 'New', source: { url: 'https://example.com/list', kind: 'playlist' } }), cmd('createPlaylist', { playlistId: 'np2', name: 'Ruled', rules: { match: 'any', conditions: [{ field: 'plays', op: 'gt', value: 2 }] } })],
  renamePlaylist: [cmd('renamePlaylist', { playlistId: 'p1', name: 'Hard Rock' }), cmd('renamePlaylist', { playlistId: 'p1', name: 'Hard Rock' }), cmd('renamePlaylist', { playlistId: 'p2', name: 'Hard Rock' })],
  createGroup: [cmd('createGroup', { groupId: 'g3', name: 'Third' })],
  renameGroup: [cmd('renameGroup', { groupId: 'g1', name: 'Feelings' })],
  deleteGroup: [cmd('deleteGroup', { groupId: 'g1' })],
  setPlaylistGroup: [cmd('setPlaylistGroup', { playlistId: 'p2', groupId: 'g2' }), cmd('setPlaylistGroup', { playlistId: 'p1', groupId: '' }), cmd('setPlaylistGroup', { playlistId: 'p4', groupId: '' }), cmd('setPlaylistGroup', { playlistId: 'sh1', groupId: 'g1' })],
  setGroupShared: [cmd('setGroupShared', { groupId: 'g1', shared: true }), cmd('setGroupShared', { groupId: 'g1', shared: true }), cmd('setGroupShared', { groupId: 'g1', shared: false })],
  followGroup: [cmd('followGroup', { groupId: 'sg1' })],
  setGroupPlaylistFollowed: [cmd('followGroup', { groupId: 'sg1' }), cmd('setGroupPlaylistFollowed', { groupId: 'sg1', playlistId: 'sh2', on: false }), cmd('setGroupPlaylistFollowed', { groupId: 'sg1', playlistId: 'sh2', on: true })],
  unfollowGroup: [cmd('followGroup', { groupId: 'sg1' }), cmd('unfollowGroup', { groupId: 'sg1' })],
  addPlaylistToGroup: [cmd('addPlaylistToGroup', { playlistId: 'p4', groupId: 'g2' }), cmd('addPlaylistToGroup', { playlistId: 'p4', groupId: 'g2' }), cmd('addPlaylistToGroup', { playlistId: 'p1', groupId: 'g2' }), cmd('addPlaylistToGroup', { playlistId: 'sh1', groupId: 'g1' })],
  removePlaylistFromGroup: [cmd('removePlaylistFromGroup', { playlistId: 'p1', groupId: 'g1' }), cmd('removePlaylistFromGroup', { playlistId: 'p4', groupId: 'g1' }), cmd('removePlaylistFromGroup', { playlistId: 'sh1', groupId: 'g2' })],
  setPlaylistShared: [cmd('setPlaylistShared', { playlistId: 'p2', shared: true }), cmd('setPlaylistShared', { playlistId: 'p2', shared: true }), cmd('setPlaylistShared', { playlistId: 'p2', shared: false }), cmd('setPlaylistShared', { playlistId: 'p3', shared: true })],
  followPlaylist: [cmd('followPlaylist', { playlistId: 'sh2' })],
  unfollowPlaylist: [cmd('unfollowPlaylist', { playlistId: 'sh1' })],
  deletePlaylist: [cmd('deletePlaylist', { playlistId: 'p4' }), cmd('deletePlaylist', { playlistId: 'p5', deleteSongs: true }), cmd('deletePlaylist', { playlistId: 'p2', deleteSongs: true }), cmd('deletePlaylist', { playlistId: 'fav-default' })],
  setPlaylistSource: [cmd('setPlaylistSource', { playlistId: 'p2', source: { url: 'https://example.com/a', kind: 'playlist' } }), cmd('setPlaylistSource', { playlistId: 'p2', source: { url: 'https://example.com/b', kind: 'playlist' } })],
  setPlaylistRules: [cmd('setPlaylistRules', { playlistId: 'p2', rules: { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'a' }] } }), cmd('setPlaylistRules', { playlistId: 'p2', rules: null })],
  addSongToPlaylists: [cmd('addSongToPlaylists', { songId: 's5', playlistIds: ['p1', 'fav-default', 'p3', 'p2'] }), cmd('addSongToPlaylists', { songId: 's5', playlistIds: ['p1'] })],
  addSongsToPlaylist: [cmd('addSongsToPlaylist', { playlistId: 'p1', songIds: ['s6', 's7', 's1'] }), cmd('addSongsToPlaylist', { playlistId: 'fav-default', songIds: ['s2', 's3'] }), cmd('addSongsToPlaylist', { playlistId: 'p3', songIds: ['s2'] }), cmd('addSongsToPlaylist', { playlistId: 'p1', songIds: ['s6'] })],
  removeFromPlaylist: [cmd('removeFromPlaylist', { playlistId: 'p1', songId: 's2' }), cmd('removeFromPlaylist', { playlistId: 'p1', songId: 's2' }), cmd('removeFromPlaylist', { playlistId: 'fav-default', songId: 's1' })],
  deleteSong: [cmd('deleteSong', { songId: 's3' }), cmd('deleteSong', { songId: 's1' }), cmd('deleteSong', { songId: 's3' })],
  editSong: [cmd('editSong', { songId: 's4', artist: 'Someone', title: 'Renamed', mix: 'Live' }), cmd('editSong', { songId: 's2', artist: 'A', title: 'B', mix: '', album: '', genre: 'Rock', subGenre: 'Melodic' }), cmd('editSong', { songId: 's2', artist: 'A', title: ' ', mix: '' })],
  setFavourite: [cmd('setFavourite', { songId: 's2', on: true }), cmd('setFavourite', { songId: 's2', on: true }), cmd('setFavourite', { songId: 's1', on: false }), cmd('setFavourite', { songId: 's5', on: false })],
  setLoudness: [cmd('setLoudness', { songId: 's4', loudness: -13.5 })],
  setDuration: [cmd('setDuration', { songId: 's7', duration: 187 }), cmd('setDuration', { songId: 's1', duration: 9 })],
  recordListen: [cmd('recordListen', { songId: 's1', listened: 190, duration: 200, contextId: 'p1', tz: -60 }), cmd('recordListen', { songId: 's1', listened: 3, duration: 200 }), cmd('recordListen', { songId: 's7', listened: 40, duration: 120, contextId: 'all' }), cmd('recordListen', { songId: 's5', listened: 12, duration: 200, contextId: 'sh1' })],
  recordAwayListen: [cmd('recordAwayListen', { listened: 100, duration: 200, tz: 0 })],
  trimSong: [cmd('trimSong', { songId: 's4', start: 2, end: 150, cut: 'abcdef12' }), cmd('trimSong', { songId: 's4', start: 2, end: 150, cut: 'abcdef12' })],
  addSong: [cmd('addSong', { song: { id: 's9', file: '/music/Nine.mp3', title: 'Nine', artist: 'A', duration: 100, addedAt: T + 9, favouriteAt: T + 99 }, playlistIds: ['p1', 'nope'] }), cmd('addSong', { song: { id: 's9', file: '/music/Nine.mp3', title: 'Nine' } })],
};

test('every command has a run on locked rows here', () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), COMMAND_TYPES.slice().sort());
});

for (const [type, steps] of Object.entries(COMMANDS)) {
  test(`${type}: the same on locked rows as on free ones, only the rows it changes put anew`, () => {
    bothWays(steps, type);
  });
}

test('all the commands one after another on the same library', () => {
  const { locked } = bothWays(Object.values(COMMANDS).flat(), 'all');
  assert.ok(locked.songs.length > 0 && locked.playlists.length > 0);
});

test('the model\'s other changes (covers, tags, info, files, the info round, a song gone with its file kept) on locked rows', () => {
  bothWays([
    (d) => model.setCover(d, 's2', 'ffff0000').cover,
    (d) => model.setCover(d, 's2', 'ffff0000').cover,
    (d) => model.setCover(d, 's8', null).cover,
    (d) => model.setTagged(d, 's2', '').tagged,
    (d) => model.setTagged(d, 's2', 'ffff0000').tagged,
    (d) => model.setTagged(d, 's8', 'abcd1234').tagged,
    (d) => model.setInfo(d, 's3', { album: 'Found', genre: 'Pop', subGenre: 'Synth' }).album,
    (d) => model.setInfo(d, 's4', { album: 'Other' }).album,
    (d) => model.updateSong(d, 's5', { file: '/music/Moved.mp3', format: 'mp3', duration: 99 }).file,
    (d) => {
      d.infoRound = 0;
      return model.startInfoRound(d);
    },
    (d) => model.startInfoRound(d),
    (d) => model.removeSong(d, 's2', true).id,
    (d) => model.addSong(d, { id: 'n1', file: '/music/N1.mp3', title: 'N1', artist: 'A', duration: 5, addedAt: T, favouriteAt: T + 7 }).id,
    (d) => model.addSongToPlaylists(d, 'n1', ['p1', 'p2']),
    (d) => model.setFavourite(d, 'n1', false).favouriteAt,
    (d) => model.createPlaylist(d, 'Made', 'made', T).id,
    (d) => model.addSongsToPlaylist(d, 'made', ['s1', 's3']),
    (d) => model.deletePlaylist(d, 'made'),
  ], 'model');
});

test('a row handed to addSong locked is copied, and the one handed over stays as it was', () => {
  const d = lockRows(library());
  const given = lock({ id: 'x1', file: '/music/X.mp3', title: 'X', artist: 'A', duration: 5, addedAt: T });
  const added = model.addSong(d, given);
  assert.notEqual(added, given);
  assert.equal(d.songs[d.songs.length - 1], added);
  assert.equal(given.stats, undefined);
  assert.deepEqual(added.stats, model.emptyStats());
});

test('songToChange and listToChange: the row itself while it is free, a copy in its place when it is locked', () => {
  const d = library();
  const s = d.songs[1];
  assert.equal(model.songToChange(d, 's2'), s, 'free: the row itself');
  lockRows(d);
  const w = model.songToChange(d, 's2');
  assert.notEqual(w, s);
  assert.equal(d.songs[1], w, 'in its place');
  assert.deepEqual(w, s);
  assert.equal(w.stats, s.stats, 'what is inside is replaced by whoever changes it, not copied');
  assert.equal(model.songToChange(d, 's2'), w, 'free now: the same again');
  assert.throws(() => model.songToChange(d, 'nope'), /no longer exists/);
  const p = d.playlists[1];
  const pw = model.listToChange(d, p);
  assert.notEqual(pw, p);
  assert.equal(d.playlists[1], pw);
  assert.notEqual(pw.entries, p.entries, 'its entries are a list of its own');
  assert.equal(pw.entries[0], p.entries[0], 'holding the same entries');
  pw.entries.push({ songId: 's5', addedAt: T });
  assert.equal(p.entries.length, 3);
  assert.throws(() => model.listToChange(d, d.sharedPlaylists[0]), /library's own/);
});

// ---- profiles: a command of a profile runs on its view and is put back (profiles.js) ----

/** absorb() as it was before 4.6 (every shared song and own entry made anew): what the new one must equal. */
function absorbAsBefore(data, profiles, profileId, v) {
  const OWN = ['stats', 'favouriteAt'];
  const hasOwn = (entry) => {
    const st = entry.stats || {};
    return !!(entry.favouriteAt || st.sessions || st.plays || st.stops || st.skips || st.listened || st.lastPlayedAt);
  };
  const byId = new Map(data.songs.map((s) => [s.id, s]));
  const songs = [];
  const own = {};
  for (const vs of v.songs) {
    const shared = { ...(byId.get(vs.id) || {}) };
    for (const [key, value] of Object.entries(vs)) if (!OWN.includes(key)) shared[key] = value;
    if (!byId.has(vs.id)) {
      shared.stats = model.emptyStats();
      shared.favouriteAt = null;
    }
    songs.push(shared);
    const mine = { stats: vs.stats };
    if (hasOwn(mine)) own[vs.id] = mine;
  }
  data.songs = songs;
  data.ignoredFiles = v.ignoredFiles;
  profiles[profileId] = {
    playlists: v.playlists, groups: v.groups || [], songs: own, follows: v.follows, groupFollows: v.groupFollows || [], groupSkips: v.groupSkips || {}, playlistListened: v.playlistListened || {}, listening: v.listening, statistics: v.statistics,
  };
  prof.prune(data, profiles);
}

function server() {
  const data = library();
  const profiles = {};
  let n = 0;
  prof.addProfile(data, profiles, 'anna', () => `id${(n += 1)}`, T);
  prof.addProfile(data, profiles, 'ben', () => `id${(n += 1)}`, T);
  prof.ensureFavourites(data, profiles, T);
  return { data, profiles };
}

/** Every row of the server's library locked, as after a save. */
function lockServer({ data, profiles }) {
  for (const row of data.songs) lock(row);
  for (const row of data.playlists) lock(row);
  for (const p of Object.values(profiles)) {
    for (const row of p.playlists) lock(row);
    // The map of its own stats is kept itself too: locked with what is in it.
    lock(p.songs);
  }
}

test('a profile\'s commands on a server with locked rows: as before 4.6, and only the rows they change are other rows', () => {
  const names = { default: 'Default / Shared', anna: 'Anna', ben: 'Ben' };
  const now = server();
  const then = server();
  lockServer(now);
  const annaLists = now.profiles.anna.playlists.map((p) => p.id);
  const rock = annaLists[1];
  const runs = [
    ['anna', [{ type: 'recordListen', songId: 's1', listened: 190, duration: 200, contextId: rock, tz: -60 }]],
    ['anna', [{ type: 'setFavourite', songId: 's2', on: true }]],
    ['ben', [{ type: 'recordListen', songId: 's1', listened: 20, duration: 200 }, { type: 'recordListen', songId: 's4', listened: 200, duration: 200 }]],
    ['anna', [{ type: 'editSong', songId: 's4', artist: 'Someone', title: 'Renamed', mix: '' }]],
    ['anna', [{ type: 'addSongsToPlaylist', playlistId: rock, songIds: ['s5', 's6'] }]],
    [null, [{ type: 'setFavourite', songId: 's3', on: true }, { type: 'recordListen', songId: 's3', listened: 100, duration: 200 }]],
    ['ben', [{ type: 'deleteSong', songId: 's2' }]],
    ['anna', [{ type: 'createPlaylist', playlistId: 'mine', name: 'Mine' }, { type: 'addSongToPlaylists', songId: 's8', playlistIds: ['mine'] }]],
    ['anna', [{ type: 'recordListen', songId: 's1', listened: 2, duration: 200 }]],
    [null, [{ type: 'deleteSong', songId: 's8' }]],
    ['anna', [{ type: 'setPlaylistShared', playlistId: 'mine', shared: true }]],
    ['ben', [{ type: 'followPlaylist', playlistId: 'mine' }]],
  ];
  runs.forEach(([who, commands], n) => {
    const songsBefore = new Map(now.data.songs.map((s) => [s.id, [s, text(s)]]));
    const ownBefore = Object.fromEntries(Object.entries(now.profiles).map(([id, p]) => [id, new Map(Object.entries(p.songs).map(([sid, e]) => [sid, [e, text(e)]]))]));
    const listsBefore = new Map([...now.data.playlists, ...Object.values(now.profiles).flatMap((p) => p.playlists)].map((p) => [p.id, [p, text(p)]]));
    const ownMaps = Object.fromEntries(Object.entries(now.profiles).map(([id, p]) => [id, p.songs]));
    const ownText = Object.fromEntries(Object.entries(now.profiles).map(([id, p]) => [id, text(p.songs)]));
    for (const [lib, absorb] of [[now, prof.absorb], [then, absorbAsBefore]]) {
      const v = prof.view(lib.data, lib.profiles, who, names);
      for (const c of commands) applyCommand(v, { at: T + 2000 + n, ...c }, null, who, { keepSongs: () => new Set() });
      if (who) absorb(lib.data, lib.profiles, who, v);
      else prof.absorb(lib.data, lib.profiles, who, v);
      prof.prune(lib.data, lib.profiles);
    }
    assert.deepEqual(copy(now.data), copy(then.data), `run ${n}: the shared library as before 4.6`);
    assert.deepEqual(copy(now.profiles), copy(then.profiles), `run ${n}: the profiles as before 4.6`);
    // prune() looked through the playlists only if a song left: pruned from nothing (a copy it has
    // never seen, so all of it is looked through), the library must come out the same.
    const again = copy({ data: now.data, profiles: now.profiles });
    prof.prune(again.data, again.profiles);
    assert.deepEqual(again, copy({ data: now.data, profiles: now.profiles }), `run ${n}: nothing left for a full prune to take out`);
    // A profile whose stats did not change keeps the map of them.
    for (const [id, p] of Object.entries(now.profiles)) {
      if (JSON.stringify(p.songs) === ownText[id]) assert.equal(p.songs, ownMaps[id], `run ${n}: ${id}'s own stats did not change and are the map they were`);
    }
    // What reads the same as before the run is the row it was.
    for (const s of now.data.songs) {
      const [was, t] = songsBefore.get(s.id) || [];
      if (was && text(s) === t) assert.equal(s, was, `run ${n}: song ${s.id} did not change and is the row it was`);
    }
    for (const [id, p] of Object.entries(now.profiles)) {
      for (const [sid, e] of Object.entries(p.songs)) {
        const [was, t] = ownBefore[id].get(sid) || [];
        if (was && text(e) === t) assert.equal(e, was, `run ${n}: ${id}'s own entry of ${sid} did not change and is the one it was`);
      }
    }
    for (const p of [...now.data.playlists, ...Object.values(now.profiles).flatMap((x) => x.playlists)]) {
      const [was, t] = listsBefore.get(p.id) || [];
      if (was && text(p) === t) assert.equal(p, was, `run ${n}: playlist ${p.id} did not change and is the row it was`);
    }
    lockServer(now);
  });
});

test('the Default\'s view on locked rows: stars are written only where they differ', () => {
  const s = server();
  lockServer(s);
  const rows = s.data.songs.slice();
  const v = prof.view(s.data, s.profiles, null, {});
  assert.equal(v.songs, s.data.songs);
  assert.ok(s.data.songs.every((row, i) => row === rows[i]), 'nothing to set: every row the one it was');
  // A star gone from the Favourites list, set right by the next view.
  const fav = model.favouritesList(s.data);
  model.listToChange(s.data, fav).entries = [];
  prof.view(s.data, s.profiles, null, {});
  assert.equal(s.data.songs[0].favouriteAt, null);
  assert.notEqual(s.data.songs[0], rows[0]);
  assert.ok(s.data.songs.slice(1).every((row, i) => row === rows[i + 1]));
});
