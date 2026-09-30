'use strict';

// Profiles: shared songs, own playlists, favourites and stats.

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/libraryModel');
const prof = require('../src/profiles');
const { applyCommand } = require('../src/commands');

function library() {
  const data = m.sanitize({
    songs: [
      { id: 's1', file: 'a.mp3', title: 'Teardrop', artist: 'Massive Attack', addedAt: 100, favouriteAt: 5, stats: { plays: 3, sessions: 3, listened: 900 } },
      { id: 's2', file: 'b.mp3', title: 'Glory Box', artist: 'Portishead', addedAt: 200 },
    ],
    playlists: [{ id: 'p1', name: 'Evening', entries: [{ songId: 's1' }, { songId: 's2' }] }],
  });
  return { data, profiles: {} };
}

/** Anna's profile with her own Evening (p1) holding both songs; the default has no playlists. */
function withAnna() {
  const lib = library();
  lib.data.playlists = [];
  prof.addProfile(lib.data, lib.profiles, 'anna');
  run(lib, 'anna', { type: 'createPlaylist', playlistId: 'p1', name: 'Evening' });
  run(lib, 'anna', { type: 'addSongsToPlaylist', playlistId: 'p1', songIds: ['s1', 's2'] });
  return lib;
}

function run(lib, profileId, cmd, touched = null) {
  const v = prof.view(lib.data, lib.profiles, profileId);
  const r = applyCommand(v, { at: Date.now(), ...cmd }, touched, profileId);
  prof.absorb(lib.data, lib.profiles, profileId, v);
  return r;
}

test('a new profile gets a copy of the default playlists; favourites and stats stay with the default', () => {
  const lib = library();
  let n = 0;
  const newId = () => `n${++n}`;
  prof.addProfile(lib.data, lib.profiles, 'anna', newId);
  assert.equal(lib.data.playlists.length, 1, 'the default keeps its playlists');
  assert.equal(lib.data.songs[0].favouriteAt, 5);
  assert.equal(lib.data.songs[0].stats.plays, 3);

  const anna = prof.view(lib.data, lib.profiles, 'anna');
  assert.deepEqual(anna.playlists.map((p) => [p.id, p.name]), [['n1', 'Evening']], 'a copy under a new id');
  assert.deepEqual(anna.playlists[0].entries.map((e) => e.songId), ['s1', 's2']);
  assert.equal(anna.songs[0].favouriteAt, null);
  assert.equal(anna.songs[0].stats.plays, 0);
  assert.equal(anna.songs.length, 2, "All Songs is everyone's");

  // Later profiles copy the default too, and the copies are their own.
  run(lib, 'anna', { type: 'removeFromPlaylist', playlistId: 'n1', songId: 's1' });
  prof.addProfile(lib.data, lib.profiles, 'ben', newId);
  const ben = prof.view(lib.data, lib.profiles, 'ben');
  assert.deepEqual(ben.playlists.map((p) => [p.id, p.entries.length]), [['n2', 2]]);
  assert.equal(prof.view(lib.data, lib.profiles, 'anna').playlists[0].entries.length, 1);
  assert.equal(lib.data.playlists[0].entries.length, 2);
  assert.equal(ben.songs[0].favouriteAt, null);
  assert.equal(ben.songs[0].addedAt, 100, 'when a song was added is shared');
});

test('time listened to a list is per profile, also for a shared one, and goes when unfollowed', () => {
  const lib = withAnna();
  prof.addProfile(lib.data, lib.profiles, 'ben');
  run(lib, 'anna', { type: 'setPlaylistShared', playlistId: 'p1', shared: true });
  run(lib, 'anna', { type: 'recordListen', songId: 's1', listened: 100, duration: 250, contextId: 'p1' });
  // Ben cannot count for it before following it.
  run(lib, 'ben', { type: 'recordListen', songId: 's1', listened: 40, duration: 250, contextId: 'p1' });
  assert.equal(prof.view(lib.data, lib.profiles, 'ben').playlistListened.p1, undefined);
  run(lib, 'ben', { type: 'followPlaylist', playlistId: 'p1' });
  run(lib, 'ben', { type: 'recordListen', songId: 's1', listened: 40, duration: 250, contextId: 'p1' });
  assert.equal(prof.view(lib.data, lib.profiles, 'ben').playlistListened.p1, 40);
  assert.equal(prof.view(lib.data, lib.profiles, 'anna').playlistListened.p1, 100, "Anna's own time is hers");
  // Nothing of it travels with the shared list itself.
  assert.equal(prof.view(lib.data, lib.profiles, 'ben').sharedPlaylists[0].playlistListened, undefined);
  run(lib, 'ben', { type: 'unfollowPlaylist', playlistId: 'p1' });
  assert.equal(prof.view(lib.data, lib.profiles, 'ben').playlistListened.p1, undefined);
  assert.equal(prof.view(lib.data, lib.profiles, 'anna').playlistListened.p1, 100);
});

test('playlists, favourites and listens stay with their profile; names are shared', () => {
  const lib = withAnna();
  prof.addProfile(lib.data, lib.profiles, 'ben');

  run(lib, 'ben', { type: 'createPlaylist', playlistId: 'p2', name: 'Evening' });
  run(lib, 'ben', { type: 'addSongsToPlaylist', playlistId: 'p2', songIds: ['s2'] });
  run(lib, 'ben', { type: 'setFavourite', songId: 's2', on: true });
  run(lib, 'ben', { type: 'recordListen', songId: 's2', listened: 200, duration: 250 });
  run(lib, 'ben', { type: 'editSong', songId: 's2', artist: 'Portishead', title: 'Glory Box', mix: 'Live' });

  const anna = prof.view(lib.data, lib.profiles, 'anna');
  const ben = prof.view(lib.data, lib.profiles, 'ben');
  assert.deepEqual(anna.playlists.map((p) => p.id), ['p1']);
  assert.deepEqual(ben.playlists.map((p) => p.id), ['p2'], 'the same name in another profile is no clash');
  assert.equal(m.songById(anna, 's2').favouriteAt, null);
  assert.ok(m.songById(ben, 's2').favouriteAt);
  assert.equal(m.songById(anna, 's2').stats.plays, 0);
  assert.equal(m.songById(ben, 's2').stats.plays, 1);
  assert.equal(m.songById(anna, 's2').mix, 'Live');
  assert.equal(m.songById(lib.data, 's2').stats.plays, 0, 'the default heard nothing');

  // Another profile's playlist cannot be reached.
  assert.deepEqual(run(lib, 'anna', { type: 'renamePlaylist', playlistId: 'p2', name: 'Mine' }), { skipped: 'gone' });
});

test('a deleted song is gone for every profile and every playlist', () => {
  const lib = withAnna();
  prof.addProfile(lib.data, lib.profiles, 'ben');
  run(lib, 'ben', { type: 'createPlaylist', playlistId: 'p2', name: 'Mine' });
  run(lib, 'ben', { type: 'addSongsToPlaylist', playlistId: 'p2', songIds: ['s1'] });

  run(lib, 'ben', { type: 'deleteSong', songId: 's1' });
  assert.equal(m.songById(lib.data, 's1'), null);
  assert.deepEqual(lib.profiles.anna.playlists[0].entries.map((e) => e.songId), ['s2']);
  assert.equal(lib.profiles.anna.songs.s1, undefined);
  assert.deepEqual(lib.profiles.ben.playlists[0].entries, []);
});

test('last change wins per profile: two profiles favouriting one song do not clash', () => {
  const lib = withAnna();
  prof.addProfile(lib.data, lib.profiles, 'ben');
  const touched = {};
  const t = Date.now();
  run(lib, 'anna', { type: 'setFavourite', songId: 's2', on: true, at: t }, touched);
  // Ben's older change is still his own to make.
  assert.deepEqual(run(lib, 'ben', { type: 'setFavourite', songId: 's2', on: true, at: t - 1000 }, touched), {});
  // Anna's own older change loses.
  assert.deepEqual(run(lib, 'anna', { type: 'setFavourite', songId: 's2', on: false, at: t - 1000 }, touched), { skipped: 'stale' });
  // A song's names are shared: an older rename loses to anyone's newer one.
  run(lib, 'anna', { type: 'editSong', songId: 's2', title: 'Roads', artist: 'Portishead', at: t }, touched);
  assert.deepEqual(run(lib, 'ben', { type: 'editSong', songId: 's2', title: 'Sour Times', artist: 'Portishead', at: t - 1000 }, touched), { skipped: 'stale' });
  assert.deepEqual(Object.keys(touched).sort(), ['anna/s:s2:fav', 'ben/s:s2:fav', 's:s2:meta']);
});

test('profiles read back from a file are repaired', () => {
  const { data } = library();
  const profiles = prof.sanitizeProfiles(data, {
    anna: {
      playlists: [{ id: 'p9', name: 'Kept', entries: [{ songId: 's1' }, { songId: 'nope' }] }],
      songs: { s1: { favouriteAt: 7, stats: { plays: '2' } }, gone: { favouriteAt: 1 }, s2: { stats: {} } },
    },
    'bad id!': { playlists: [] },
  });
  assert.deepEqual(Object.keys(profiles), ['anna']);
  assert.deepEqual(profiles.anna.playlists[0].entries.map((e) => e.songId), ['s1']);
  assert.deepEqual(Object.keys(profiles.anna.songs), ['s1'], 'unknown songs and empty entries are dropped');
  assert.equal(profiles.anna.songs.s1.stats.plays, 2);
  assert.deepEqual(prof.sanitizeProfiles(data, null), {});
});

test('a shared playlist shows up read-only for the others, and can be followed', () => {
  const lib = withAnna();
  prof.addProfile(lib.data, lib.profiles, 'ben');
  const names = { anna: 'Anna', ben: 'Ben' };
  const seen = (id) => prof.view(lib.data, lib.profiles, id, names);

  assert.deepEqual(seen('ben').sharedPlaylists, [], 'nothing is shared yet');
  run(lib, 'anna', { type: 'setPlaylistShared', playlistId: 'p1', shared: true });
  assert.equal(seen('anna').playlists[0].shared, true);
  assert.deepEqual(seen('anna').sharedPlaylists, [], 'you never see your own among the shared ones');
  const shared = seen('ben').sharedPlaylists;
  assert.deepEqual(shared.map((p) => [p.id, p.name, p.ownerId, p.ownerName]), [['p1', 'Evening', 'anna', 'Anna']]);
  assert.deepEqual(shared[0].entries.map((e) => e.songId), ['s1', 's2']);
  assert.deepEqual(seen(null).sharedPlaylists.map((p) => p.id), ['p1'], 'the Default sees it too');

  // Only the owner can change it: for Ben it is not among his playlists.
  assert.deepEqual(run(lib, 'ben', { type: 'renamePlaylist', playlistId: 'p1', name: 'Mine' }), { skipped: 'gone' });
  assert.deepEqual(run(lib, 'ben', { type: 'addSongsToPlaylist', playlistId: 'p1', songIds: ['s1'] }), { skipped: 'gone' });

  // Following is the follower's own list, and the owner cannot follow.
  const follow = (who) => {
    const v = prof.view(lib.data, lib.profiles, who, names);
    const r = applyCommand(v, { at: Date.now(), type: 'followPlaylist', playlistId: 'p1' }, null, who);
    prof.absorb(lib.data, lib.profiles, who, v);
    return r;
  };
  assert.throws(() => follow('anna'), /own playlists/);
  assert.deepEqual(follow('ben'), {});
  assert.deepEqual(seen('ben').follows, ['p1']);
  assert.deepEqual(seen('anna').follows, []);
  assert.deepEqual(seen(null).follows, []);

  // Unshared: the follow waits (nothing is shown), and comes back when shared again.
  run(lib, 'anna', { type: 'setPlaylistShared', playlistId: 'p1', shared: false });
  assert.deepEqual(seen('ben').sharedPlaylists, []);
  assert.deepEqual(seen('ben').follows, ['p1']);
  run(lib, 'anna', { type: 'setPlaylistShared', playlistId: 'p1', shared: true });
  assert.deepEqual(seen('ben').sharedPlaylists.map((p) => p.id), ['p1']);

  // A song removed from the library leaves the shared list; a deleted playlist takes the follows.
  run(lib, 'ben', { type: 'deleteSong', songId: 's1' });
  assert.deepEqual(seen('ben').sharedPlaylists[0].entries.map((e) => e.songId), ['s2']);
  run(lib, 'anna', { type: 'deletePlaylist', playlistId: 'p1' });
  assert.deepEqual(seen('ben').follows, []);

  run(lib, 'ben', { type: 'unfollowPlaylist', playlistId: 'nothing' });
});

test('the Default shares and follows as well, and its changes go back into the library', () => {
  const lib = library();
  prof.addProfile(lib.data, lib.profiles, 'anna');
  run(lib, null, { type: 'setPlaylistShared', playlistId: 'p1', shared: true });
  assert.equal(lib.data.playlists[0].shared, true);
  const anna = prof.view(lib.data, lib.profiles, 'anna', { anna: 'Anna' });
  assert.deepEqual(anna.sharedPlaylists.map((p) => [p.id, p.ownerId, p.ownerName]), [['p1', 'default', 'Default / Shared']]);
  // Her copy is her own and is not shared.
  assert.equal(anna.playlists[0].shared, false);

  run(lib, 'anna', { type: 'setPlaylistShared', playlistId: anna.playlists[0].id, shared: true });
  const v = prof.view(lib.data, lib.profiles, null, { anna: 'Anna' });
  assert.equal(v.sharedPlaylists.length, 1);
  applyCommand(v, { at: Date.now(), type: 'followPlaylist', playlistId: v.sharedPlaylists[0].id });
  prof.absorb(lib.data, lib.profiles, null, v);
  assert.deepEqual(lib.data.follows, [v.sharedPlaylists[0].id]);
  assert.equal(lib.data.sharedPlaylists.length, 0, 'what is shared with the Default is not stored in it');
});
