'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/libraryModel');

function song(id, extra = {}) {
  return {
    id, file: `C:\\Music\\YPlayer\\${id}.mp3`, title: 'T' + id, artist: 'A', mix: '',
    duration: 100, format: 'mp3', sourceUrl: '', sourceKey: '', addedAt: 1, ...extra,
  };
}

function lib() {
  const data = m.emptyLibrary();
  m.addSong(data, song('s1', { sourceKey: 'youtube:abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }));
  m.addSong(data, song('s2', { sourceUrl: 'https://soundcloud.com/artist/track?si=123' }));
  return data;
}

test('playlist names: required, unique ignoring case, All Songs reserved', () => {
  const data = lib();
  m.createPlaylist(data, '  Gym  ', 'p1');
  assert.equal(data.playlists[0].name, 'Gym');
  assert.throws(() => m.createPlaylist(data, 'gym', 'p2'), /already exists/);
  assert.throws(() => m.createPlaylist(data, 'all songs', 'p2'), /taken/);
  assert.throws(() => m.createPlaylist(data, '   ', 'p2'), /enter a name/);
});

test('rename keeps its own name allowed, refuses a clash', () => {
  const data = lib();
  m.createPlaylist(data, 'Gym', 'p1');
  m.createPlaylist(data, 'Chill', 'p2');
  m.renamePlaylist(data, 'p1', 'GYM');
  assert.equal(m.playlistById(data, 'p1').name, 'GYM');
  assert.throws(() => m.renamePlaylist(data, 'p1', 'chill'), /already exists/);
  assert.throws(() => m.renamePlaylist(data, m.ALL_SONGS_ID, 'x'), /cannot be changed/);
});

test('adding to playlists skips lists that already hold the song', () => {
  const data = lib();
  m.createPlaylist(data, 'Gym', 'p1');
  m.createPlaylist(data, 'Chill', 'p2');
  assert.equal(m.addSongToPlaylists(data, 's1', ['p1'], 10), 1);
  assert.equal(m.addSongToPlaylists(data, 's1', ['p1', 'p2'], 20), 1);
  assert.deepEqual(m.playlistById(data, 'p1').entries, [{ songId: 's1', addedAt: 10 }]);
  assert.deepEqual(m.playlistById(data, 'p2').entries, [{ songId: 's1', addedAt: 20 }]);
});

test('removing a song removes it from every playlist', () => {
  const data = lib();
  m.createPlaylist(data, 'Gym', 'p1');
  m.addSongsToPlaylist(data, 'p1', ['s1', 's2']);
  m.removeSong(data, 's1', false);
  assert.equal(data.songs.length, 1);
  assert.deepEqual(m.playlistById(data, 'p1').entries.map((e) => e.songId), ['s2']);
  assert.deepEqual(data.ignoredFiles, []);
});

test('removing a song but keeping its file ignores that file', () => {
  const data = lib();
  m.removeSong(data, 's2', true);
  assert.deepEqual(data.ignoredFiles, ['c:\\music\\yplayer\\s2.mp3']);
  m.addSong(data, song('s2'));
  assert.deepEqual(data.ignoredFiles, []);
});

test('duplicates by source key or by link', () => {
  const data = lib();
  assert.equal(m.findBySource(data, { key: 'youtube:abcdefghijk' }).id, 's1');
  assert.equal(m.findBySource(data, { url: 'youtu.be/abcdefghijk?t=30' }).id, 's1');
  assert.equal(m.findBySource(data, { url: 'https://www.soundcloud.com/artist/track/' }).id, 's2');
  assert.equal(m.findBySource(data, { url: 'https://soundcloud.com/artist/other' }), null);
});

test('duplicates by artist, title and mix ignoring case', () => {
  const data = lib();
  assert.equal(m.findByMeta(data, { artist: 'a', title: 'ts1', mix: '' }).id, 's1');
  assert.equal(m.findByMeta(data, { artist: 'a', title: 'ts1', mix: 'Remix' }), null);
  assert.equal(m.findByMeta(data, { artist: 'a', title: 'ts1', mix: '' }, 's1'), null);
});

test('sanitize drops broken entries and duplicate songs in a list', () => {
  const data = m.sanitize({
    songs: [song('s1'), song('s1'), { id: 'x' }],
    playlists: [
      { id: 'p1', name: 'P', entries: [{ songId: 's1' }, { songId: 's1' }, { songId: 'gone' }] },
      { id: 'all', name: 'fake' },
    ],
  });
  assert.equal(data.songs.length, 1);
  assert.equal(data.playlists.length, 1);
  assert.equal(data.playlists[0].entries.length, 1);
});

test('favourites: set once with the time, cleared, and kept through sanitize', () => {
  const data = lib();
  assert.equal(m.songById(data, 's1').favouriteAt, null);
  m.setFavourite(data, 's1', true, 500);
  m.setFavourite(data, 's1', true, 900);
  assert.equal(m.songById(data, 's1').favouriteAt, 500);
  assert.equal(m.sanitize(JSON.parse(JSON.stringify(data))).songs[0].favouriteAt, 500);
  m.setFavourite(data, 's1', false);
  assert.equal(m.songById(data, 's1').favouriteAt, null);
  assert.throws(() => m.setFavourite(data, 'nope', true), /no longer exists|not found|exist/i);
});

test('a song keeps the playlist it was imported with; others have none', () => {
  const data = lib();
  m.addSong(data, song('s3', { sourcePlaylistUrl: 'https://www.youtube.com/playlist?list=PL1' }));
  const again = m.sanitize(JSON.parse(JSON.stringify(data)));
  assert.equal(m.songById(again, 's1').sourcePlaylistUrl, '');
  assert.equal(m.songById(again, 's3').sourcePlaylistUrl, 'https://www.youtube.com/playlist?list=PL1');
});
