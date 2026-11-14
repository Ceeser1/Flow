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
// Files song cannot be trimmed. privateStats (privateStats.js): every listen
// heard here counts there too, whatever library it was from.

const model = require('../libraryModel');
const { tr } = require('../lang');

function createActions({
  remote, library, files, retag = null, trim = null, privateStats = null,
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

  /** A smart playlist (4.0): its songs are the ones its rules pick (playlistRules.js in the window). */
  function createSmartPlaylist({ name, rules }) {
    const clean = model.cleanRules(rules);
    if (!clean) throw new Error(tr('songs.error.smartNeedsRules', 'A smart playlist needs its rules.'));
    if (!remote.active()) {
      return library.mutate((d) => {
        const p = model.createPlaylist(d, name, library.newId());
        return model.setPlaylistRules(d, p.id, clean);
      });
    }
    const name2 = model.checkPlaylistName(remote.view(), name);
    const id = library.newId();
    remote.command('createPlaylist', { playlistId: id, name: name2, rules: clean });
    return model.playlistById(remote.view(), id);
  }

  function setPlaylistRules({ id, rules }) {
    const clean = model.cleanRules(rules);
    if (!clean) throw new Error(tr('songs.error.smartNeedsRules', 'A smart playlist needs its rules.'));
    return change((d) => model.setPlaylistRules(d, id, clean), 'setPlaylistRules', { playlistId: id, rules: clean });
  }

  function renamePlaylist({ id, name }) {
    return change((d) => model.renamePlaylist(d, id, name), 'renamePlaylist', { playlistId: id, name });
  }

  // ---- playlist groups (4.5) ----

  function createGroup(name) {
    if (!remote.active()) return library.mutate((d) => model.createGroup(d, name, library.newId()));
    const clean = model.checkGroupName(remote.view(), name);
    const id = library.newId();
    remote.command('createGroup', { groupId: id, name: clean });
    return model.groupById(remote.view(), id);
  }

  function renameGroup({ id, name }) {
    return change((d) => model.renameGroup(d, id, name), 'renameGroup', { groupId: id, name });
  }

  /** The group goes, its playlists stay single. */
  function deleteGroup(id) {
    return change((d) => model.deleteGroup(d, id), 'deleteGroup', { groupId: id });
  }

  /** Playlists into a group, or (groupId '') out of theirs: one or several. */
  function setPlaylistGroup({ playlistIds, groupId }) {
    const ids = (Array.isArray(playlistIds) ? playlistIds : [playlistIds]).map(String).filter(Boolean);
    const gid = groupId ? String(groupId) : '';
    if (!remote.active()) {
      return library.mutate((d) => {
        for (const id of ids) model.setPlaylistGroup(d, id, gid);
      });
    }
    // Checked first, as the server would: none goes when one cannot.
    const v = remote.view();
    if (gid && !model.groupById(v, gid)) throw new Error(tr('core.library.groupGone', 'That playlist group no longer exists.'));
    for (const id of ids) {
      const p = model.playlistById(v, id);
      // A followed one (4.5.1), on a server that keeps them in groups.
      if (!p && (v.follows || []).includes(id) && remote.status().followedInGroups) continue;
      if (!p) throw new Error(tr('core.library.playlistGone', 'That playlist no longer exists.'));
      if (p.favourites) throw new Error(tr('core.library.favouritesFixed', 'Favourites cannot be renamed, deleted or given rules.'));
    }
    for (const id of ids) remote.command('setPlaylistGroup', { playlistId: id, groupId: gid });
    return null;
  }

  /**
   * Playlists into one more group (4.5.3), keeping their other groups. A
   * server from before keeps one group per playlist: there it is a move.
   */
  function addToGroup({ playlistIds, groupId }) {
    return groupChange(playlistIds, groupId, true);
  }

  /** Playlists out of one of their groups (4.5.3), their other groups kept. */
  function removeFromGroup({ playlistIds, groupId }) {
    return groupChange(playlistIds, groupId, false);
  }

  function groupChange(playlistIds, groupId, add) {
    const ids = (Array.isArray(playlistIds) ? playlistIds : [playlistIds]).map(String).filter(Boolean);
    const gid = String(groupId || '');
    if (!remote.active()) {
      return library.mutate((d) => {
        for (const id of ids) {
          if (add) model.addPlaylistToGroup(d, id, gid);
          else model.removePlaylistFromGroup(d, id, gid);
        }
      });
    }
    const v = remote.view();
    if (add && !model.groupById(v, gid)) throw new Error(tr('core.library.groupGone', 'That playlist group no longer exists.'));
    for (const id of ids) {
      const p = model.playlistById(v, id);
      if (!p && (v.follows || []).includes(id) && remote.status().followedInGroups) continue;
      if (!p) throw new Error(tr('core.library.playlistGone', 'That playlist no longer exists.'));
      if (p.favourites) throw new Error(tr('core.library.favouritesFixed', 'Favourites cannot be renamed, deleted or given rules.'));
    }
    const multi = remote.status().multiGroups;
    for (const id of ids) {
      if (multi) remote.command(add ? 'addPlaylistToGroup' : 'removePlaylistFromGroup', { playlistId: id, groupId: gid });
      else remote.command('setPlaylistGroup', { playlistId: id, groupId: add ? gid : '' });
    }
    return null;
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
    if (!remote.active()) throw new Error(tr('songs.error.followNeedsServer', 'Following playlists needs a Flow Server.'));
    const result = remote.command(on ? 'followPlaylist' : 'unfollowPlaylist', { playlistId: id });
    // Unfollowed: its downloaded songs go too, unless another downloaded
    // playlist (or All Songs) still holds them.
    if (!on) remote.setOffline(id, false).catch(() => {});
    return result;
  }

  // Sharing a group (4.5.3), its playlists with it, and following one the others share.
  function setGroupShared({ id, shared }) {
    return change((d) => model.setGroupShared(d, id, !!shared), 'setGroupShared', { groupId: id, shared: !!shared });
  }

  function setGroupFollowing({ id, on }) {
    if (!remote.active()) throw new Error(tr('songs.error.followNeedsServer', 'Following playlists needs a Flow Server.'));
    // Unfollowed: its playlists' downloaded songs go too, as they are no
    // longer followed (remote.js, rememberMarked), unless followed apart.
    return remote.command(on ? 'followGroup' : 'unfollowGroup', { groupId: id });
  }

  /** A playlist inside a group it follows, followed there or no longer (for that group only). */
  function setGroupPlaylistFollowed({ groupId, playlistId, on }) {
    if (!remote.active()) throw new Error(tr('songs.error.followNeedsServer', 'Following playlists needs a Flow Server.'));
    return remote.command('setGroupPlaylistFollowed', { groupId, playlistId, on: !!on });
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
      if (!song) throw new Error(tr('common.songGone', 'That song no longer exists.'));
      if (deleteFile && files.exists(song.file)) {
        try {
          files.rm(song.file);
        } catch {
          throw new Error(tr('songs.error.fileNotDeleted', 'The file could not be deleted. It may be open in another program.'));
        }
      }
      return library.mutate((d) => model.removeSong(d, songId, !deleteFile));
    });
  }

  function editSong({
    songId, artist, title, mix, album, genre, subGenre,
  }) {
    const meta = { artist: String(artist || '').trim(), title: String(title || '').trim(), mix: String(mix || '').trim() };
    if (!meta.title) throw new Error(tr('common.enterTitle', 'Please enter a title.'));
    if (album !== undefined) meta.album = String(album || '').trim();
    if (genre !== undefined) meta.genre = String(genre || '').trim();
    if (subGenre !== undefined) meta.subGenre = String(subGenre || '').trim();
    // The server renames its own file; a copy here follows at the next look.
    if (remote.active()) return remote.command('editSong', { songId, ...meta });
    return library.quietly(async () => {
      const song = model.songById(library.get(), songId);
      if (!song) throw new Error(tr('common.songGone', 'That song no longer exists.'));
      let file = song.file;
      let written = false;
      if (retag && files.exists(song.file)) {
        try {
          ({ file, written } = await retag(song, meta));
        } catch {
          throw new Error(tr('songs.error.fileNotRenamed', 'The file could not be renamed. It may be open in another program.'));
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
    if (!(span.end - span.start >= 0.5)) throw new Error(tr('songs.error.trimTooShort', 'The trim is too short.'));
    if (remote.active()) return remote.trimSong(songId, span);
    if (!trim) throw new Error(tr('songs.error.trimNeedsServer', 'Songs on this device can only be trimmed through a Flow Server.'));
    return library.quietly(async () => {
      const song = model.songById(library.get(), songId);
      if (!song) throw new Error(tr('common.songGone', 'That song no longer exists.'));
      if (!files.exists(song.file)) throw new Error(tr('songs.error.fileMissing', 'The song\'s file is missing.'));
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

  // jamMember: heard as a member of a Jam, whose host's listen is the one the
  // server's Default / Shared counts; the profile signed in here still counts it.
  function recordListen({
    songId, listened, duration, contextId, jamMember = false,
  }) {
    // The song may have been deleted while it played; nothing to count then.
    const song = model.songById(currentLibrary(), songId);
    if (!song) return null;
    // The day and hour it was heard are this device's (listening.js).
    const tz = new Date().getTimezoneOffset();
    if (privateStats) privateStats.recordListen({ song, listened, duration, tz });
    return change((d) => model.recordListen(d, songId, { listened, duration, contextId, tz }), 'recordListen', {
      songId, listened, duration, contextId, tz, ...(jamMember ? { jamMember: true } : {}),
    });
  }

  /**
   * A listen as a guest in another server's session (4.0): this device's
   * Private Statistics and the totals of the profile in use here (Local
   * Files' without a server). Not the Default / Shared's of a server: those
   * are the server's own listening.
   */
  function recordAwayListen({ song = {}, listened, duration }) {
    const tz = new Date().getTimezoneOffset();
    if (privateStats) privateStats.recordListen({ song, listened, duration, tz });
    if (remote.active() && !remote.status().profile) return null;
    return change((d) => model.recordAwayListen(d, { listened, duration, tz }), 'recordAwayListen', { listened, duration, tz });
  }

  const findBySource = ({ url, key }) => model.findBySource(currentLibrary(), { url, key });
  // With meta.duration: only a song of the same length (model.findSameSong).
  const findByMeta = (meta) => (meta && meta.duration
    ? model.findSameSong(currentLibrary(), meta, meta.duration)
    : model.findByMeta(currentLibrary(), meta));

  return {
    currentLibrary,
    createPlaylist,
    createSmartPlaylist,
    setPlaylistRules,
    renamePlaylist,
    deletePlaylist,
    createGroup,
    renameGroup,
    deleteGroup,
    setPlaylistGroup,
    addToGroup,
    removeFromGroup,
    setPlaylistShared,
    setFollowing,
    setGroupShared,
    setGroupFollowing,
    setGroupPlaylistFollowed,
    addSongToPlaylists,
    addSongsToPlaylist,
    removeFromPlaylist,
    deleteSong,
    editSong,
    trimSong,
    setFavourite,
    recordListen,
    recordAwayListen,
    findBySource,
    findByMeta,
  };
}

module.exports = { createActions };
