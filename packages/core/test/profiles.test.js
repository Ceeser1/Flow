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

/** A profile's playlists but its Favourites. */
const lists = (v) => v.playlists.filter((p) => !p.favourites);

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
  assert.deepEqual(lists(anna).map((p) => [p.id, p.name]), [['n1', 'Evening']], 'a copy under a new id');
  assert.deepEqual(lists(anna)[0].entries.map((e) => e.songId), ['s1', 's2']);
  assert.equal(anna.songs[0].favouriteAt, null);
  assert.equal(anna.songs[0].stats.plays, 0);
  assert.equal(anna.songs.length, 2, "All Songs is everyone's");

  // Later profiles copy the default too, and the copies are their own.
  run(lib, 'anna', { type: 'removeFromPlaylist', playlistId: 'n1', songId: 's1' });
  prof.addProfile(lib.data, lib.profiles, 'ben', newId);
  const ben = prof.view(lib.data, lib.profiles, 'ben');
  assert.deepEqual(lists(ben).map((p) => [p.id, p.entries.length]), [['n2', 2]]);
  assert.equal(lists(prof.view(lib.data, lib.profiles, 'anna'))[0].entries.length, 1);
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
  assert.deepEqual(lists(anna).map((p) => p.id), ['p1']);
  assert.deepEqual(lists(ben).map((p) => p.id), ['p2'], 'the same name in another profile is no clash');
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
  assert.deepEqual(lists(lib.profiles.anna)[0].entries.map((e) => e.songId), ['s2']);
  assert.equal(lib.profiles.anna.songs.s1, undefined);
  assert.deepEqual(lists(lib.profiles.ben)[0].entries, []);
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
  assert.equal(lists(seen('anna'))[0].shared, true);
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
  assert.equal(lists(anna)[0].shared, false);

  run(lib, 'anna', { type: 'setPlaylistShared', playlistId: lists(anna)[0].id, shared: true });
  const v = prof.view(lib.data, lib.profiles, null, { anna: 'Anna' });
  assert.equal(v.sharedPlaylists.length, 1);
  applyCommand(v, { at: Date.now(), type: 'followPlaylist', playlistId: v.sharedPlaylists[0].id });
  prof.absorb(lib.data, lib.profiles, null, v);
  assert.deepEqual(lib.data.follows, [v.sharedPlaylists[0].id]);
  assert.equal(lib.data.sharedPlaylists.length, 0, 'what is shared with the Default is not stored in it');
});

test('every playlist with its owner, and a playlist given to another owner', () => {
  const lib = withAnna();
  prof.addProfile(lib.data, lib.profiles, 'ben');
  lib.data.songs.find((s) => s.id === 's1').duration = 330;
  lib.data.songs.find((s) => s.id === 's2').duration = 300;
  run(lib, null, { type: 'createPlaylist', playlistId: 'd1', name: 'Kitchen' });
  run(lib, 'ben', { type: 'createPlaylist', playlistId: 'b1', name: 'Evening' });
  run(lib, 'ben', { type: 'createPlaylist', playlistId: 'b2', name: 'Fresh' });
  run(lib, 'ben', { type: 'setPlaylistRules', playlistId: 'b2', rules: { match: 'all', conditions: [{ field: 'artist', op: 'contains', value: 'Portishead' }] } });
  const rows = () => prof.allPlaylists(lib.data, lib.profiles).map((p) => [p.id, p.name, p.ownerId, p.songs, p.seconds, p.smart]);
  assert.deepEqual(rows(), [
    ['d1', 'Kitchen', 'default', 0, 0, false],
    ['p1', 'Evening', 'anna', 2, 630, false],
    ['b1', 'Evening', 'ben', 0, 0, false],
    ['b2', 'Fresh', 'ben', null, null, true],
  ]);
  assert.equal(prof.playlistOwner(lib.data, lib.profiles, 'p1'), 'anna');
  assert.equal(prof.playlistOwner(lib.data, lib.profiles, 'nothing'), null);

  // Shared and followed by Ben and the Default; Anna has listened to it.
  run(lib, 'anna', { type: 'setPlaylistShared', playlistId: 'p1', shared: true });
  run(lib, 'ben', { type: 'followPlaylist', playlistId: 'p1' });
  run(lib, null, { type: 'followPlaylist', playlistId: 'p1' });
  lib.profiles.anna.playlistListened.p1 = 120;

  // To Ben, who has an Evening already: "Evening (2)", his own now, no longer followed by him.
  assert.equal(prof.movePlaylist(lib.data, lib.profiles, 'p1', 'ben'), 'Evening (2)');
  const ben = prof.view(lib.data, lib.profiles, 'ben');
  const moved = lists(ben).find((p) => p.id === 'p1');
  assert.deepEqual([moved.name, moved.shared, moved.entries.map((e) => e.songId)], ['Evening (2)', true, ['s1', 's2']]);
  assert.deepEqual(lists(ben).map((p) => p.id), ['b1', 'b2', 'p1'], 'at the end');
  assert.deepEqual(ben.follows, []);
  assert.deepEqual(lists(prof.view(lib.data, lib.profiles, 'anna')), []);
  assert.deepEqual(lib.profiles.anna.playlistListened, {}, 'Anna\'s time with it went with it');
  assert.deepEqual(lib.data.follows, ['p1'], 'the Default still follows it');
  assert.deepEqual(prof.view(lib.data, lib.profiles, 'anna', { ben: 'Ben' }).sharedPlaylists.map((p) => [p.id, p.ownerName]), [['p1', 'Ben']]);

  // To the Default, which followed it; a smart one keeps its rules.
  assert.equal(prof.movePlaylist(lib.data, lib.profiles, 'p1', 'default'), 'Evening (2)');
  assert.deepEqual(lib.data.follows, []);
  assert.equal(prof.playlistOwner(lib.data, lib.profiles, 'p1'), 'default');
  prof.movePlaylist(lib.data, lib.profiles, 'b2', 'anna');
  assert.equal(lists(prof.view(lib.data, lib.profiles, 'anna'))[0].rules.conditions[0].value, 'Portishead');
  // To its own owner: nothing changes.
  assert.equal(prof.movePlaylist(lib.data, lib.profiles, 'b2', 'anna'), 'Fresh');
  assert.equal(lists(lib.profiles.anna).length, 1);

  assert.throws(() => prof.movePlaylist(lib.data, lib.profiles, 'nothing', 'ben'), /no longer exists/);
  assert.throws(() => prof.movePlaylist(lib.data, lib.profiles, 'b1', 'carla'), /profile no longer exists/);
});

test('Favourites are a playlist of each owner: made once from the stars, kept in step both ways (4.3)', () => {
  const { data } = library();
  // From before 4.3: Anna's stars in her songs, the Default's in data.songs (s1 at 5).
  const profiles = prof.sanitizeProfiles(data, {
    anna: { playlists: [], songs: { s2: { favouriteAt: 30 }, s1: { favouriteAt: 20, stats: { plays: 1, sessions: 1 } } } },
  });
  assert.equal(prof.ensureFavourites(data, profiles, 1000), true);
  assert.equal(prof.ensureFavourites(data, profiles, 1000), false, 'only once');
  const fav = (owner) => m.favouritesList(owner);
  assert.deepEqual(fav(data).entries.map((e) => [e.songId, e.addedAt]), [['s1', 5]]);
  assert.equal(fav(data).id, 'fav-default');
  assert.deepEqual(fav(profiles.anna).entries.map((e) => [e.songId, e.addedAt]), [['s1', 20], ['s2', 30]], 'in star order');
  assert.equal(fav(profiles.anna).id, 'fav-anna');
  assert.deepEqual(profiles.anna.songs, { s1: { stats: profiles.anna.songs.s1.stats } }, 'the stars left the songs; s2 had nothing else');

  const lib = { data, profiles };
  const anna = () => prof.view(data, profiles, 'anna');
  assert.equal(m.songById(anna(), 's2').favouriteAt, 30, 'a view carries the stars');
  // The star takes it out of the list, adding to the list stars it.
  run(lib, 'anna', { type: 'setFavourite', songId: 's2', on: false });
  assert.deepEqual(fav(profiles.anna).entries.map((e) => e.songId), ['s1']);
  assert.equal(m.songById(anna(), 's2').favouriteAt, null);
  run(lib, 'anna', { type: 'addSongsToPlaylist', playlistId: 'fav-anna', songIds: ['s2'], at: 77 });
  assert.equal(m.songById(anna(), 's2').favouriteAt, 77);
  run(lib, 'anna', { type: 'removeFromPlaylist', playlistId: 'fav-anna', songId: 's1' });
  assert.equal(m.songById(anna(), 's1').favouriteAt, null);
  assert.equal(m.songById(data, 's1').favouriteAt, 5, "the Default's own stay");

  // Never renamed, deleted, ruled or given away; a playlist called Favourites is no clash.
  assert.throws(() => run(lib, 'anna', { type: 'renamePlaylist', playlistId: 'fav-anna', name: 'Mine' }), /cannot be renamed/);
  assert.throws(() => run(lib, 'anna', { type: 'deletePlaylist', playlistId: 'fav-anna' }), /cannot be renamed, deleted/);
  assert.throws(() => run(lib, 'anna', { type: 'setPlaylistRules', playlistId: 'fav-anna', rules: { conditions: [] } }), /rules/);
  assert.deepEqual(run(lib, 'anna', { type: 'createPlaylist', playlistId: 'a1', name: 'Favourites' }), { value: 'a1' });
  assert.throws(() => prof.movePlaylist(data, profiles, 'fav-anna', 'default'), /stay with their profile/);
  assert.deepEqual(prof.allPlaylists(data, profiles).map((p) => p.id), ['p1', 'a1']);

  // Shared, the others see it as Anna's Favourites; a new profile starts with an empty one.
  run(lib, 'anna', { type: 'setPlaylistShared', playlistId: 'fav-anna', shared: true });
  prof.addProfile(data, profiles, 'ben');
  const ben = prof.view(data, profiles, 'ben', { anna: 'Anna' });
  assert.deepEqual(ben.sharedPlaylists.map((p) => [p.id, p.ownerName, !!p.favourites]), [['fav-anna', 'Anna', true]]);
  assert.deepEqual(ben.playlists.map((p) => [p.id, p.entries.length]), [['fav-ben', 0], [ben.playlists[1].id, 2]], "a copy of the Default's lists, not of its Favourites");
  const copy = m.sanitize(JSON.parse(JSON.stringify(ben)));
  assert.equal(copy.playlists[0].favourites, true, 'kept through sanitize');
  assert.equal(copy.sharedPlaylists[0].favourites, true);
});
