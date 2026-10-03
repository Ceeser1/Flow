'use strict';

// The window's library changes (src/client/actions): into Local Files without
// a server, as commands with one; what an app that cannot retag or trim files
// gets.

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/libraryModel');
const { createActions } = require('../src/client/actions');
const { createLocalLibrary } = require('../src/client/localLibrary');

function setup({ active = false, retag = null, trim = null } = {}) {
  const library = createLocalLibrary({ read: () => null, write: () => {} });
  library.quietly = async (fn) => fn();
  const files = new Map();
  const commands = [];
  const view = model.emptyLibrary();
  const remote = {
    active: () => active,
    view: () => view,
    command: (type, args) => {
      commands.push({ type, ...args });
      return null;
    },
    setOffline: async () => {},
    deleteSong: async (songId, deleteFile) => commands.push({ type: 'deleteSong', songId, deleteFile }),
    trimSong: async (songId, span) => commands.push({ type: 'trimSong', songId, ...span }),
    newCutId: () => 'a1b2c3d4e5f6',
    trimmedHere: (songId, t) => commands.push({ type: 'trimmedHere', songId, ...t }),
  };
  const fileOps = {
    exists: (f) => files.has(f),
    rm: (f) => {
      if (files.get(f) === 'busy') throw new Error('EBUSY');
      files.delete(f);
    },
  };
  const actions = createActions({
    remote, library, files: fileOps, retag, trim,
  });
  const addSong = (id, file, state = 'ok') => {
    files.set(file, state);
    library.mutate((d) => model.addSong(d, {
      id, file, title: id, artist: 'Air', mix: '', duration: 200, format: 'mp3', addedAt: 1,
    }));
  };
  return {
    actions, library, files, commands, addSong,
  };
}

test('without a server: Local Files changes, and files deleted with their songs', async () => {
  const {
    actions, library, files, addSong,
  } = setup();
  addSong('s1', '/m/a.mp3');
  addSong('s2', '/m/b.mp3', 'busy');
  const p = actions.createPlaylist('Evening');
  assert.equal(model.playlistById(library.get(), p.id).name, 'Evening');
  actions.renamePlaylist({ id: p.id, name: 'Night' });
  assert.equal(actions.addSongsToPlaylist({ playlistId: p.id, songIds: ['s1', 's2'] }), 2);
  actions.setFavourite({ songId: 's1', on: true });
  assert.ok(model.songById(library.get(), 's1').favouriteAt);
  actions.recordListen({
    songId: 's1', listened: 150, duration: 200, contextId: p.id,
  });
  assert.equal(actions.recordListen({ songId: 'gone', listened: 1, duration: 2 }), null);
  assert.throws(() => actions.setFollowing({ id: p.id, on: true }), /needs a Flow Server/);

  // A favourite is not deleted with a playlist; then the song whose file is in use stays.
  actions.setFavourite({ songId: 's1', on: false });
  assert.deepEqual(await actions.deletePlaylist({ id: p.id, deleteSongs: true }), { deleted: 1, kept: 1 });
  assert.equal(files.has('/m/a.mp3'), false);
  assert.deepEqual(library.get().songs.map((s) => s.id), ['s2']);
  await assert.rejects(actions.deleteSong({ songId: 's2', deleteFile: true }), /could not be deleted/);
  files.set('/m/b.mp3', 'ok');
  await actions.deleteSong({ songId: 's2', deleteFile: true });
  assert.equal(library.get().songs.length, 0);
});

test('without a server and nothing to retag or trim with (Android): names change in the library only, no trim', async () => {
  const { actions, library, addSong } = setup();
  addSong('s1', '/m/a.mp3');
  await actions.editSong({ songId: 's1', artist: ' Moby ', title: 'Porcelain' });
  const s = model.songById(library.get(), 's1');
  assert.equal(s.artist, 'Moby');
  assert.equal(s.file, '/m/a.mp3');
  assert.throws(() => actions.editSong({ songId: 's1', title: ' ' }), /enter a title/);
  assert.throws(() => actions.trimSong({ songId: 's1', start: 1, end: 100 }), /only be trimmed through a Flow Server/);
  assert.throws(() => actions.trimSong({ songId: 's1', start: 1, end: 1.2 }), /too short/);
});

test('without a server, with retag and trim (desktop): the file renamed and cut, the server told of the trim', async () => {
  const { actions, library, commands, addSong } = setup({
    retag: async (song, meta) => ({ file: `/m/${meta.artist} - ${meta.title}.mp3`, written: true }),
    trim: async (song, start, end) => ({ duration: end - start }),
  });
  addSong('s1', '/m/a.mp3');
  await actions.editSong({ songId: 's1', artist: 'Moby', title: 'Porcelain' });
  assert.equal(model.songById(library.get(), 's1').file, '/m/Moby - Porcelain.mp3');
  // The renamed file is where the song now is.
  library.mutate((d) => model.updateSong(d, 's1', { file: '/m/a.mp3' }));
  await actions.trimSong({ songId: 's1', start: 10, end: 110 });
  const s = model.songById(library.get(), 's1');
  assert.equal(s.duration, 100);
  assert.equal(s.cut, 'a1b2c3d4e5f6');
  assert.deepEqual(commands.at(-1), {
    type: 'trimmedHere', songId: 's1', start: 10, end: 110, base: '', cut: 'a1b2c3d4e5f6',
  });
});

test('with a server: every change is a command', async () => {
  const { actions, commands, library } = setup({ active: true });
  actions.renamePlaylist({ id: 'p1', name: 'Night' });
  actions.setFollowing({ id: 'p2', on: true });
  actions.addSongToPlaylists({ songId: 's1', playlistIds: ['p1'] });
  actions.removeFromPlaylist({ playlistId: 'p1', songId: 's1' });
  assert.equal(await actions.deletePlaylist({ id: 'p1', deleteSongs: true }), null);
  await actions.deleteSong({ songId: 's1', deleteFile: false });
  await actions.editSong({ songId: 's1', artist: 'Air', title: 'Alpha Beta Gaga' });
  await actions.trimSong({ songId: 's1', start: 0, end: 30 });
  assert.deepEqual(commands.map((c) => c.type), [
    'renamePlaylist', 'followPlaylist', 'addSongToPlaylists', 'removeFromPlaylist', 'deletePlaylist', 'deleteSong', 'editSong', 'trimSong',
  ]);
  assert.equal(library.get().playlists.length, 0);
});
