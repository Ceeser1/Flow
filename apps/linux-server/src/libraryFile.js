'use strict';

// The server's library.json and state.json, kept as their changes (4.3.4,
// @flow/core/journalFile): a listen or a star adds a line to library.json.log
// and state.json.log instead of writing 80 MB again (100 000 songs). Every
// reader of these files goes through here, so none misses the log: the
// running server (library.js) and the commands beside it (move-music,
// backup, tag-songs).

const { fileJournalIo } = require('@flow/core/jsonFile');
const {
  createJournal, within, LIBRARY_SPEC, LISTENING_SPEC, STATISTICS_SPEC,
} = require('@flow/core/journalFile');

// { ...the library, profiles: { id: { songs: { id: { stats, favouriteAt } }, playlists, ... } } }
const LIBRARY_FILE_SPEC = {
  ...LIBRARY_SPEC,
  'profiles.*.songs': 'map',
  'profiles.*.playlists': 'list',
  ...within('profiles.*.listening', LISTENING_SPEC),
  ...within('profiles.*.statistics', STATISTICS_SPEC),
};

// library.js's state: the stamps of every song, playlist and owner, the stats stamps by owner.
const STATE_FILE_SPEC = {
  'stamps.s': 'map', 'stamps.p': 'map', 'stamps.o': 'map', touched: 'map', srev: 'map', 'sstamps.*': 'map', sfloor: 'map',
};

const libraryJournal = (config) => createJournal(fileJournalIo, config.libraryFile, LIBRARY_FILE_SPEC);
const stateJournal = (config) => createJournal(fileJournalIo, config.stateFile, STATE_FILE_SPEC);

/** library.json as it stands, its log applied (null when there is none). */
function readLibrary(config) {
  return libraryJournal(config).load();
}

/** library.json written whole (a command run beside the server: the music moved). */
function writeLibrary(config, value) {
  libraryJournal(config).saveWhole(value);
}

module.exports = {
  LIBRARY_FILE_SPEC, STATE_FILE_SPEC, libraryJournal, stateJournal, readLibrary, writeLibrary,
};
