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
  // The Flow Server's state (remote.js publicStatus); `on` false without one.
  server: { on: false, state: 'off', offline: [] },
  songsById: new Map(),
  smart: {}, // the Listen behaviour lists: id -> song ids, best match first
  holding: new Map(), // song id -> your own playlists ({ id, name }) that hold it, A to Z
  _listeners: [],

  setLibrary(lib) {
    this.library = lib;
    this.songsById = new Map(lib.songs.map((s) => [s.id, s]));
    this.smart = SmartLists.compute(lib.songs, lib.playlists);
    this.holding = new Map();
    for (const p of this.sortedPlaylists()) {
      for (const e of p.entries) {
        if (!this.holding.has(e.songId)) this.holding.set(e.songId, []);
        this.holding.get(e.songId).push({ id: p.id, name: p.name });
      }
    }
    for (const fn of this._listeners) fn(lib);
  },

  onLibrary(fn) {
    this._listeners.push(fn);
  },

  setServer(st) {
    this.server = st || { on: false, state: 'off', offline: [] };
    for (const fn of this._serverListeners || []) fn(this.server);
  },

  onServer(fn) {
    this._serverListeners = this._serverListeners || [];
    this._serverListeners.push(fn);
  },

  /**
   * Where a song plays from: its file here (Local Files, or a copy of a
   * server song), else streamed from the server. '' when neither can be had
   * (a server song not downloaded, with the server out of reach).
   */
  audioSrc(song) {
    if (!song) return '';
    if (song.file) return Util.fileUrl(song.file);
    const st = this.server;
    if (!st.on || !st.base) return '';
    return `${st.base}/api/songs/${encodeURIComponent(song.id)}/audio${st.token ? `?t=${encodeURIComponent(st.token)}` : ''}`;
  },

  /** A song's cover file as an address, '' without one (covers.js: Covers.el shows it). */
  coverSrc(song) {
    return Covers.src(song);
  },

  /** Whether a playlist's songs are kept on this computer (server playlists marked for download). */
  isOffline(playlistId) {
    return !!this.server.on && (this.server.offline || []).includes(playlistId);
  },

  song(id) {
    return this.songsById.get(id) || null;
  },

  playlist(id) {
    if (id === ALL_SONGS_ID) return this.allSongsPlaylist();
    if (id === FAVOURITES_ID) return this.favouritesPlaylist();
    if (SmartLists.isSmart(id)) return this.smartPlaylist(id);
    const own = this.library.playlists.find((p) => p.id === id);
    if (own) return own;
    // A playlist another profile shares: to read, not to change.
    const shared = (this.library.sharedPlaylists || []).find((p) => p.id === id);
    return shared ? { ...shared, isShared: true } : null;
  },

  /** With a Flow Server that has profiles: playlists can be shared with the others and followed. */
  canShare() {
    return !!this.server.on && !!this.server.profilesSupported;
  },

  /** The playlists other profiles share, A to Z. */
  sharedPlaylists() {
    return (this.library.sharedPlaylists || [])
      .map((p) => ({ ...p, isShared: true }))
      .sort((a, b) => Util.compareValues(a.name, b.name));
  },

  isFollowing(id) {
    return (this.library.follows || []).includes(id);
  },

  /** The shared playlists this profile follows, A to Z. */
  followedPlaylists() {
    return this.sharedPlaylists().filter((p) => this.isFollowing(p.id));
  },

  /** Seconds this profile has listened to a list (as the one playing), 0 for none. */
  listenedTo(id) {
    return Number((this.library.playlistListened || {})[id]) || 0;
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

  /** Your own playlists that hold a song ({ id, name }), A to Z. */
  playlistsHolding(songId) {
    return this.holding.get(songId) || [];
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
