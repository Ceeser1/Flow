'use strict';

// Commands sent to a Flow Server: what each does, and last change wins.

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/libraryModel');
const { applyCommand } = require('../src/commands');

function lib() {
  const d = m.emptyLibrary();
  m.addSong(d, { id: 's1', file: '/music/a.mp3', title: 'Around the World', artist: 'Daft Punk', mix: '', duration: 420, addedAt: 1 });
  m.addSong(d, { id: 's2', file: '/music/b.mp3', title: 'Windowlicker', artist: 'Aphex Twin', mix: '', duration: 360, addedAt: 2 });
  m.createPlaylist(d, 'Chill', 'p1', 1);
  return d;
}

test('playlist commands create, rename, fill and delete', () => {
  const d = lib();
  assert.deepEqual(applyCommand(d, { type: 'createPlaylist', playlistId: 'p2', name: 'Night', at: 5 }), { value: 'p2' });
  applyCommand(d, { type: 'addSongsToPlaylist', playlistId: 'p2', songIds: ['s1', 's2', 'nope'], at: 6 });
  assert.deepEqual(m.playlistById(d, 'p2').entries.map((e) => e.songId), ['s1', 's2']);
  applyCommand(d, { type: 'removeFromPlaylist', playlistId: 'p2', songId: 's1', at: 7 });
  applyCommand(d, { type: 'renamePlaylist', playlistId: 'p2', name: 'Late Night', at: 8 });
  assert.equal(m.playlistById(d, 'p2').name, 'Late Night');
  applyCommand(d, { type: 'deletePlaylist', playlistId: 'p2', at: 9 });
  assert.equal(m.playlistById(d, 'p2'), null);
});

test('two apps making the same playlist name while apart both keep theirs', () => {
  const d = lib();
  applyCommand(d, { type: 'createPlaylist', playlistId: 'p9', name: 'chill', at: 5 });
  assert.equal(m.playlistById(d, 'p9').name, 'chill (2)');
  // Sent twice: the second is a no-op.
  assert.deepEqual(applyCommand(d, { type: 'createPlaylist', playlistId: 'p9', name: 'chill', at: 5 }), { skipped: 'exists' });
});

test('last change wins: an older edit is skipped', () => {
  const d = lib();
  const touched = {};
  applyCommand(d, { type: 'editSong', songId: 's1', artist: 'Daft Punk', title: 'One More Time', at: 200 }, touched);
  const r = applyCommand(d, { type: 'editSong', songId: 's1', artist: 'Daft Punk', title: 'Da Funk', at: 100 }, touched);
  assert.deepEqual(r, { skipped: 'stale' });
  assert.equal(m.songById(d, 's1').title, 'One More Time');
  applyCommand(d, { type: 'editSong', songId: 's1', artist: 'Daft Punk', title: 'Digital Love', at: 300 }, touched);
  assert.equal(m.songById(d, 's1').title, 'Digital Love');
});

test('a delete wins over an edit, made before or after it', () => {
  const d = lib();
  const touched = {};
  applyCommand(d, { type: 'editSong', songId: 's1', title: 'Later', at: 500 }, touched);
  applyCommand(d, { type: 'deleteSong', songId: 's1', at: 100 }, touched);
  assert.equal(m.songById(d, 's1'), null);
  assert.deepEqual(applyCommand(d, { type: 'editSong', songId: 's1', title: 'Even later', at: 900 }, touched), { skipped: 'gone' });
  assert.equal(m.playlistById(d, 'p1').entries.length, 0);
});

test('adding to a playlist and taking out again: the later one counts', () => {
  const d = lib();
  const touched = {};
  applyCommand(d, { type: 'addSongToPlaylists', songId: 's2', playlistIds: ['p1'], at: 300 }, touched);
  applyCommand(d, { type: 'removeFromPlaylist', playlistId: 'p1', songId: 's2', at: 200 }, touched);
  assert.deepEqual(m.playlistById(d, 'p1').entries.map((e) => e.songId), ['s2']);
});

test('favourites, loudness and listens', () => {
  const d = lib();
  applyCommand(d, { type: 'setFavourite', songId: 's2', on: true, at: 50 });
  assert.equal(m.songById(d, 's2').favouriteAt, 50);
  applyCommand(d, { type: 'setLoudness', songId: 's2', loudness: -9.5 });
  assert.equal(m.songById(d, 's2').loudness, -9.5);
  assert.deepEqual(applyCommand(d, { type: 'recordListen', songId: 's2', listened: 350, duration: 360, at: 60 }), { value: 'play' });
  assert.equal(m.songById(d, 's2').stats.plays, 1);
});

test('a length the server did not know is filled in, a known one kept', () => {
  const d = lib();
  m.updateSong(d, 's1', { duration: 0 });
  assert.deepEqual(applyCommand(d, { type: 'setDuration', songId: 's1', duration: 421.5 }), {});
  assert.equal(m.songById(d, 's1').duration, 421.5);
  assert.deepEqual(applyCommand(d, { type: 'setDuration', songId: 's1', duration: 10 }), { skipped: 'known' });
  m.updateSong(d, 's2', { duration: 0 });
  applyCommand(d, { type: 'recordListen', songId: 's2', listened: 20, duration: 360 });
  assert.equal(m.songById(d, 's2').duration, 360);
});

test('an upload on its way shows as a song in its playlists', () => {
  const d = lib();
  applyCommand(d, {
    type: 'addSong', playlistIds: ['p1', 'gone'],
    song: { id: 's3', file: 'C:\\Music\\c.mp3', title: 'Teardrop', artist: 'Massive Attack', addedAt: 70 },
  });
  assert.equal(m.songById(d, 's3').title, 'Teardrop');
  assert.deepEqual(m.playlistById(d, 'p1').entries.map((e) => e.songId), ['s3']);
});

test('wrong commands say why', () => {
  const d = lib();
  assert.throws(() => applyCommand(d, { type: 'explode' }), /Unknown command/);
  assert.throws(() => applyCommand(d, { type: 'editSong', songId: 's1', title: ' ' }), /Please enter a title/);
});

test('a playlist deleted with its songs takes only those in no other playlist, and only on the server', () => {
  const d = lib();
  m.addSong(d, { id: 's3', file: '/music/c.mp3', title: 'Teardrop', artist: 'Massive Attack', mix: '', duration: 330, addedAt: 3 });
  m.addSong(d, { id: 's4', file: '/music/d.mp3', title: 'Roads', artist: 'Portishead', mix: '', duration: 300, addedAt: 4 });
  m.addSongsToPlaylist(d, 'p1', ['s1', 's2', 's3', 's4'], 5);
  m.createPlaylist(d, 'Night', 'p2', 6);
  m.addSongsToPlaylist(d, 'p2', ['s2'], 7);
  m.setFavourite(d, 's3', true, 8);
  assert.deepEqual(m.songsOnlyIn(d, 'p1'), ['s1', 's4']);
  assert.deepEqual(m.songsOnlyIn(d, 'p1', new Set(['s4'])), ['s1']);

  // An app's preview: the playlist only, the songs wait for the server.
  const preview = JSON.parse(JSON.stringify(d));
  assert.deepEqual(applyCommand(preview, { type: 'deletePlaylist', playlistId: 'p1', deleteSongs: true, at: 9 }), { value: [] });
  assert.equal(preview.songs.length, 4);

  // The server: another profile still has s4.
  const r = applyCommand(d, { type: 'deletePlaylist', playlistId: 'p1', deleteSongs: true, at: 9 }, {}, null, { keepSongs: () => new Set(['s4']) });
  assert.deepEqual(r.value.map((s) => s.id), ['s1']);
  assert.deepEqual(d.songs.map((s) => s.id), ['s2', 's3', 's4']);
  assert.equal(m.playlistById(d, 'p1'), null);
});
