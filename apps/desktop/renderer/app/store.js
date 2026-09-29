'use strict';

// The window's copy of the library and settings. The main process owns both;
// every change goes through window.flow and comes back here as a fresh
// library, which is when the pages redraw.

const ALL_SONGS_ID = 'all';
const ALL_SONGS_NAME = 'All Songs';
const FAVOURITES_ID = 'favourites';
const FAVOURITES_NAME = 'Favourites';

const Store = {
  library: { songs: [], playlists: [], ignoredFiles: [] },
  settings: {},
  musicDir: '',
  iconDataUrl: '',
  mp3Qualities: [],
  songsById: new Map(),
  smart: {}, // the Listen behaviour lists: id -> song ids, best match first
  _listeners: [],

  setLibrary(lib) {
    this.library = lib;
    this.songsById = new Map(lib.songs.map((s) => [s.id, s]));
    this.smart = SmartLists.compute(lib.songs);
    for (const fn of this._listeners) fn(lib);
  },

  onLibrary(fn) {
    this._listeners.push(fn);
  },

  song(id) {
    return this.songsById.get(id) || null;
  },

  playlist(id) {
    if (id === ALL_SONGS_ID) return this.allSongsPlaylist();
    if (id === FAVOURITES_ID) return this.favouritesPlaylist();
    if (SmartLists.isSmart(id)) return this.smartPlaylist(id);
    return this.library.playlists.find((p) => p.id === id) || null;
  },

  /**
   * A Listen behaviour list, shaped like a playlist. Read-only; its entries
   * are in rank order and carry the download date as when they were added.
   */
  smartPlaylist(id) {
    const def = SmartLists.LISTS.find((l) => l.id === id);
    if (!def) return null;
    const entries = (this.smart[id] || [])
      .map((songId) => this.songsById.get(songId))
      .filter(Boolean)
      .map((s) => ({ songId: s.id, addedAt: s.addedAt }));
    return { id, name: def.name, entries, isSmart: true };
  },

  smartPlaylists() {
    return SmartLists.LISTS.map((l) => this.smartPlaylist(l.id));
  },

  /** All Songs, shaped like a playlist whose entries were added on download. */
  allSongsPlaylist() {
    return {
      id: ALL_SONGS_ID,
      name: ALL_SONGS_NAME,
      entries: this.library.songs.map((s) => ({ songId: s.id, addedAt: s.addedAt })),
      isAll: true,
    };
  },

  /** The favourite songs, shaped like a playlist whose entries were added when made one. */
  favouritesPlaylist() {
    return {
      id: FAVOURITES_ID,
      name: FAVOURITES_NAME,
      entries: this.library.songs
        .filter((s) => s.favouriteAt)
        .map((s) => ({ songId: s.id, addedAt: s.favouriteAt })),
      isFavourites: true,
    };
  },

  /** All Songs, Favourites and the Listen behaviour lists: the ones the app keeps itself. */
  builtInPlaylists() {
    return [this.allSongsPlaylist(), this.favouritesPlaylist(), ...this.smartPlaylists()];
  },

  /** User playlists by name, A to Z. */
  sortedPlaylists() {
    return this.library.playlists.slice().sort((a, b) => Util.compareValues(a.name, b.name));
  },

  /** Songs of a playlist as rows: the song plus when it was added to this list. */
  rowsOf(playlistId) {
    const p = this.playlist(playlistId);
    if (!p) return [];
    const rows = [];
    for (const e of p.entries) {
      const song = this.songsById.get(e.songId);
      if (song) rows.push({ song, addedAt: e.addedAt });
    }
    return rows;
  },

  totalDuration(playlistId) {
    return this.rowsOf(playlistId).reduce((sum, r) => sum + (r.song.duration || 0), 0);
  },

  /**
   * Average song length, for the MP3 size estimate. A typical 3:30 until there
   * are enough songs for their own average to mean something.
   */
  averageDuration() {
    const songs = this.library.songs.filter((s) => s.duration > 0);
    if (songs.length < 5) return 210;
    return songs.reduce((sum, s) => sum + s.duration, 0) / songs.length;
  },

  /** fn(patch) after every settings change made in the window. */
  onSettings(fn) {
    this._settingsListeners = this._settingsListeners || [];
    this._settingsListeners.push(fn);
  },

  saveSettings(patch) {
    this.previewSettings(patch);
    return window.flow.setSettings(patch).catch(() => {});
  },

  /** A change the window follows at once but that is not saved yet (a slider being dragged). */
  previewSettings(patch) {
    Object.assign(this.settings, patch);
    for (const fn of this._settingsListeners || []) fn(patch);
  },
};
