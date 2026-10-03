'use strict';

// What the window changes in the library: a playlist made, a song renamed, a
// listen counted. Each goes to the Local Files library, or with a Flow Server
// to the server as a command (remote.js). Shared by the Flow apps: each takes
// the same argument as its window.flow call. No Node.
//
// From the app: remote, library (Local Files), files (exists, rm), and what
// it can do to a song's file: retag(song, meta) -> { file, written } (its
// names into the file and the file renamed), trim(song, start, end) ->
// { duration } (the file cut, the uncut one kept aside). An app that cannot
// leaves them out: the names then change in the library only, and a Local
// Files song cannot be trimmed.

const model = require('../libraryModel');

function createActions({
  remote, library, files, retag = null, trim = null,
}) {
  /** The library the window works with: the server's, or Local Files. */
  function currentLibrary() {
    return remote.active() ? remote.view() : library.get();
  }

  function change(localFn, type, args) {
    if (remote.active()) return remote.command(type, args);
    return library.mutate(localFn);
  }

  function createPlaylist(name) {
    if (!remote.active()) return library.mutate((d) => model.createPlaylist(d, name, library.newId()));
    const clean = model.checkPlaylistName(remote.view(), name);
    const id = library.newId();
    remote.command('createPlaylist', { playlistId: id, name: clean });
    return model.playlistById(remote.view(), id);
  }

  function renamePlaylist({ id, name }) {
    return change((d) => model.renamePlaylist(d, id, name), 'renamePlaylist', { playlistId: id, name });
  }

  // deleteSongs: the songs in no other playlist go too. With a server it decides
  // which (another profile may have them); here a file that cannot be deleted
  // (playing, open elsewhere) keeps its song. Resolves { deleted, kept }, null
  // for a server.
  function deletePlaylist({ id, deleteSongs }) {
    if (remote.active()) {
      remote.setOffline(id, false).catch(() => {});
      remote.command('deletePlaylist', { playlistId: id, deleteSongs: !!deleteSongs });
      return null;
    }
    return library.quietly(() => {
      const gone = [];
      let kept = 0;
      for (const sid of deleteSongs ? model.songsOnlyIn(library.get(), id) : []) {
        const song = model.songById(library.get(), sid);
        try {
          if (song.file && files.exists(song.file)) files.rm(song.file);
          gone.push(sid);
        } catch {
          kept += 1;
        }
      }
      library.mutate((d) => {
        model.deletePlaylist(d, id);
        for (const sid of gone) if (model.songById(d, sid)) model.removeSong(d, sid, false);
      });
      return { deleted: gone.length, kept };
    });
  }

  // Sharing a playlist with the server's other profiles, and following one they share.
  function setPlaylistShared({ id, shared }) {
    return change((d) => model.setPlaylistShared(d, id, !!shared), 'setPlaylistShared', { playlistId: id, shared: !!shared });
  }

  function setFollowing({ id, on }) {
    if (!remote.active()) throw new Error('Following playlists needs a Flow Server.');
    const result = remote.command(on ? 'followPlaylist' : 'unfollowPlaylist', { playlistId: id });
    // Unfollowed: its downloaded songs go too, unless another downloaded
    // playlist (or All Songs) still holds them.
    if (!on) remote.setOffline(id, false).catch(() => {});
    return result;
  }

  function addSongToPlaylists({ songId, playlistIds }) {
    return change((d) => model.addSongToPlaylists(d, songId, playlistIds), 'addSongToPlaylists', { songId, playlistIds });
  }

  function addSongsToPlaylist({ playlistId, songIds }) {
    return change((d) => model.addSongsToPlaylist(d, playlistId, songIds), 'addSongsToPlaylist', { playlistId, songIds });
  }

  function removeFromPlaylist({ playlistId, songId }) {
    return change((d) => model.removeFromPlaylist(d, playlistId, songId), 'removeFromPlaylist', { playlistId, songId });
  }

  function deleteSong({ songId, deleteFile }) {
    if (remote.active()) return remote.deleteSong(songId, !!deleteFile);
    return library.quietly(() => {
      const song = model.songById(library.get(), songId);
      if (!song) throw new Error('That song no longer exists.');
      if (deleteFile && files.exists(song.file)) {
        try {
          files.rm(song.file);
        } catch {
          throw new Error('The file could not be deleted. It may be open in another program.');
        }
      }
      return library.mutate((d) => model.removeSong(d, songId, !deleteFile));
    });
  }

  function editSong({
    songId, artist, title, mix,
  }) {
    const meta = { artist: String(artist || '').trim(), title: String(title || '').trim(), mix: String(mix || '').trim() };
    if (!meta.title) throw new Error('Please enter a title.');
    // The server renames its own file; a copy here follows at the next look.
    if (remote.active()) return remote.command('editSong', { songId, ...meta });
    return library.quietly(async () => {
      const song = model.songById(library.get(), songId);
      if (!song) throw new Error('That song no longer exists.');
      let file = song.file;
      let written = false;
      if (retag && files.exists(song.file)) {
        try {
          ({ file, written } = await retag(song, meta));
        } catch {
          throw new Error('The file could not be renamed. It may be open in another program.');
        }
      }
      return library.mutate((d) => {
        model.updateSong(d, songId, { ...meta, file });
        // Its file carries its flowid and cover now (a cover still being looked for: written again then).
        if (written) model.setTagged(d, songId, song.cover === null ? '' : song.cover);
      });
    });
  }

  // Edit's trim: the song's file cut to [start, end]. With a Flow Server the
  // server cuts its file (remote.trimSong; a copy here is cut at once); else
  // the Local Files file is cut here, the uncut one kept aside, and a song
  // that is one of a server's goes there too once it is connected.
  function trimSong({ songId, start, end }) {
    const span = { start: Math.max(0, Number(start) || 0), end: Number(end) || 0 };
    if (!(span.end - span.start >= 0.5)) throw new Error('The trim is too short.');
    if (remote.active()) return remote.trimSong(songId, span);
    if (!trim) throw new Error('Songs on this device can only be trimmed through a Flow Server.');
    return library.quietly(async () => {
      const song = model.songById(library.get(), songId);
      if (!song) throw new Error('That song no longer exists.');
      if (!files.exists(song.file)) throw new Error('The song\'s file is missing.');
      const base = song.cut;
      const cut = remote.newCutId();
      const { duration } = await trim(song, span.start, span.end);
      library.mutate((d) => {
        if (!model.songById(d, songId)) return;
        model.updateSong(d, songId, { duration, cut, loudness: null });
        // Its flowid and cover go into the cut file again (tagger.js).
        if (model.songById(d, songId).tagged !== null) model.setTagged(d, songId, '');
      });
      remote.trimmedHere(songId, { ...span, base, cut });
    });
  }

  function setFavourite({ songId, on }) {
    change((d) => model.setFavourite(d, songId, !!on), 'setFavourite', { songId, on: !!on });
  }

  function recordListen({
    songId, listened, duration, contextId,
  }) {
    // The song may have been deleted while it played; nothing to count then.
    if (!model.songById(currentLibrary(), songId)) return null;
    return change((d) => model.recordListen(d, songId, { listened, duration, contextId }), 'recordListen', {
      songId, listened, duration, contextId,
    });
  }

  const findBySource = ({ url, key }) => model.findBySource(currentLibrary(), { url, key });
  const findByMeta = (meta) => model.findByMeta(currentLibrary(), meta);

  return {
    currentLibrary,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    setPlaylistShared,
    setFollowing,
    addSongToPlaylists,
    addSongsToPlaylist,
    removeFromPlaylist,
    deleteSong,
    editSong,
    trimSong,
    setFavourite,
    recordListen,
    findBySource,
    findByMeta,
  };
}

module.exports = { createActions };
