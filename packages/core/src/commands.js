'use strict';

// The changes a Flow app sends to a Flow Server, one command each, and how a
// command changes the library. The server applies them for real; an app
// applies the ones still on their way on top of the server's library, so the
// window shows them straight away. Pure, like libraryModel.js.
//
//   command  { cid, at, type, ...arguments }
//   cid      unique per command, so one sent twice (its answer got lost on the
//            way back) only counts once. The server remembers the recent ones.
//   at       when it was made (ms). Last change wins: a command older than the
//            last change to the same thing (a song's names, a playlist's name,
//            one song's place in one playlist) is skipped. A delete always
//            wins, whenever it was made.
//
// `touched` is where the server keeps those last-change times, key -> ms. The
// app leaves it out: what it shows is only a preview of the server's answer.
// With profiles (profiles.js), `scope` is the profile a command is for: its
// playlists and favourites are its own, so their keys are kept per profile.
// A song's names are shared (`shared` below).

const model = require('./libraryModel');

function str(v) {
  return String(v === undefined || v === null ? '' : v);
}

function ids(list) {
  return (Array.isArray(list) ? list : []).map(str).filter(Boolean);
}

// Each type: which change it is for last-change-wins (null: none) and what it
// does. `gone` in an answer means the song or playlist no longer exists, which
// for a command made before a delete is no error: the delete won.
const TYPES = {
  createPlaylist: {
    keys: () => [],
    run(d, c) {
      const id = str(c.playlistId);
      if (!id) throw new Error('A new playlist needs an id.');
      if (model.playlistById(d, id)) return { skipped: 'exists' };
      if (!str(c.name).trim()) throw new Error('Please enter a name for the playlist.');
      // Two apps may each have made a "Chill" while apart: the later one
      // becomes "Chill (2)" rather than getting lost.
      const p = model.createPlaylist(d, model.freePlaylistName(d, c.name), id, c.at);
      if (c.source) model.setPlaylistSource(d, id, c.source);
      return { value: p.id };
    },
  },
  renamePlaylist: {
    keys: (c) => [`p:${c.playlistId}:name`],
    run(d, c) {
      if (!model.playlistById(d, str(c.playlistId))) return { skipped: 'gone' };
      model.renamePlaylist(d, str(c.playlistId), c.name);
      return {};
    },
  },
  deletePlaylist: {
    keys: () => [],
    run(d, c) {
      if (!model.playlistById(d, str(c.playlistId))) return { skipped: 'gone' };
      model.deletePlaylist(d, str(c.playlistId));
      return {};
    },
  },
  setPlaylistSource: {
    keys: () => [],
    run(d, c) {
      if (!model.playlistById(d, str(c.playlistId))) return { skipped: 'gone' };
      model.setPlaylistSource(d, str(c.playlistId), c.source);
      return {};
    },
  },
  addSongToPlaylists: {
    keys: (c) => ids(c.playlistIds).map((pid) => `p:${pid}:e:${c.songId}`),
    run(d, c, fresh) {
      if (!model.songById(d, str(c.songId))) return { skipped: 'gone' };
      const lists = ids(c.playlistIds).filter((pid) => model.playlistById(d, pid) && fresh(`p:${pid}:e:${c.songId}`));
      return { value: model.addSongToPlaylists(d, str(c.songId), lists, c.at) };
    },
  },
  addSongsToPlaylist: {
    keys: (c) => ids(c.songIds).map((sid) => `p:${c.playlistId}:e:${sid}`),
    run(d, c, fresh) {
      const pid = str(c.playlistId);
      if (!model.playlistById(d, pid)) return { skipped: 'gone' };
      const songs = ids(c.songIds).filter((sid) => model.songById(d, sid) && fresh(`p:${pid}:e:${sid}`));
      return { value: model.addSongsToPlaylist(d, pid, songs, c.at) };
    },
  },
  removeFromPlaylist: {
    keys: (c) => [`p:${c.playlistId}:e:${c.songId}`],
    run(d, c) {
      if (!model.playlistById(d, str(c.playlistId))) return { skipped: 'gone' };
      model.removeFromPlaylist(d, str(c.playlistId), str(c.songId));
      return {};
    },
  },
  deleteSong: {
    keys: () => [],
    run(d, c) {
      if (!model.songById(d, str(c.songId))) return { skipped: 'gone' };
      return { value: model.removeSong(d, str(c.songId), false) };
    },
  },
  editSong: {
    shared: true,
    keys: (c) => [`s:${c.songId}:meta`],
    run(d, c) {
      if (!model.songById(d, str(c.songId))) return { skipped: 'gone' };
      const meta = { artist: str(c.artist).trim(), title: str(c.title).trim(), mix: str(c.mix).trim() };
      if (!meta.title) throw new Error('Please enter a title.');
      return { value: model.updateSong(d, str(c.songId), meta) };
    },
  },
  setFavourite: {
    keys: (c) => [`s:${c.songId}:fav`],
    run(d, c) {
      if (!model.songById(d, str(c.songId))) return { skipped: 'gone' };
      model.setFavourite(d, str(c.songId), !!c.on, c.at);
      return {};
    },
  },
  setLoudness: {
    keys: () => [],
    run(d, c) {
      if (!model.songById(d, str(c.songId))) return { skipped: 'gone' };
      model.updateSong(d, str(c.songId), { loudness: c.loudness });
      return {};
    },
  },
  // A song's length, from an app that knows it (a copy of its own, or the
  // song played) when the server does not (found in its folder without ffprobe).
  setDuration: {
    keys: () => [],
    run(d, c) {
      const s = model.songById(d, str(c.songId));
      if (!s) return { skipped: 'gone' };
      const len = Number(c.duration) || 0;
      if (!(len > 0) || s.duration > 0) return { skipped: 'known' };
      model.updateSong(d, s.id, { duration: len });
      return {};
    },
  },
  recordListen: {
    keys: () => [],
    run(d, c) {
      const s = model.songById(d, str(c.songId));
      if (!s) return { skipped: 'gone' };
      if (!(s.duration > 0) && Number(c.duration) > 0) model.updateSong(d, s.id, { duration: Number(c.duration) });
      return { value: model.recordListen(d, str(c.songId), { listened: c.listened, duration: c.duration, at: c.at }) };
    },
  },
  // A song on its way up (an upload): only ever applied by the app, to show
  // it before it has arrived. The server adds songs through the upload itself.
  addSong: {
    keys: () => [],
    run(d, c) {
      const song = c.song || {};
      if (!song.id || model.songById(d, str(song.id))) return { skipped: 'exists' };
      model.addSong(d, { ...song });
      const lists = ids(c.playlistIds).filter((pid) => model.playlistById(d, pid));
      model.addSongToPlaylists(d, str(song.id), lists, song.addedAt);
      return { value: song.id };
    },
  },
};

const COMMAND_TYPES = Object.keys(TYPES);

/**
 * Applies one command to the library `data`. Resolves { value } or { skipped }
 * ('gone', 'exists' or 'stale'); throws an Error fit to show the user when the
 * command itself is wrong (an empty title, a taken playlist name).
 */
function applyCommand(data, cmd, touched = null, scope = null) {
  const c = cmd || {};
  const type = TYPES[c.type];
  if (!type) throw new Error(`Unknown command "${str(c.type)}".`);
  const at = Number(c.at) || Date.now();
  const cc = { ...c, at };
  // A change older than the last one to the same thing is skipped. For a
  // command touching several things (a song into several playlists), each
  // is checked on its own through fresh().
  const scoped = (key) => (scope && !type.shared ? `${scope}/${key}` : key);
  const fresh = (key) => !touched || !(touched[scoped(key)] > at);
  const keys = type.keys(cc);
  if (keys.length === 1 && !fresh(keys[0])) return { skipped: 'stale' };
  const result = type.run(data, cc, fresh);
  if (touched && !result.skipped) {
    for (const key of keys) if (fresh(key)) touched[scoped(key)] = at;
  }
  return result;
}

module.exports = { applyCommand, COMMAND_TYPES };
