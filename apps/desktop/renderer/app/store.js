'use strict';

// The window's copy of the library and settings. The main process owns both;
// every change goes through window.flow and comes back here as a fresh
// library, which is when the pages redraw.

const ALL_SONGS_ID = 'all';
const ALL_SONGS_NAME = T('common.allSongs');
const FAVOURITES_ID = 'favourites';
// The songs of another server's session this app is a guest in (4.0).
const GUEST_ID = 'guest:songs';
const FAVOURITES_NAME = T('common.favourites');
// "All Songs from <profile>": the songs one profile of the Flow Server added.
const FROM_PREFIX = 'from:';
// The Default / Shared's id as a song's addedBy (@flow/core/profiles DEFAULT_OWNER).
const DEFAULT_PROFILE = 'default';
// Downloaded Songs (with a Flow Server): every song with a file on this device.
const DEVICE_ID = 'device';

/** A list's entries are still `songs` (the same ids, `at` the same date) in the same order. */
function sameEntries(entries, songs, at) {
  if (entries.length !== songs.length) return false;
  for (let i = 0; i < songs.length; i += 1) {
    const e = entries[i];
    const s = songs[i];
    if (e.songId !== s.id || e.addedAt !== at(s)) return false;
  }
  return true;
}

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
  holding: new Map(), // song id -> your own playlists ({ id, name }) that hold it, A to Z
  // A guest in another server's session (4.0): that server's songs, to show,
  // queue and play along with (Session sets them): id -> song (foreign: true).
  foreign: new Map(),
  foreignName: '',
  // The songs guests brought into this app's session (4.0): id -> song (foreign: true).
  sessionSongs: new Map(),
  _listeners: [],

  /**
   * The library as the app sends it (4.3.3): whole ({ library, seq }), or
   * what changed since the one numbered `base` ({ patch, base, seq },
   * LibraryPatch), so the songs that stay are the same objects and keep
   * what was worked out for them (search, sort keys). One that does not fit
   * (a change missed) has it sent whole.
   */
  takeLibrary(msg) {
    if (!msg) return;
    if (!msg.patch) {
      this._librarySeq = msg.seq;
      this.setLibrary(msg.library || { songs: [], playlists: [], ignoredFiles: [] });
      return;
    }
    if (msg.base !== this._librarySeq) {
      if (!this._askedWhole && window.flow.libraryWhole) {
        this._askedWhole = true;
        window.flow.libraryWhole().catch(() => {}).finally(() => { this._askedWhole = false; });
      }
      return;
    }
    this._librarySeq = msg.seq;
    this.setLibrary(LibraryPatch.apply(this.library, msg.patch), msg.patch);
  },
  _librarySeq: 0,

  /** steps: what changed since the library before (a patch), when that is how it came. */
  setLibrary(lib, steps = null) {
    this.library = lib;
    // The songs here that are not the server's (Downloaded Songs) can be played and queued too.
    // A patch changes only its songs (100 000: the map is not made again).
    const songSteps = steps && steps.filter((s) => s[1] === 'songs' || s[1] === 'deviceSongs');
    if (songSteps && songSteps.every((s) => s[0] === 'list')) {
      for (const [, , s] of songSteps) for (const id of s.gone || []) this.songsById.delete(id);
      for (const [, p, s] of songSteps) {
        const list = lib[p] || [];
        // The changed songs where the patch says they are now, else looked for.
        const at = s.order ? [] : s.at || [];
        const missed = (s.put || []).some((x, n) => {
          const song = list[at[n]];
          if (!song || song.id !== x.id) return true;
          this.songsById.set(song.id, song);
          return false;
        });
        if (missed) for (const song of list) if (this.songsById.get(song.id) !== song) this.songsById.set(song.id, song);
      }
    } else {
      this.songsById = new Map([...lib.songs, ...(lib.deviceSongs || [])].map((s) => [s.id, s]));
    }
    // Smart playlists (4.0): their songs are the ones their rules pick, now.
    for (const p of lib.playlists) {
      if (!p.rules) continue;
      p.entries = PlaylistRules.evaluate(lib.songs, p.rules).map((s) => ({ songId: s.id, addedAt: s.addedAt }));
      p.isRuled = true;
    }
    this.holding = new Map();
    for (const p of this.editablePlaylists()) {
      for (const e of p.entries) {
        if (!this.holding.has(e.songId)) this.holding.set(e.songId, []);
        this.holding.get(e.songId).push({ id: p.id, name: p.name });
      }
    }
    for (const fn of this._listeners) fn(lib);
    this._prepare(lib);
  },

  /**
   * While nothing else runs: each song's folded names and title, its title's and
   * artist's sort keys made (Util.songHay, songSortKey), so the first search
   * or sort of a long library does not wait for 100 000 of them.
   */
  _prepare(lib) {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 50));
    let at = 0;
    const step = (deadline) => {
      if (this.library !== lib) return;
      const songs = lib.songs;
      while (at < songs.length && deadline.timeRemaining() > 2) {
        for (let k = 0; k < 200 && at < songs.length; k += 1, at += 1) {
          const s = songs[at];
          Util.songHay(s);
          Util.titleHay(s);
          Util.songSortKey(s, 'title');
          Util.songSortKey(s, 'artist');
        }
      }
      if (at < songs.length) idle(step, { timeout: 2000 });
    };
    idle(step, { timeout: 2000 });
  },

  /** Whether this app can do `cap` (@flow/core/client/caps); its controls are hidden when not. */
  can(cap) {
    return this.caps[cap] !== false;
  },

  /** Whether this app runs on a phone (Android or iPhone, or the web player in a phone's layout). */
  get phone() {
    return this.platform === 'android' || this.platform === 'ios' || (this.platform === 'web' && this.uiMode === 'mobile');
  },

  /** Whether this is the web player (apps/web): a page in a browser. */
  get web() {
    return this.platform === 'web';
  },

  /** The device as the window names it: "this phone", "this browser" or "this computer". */
  get here() {
    return T(`common.this${this.hereKey[0].toUpperCase()}${this.hereKey.slice(1)}`);
  },

  /** 'computer', 'phone' or 'browser': the end of the keys whose sentence names this device (German changes its case). */
  get hereKey() {
    if (this.web) return 'browser';
    return this.phone ? 'phone' : 'computer';
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
    return shared ? this._shared(shared) : null;
  },

  /** With a Flow Server that has profiles: playlists can be shared with the others and followed. */
  canShare() {
    return !!this.server.on && !!this.server.profilesSupported;
  },

  /**
   * The playlists other profiles share, A to Z. Another profile's Favourites
   * (4.3) is "Anna's Favourites". One not followed and not opened yet comes
   * by its details only (partial: songCount and seconds instead of its songs).
   */
  sharedPlaylists() {
    return (this.library.sharedPlaylists || [])
      .map((p) => this._shared(p))
      .sort((a, b) => Util.compareValues(a.name, b.name));
  },

  _shared(p) {
    const owner = this.profileName(p.ownerId) || p.ownerName;
    return {
      // "James' Favorites" for a name ending in s.
      ...p, ownerName: owner, isShared: true, ...(p.favourites ? { name: T(/s$/i.test(owner) ? 'common.favouritesOf.s' : 'common.favouritesOf', { profile: owner }) } : {}),
    };
  },

  /** How many songs a list has, also one known only by its details. */
  songCount(p) {
    return p.partial ? p.songCount || 0 : p.entries.length;
  },

  /** A list's length in seconds, also one known only by its details. */
  durationOf(p) {
    return p.partial ? p.seconds || 0 : this.totalDuration(p.id);
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
  /**
   * The listening trend lists: id -> song ids, best match first. Worked out
   * when one is shown or played, once per library (100 000 songs: some 200 ms).
   */
  get smart() {
    if (!this._smart || this._smart.lib !== this.library) {
      this._smart = { lib: this.library, lists: SmartLists.compute(this.library.songs, this.library.playlists.filter((p) => !p.isRuled)) };
    }
    return this._smart.lists;
  },

  /** The trend lists by their names only (the menu), without working them out. */
  smartNames() {
    return SmartLists.LISTS.map((l) => ({ id: l.id, name: l.name, desc: l.desc, isSmart: true }));
  },

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
      name: T('common.songsOn', { server: this.foreignName || T('common.songsOn.otherServer') }),
      entries: [...this.foreign.values()].map((s) => ({ songId: s.id, addedAt: 0 })),
      isGuest: true,
    };
  },

  /** All Songs, shaped like a playlist whose entries were added on download. */
  allSongsPlaylist() {
    // Made once per library (a long one is asked for often while drawing),
    // and kept while its songs and their dates stay (a star, a rename).
    const kept = this._allSongs;
    if (kept && kept.lib === this.library) return kept.list;
    const songs = this.library.songs;
    if (kept && sameEntries(kept.list.entries, songs, (s) => s.addedAt)) {
      kept.lib = this.library;
      return kept.list;
    }
    const list = {
      id: ALL_SONGS_ID,
      name: ALL_SONGS_NAME,
      entries: songs.map((s) => ({ songId: s.id, addedAt: s.addedAt })),
      isAll: true,
    };
    this._allSongs = { lib: this.library, list };
    return list;
  },

  /**
   * Downloaded Songs, first under All Songs while a Flow Server is in use:
   * every song with a file on this device, the server's (downloaded, or
   * uploaded from here) and the rest (copies of another server's songs, songs
   * not uploaded: lib.deviceSongs, which only play). Null without a server,
   * and in an app that keeps no songs (the web player).
   */
  devicePlaylist() {
    if (!this.server.on || !this.can('localFiles')) return null;
    // Made once per library, as All Songs.
    const kept = this._deviceList;
    if (kept && kept.lib === this.library) return kept.list;
    const songs = [...this.library.songs.filter((s) => s.file), ...(this.library.deviceSongs || [])];
    if (kept && sameEntries(kept.list.entries, songs, (s) => s.addedAt)) {
      kept.lib = this.library;
      return kept.list;
    }
    const list = {
      id: DEVICE_ID,
      name: T('common.downloadedSongs'),
      entries: songs.map((s) => ({ songId: s.id, addedAt: s.addedAt })),
      isDevice: true,
    };
    this._deviceList = { lib: this.library, list };
    return list;
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
    const entries = this._addedBy().get(profileId) || [];
    if (!name || !entries.length) return null;
    return { id: FROM_PREFIX + profileId, name: T('common.allSongsFrom', { profile: name }), menuName: T('common.allSongsFrom.menu', { profile: name }), entries, isFrom: true };
  },

  /** profile id -> the entries of the songs it added, once per library (in one pass). */
  _addedBy() {
    if (this._added && this._added.lib === this.library) return this._added.map;
    const map = new Map();
    for (const s of this.library.songs) {
      if (!s.addedBy) continue;
      let list = map.get(s.addedBy);
      if (!list) map.set(s.addedBy, (list = []));
      list.push({ songId: s.id, addedAt: s.addedAt });
    }
    this._added = { lib: this.library, map };
    return map;
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
    const ids = [...this._addedBy().keys()].filter((id) => profiles || id !== DEFAULT_PROFILE);
    return [...ids].map((id) => this.fromPlaylist(id)).filter(Boolean)
      .sort((a, b) => Util.compareValues(a.menuName, b.menuName));
  },

  /**
   * The favourite songs, shaped like a playlist whose entries were added when
   * made one. On a Flow Server (4.3) it is a playlist of the profile's own
   * (favourites: true), shared and downloaded like the others.
   */
  favouritesPlaylist() {
    const own = this.library.playlists.find((p) => p.favourites);
    if (own) return { ...own, name: FAVOURITES_NAME, isFavourites: true };
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

  /** User playlists by name, A to Z (Favourites is one of the app's own lists). */
  sortedPlaylists() {
    return this.library.playlists.filter((p) => !p.favourites).sort((a, b) => Util.compareValues(a.name, b.name));
  },

  /** The ones songs can be put into by hand: not the smart ones (their rules pick their songs). */
  editablePlaylists() {
    return this.sortedPlaylists().filter((p) => !p.isRuled);
  },

  /** Songs of a playlist as rows: the song plus when it was added to this list. */
  /** A list's rows ({ song, addedAt }), the same array while its entries and the library stay: never to be changed. */
  rowsOf(playlistId) {
    const p = this.playlist(playlistId);
    if (!p) return [];
    const kept = this._rowsKept.get(p.entries);
    if (kept && kept.lib === this.library) return kept.rows;
    // A library changed elsewhere (a song of another list starred): the same
    // rows while each is its song as it was, so their order stays worked out.
    const old = kept ? kept.rows : null;
    let same = !!old;
    const rows = [];
    for (const e of p.entries) {
      const song = this.song(e.songId);
      if (!song) continue;
      const o = old ? old[rows.length] : null;
      if (o && o.song === song && o.addedAt === e.addedAt) {
        rows.push(o);
      } else {
        same = false;
        rows.push({ song, addedAt: e.addedAt });
      }
    }
    if (same && rows.length === old.length) {
      kept.lib = this.library;
      return old;
    }
    this._rowsKept.set(p.entries, { lib: this.library, rows });
    return rows;
  },
  _rowsKept: new WeakMap(),
  _durations: new WeakMap(), // a list's rows (rowsOf) -> their length in seconds

  totalDuration(playlistId) {
    const rows = this.rowsOf(playlistId);
    if (this._durations.has(rows)) return this._durations.get(rows);
    const total = rows.reduce((sum, r) => sum + (r.song.duration || 0), 0);
    this._durations.set(rows, total);
    return total;
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
