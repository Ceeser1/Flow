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
const { createPrivateStats } = require('@flow/core/client/privateStats');
const { createLyricsClient } = require('@flow/core/client/lyrics');
const { createLyricsFolder } = require('@flow/core/client/lyricsFolder');
const { encode: encodeQr } = require('@flow/core/qr');
const { createGuestLink } = require('@flow/core/client/guest');
const caps = require('@flow/core/client/caps');
const { MP3_QUALITIES } = require('@flow/core/formats');
const {
  platform, plugin, audio, fileUrl, fs, path, info,
} = require('./native');
const { createAudioEngine, fileAddressToPath } = require('./engine');
const { createEnv } = require('./env');
const { createLocalFiles } = require('./localFiles');
const { sharedLink } = require('./share');
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
  // The Statistics of everything heard on this phone (privateStats.js).
  const privateStats = createPrivateStats({
    jsonFiles: env.jsonFiles,
    deviceId: () => settings.clientId(),
    onChange: (data) => emit('stats:private', data),
  });
  const actions = createActions({
    remote, library, files: env.files, privateStats,
  });
  // A song's lyrics (4.0): the server's, else LRCLIB's through the page's
  // fetch, which cannot name Flow as its User-Agent; kept in the Lyrics
  // folder (4.0.1), only that with Settings' "Fetch/Sync Lyrics" off.
  const lyricsClient = createLyricsClient({
    remote,
    library,
    folder: createLyricsFolder(env.lyricsFiles),
    jsonFiles: env.jsonFiles,
    fetchOn: () => settings.get('lyricsOn') !== false,
    syncEveryMs: 15 * 60 * 1000,
    // Copies of a server's songs have the server's lyrics.
    skip: (id) => remote.active() && remote.isServerCopy(id),
    onChange: () => emit('lyrics:changed'),
    fetch: (...args) => fetch(...args),
    agent: false,
  });
  /**
   * One of this phone's songs into the session it is a guest in (4.0): its
   * file here, else the server's audio fetched into the cache first.
   * Resolves { gid }.
   */
  async function bringSong(songId) {
    const song = actions.currentLibrary().songs.find((s) => s.id === songId);
    if (!song) throw new Error('That song is not in your library.');
    const audio = remote.active() ? await remote.songAudio(songId) : { file: song.file, temp: false };
    if (!audio.file || !fs.exists(audio.file)) throw new Error(`"${song.title}" has no file to send along.`);
    const gid = `g-${settings.clientId().slice(0, 12)}-${songId}`.replace(/[^\w-]/g, '').slice(0, 64);
    const ext = (/\.([a-z0-9]+)$/i.exec(song.file || audio.file) || [])[1] || song.format || 'mp3';
    try {
      await guest.upload(gid, {
        title: song.title, artist: song.artist, mix: song.mix, duration: song.duration, format: ext.toLowerCase(),
      }, audio.file);
    } finally {
      if (audio.temp) {
        try {
          fs.remove(audio.file);
        } catch {
          // Emptied with the cache.
        }
      }
    }
    return { gid };
  }

  // Being a guest in another server's session on this network (4.0).
  const guest = createGuestLink({
    http: env.http,
    device: env.device,
    clientId: () => settings.clientId(),
    discovery: env.discovery,
    ownServerId: () => (remote.active() ? remote.status().serverId : ''),
    who: () => {
      const st = remote.status();
      return { profileName: st.on && st.profile ? st.profile.name : '', serverName: st.on ? st.serverName || st.name : '' };
    },
    onLive: (ev) => emit('guest:live', ev),
    onChange: () => emit('guest:changed', guest.list()),
  });

  function coverDirs() {
    return { local: covers.dirOf(covers.LOCAL), server: remote ? remote.coverDir() : '' };
  }

  library.onChange((data) => {
    if (!remote.active()) emit('library:changed', data);
  });
  // Every Local Files song's lyrics in the background (4.0.1): now, and soon after a change.
  library.onChange(() => lyricsClient.fillSoon());
  lyricsClient.fillSoon();

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
      if (clean.lyricsOn === true) {
        lyricsClient.sync();
        lyricsClient.fill();
      }
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
    createSmartPlaylist: call((name, rules) => actions.createSmartPlaylist({ name, rules })),
    setPlaylistRules: call((id, rules) => actions.setPlaylistRules({ id, rules })),
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
    privateStatistics: call(() => privateStats.get()),
    onPrivateStatistics: on('stats:private'),
    removeTrackedProfile: call((serverId, profileId) => remote.removeTracked(serverId, profileId)),
    recordListen: call((songId, listened, duration, contextId, jamMember) => actions.recordListen({
      songId, listened, duration, contextId, jamMember: !!jamMember,
    })),
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
    // A song's name typed into the box goes to the server too (serverDownloads 'search').
    searchSongs: notHere('Searching for songs on the phone'),
    cancelSearch: call(nothing),
    downloadImport: notHere('Importing on the phone'),
    pickLocalFiles: call(() => local.pick(false)),
    pickLocalFolder: call(() => local.pick(true)),
    listLocal: call((picked) => local.listLocal(picked)),
    prepareLocal: call((items, opts, run) => local.prepareLocal(items, run)),
    finishImport: call(async (job, run) => {
      const summary = await local.finish(job, (p) => emit('import:progress', { ...p, run }));
      privateStats.added(summary && summary.songIds ? summary.songIds.length : 0);
      return summary;
    }),
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
    removeDeviceSong: call((songId) => remote.removeDeviceSong(songId)),
    switchServer: call((id) => remote.switchServer(id)),
    forgetServer: call((id) => remote.forgetServer(id)),
    /** Settings > Media Management > Song Storage's Remove: every download (as remote.removeAllDownloads). */
    removeAllDownloads: call(() => remote.removeAllDownloads()),
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
    // No browser cookies on the phone to share with the server.
    serverDownloads: call(async (action, args = {}) => {
      const result = await remote.serverDownloads(action, { ...args });
      // A song saved on the server from here is one this phone added.
      if (action === 'finish' && result && result.song) privateStats.added(1);
      return result;
    }),
    cookieBrowsers: call(() => []),
    onServerNotice: on('server:notice'),
    sessions: call((body) => remote.sessions(body || null)),
    onServerLive: on('server:live'),
    onSettingsChanged: on('settings:changed'),
    finishSong: notHere('Saving a download on the phone'),
    lyrics: call((songId) => lyricsClient.get(songId)),
    lyricsStats: call(() => lyricsClient.stats()),
    clearLyricsCache: call(() => lyricsClient.clear()),
    onLyricsChanged: on('lyrics:changed'),
    shareLink: call(() => remote.shareLink()),
    recordAwayListen: call((song, listened, duration) => actions.recordAwayListen({ song, listened, duration })),
    guestLook: call(() => guest.look()),
    guest: call((action, args = {}) => {
      if (action === 'join') return guest.join(args.serverId, args.sessionId, args.mode);
      if (action === 'session') return guest.session(args.body || {});
      if (action === 'leave') return guest.leave();
      if (action === 'songs') return guest.songs();
      if (action === 'bring') return bringSong(String(args.songId || ''));
      if (action === 'status') return guest.status();
      if (action === 'list') return guest.list();
      throw new Error(`Unknown guest action ${action}.`);
    }),
    onGuestLive: on('guest:live'),
    onGuestChanged: on('guest:changed'),
    connectLink: call((text) => remote.connectLink(String(text || ''))),
    qr: call((text) => encodeQr(String(text || ''))),
    /** Google's code scanner (no camera permission): the text read, or '' when called off. */
    scanQr: call(async () => {
      const r = await plugin.scanQr();
      if (r && r.cancelled) {
        const err = new Error('Scan called off');
        err.cancelled = true;
        throw err;
      }
      return String((r && r.text) || '');
    }),
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
     * Settings > Media Management > Song Storage: the songs kept on the phone and their bytes, those
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
