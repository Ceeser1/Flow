'use strict';

// window.flow for the Android app (and the iPhone's, apps/ios, which has the
// same plugins in Swift): the same calls the desktop's preload.js offers the
// window, answered here in the page by the shared client (@flow/core/client)
// instead of in Electron's main process. Bundled into www/flow-android.js
// (scripts/bundle.js), which index.html loads before the window's own scripts.
//
// What the phone cannot do (Add Songs' own downloads, the music folder, the
// shutdown) answers "not on the phone"; the window hides those controls by
// its caps (@flow/core/client/caps), so they are not offered in the first place.
// Local files go through localFiles.js.

const { createRemote } = require('@flow/core/client/remote');
const { createActions } = require('@flow/core/client/actions');
const caps = require('@flow/core/client/caps');
const { MP3_QUALITIES } = require('@flow/core/formats');
const {
  platform, plugin, audio, fileUrl, fs, path, info,
} = require('./native');
const { createAudioEngine, fileAddressToPath } = require('./engine');
const { createEnv } = require('./env');
const { createLocalFiles } = require('./localFiles');
const { sharedLink } = require('./share');
const { latestRelease, isNewer } = require('./update');
const ask = require('./ask');
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
    // Songs of the phone's own going up to a server, asked in the window (ask.js).
    confirmUpload: (q) => ask.upload(q),
    askExisting: (q) => ask.existing(q),
  });
  // The phone's player signed in again by itself (the server had ended the
  // session while this page slept): its token is this app's now.
  audio.addListener('signedIn', (e) => remote.adoptToken(e && e.token));

  // Files picked wait here until saved; what a closed Flow left behind goes.
  const stageDir = path.join(info().files, 'Import');
  try {
    if (fs.exists(stageDir)) fs.remove(stageDir, { recursive: true });
  } catch {
    // Tried again at the next start.
  }
  const local = createLocalFiles({
    plugin,
    fs,
    path,
    stageDir,
    library,
    covers,
    exporter: env.exporter,
    remote,
    progress: (p, run) => emit('import:progress', { ...p, run }),
    onStaged: (staged) => emit('cover:staged', staged),
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

  // What the phone's player had when this page started (FlowAudio.attach), for its engine.
  let attached = null;

  // ---- updates (update.js) ----

  plugin.addListener('downloadProgress', ({ id, frac }) => {
    if (id === 'flow-update') emit('update:progress', { frac });
  });

  /** The newest release and whether it is newer than this Flow: { current, latest, newer }. */
  async function checkUpdate() {
    const latest = await latestRelease();
    return { current: version, latest, newer: !!latest && isNewer(latest.version, version) };
  }

  /**
   * Downloads the release `found` ({ version, url, size }) into the cache
   * (once: a complete copy is used again) and hands it to Android's
   * installer: { allowed, started }; not allowed yet, Android's setting for it opened.
   */
  async function installUpdate(found, { ask = true } = {}) {
    if (!found || !isNewer(found.version, version) || !/^https:\/\//.test(String(found.url))) {
      throw new Error('There is no newer Flow to install.');
    }
    const dir = path.join(info().cache, 'update');
    const file = path.join(dir, `Flow-${found.version}.apk`);
    const whole = fs.exists(file) && (!found.size || fs.size(file) === found.size);
    if (!whole) {
      if (fs.exists(dir)) fs.remove(dir, { recursive: true });
      fs.mkdir(dir);
      let r;
      try {
        r = await plugin.download({ url: found.url, path: file, id: 'flow-update', timeout: 60000 });
      } catch {
        throw new Error('The update could not be downloaded. Is the phone online?');
      }
      if (r.status !== 200) throw new Error(`The update could not be downloaded (GitHub answered ${r.status}).`);
    }
    return plugin.installApk({ path: file, ask: !!ask });
  }

  const flow = {
    init: call(async () => {
      attached = await audio.attach().catch(() => null);
      return {
        platform,
        uiMode: 'mobile',
        caps: platform === 'ios' ? caps.IOS : caps.ANDROID,
        library: actions.currentLibrary(),
        server: remote.status(),
        settings: settings.all(),
        musicDir: '',
        tools: {},
        mp3Qualities: MP3_QUALITIES,
        version,
        iconDataUrl: '',
        covers: coverDirs(),
      };
    }),
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

    // Add Songs on the phone downloads through the server ("Download (Server)");
    // local files are its own (localFiles.js).
    probe: notHere('Downloading on the phone'),
    listImport: notHere('Importing on the phone'),
    downloadImport: notHere('Importing on the phone'),
    pickLocalFiles: call(() => local.pick(false)),
    pickLocalFolder: call(() => local.pick(true)),
    listLocal: call((picked) => local.listLocal(picked)),
    prepareLocal: call((items, opts, run) => local.prepareLocal(items, run)),
    finishImport: call((job, run) => local.finish(job, (p) => emit('import:progress', { ...p, run }))),
    setImportPending: call(nothing),
    cancelImport: call(() => local.cancel()),
    onImportProgress: on('import:progress'),
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
    discardDownload: call((cachePath) => local.discard(cachePath)),
    onDownloadProgress: nothing,
    // A song's waveform for the trim, read by Android's decoder (FlowNative.peaks).
    peaks: call(async (file, duration) => (await plugin.peaks({ path: String(file || ''), duration: Number(duration) || 0 })).peaks),
    sponsorSegments: call(() => []),

    serverStatus: call(() => remote.status()),
    setServerSecret: call((text) => remote.setSecret(text)),
    syncNow: call(() => remote.syncNow()),
    setOffline: call((playlistId, isOn) => remote.setOffline(playlistId, !!isOn)),
    downloadServerSong: call((songId) => remote.downloadSong(songId)),
    removeServerDownload: call((songId) => remote.removeDownload(songId)),
    /** Settings > Storage's Remove: every download (as remote.removeAllDownloads). */
    removeAllDownloads: call(() => remote.removeAllDownloads()),
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
    stagedCover: call((cachePath) => local.stagedCover(cachePath)),
    onCoverStaged: on('cover:staged'),

    // The phone's own (no desktop counterpart).
    /** A file in the app's storage as an address for <img> and <audio> (Util.fileUrl). */
    fileUrl,
    /**
     * Settings > Storage: the songs kept on the phone and their bytes, those
     * downloaded from the server apart ({ songs, bytes, downloaded, downloadedBytes }).
     */
    storageStats: call(() => {
      const out = { songs: 0, bytes: 0, downloaded: 0, downloadedBytes: 0 };
      for (const s of library.get().songs) {
        const size = Math.max(0, fs.size(s.file));
        out.songs += 1;
        out.bytes += size;
        if (remote.isServerCopy(s.id)) {
          out.downloaded += 1;
          out.downloadedBytes += size;
        }
      }
      return out;
    }),
    /** Back pressed (the button or the gesture): fn decides what it closes. */
    onBack: (fn) => plugin.addListener('back', () => fn()),
    /** Back with nothing left to close: Flow goes to the background. */
    leave: call(() => plugin.leave()),
    /** Where the music comes out now (a name), Android's chooser of it, and its changes. */
    outputName: call(async () => (await plugin.output()).name),
    /** The same as { name, builtin } (builtin: the phone's own speaker). */
    output: call(() => plugin.output()),
    chooseOutput: call(() => plugin.chooseOutput()),
    onOutputChange: (fn) => plugin.addListener('outputChanged', () => fn()),
    /** The phone's media volume (0-1), as its buttons set it; a session's host takes members' changes there. */
    mediaVolume: call(async () => (await plugin.mediaVolume()).value),
    setMediaVolume: call(async (value) => (await plugin.setMediaVolume({ value })).value),
    onMediaVolume: (fn) => plugin.addListener('mediaVolume', (e) => fn(e.value)),
    /**
     * What this app last told the server it plays (Active Sessions: { base,
     * token, client, state, shift, offset }), which the player tells it again
     * while Flow is out of sight and its page frozen; null: hosting nothing.
     */
    keepSession: call((o) => audio.keepSession(o || { off: true })),
    /** A link shared to Flow (Android's Share): fn({ url, text }), url '' when there was none. */
    onShare: (fn) => plugin.addListener('share', (s) => fn(sharedLink(s))),
    /** Whether the window may turn sideways (Add Songs) or stays upright. */
    setOrientation: call((free) => plugin.orientation({ free: !!free })),
    /** The newest Flow on GitHub: { current, latest: { version, url, size, page } or null, newer }. */
    checkUpdate: call(checkUpdate),
    /** Downloads it (progress: onUpdateProgress) and opens Android's installer: { allowed, started }. */
    installUpdate: call(installUpdate),
    onUpdateProgress: on('update:progress'),
    /** How Android treats Flow in the background: { unrestricted, restricted, maker }. */
    power: call(() => plugin.power()),
    /** Android's "Let Flow always run in the background?" */
    allowBackground: call(() => plugin.allowBackground()),
    /** Flow's page in Android's settings (its Battery). */
    appSettings: call(() => plugin.appSettings()),
    /** Back in Flow from elsewhere (Android's settings). */
    onResume: (fn) => plugin.addListener('resume', () => fn()),
    /** What the player plays through: the phone's own player, for the background (engine.js). */
    createAudioEngine: () => createAudioEngine({
      plugin: audio,
      attached,
      // Capacitor's address of the page (capacitor://localhost on the iPhone, whose origin reads "null").
      toPath: (address) => fileAddressToPath(address, window.WEBVIEW_SERVER_URL || window.location.origin),
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
