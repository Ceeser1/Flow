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

function run(lib, profileId, cmd, touched = null) {
  const v = prof.view(lib.data, lib.profiles, profileId);
  const r = applyCommand(v, { at: Date.now(), ...cmd }, touched, profileId);
  prof.absorb(lib.data, lib.profiles, profileId, v);
  return r;
}

test('the first profile takes over the playlists, favourites and stats; the next starts empty', () => {
  const lib = library();
  assert.equal(prof.addProfile(lib.data, lib.profiles, 'anna'), true);
  assert.equal(lib.data.playlists.length, 0);
  assert.equal(lib.data.songs[0].favouriteAt, null);
  assert.equal(lib.data.songs[0].stats.plays, 0);

  const anna = prof.view(lib.data, lib.profiles, 'anna');
  assert.deepEqual(anna.playlists.map((p) => p.name), ['Evening']);
  assert.equal(anna.songs[0].favouriteAt, 5);
  assert.equal(anna.songs[0].stats.plays, 3);
  assert.equal(anna.songs.length, 2, 'All Songs is everyone\'s');

  assert.equal(prof.addProfile(lib.data, lib.profiles, 'ben'), false);
  const ben = prof.view(lib.data, lib.profiles, 'ben');
  assert.equal(ben.playlists.length, 0);
  assert.equal(ben.songs[0].favouriteAt, null);
  assert.equal(ben.songs[0].stats.plays, 0);
  assert.equal(ben.songs[0].addedAt, 100, 'when a song was added is shared');
});

test('playlists, favourites and listens stay with their profile; names are shared', () => {
  const lib = library();
  prof.addProfile(lib.data, lib.profiles, 'anna');
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
  assert.equal(m.songById(lib.data, 's2').stats.plays, 0, 'None heard nothing');

  // Another profile's playlist cannot be reached.
  assert.deepEqual(run(lib, 'anna', { type: 'renamePlaylist', playlistId: 'p2', name: 'Mine' }), { skipped: 'gone' });
});

test('a deleted song is gone for every profile and every playlist', () => {
  const lib = library();
  prof.addProfile(lib.data, lib.profiles, 'anna');
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
  const lib = library();
  prof.addProfile(lib.data, lib.profiles, 'anna');
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

test('None keeps its keys until the first profile takes them over', () => {
  const touched = { 'p:p1:name': 1, 's:s1:fav': 2, 's:s1:meta': 3, 'ben/p:p2:name': 4 };
  prof.moveTouched(touched, 'anna');
  assert.deepEqual(touched, { 'anna/p:p1:name': 1, 'anna/s:s1:fav': 2, 's:s1:meta': 3, 'ben/p:p2:name': 4 });
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
