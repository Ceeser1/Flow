'use strict';

// The window's copy of the library and settings. The main process owns both;
// every change goes through window.flow and comes back here as a fresh
// library, which is when the pages redraw.

const ALL_SONGS_ID = 'all';
const ALL_SONGS_NAME = 'All Songs';
const FAVOURITES_ID = 'favourites';
// The songs of another server's session this app is a guest in (4.0).
const GUEST_ID = 'guest:songs';
const FAVOURITES_NAME = 'Favourites';
// "All Songs from <profile>": the songs one profile of the Flow Server added.
const FROM_PREFIX = 'from:';
// The Default / Shared's id as a song's addedBy (@flow/core/profiles DEFAULT_OWNER).
const DEFAULT_PROFILE = 'default';
// Downloaded Songs (with a Flow Server): every song with a file on this device.
const DEVICE_ID = 'device';

const Store = {
  library: { songs: [], playlists: [], ignoredFiles: [] },
  settings: {},
  musicDir: '',
  iconDataUrl: '',
  mp3Qualities: [],
  // Which app this window is in ('desktop', 'android', 'ios'), its layout ('desktop',
  // 'mobile') and what it can do (@flow/core/client/caps).
  platform: 'desktop',
  // The computer's OS (Node's process.platform): file names such as yt-dlp.exe.
  os: 'win32',
  uiMode: 'desktop',
  caps: {},
  version: '',
  // The Flow Server's state (remote.js publicStatus); `on` false without one.
  server: { on: false, state: 'off', offline: [] },
  songsById: new Map(),
  smart: {}, // the listening trend lists: id -> song ids, best match first
  holding: new Map(), // song id -> your own playlists ({ id, name }) that hold it, A to Z
  // A guest in another server's session (4.0): that server's songs, to show,
  // queue and play along with (Session sets them): id -> song (foreign: true).
  foreign: new Map(),
  foreignName: '',
  // The songs guests brought into this app's session (4.0): id -> song (foreign: true).
  sessionSongs: new Map(),
  _listeners: [],

  setLibrary(lib) {
    this.library = lib;
    // The songs here that are not the server's (Downloaded Songs) can be played and queued too.
    this.songsById = new Map([...lib.songs, ...(lib.deviceSongs || [])].map((s) => [s.id, s]));
    // Smart playlists (4.0): their songs are the ones their rules pick, now.
    for (const p of lib.playlists) {
      if (!p.rules) continue;
      p.entries = PlaylistRules.evaluate(lib.songs, p.rules).map((s) => ({ songId: s.id, addedAt: s.addedAt }));
      p.isRuled = true;
    }
    this.smart = SmartLists.compute(lib.songs, lib.playlists.filter((p) => !p.isRuled));
    this.holding = new Map();
    for (const p of this.editablePlaylists()) {
      for (const e of p.entries) {
        if (!this.holding.has(e.songId)) this.holding.set(e.songId, []);
        this.holding.get(e.songId).push({ id: p.id, name: p.name });
      }
    }
    for (const fn of this._listeners) fn(lib);
  },

  /** Whether this app can do `cap` (@flow/core/client/caps); its controls are hidden when not. */
  can(cap) {
    return this.caps[cap] !== false;
  },

  /** Whether this app runs on a phone (Android or iPhone). */
  get phone() {
    return this.platform === 'android' || this.platform === 'ios';
  },

  /** The device as the window names it: "this phone" or "this computer". */
  get here() {
    return this.phone ? 'this phone' : 'this computer';
  },

  onLibrary(fn) {
    this._listeners.push(fn);
  },

  setServer(st) {
    this.server = st || { on: false, state: 'off', offline: [] };
    for (const fn of this._serverListeners || []) fn(this.server);
  },

  /** Returns what stops listening. */
  onServer(fn) {
    this._serverListeners = this._serverListeners || [];
    this._serverListeners.push(fn);
    return () => {
      this._serverListeners = this._serverListeners.filter((f) => f !== fn);
    };
  },

  /**
   * Where a song plays from: its file here (Local Files, or a copy of a
   * server song), else streamed from the server. '' when neither can be had
   * (a server song not downloaded, with the server out of reach).
   */
  audioSrc(song) {
    if (!song) return '';
    // Another server's song (a guest in its session): from there.
    if (song.foreign) return song.src || '';
    if (song.file) return Util.fileUrl(song.file);
    const st = this.server;
    if (!st.on || !st.base) return '';
    // An app that cannot play Ogg Vorbis (the iPhone) gets such a song as Opus.
    const query = [st.token ? `t=${encodeURIComponent(st.token)}` : '', this.can('vorbis') ? '' : 'vorbis=0'].filter(Boolean).join('&');
    return `${st.base}/api/songs/${encodeURIComponent(song.id)}/audio${query ? `?${query}` : ''}`;
  },

  /** A song's cover file as an address, '' without one (covers.js: Covers.el shows it). */
  coverSrc(song) {
    return Covers.src(song);
  },

  /** Whether a playlist's songs are kept here (server playlists marked for download). */
  isOffline(playlistId) {
    return !!this.server.on && (this.server.offline || []).includes(playlistId);
  },

  song(id) {
    return this.songsById.get(id) || this.foreign.get(id) || this.sessionSongs.get(id) || null;
  },

  /** The songs guests brought into this app's session, each with where it streams from. */
  setSessionSongs(songs) {
    const key = (songs || []).map((s) => s.id).join(',');
    if (key === this._sessionSongsKey) return;
    this._sessionSongsKey = key;
    this.sessionSongs = new Map((songs || []).map((s) => [s.id, { ...s, file: '', foreign: true, cover: null }]));
    for (const fn of this._listeners) fn(this.library);
  },

  /** Another server's songs (a guest in its session), or none (null). */
  setForeign(songs, name = '') {
    this.foreign = new Map((songs || []).map((s) => [s.id, { ...s, file: '', foreign: true }]));
    this.foreignName = name;
    for (const fn of this._listeners) fn(this.library);
  },

  playlist(id) {
    if (id === ALL_SONGS_ID) return this.allSongsPlaylist();
    if (id === DEVICE_ID) return this.devicePlaylist();
    if (id === FAVOURITES_ID) return this.favouritesPlaylist();
    if (SmartLists.isSmart(id)) return this.smartPlaylist(id);
    if (id === GUEST_ID) return this.guestPlaylist();
    if (String(id).startsWith(FROM_PREFIX)) return this.fromPlaylist(id.slice(FROM_PREFIX.length));
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
   * A listening trend list, shaped like a playlist. Read-only; its entries
   * are in rank order and carry the download date as when they were added.
   */
  smartPlaylist(id) {
    const def = SmartLists.LISTS.find((l) => l.id === id);
    if (!def) return null;
    const entries = (this.smart[id] || [])
      .map((songId) => this.songsById.get(songId))
      .filter(Boolean)
      .map((s) => ({ songId: s.id, addedAt: s.addedAt }));
    return { id, name: def.name, desc: def.desc, entries, isSmart: true };
  },

  /** Your own playlists that hold a song ({ id, name }), A to Z. */
  playlistsHolding(songId) {
    return this.holding.get(songId) || [];
  },

  smartPlaylists() {
    return SmartLists.LISTS.map((l) => this.smartPlaylist(l.id));
  },

  /** The songs of the server this app is a guest of, shaped like a playlist to play from and queue (null: none). */
  guestPlaylist() {
    if (!this.foreign.size) return null;
    return {
      id: GUEST_ID,
      name: `Songs on ${this.foreignName || 'the other server'}`,
      entries: [...this.foreign.values()].map((s) => ({ songId: s.id, addedAt: 0 })),
      isGuest: true,
    };
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

  /**
   * Downloaded Songs, first under All Songs while a Flow Server is in use:
   * every song with a file on this device, the server's (downloaded, or
   * uploaded from here) and the rest (copies of another server's songs, songs
   * not uploaded: lib.deviceSongs, which only play). Null without a server.
   */
  devicePlaylist() {
    if (!this.server.on) return null;
    const songs = [...this.library.songs.filter((s) => s.file), ...(this.library.deviceSongs || [])];
    return {
      id: DEVICE_ID,
      name: 'Downloaded Songs',
      entries: songs.map((s) => ({ songId: s.id, addedAt: s.addedAt })),
      isDevice: true,
    };
  },

  /** All Songs or a part of it ("All Songs from ..."): the lists whose songs can be deleted from the library. */
  isAllSongs(id) {
    return id === ALL_SONGS_ID || String(id || '').startsWith(FROM_PREFIX);
  },

  /**
   * A server profile's name: the server's list while online (it follows a
   * rename at once), else the names the library came with; '' for a profile
   * that is gone.
   */
  profileName(profileId) {
    const live = (this.server.profiles || []).find((p) => p.id === profileId);
    return live ? live.name : (this.library.profileNames || {})[profileId] || '';
  },

  /**
   * The songs one profile added (uploaded, or had the server download),
   * shaped like All Songs; null when the profile is gone or added none.
   */
  fromPlaylist(profileId) {
    const name = this.profileName(profileId);
    const entries = this.library.songs
      .filter((s) => s.addedBy === profileId)
      .map((s) => ({ songId: s.id, addedAt: s.addedAt }));
    if (!name || !entries.length) return null;
    return { id: FROM_PREFIX + profileId, name: `All Songs from ${name}`, menuName: `from ${name}`, entries, isFrom: true };
  },

  /** The profile songs added now count as added by: the one signed in to, else the Default / Shared. */
  uploaderId() {
    return this.server.profile ? this.server.profile.id : DEFAULT_PROFILE;
  },

  /**
   * The "All Songs from ..." lists under All Songs in the menu: profiles that
   * added songs, A to Z. The Default / Shared's only on a server with profiles.
   */
  fromPlaylists() {
    const profiles = Object.keys(this.library.profileNames || {}).some((id) => id !== DEFAULT_PROFILE);
    const ids = new Set(this.library.songs.map((s) => s.addedBy).filter((id) => id && (profiles || id !== DEFAULT_PROFILE)));
    return [...ids].map((id) => this.fromPlaylist(id)).filter(Boolean)
      .sort((a, b) => Util.compareValues(a.menuName, b.menuName));
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

  /** All Songs, Favourites and the listening trend lists: the ones the app keeps itself. */
  builtInPlaylists() {
    return [this.allSongsPlaylist(), this.favouritesPlaylist(), ...this.smartPlaylists()];
  },

  /** User playlists by name, A to Z. */
  sortedPlaylists() {
    return this.library.playlists.slice().sort((a, b) => Util.compareValues(a.name, b.name));
  },

  /** The ones songs can be put into by hand: not the smart ones (their rules pick their songs). */
  editablePlaylists() {
    return this.sortedPlaylists().filter((p) => !p.isRuled);
  },

  /** Songs of a playlist as rows: the song plus when it was added to this list. */
  rowsOf(playlistId) {
    const p = this.playlist(playlistId);
    if (!p) return [];
    const rows = [];
    for (const e of p.entries) {
      const song = this.song(e.songId);
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
