'use strict';

// window.flow for the Android app: the same calls the desktop's preload.js
// offers the window, answered here in the page by the shared client
// (@flow/core/client) instead of in Electron's main process. Bundled into
// www/flow-android.js (scripts/bundle.js), which index.html loads before the
// window's own scripts.
//
// What the phone cannot do (Add Songs' own downloads, the music folder, the
// shutdown) answers "not on the phone"; the window hides those controls by
// its caps (@flow/core/client/caps), so they are not offered in the first place.

const { createRemote } = require('@flow/core/client/remote');
const { createActions } = require('@flow/core/client/actions');
const caps = require('@flow/core/client/caps');
const { MP3_QUALITIES } = require('@flow/core/formats');
const { plugin, audio, fileUrl } = require('./native');
const { createAudioEngine, fileAddressToPath } = require('./engine');
const { createEnv } = require('./env');
const { version } = require('../package.json');

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

function start() {
  // ---- the clients ----

  let remote = null;
  const env = createEnv({ tellCovers: (scope, ids) => emit('covers:updated', { scope, ids, dirs: coverDirs() }) });
  const { settings, library, covers } = env;
  settings.load();
  library.load();
  remote = createRemote(env);
  const actions = createActions({ remote, library, files: env.files });

  function coverDirs() {
    return { local: covers.dirOf(covers.LOCAL), server: remote ? remote.coverDir() : '' };
  }

  library.onChange((data) => {
    if (!remote.active()) emit('library:changed', data);
  });

  remote.init({
    onView: (view) => emit('library:changed', view),
    onStatus: (st) => emit('server:status', st),
    onNotice: (text, kind) => emit('server:notice', { text, kind }),
    onSettings: (patch) => emit('settings:changed', patch),
    onLive: (ev) => emit('server:live', ev),
    // Songs of the phone's own going up to a server: the phone keeps none yet.
    confirmUpload: async () => false,
    askExisting: async () => ({ choice: 'keep', all: true }),
  });

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
        const e = new Error((err && err.message) || String(err) || 'Something went wrong.');
        e.cancelled = !!(err && err.cancelled);
        throw e;
      }
    };
  }

  const notHere = (what) => call(() => {
    throw new Error(`${what} is not possible on the phone.`);
  });
  const nothing = () => {};

  const flow = {
    init: call(() => ({
      platform: 'android',
      uiMode: 'mobile',
      caps: caps.ANDROID,
      library: actions.currentLibrary(),
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
      // The password only ever arrives through setServerSecret, to be encrypted.
      const clean = { ...(patch || {}) };
      delete clean.serverSecret;
      const wasRemote = remote.active();
      const next = settings.set(clean);
      remote.reconfigure(clean);
      if (remote.active() !== wasRemote) {
        emit('covers:updated', { scope: '', ids: null, dirs: coverDirs() });
        emit('library:changed', actions.currentLibrary());
      }
      return next;
    }),
    setSettingsNow: (patch) => {
      settings.set(copy(patch));
      return true;
    },
    onLibraryChanged: on('library:changed'),
    onFolderScanned: nothing,

    createPlaylist: call((name) => actions.createPlaylist(name)),
    renamePlaylist: call((id, name) => actions.renamePlaylist({ id, name })),
    deletePlaylist: call((id, deleteSongs = false) => actions.deletePlaylist({ id, deleteSongs })),
    setPlaylistShared: call((id, shared) => actions.setPlaylistShared({ id, shared })),
    setFollowing: call((id, isOn) => actions.setFollowing({ id, on: isOn })),
    addSongToPlaylists: call((songId, playlistIds) => actions.addSongToPlaylists({ songId, playlistIds })),
    addSongsToPlaylist: call((playlistId, songIds) => actions.addSongsToPlaylist({ playlistId, songIds })),
    removeFromPlaylist: call((playlistId, songId) => actions.removeFromPlaylist({ playlistId, songId })),
    deleteSong: call((songId, deleteFile) => actions.deleteSong({ songId, deleteFile })),
    editSong: call((songId, meta) => actions.editSong({ songId, ...meta })),
    trimSong: call((songId, start, end) => actions.trimSong({ songId, start, end })),
    serverSongPeaks: call((songId) => remote.songPeaks(songId)),
    setFavourite: call((songId, isOn) => actions.setFavourite({ songId, on: isOn })),
    recordListen: call((songId, listened, duration, contextId) => actions.recordListen({ songId, listened, duration, contextId })),
    findBySource: call((url, key) => actions.findBySource({ url, key })),
    findByMeta: call((meta) => actions.findByMeta(meta)),
    rescan: call(() => library.scan()),
    showSong: notHere('Showing a song\'s file'),
    openMusicFolder: notHere('Opening the music folder'),
    folderStats: notHere('The music folder'),
    chooseFolder: notHere('Choosing a folder'),
    moveMusicFolder: notHere('Moving the music folder'),
    onFolderProgress: nothing,

    // Add Songs on the phone downloads through the server ("Download (Server)").
    probe: notHere('Downloading on the phone'),
    listImport: notHere('Importing on the phone'),
    downloadImport: notHere('Importing on the phone'),
    pickLocalFiles: notHere('Adding files'),
    pickLocalFolder: notHere('Adding a folder'),
    listLocal: notHere('Adding files'),
    prepareLocal: notHere('Adding files'),
    finishImport: notHere('Importing on the phone'),
    setImportPending: call(nothing),
    cancelImport: call(nothing),
    onImportProgress: nothing,
    openUrl: call((url) => {
      if (/^https:\/\//i.test(String(url || ''))) return plugin.openUrl({ url: String(url) });
      return undefined;
    }),
    scheduleShutdown: notHere('Shutting down'),
    cancelShutdown: call(() => false),
    // Notifications come with playing in the background.
    notify: call(() => false),
    notifySession: call(() => false),
    download: notHere('Downloading on the phone'),
    cancelDownload: call(nothing),
    discardDownload: call(nothing),
    onDownloadProgress: nothing,
    peaks: notHere('Reading a file\'s waveform'),
    sponsorSegments: call(() => []),

    serverStatus: call(() => remote.status()),
    setServerSecret: call((text) => remote.setSecret(text)),
    syncNow: call(() => remote.syncNow()),
    setOffline: call((playlistId, isOn) => remote.setOffline(playlistId, !!isOn)),
    downloadServerSong: call((songId) => remote.downloadSong(songId)),
    removeServerDownload: call((songId) => remote.removeDownload(songId)),
    profiles: call(() => remote.loadProfiles()),
    profileLogin: call((profileId, pin) => remote.loginProfile(profileId, pin)),
    profileCreate: call((name, pin) => remote.createProfile(name, pin)),
    profileLogout: call(() => remote.logoutProfile()),
    profileRename: call((name) => remote.renameProfile(name)),
    profileDelete: call(() => remote.deleteProfile()),
    onServerStatus: on('server:status'),
    // No browser cookies on the phone to share with the server.
    serverDownloads: call((action, args = {}) => remote.serverDownloads(action, { ...args })),
    cookieBrowsers: call(() => []),
    onServerNotice: on('server:notice'),
    sessions: call((body) => remote.sessions(body || null)),
    onServerLive: on('server:live'),
    onSettingsChanged: on('settings:changed'),
    finishSong: notHere('Saving a download on the phone'),
    wantCovers: call((ids) => {
      if (remote.active()) remote.wantCovers(ids);
    }),
    coverStats: call(() => ({ local: covers.localStore().size(), server: remote.active() ? remote.coverStats() : null })),
    clearCoverCache: call(() => remote.clearCoverCache()),
    onCoversUpdated: on('covers:updated'),
    stagedCover: call(() => null),
    onCoverStaged: nothing,

    // The phone's own (no desktop counterpart).
    /** A file in the app's storage as an address for <img> and <audio> (Util.fileUrl). */
    fileUrl,
    /** Back pressed (the button or the gesture): fn decides what it closes. */
    onBack: (fn) => plugin.addListener('back', () => fn()),
    /** Back with nothing left to close: Flow goes to the background. */
    leave: call(() => plugin.leave()),
    /** What the player plays through: the phone's own player, for the background (engine.js). */
    createAudioEngine: () => createAudioEngine({
      plugin: audio,
      toPath: (address) => fileAddressToPath(address, window.location.origin),
    }),
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
