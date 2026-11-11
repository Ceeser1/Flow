'use strict';

// window.flow for the web player: the same calls the desktop's preload.js
// offers the window, answered here in the page by the shared client
// (@flow/core/client), as the Android app's (apps/android/src/main.js) are.
// Bundled into dist/flow-web.js (scripts/build.js), which index.html loads
// before the window's own scripts.
//
// The page is only a player of one Flow Server: the browser talks to it
// straight (no service of the page's own in between), the server's songs
// stream into the window's <audio>, its covers load from it. What a browser
// cannot do (songs of its own, downloads here, the music folder, finding
// servers on the network) answers "not in the browser"; the window hides
// those controls by its caps (@flow/core/client/caps WEB), so they are not
// offered in the first place.
//
// The layout is the desktop's, or the phone's on a phone-sized screen
// (?ui=mobile or ?ui=desktop picks one), chosen when the page opens.

const { createRemote } = require('@flow/core/client/remote');
const { createActions } = require('@flow/core/client/actions');
const vizPicture = require('@flow/core/client/vizPicture');
const { createPrivateStats } = require('@flow/core/client/privateStats');
const { createLyricsClient } = require('@flow/core/client/lyrics');
const { createLyricsFolder } = require('@flow/core/client/lyricsFolder');
const { encode: encodeQr } = require('@flow/core/qr');
const caps = require('@flow/core/client/caps');
const { createViewChannel } = require('@flow/core/client/viewChannel');
const { MP3_QUALITIES } = require('@flow/core/formats');
const { tr, useTranslator } = require('@flow/core/lang');
const { createEnv } = require('./env');
const { version } = require('../package.json');

// The shared client's messages (the server connection, Download (Server)) in
// the window's language: i18n.js loads after this bundle, so it is asked only
// when a message is made.
useTranslator((key, vars) => {
  const i18n = typeof window !== 'undefined' && window.I18n;
  return i18n && i18n.has(key) ? i18n.t(key, vars) : null;
});

// ---- events to the window (the preload's on* calls) ----

const listeners = new Map();
const on = (name) => (fn) => {
  if (!listeners.has(name)) listeners.set(name, []);
  listeners.get(name).push(fn);
};

// The window gets copies, as through Electron's IPC: what it does with them
// never changes the client's own.
const copy = (value) => (value === undefined ? undefined : structuredClone(value));

function emit(name, payload) {
  for (const fn of listeners.get(name) || []) {
    try {
      fn(copy(payload));
    } catch (err) {
      console.error(err);
    }
  }
}

/** 'mobile' on a phone-sized screen, else 'desktop'; ?ui= decides when given. */
function pickLayout() {
  const asked = new URLSearchParams(location.search).get('ui');
  if (asked === 'mobile' || asked === 'desktop') return asked;
  const narrow = matchMedia('(max-width: 760px)').matches;
  const touchPhone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
  return narrow || touchPhone ? 'mobile' : 'desktop';
}

/** The system, as the desktop's process.platform names it (keyboard hints: Ctrl or ⌘). */
function osName() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
  if (/mac|iphone|ipad/i.test(p)) return 'darwin';
  if (/win/i.test(p)) return 'win32';
  return 'linux';
}

function playsVorbis() {
  try {
    return !!document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"');
  } catch {
    return false;
  }
}

function start() {
  const uiMode = pickLayout();
  const vorbis = playsVorbis();

  // ---- the clients ----

  let remote = null;
  const env = createEnv({ tellCovers: (scope, ids, size) => emit('covers:updated', { scope, ids, size, dirs: coverDirs() }), vorbis });
  const { settings, library, storage, memfs } = env;
  settings.load();
  library.load();
  // A password kept by a browser session that has ended is no longer here: the server asks again.
  if (settings.get('serverSecret') && !storage.hasSecret(settings.get('serverSecret'))) settings.set({ serverSecret: '' });
  remote = createRemote(env);
  // The Statistics of everything heard in this browser (privateStats.js).
  const privateStats = createPrivateStats({
    jsonFiles: env.jsonFiles,
    deviceId: () => settings.clientId(),
    onChange: (data) => emit('stats:private', data),
  });
  const actions = createActions({
    remote, library, files: env.files, privateStats,
  });
  // A song's lyrics: the server's, else LRCLIB's through the page's fetch.
  const lyricsClient = createLyricsClient({
    remote,
    library,
    folder: createLyricsFolder(env.lyricsFiles),
    jsonFiles: env.jsonFiles,
    fetchOn: () => settings.get('lyricsOn') !== false,
    syncEveryMs: 15 * 60 * 1000,
    skip: (id) => remote.active() && remote.isServerCopy(id),
    onChange: () => emit('lyrics:changed'),
    fetch: (...args) => fetch(...args),
    agent: false,
  });

  function coverDirs() {
    return { local: env.covers.dirOf(env.covers.LOCAL), server: remote ? remote.coverDir() : '' };
  }

  // Covers load from the server with its token: a new token (or the first
  // connection) has every cover on screen load again, once the window knows
  // the server is online (the status first).
  let coverKey = '';
  function onStatus(st) {
    emit('server:status', st);
    const key = st && st.state === 'online' ? `${st.base}|${st.token}` : '';
    if (key !== coverKey) {
      coverKey = key;
      emit('covers:updated', { scope: '', ids: null, dirs: coverDirs() });
    }
  }

  // The library on its way to the window: whole at its start, then only what changed (4.3.3).
  const toWindow = createViewChannel((msg) => emit('library:changed', msg));
  // The window's first library, numbered: the next change fits it.
  const startLibrary = () => {
    const lib = actions.currentLibrary();
    return { library: lib, librarySeq: toWindow.start(lib) };
  };
  library.onChange((data) => {
    if (!remote.active()) toWindow.update(data);
  });

  remote.init({
    onView: (view) => toWindow.update(view),
    onStatus,
    onNotice: (text, kind) => emit('server:notice', { text, kind }),
    onSettings: (patch) => emit('settings:changed', patch),
    onLive: (ev) => emit('server:live', ev),
    // Nothing of the browser's own goes up: there is nothing to ask about.
    confirmUpload: async () => false,
    askExisting: async () => 'skip',
  });

  /**
   * A file as an address for <img> and <audio> (Util.fileUrl): a cover in
   * the server's folder straight from the server, with its token; a file in
   * the page's memory as a blob:; anything else as an address that loads
   * nothing (the window shows its note instead). A cover's size is its
   * folder's (thumbnails 128 x 128, high_res 512 x 512: only with the
   * high-res setting, else the small one stands in).
   */
  const coverPath = /^\/flow\/Covers\/([\w-]+)\/(thumbnails|high_res)\/([\w-]{1,64})\.webp$/;
  function fileUrl(p) {
    const m = coverPath.exec(String(p || ''));
    if (m) {
      const st = remote.status();
      if (m[1] === env.covers.LOCAL || st.state !== 'online' || !st.base) return 'data:,';
      const size = m[2] === 'high_res' && env.settings.get('highResCovers') !== false ? 'big' : 'small';
      // "Cover thumbnails cache" unticked: the lists ask the server for none.
      if (size === 'small' && env.settings.get('thumbCovers') === false) return 'data:,';
      const query = [`size=${size}`, st.token ? `t=${encodeURIComponent(st.token)}` : ''].filter(Boolean).join('&');
      return `${st.base}/api/songs/${encodeURIComponent(m[3])}/cover?${query}`;
    }
    return memfs.url(p) || 'data:,';
  }

  // ---- the calls ----

  /**
   * Each call answers a copy of its value, or rejects with an Error as the
   * preload's do (`cancelled` when the user called it off). Arguments are copied
   * in too.
   */
  function call(fn) {
    return async (...args) => {
      try {
        return copy(await fn(...args.map(copy)));
      } catch (err) {
        const e = new Error((err && err.message) || String(err) || tr('common.wentWrong', 'Something went wrong.'));
        e.cancelled = !!(err && err.cancelled);
        throw e;
      }
    };
  }

  // `key` / `english`: what cannot be done ("Downloading in the browser").
  const notHere = (key, english) => call(() => {
    throw new Error(tr('web.notHere', '{what} is not possible in the browser.', { what: tr(key, english) }));
  });
  const nothing = () => {};

  const pageCaps = {
    ...caps.WEB,
    vorbis,
    // The phone's layout has no volume slider (a phone's is its buttons) and no keyboard.
    keyboard: uiMode === 'desktop',
    volume: uiMode === 'desktop',
  };

  const flow = {
    // The texts' language chosen in Settings ('' for the browser's), read once
    // as the desktop's preload does: i18n.js needs it before anything is drawn,
    // and the page loads again to switch.
    language: settings.get('language') || '',
    init: call(async () => ({
      platform: 'web',
      os: osName(),
      uiMode,
      caps: pageCaps,
      ...startLibrary(),
      server: remote.status(),
      settings: settings.all(),
      musicDir: '',
      tools: {},
      mp3Qualities: MP3_QUALITIES,
      version,
      iconDataUrl: '',
      covers: coverDirs(),
    })),
    setSettings: call((patch) => {
      // The password only ever arrives through setServerSecret, to be kept as a secret.
      const clean = { ...(patch || {}) };
      delete clean.serverSecret;
      const wasRemote = remote.active();
      const next = settings.set(clean);
      remote.reconfigure(clean);
      if (clean.lyricsOn === true) {
        lyricsClient.sync();
        lyricsClient.fill();
      }
      if (remote.active() !== wasRemote) {
        emit('covers:updated', { scope: '', ids: null, dirs: coverDirs() });
        toWindow.whole(actions.currentLibrary());
      }
      return next;
    }),
    setSettingsNow: (patch) => {
      settings.set(copy(patch));
      return true;
    },
    onLibraryChanged: on('library:changed'),
    // A change that did not fit: the library comes whole through onLibraryChanged.
    libraryWhole: call(() => {
      toWindow.whole(actions.currentLibrary());
      return true;
    }),
    onFolderScanned: nothing,

    createPlaylist: call((name) => actions.createPlaylist(name)),
    createSmartPlaylist: call((name, rules) => actions.createSmartPlaylist({ name, rules })),
    setPlaylistRules: call((id, rules) => actions.setPlaylistRules({ id, rules })),
    renamePlaylist: call((id, name) => actions.renamePlaylist({ id, name })),
    deletePlaylist: call((id, deleteSongs = false) => actions.deletePlaylist({ id, deleteSongs })),
    createGroup: call((name) => actions.createGroup(name)),
    renameGroup: call((id, name) => actions.renameGroup({ id, name })),
    deleteGroup: call((id) => actions.deleteGroup(id)),
    setPlaylistGroup: call((playlistIds, groupId) => actions.setPlaylistGroup({ playlistIds, groupId })),
    setPlaylistShared: call((id, shared) => actions.setPlaylistShared({ id, shared })),
    setFollowing: call((id, isOn) => actions.setFollowing({ id, on: isOn })),
    setGroupShared: call((id, shared) => actions.setGroupShared({ id, shared })),
    setGroupFollowing: call((id, isOn) => actions.setGroupFollowing({ id, on: isOn })),
    setGroupPlaylistFollowed: call((groupId, playlistId, isOn) => actions.setGroupPlaylistFollowed({ groupId, playlistId, on: isOn })),
    addSongToPlaylists: call((songId, playlistIds) => actions.addSongToPlaylists({ songId, playlistIds })),
    addSongsToPlaylist: call((playlistId, songIds) => actions.addSongsToPlaylist({ playlistId, songIds })),
    removeFromPlaylist: call((playlistId, songId) => actions.removeFromPlaylist({ playlistId, songId })),
    deleteSong: call((songId, deleteFile) => actions.deleteSong({ songId, deleteFile })),
    editSong: call((songId, meta) => actions.editSong({ songId, ...meta })),
    trimSong: call((songId, start, end) => actions.trimSong({ songId, start, end })),
    serverSongPeaks: call((songId) => remote.songPeaks(songId)),
    setFavourite: call((songId, isOn) => actions.setFavourite({ songId, on: isOn })),
    privateStatistics: call(() => privateStats.get()),
    onPrivateStatistics: on('stats:private'),
    removeTrackedProfile: call((serverId, profileId) => remote.removeTracked(serverId, profileId)),
    serverStatistics: call(() => remote.loadStatistics()),
    loadShared: call(() => remote.loadShared()),
    openShared: call((id) => remote.openShared(id)),
    recordListen: call((songId, listened, duration, contextId, jamMember) => actions.recordListen({
      songId, listened, duration, contextId, jamMember: !!jamMember,
    })),
    findBySource: call((url, key) => actions.findBySource({ url, key })),
    findByMeta: call((meta) => actions.findByMeta(meta)),
    rescan: call(() => library.scan()),
    showSong: notHere('common.notHere.showSongFile', 'Showing a song\'s file'),
    openMusicFolder: notHere('common.notHere.openMusicFolder', 'Opening the music folder'),
    folderStats: notHere('common.notHere.musicFolder', 'The music folder'),
    chooseFolder: notHere('common.notHere.chooseFolder', 'Choosing a folder'),
    moveMusicFolder: notHere('common.notHere.moveMusicFolder', 'Moving the music folder'),
    onFolderProgress: nothing,

    // Add Songs in the browser downloads through the server ("Download (Server)") only.
    probe: notHere('web.notHere.download', 'Downloading'),
    listImport: notHere('web.notHere.import', 'Importing'),
    searchSongs: notHere('web.notHere.searchSongs', 'Searching for songs'),
    cancelSearch: call(nothing),
    downloadImport: notHere('web.notHere.import', 'Importing'),
    pickLocalFiles: notHere('web.notHere.addFiles', 'Adding files of this device'),
    pickLocalFolder: notHere('web.notHere.addFolder', 'Adding a folder of this device'),
    // A visualizer's picture: kept in the page's memory, for as long as it is open.
    saveVizPicture: call((name, bytes) => {
      const ext = vizPicture.check(name, bytes, 60);
      const dir = '/flow/Visualizer';
      for (const old of memfs.list(dir)) if (vizPicture.keptBefore(old.name, name)) memfs.remove(`${dir}/${old.name}`);
      const file = `${dir}/${name}-${Date.now().toString(36)}.${ext}`;
      memfs.writeBytes(file, bytes);
      return file;
    }),
    listLocal: notHere('web.notHere.addFiles', 'Adding files of this device'),
    prepareLocal: notHere('web.notHere.addFiles', 'Adding files of this device'),
    finishImport: notHere('web.notHere.addFiles', 'Adding files of this device'),
    setImportPending: call(nothing),
    // Add Songs' Client queue (4.4) is the computer's only: nothing downloads here.
    peekLink: call(nothing),
    cancelPeek: call(nothing),
    setQueuePending: call(nothing),
    cancelImport: call(nothing),
    onImportProgress: on('import:progress'),
    openUrl: call((url) => {
      if (/^https:\/\//i.test(String(url || ''))) window.open(String(url), '_blank', 'noopener');
    }),
    scheduleShutdown: notHere('common.notHere.shutDown', 'Shutting down'),
    cancelShutdown: call(() => false),
    notify: call(() => false),
    notifySession: call(() => false),
    download: notHere('web.notHere.download', 'Downloading'),
    cancelDownload: call(nothing),
    discardDownload: call(nothing),
    onDownloadProgress: nothing,
    peaks: notHere('web.notHere.readFile', 'Reading a file of this device'),
    sponsorSegments: call(() => []),
    /** A server song's file, whole (seekCheck.js decodes it to find where a seek in an MP3 landed). */
    songAudio: call(async (songId) => {
      const st = remote.status();
      if (st.state !== 'online' || !st.base) throw new Error(tr('common.unreachable', 'The server cannot be reached.'));
      const q = [st.token ? `t=${encodeURIComponent(st.token)}` : '', vorbis ? '' : 'vorbis=0'].filter(Boolean).join('&');
      const res = await fetch(`${st.base}/api/songs/${encodeURIComponent(String(songId))}/audio${q ? `?${q}` : ''}`);
      if (!res.ok) throw new Error(tr('common.serverFailed', 'The server could not send it.'));
      return new Uint8Array(await res.arrayBuffer());
    }),

    serverStatus: call(() => remote.status()),
    /**
     * The web player's own Logout (the menu's server line): this browser
     * forgets the server, its password and token, the profile and what this
     * browser heard; the look and sound settings stay. The window loads
     * again after it, at the connect form.
     */
    logout: call(() => {
      remote.stop();
      settings.set({
        serverOn: false, serverHome: '', serverRemote: '', serverHomeOn: true, serverRemoteOn: true, serverSecret: '', serverNames: {},
      });
      storage.forget(['server-sync.json', 'server-others.json', 'server-library.json', 'tracked-profiles.json', 'private-statistics.json']);
    }),
    setServerSecret: call((text) => remote.setSecret(text)),
    syncNow: call(() => remote.syncNow()),
    setOffline: notHere('web.notHere.offline', 'Keeping songs for offline'),
    downloadServerSong: notHere('web.notHere.offline', 'Keeping songs for offline'),
    removeServerDownload: call(nothing),
    removeDeviceSong: call(nothing),
    switchServer: call((id) => remote.switchServer(id)),
    forgetServer: call((id) => remote.forgetServer(id)),
    removeAllDownloads: call(nothing),
    profiles: call(() => remote.loadProfiles()),
    profileLogin: call((profileId, pin) => remote.loginProfile(profileId, pin)),
    profileCreate: call((name, pin) => remote.createProfile(name, pin)),
    profileLogout: call(() => remote.logoutProfile()),
    profileRename: call((name, pin) => remote.renameProfile(name, pin)),
    profilePin: call((pin, newPin) => remote.changePin(pin, newPin)),
    profileDelete: call(() => remote.deleteProfile()),
    admin: call((route, body) => remote.admin(route, body)),
    changeServerPassword: call((args) => remote.changeServerPassword(args || {})),
    onServerStatus: on('server:status'),
    serverDownloads: call(async (action, args = {}) => {
      const result = await remote.serverDownloads(action, { ...args });
      // A song saved on the server from here is one this browser added.
      if (action === 'finish' && result && result.song) privateStats.added(1);
      return result;
    }),
    cookieBrowsers: call(() => []),
    onServerNotice: on('server:notice'),
    sessions: call((body) => remote.sessions(body || null)),
    onServerLive: on('server:live'),
    onSettingsChanged: on('settings:changed'),
    finishSong: notHere('web.notHere.saveDownload', 'Saving a download'),
    lyrics: call((songId) => lyricsClient.get(songId)),
    lyricsStats: call(() => lyricsClient.stats()),
    clearLyricsCache: call(() => lyricsClient.clear()),
    onLyricsChanged: on('lyrics:changed'),
    shareLink: call(() => remote.shareLink()),
    recordAwayListen: call((song, listened, duration) => actions.recordAwayListen({ song, listened, duration })),
    // Guests of other servers' sessions need the network searched (caps.guests is off).
    guest: notHere('web.notHere.joinOtherServer', 'Joining another server\'s session'),
    onGuestLive: nothing,
    onGuestChanged: nothing,
    connectLink: call((text) => remote.connectLink(String(text || ''))),
    qr: call((text) => encodeQr(String(text || ''))),
    wantCovers: call(nothing),
    coverStats: call(() => ({ local: { small: { count: 0, bytes: 0 }, big: { count: 0, bytes: 0 } }, server: remote.active() ? remote.coverStats() : null })),
    clearCoverCache: call((size) => remote.clearCoverCache(size === 'small' || size === 'big' ? size : null)),
    onCoversUpdated: on('covers:updated'),
    stagedCover: call(() => null),
    onCoverStaged: nothing,

    fileUrl,
  };

  return flow;
}

// Started before the window's scripts run; what fails here is what the window
// says when it cannot start ("Flow could not start: ...").
try {
  window.flow = start();
} catch (err) {
  console.error(err);
  window.flow = { init: () => Promise.reject(err) };
}
