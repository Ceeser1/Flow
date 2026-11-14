'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme, screen, dialog, Notification } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const paths = require('./src/paths');

// Before the app is ready, or Chromium has already opened its files in the
// default (Roaming) location.
app.setPath('userData', paths.userDataDir());
// Room for the visualizers' shaders in the GPU's program cache (6 MB by
// default, about what a few of the big ones fill): going through many in
// one session (Random), the first ones were pushed out again by the last and
// compiled again from nothing when they came round.
app.commandLine.appendSwitch('gpu-program-cache-size-kb', '32768');

const settings = require('./src/settings');
const I18n = require('./renderer/app/i18n');
const T = I18n.t;
// The shared code's messages (downloads, imports, the Flow Server connection) in the language picked too.
require('@flow/core/lang').useTranslator((key, vars) => (I18n.has(key) ? I18n.t(key, vars) : null));
const cookieJar = require('./src/cookieJar');
const library = require('./src/library');
const model = require('@flow/core/libraryModel');
const tools = require('./src/tools');
const downloader = require('./src/downloader');
const importer = require('./src/importer');
const keptDownloads = require('./src/keptDownloads');
const exporter = require('./src/exporter');
const waveform = require('./src/waveform');
const loudness = require('./src/loudness');
const covers = require('./src/covers');
const { createTagger } = require('./src/tagger');
const remote = require('./src/remote');
const env = require('./src/env');
const { createActions } = require('@flow/core/client/actions');
const { createPrivateStats } = require('@flow/core/client/privateStats');
const sponsorblock = require('@flow/core/sponsorblock');
const { lookupInfo, createInfoFiller } = require('@flow/core/songInfo');
const caps = require('@flow/core/client/caps');
const { MP3_QUALITIES, LOCAL_EXTS } = require('@flow/core/formats');
const { ProcessCancelledError } = require('@flow/core/processRunner');
const { createBackupStore, mergeRestore } = require('@flow/core/backup');
const { createLyricsClient } = require('@flow/core/client/lyrics');
const vizPicture = require('@flow/core/client/vizPicture');
const { createLyricsFolder } = require('@flow/core/client/lyricsFolder');
const { solveChallenge } = require('./src/lrclibChallenge');
const { createGuestLink } = require('@flow/core/client/guest');
const { createViewChannel } = require('@flow/core/client/viewChannel');
const autostart = require('./src/autostart');
const { createMiniPlayer } = require('./src/miniPlayer');
const { createTray } = require('./src/tray');

let mainWindow = null;
let downloadToken = null;
// Measures the songs' loudness in the background while "Equalize volume" is on.
const loudnessFiller = loudness.createFiller(library, model, () => settings.get('normalize'));
// Finds covers for Local Files songs in the background; copies of a server's
// songs get the server's.
const coverFiller = covers.createFiller({ skip: (id) => remote.active() && remote.isServerCopy(id) });
// Looks up the album, genre and Info of Local Files songs never looked up
// (from before 3.6.3, put into the folder by hand, before Discogs for what
// is still empty); copies of a server's songs get the server's.
const infoFiller = createInfoFiller({
  nextSong: (tried) => library.get().songs.find((s) => !s.infoLooked && !tried.has(s.id)
    && !(remote.active() && remote.isServerCopy(s.id))) || null,
  save: (found) => library.mutate((d) => {
    for (const f of found) if (model.songById(d, f.id)) model.setInfo(d, f.id, f);
  }),
});
// New songs' files get their flowid and cover (tagger.js).
const tagger = createTagger({ skip: (id) => remote.active() && remote.isServerCopy(id) });
// The Statistics of everything heard on this device (privateStats.js).
const privateStats = createPrivateStats({
  jsonFiles: env.jsonFiles,
  deviceId: () => settings.clientId(),
  onChange: (data) => sendToWindow('stats:private', data),
});
// What the window changes in the library; a Local Files song's file is
// renamed and cut here (the uncut one to the Recycle Bin).
// A list read for Add Songs or an Update is held against the server's
// library while one is connected, not Local Files: the playlists and the
// songs already there are the server's (see import:finish).
importer.useLibrary(() => (remote.active() ? remote.view() : library.get()));

const actions = createActions({
  remote,
  library,
  privateStats,
  files: env.files,
  retag: (song, meta) => exporter.retagSong(song, meta),
  trim: (song, start, end) => exporter.trimSong(song, start, end, { keep: true }),
});

// A second start just brings the running window forward (out of the tray too).
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    // Started again for the Mini Player alone (Open on PC Start): that opens, as from the player bar.
    if (autostart.asked(argv) && !MOBILE_UI) {
      mini.open();
      return;
    }
    showMain();
  });
}

// ---- window ----

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** Saved bounds, if they still land on a connected screen. */
function restoredBounds() {
  const b = settings.get('windowBounds');
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.width)) return null;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 100 > a.x && b.x < a.x + a.width - 100 && b.y >= a.y - 20 && b.y < a.y + a.height - 100;
  });
  return visible ? b : null;
}

// For working on the Android app's layout: FLOW_UI=mobile shows the phone's
// layout and leaves out what the phone cannot do, in a phone-sized window.
const MOBILE_UI = process.env.FLOW_UI === 'mobile';

// Started with the computer (the Mini Player's Open on PC Start, autostart.js):
// the Mini Player shows at once, and Flow's window starts in the tray.
const START_MINI = autostart.asked(process.argv) && !MOBILE_UI;
// Flow's window was maximized when last closed but started in the tray: maximized when it is first shown.
let maximizeOnShow = false;

// Flow's window in the tray (src/tray.js): hidden, with no taskbar button,
// only playing for the Mini Player. It goes there when the Mini Player opens,
// by its own X while the Mini Player is open (its music pauses), and on a
// start with the computer; the tray icon, the Mini Player's Open Flow or
// starting Flow again bring it back. Its page is told ('window:away') and
// draws nothing meanwhile: an open visualizer is closed, no clouds, no
// equalizer. Closing the Mini Player meanwhile quits Flow.
let inTray = false;
// Flow is closing for good: its window's X no longer sends it into the tray.
let quitting = false;

const tray = createTray({
  icon: paths.appIconPath(),
  texts: () => ({ openFlow: T('mini.settings.openFlow'), openMini: T('desktop.tray.openMini'), quit: T('desktop.tray.quit') }),
  onOpen: () => showMain(),
  onMini: () => mini.open(),
  onQuit: () => quitFlow(),
});

// The Mini Player (src/miniPlayer.js): its window, and what goes between it and Flow's.
const mini = createMiniPlayer({
  settings,
  mainWindow: () => mainWindow,
  icon: paths.appIconPath(),
  language: () => settings.get('language') || '',
  hideFlow: () => toTray(),
  showFlow: () => showMain(),
  onOpenChange: (open) => {
    sendToWindow('mini:open', open);
    // Closed while Flow's window is in the tray: nothing of Flow is left on the screen, so it quits (its music with it).
    if (!open && inTray && mainWindow && !quitting) quitFlow();
    else syncTray();
  },
});

/** The tray icon is there while Flow's window is hidden and the Mini Player open. */
function syncTray() {
  tray.set(inTray && !!mainWindow && mini.isOpen());
}

/** Flow's window out of sight, into the tray (the Mini Player stays). `pause`: its music stops too (its X). */
function toTray({ pause = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || inTray) return;
  const w = mainWindow;
  inTray = true;
  sendToWindow('window:away', { away: true, pause });
  // Under a full-screen visualizer the page closes that and leaves full screen: the window is
  // hidden once it is out of it (hidden sooner, it comes back into sight as it leaves). A page
  // that has not left after 2 s is made to; after 4 s the window is hidden as it is.
  const since = Date.now();
  let made = false;
  let wasFull = false;
  const hide = () => {
    if (!inTray || w.isDestroyed()) return;
    const waited = Date.now() - since;
    if (w.isFullScreen() && waited < 4000) {
      wasFull = true;
      if (waited > 2000 && !made) {
        made = true;
        w.setFullScreen(false);
      }
      setTimeout(hide, 50);
      return;
    }
    if (wasFull) {
      // A moment more: the page finishes leaving full screen with its next frames, and a hidden window gets none.
      wasFull = false;
      setTimeout(hide, 120);
      return;
    }
    w.hide();
  };
  hide();
  syncTray();
}

/** Flow's window is on the screen again: its page draws again, the tray icon goes. */
function leftTray() {
  if (!inTray) return;
  inTray = false;
  sendToWindow('window:away', { away: false });
  syncTray();
}

/** Flow's window in front, out of the tray or the taskbar. */
function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (maximizeOnShow) {
    // Maximizing shows it.
    maximizeOnShow = false;
    mainWindow.maximize();
  } else if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  leftTray();
}

/** A system dialog's window: Flow's, unless that is in the tray (a dialog of a hidden window would be out of sight too). */
function dialogOwner() {
  return mainWindow && !mainWindow.isDestroyed() && !inTray ? mainWindow : undefined;
}

/** Flow closes for good, also while the Mini Player is open (which goes with it). */
function quitFlow() {
  quitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  else app.quit();
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  const bounds = MOBILE_UI ? null : restoredBounds();
  mainWindow = new BrowserWindow({
    width: MOBILE_UI ? 412 : 1280,
    height: MOBILE_UI ? 891 : 860,
    ...(bounds || {}),
    useContentSize: MOBILE_UI,
    minWidth: MOBILE_UI ? 320 : 960,
    minHeight: MOBILE_UI ? 480 : 640,
    show: false,
    // A start in the tray: nothing of the page is painted before the window is first shown.
    paintWhenInitiallyHidden: !START_MINI,
    title: 'Flow',
    backgroundColor: '#1e1e22',
    icon: paths.appIconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // Maximizing shows the window: one that starts in the tray is maximized when it is first shown.
  maximizeOnShow = START_MINI && !!settings.get('windowMaximized');
  if (settings.get('windowMaximized') && !MOBILE_UI && !START_MINI) mainWindow.maximize();

  inTray = START_MINI;
  if (!START_MINI) mainWindow.once('ready-to-show', () => mainWindow.show());
  // Shown by whatever way: out of the tray.
  mainWindow.on('show', leftTray);
  // Imported songs not saved yet and links waiting in the Client queue are
  // kept over a restart (4.5.3, keptDownloads.js): closing asks nothing.
  mainWindow.on('close', (e) => {
    // While the Mini Player is open the X only sends Flow into the tray, its music paused: the Mini Player can play on.
    if (!quitting && mini.isOpen()) {
      e.preventDefault();
      toTray({ pause: true });
      return;
    }
    if (!MOBILE_UI) {
      settings.set({
        windowBounds: mainWindow.getNormalBounds(),
        windowMaximized: mainWindow.isMaximized() || maximizeOnShow,
      });
    }
    // The song the Mini Player shows, where it is now (Open on PC Start shows it again).
    mini.keepNow();
  });
  // Windows shutting down or signing out closes Flow without a 'close'.
  mainWindow.on('session-end', () => mini.keepNow());
  mainWindow.on('closed', () => {
    mainWindow = null;
    inTray = false;
    tray.set(false);
    // The Mini Player only shows what this window plays: it goes with it.
    mini.close();
  });
  // A join request flashed the taskbar button (session:notify): looked at now.
  mainWindow.on('focus', () => mainWindow.flashFrame(false));

  // Links never open inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  // Only with FLOW_TRACE_REDRAWS set: what makes the pages draw again, into that file.
  require('./src/redrawTrace').attach(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---- IPC ----
//
// Every route answers { ok, value } or { ok: false, error, cancelled }, and the
// preload turns that back into a plain value or a thrown Error. Electron's own
// rejection would prefix every message with "Error invoking remote method".

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, arg) => {
    try {
      return { ok: true, value: await fn(arg) };
    } catch (err) {
      return {
        ok: false,
        cancelled: err instanceof ProcessCancelledError || !!(err && err.cancelled),
        error: (err && err.message) || String(err),
      };
    }
  });
}

// The library on its way to the window: whole at its start, then only what
// changed (4.3.3). With a Flow Server the window shows the server's library
// (remote.js), and Local Files changes reach it through that.
const toWindow = createViewChannel((msg) => sendToWindow('library:changed', msg));
library.onChange((data) => {
  if (!remote.active()) toWindow.update(data);
});

/** The library the window works with: the server's, or Local Files. */
const currentLibrary = () => actions.currentLibrary();

function iconDataUrl() {
  try {
    const png = fs.readFileSync(path.join(__dirname, 'renderer', 'assets', 'icon.png'));
    return 'data:image/png;base64,' + png.toString('base64');
  } catch {
    return '';
  }
}

handle('app:init', () => {
  const lib = currentLibrary();
  return {
    library: lib,
    librarySeq: toWindow.start(lib),
    ...startInfo(),
  };
});
// A change the window could not fit (one missed): the library whole.
handle('library:whole', () => {
  toWindow.whole(currentLibrary());
  return true;
});

const startInfo = () => ({
  platform: 'desktop',
  os: process.platform,
  uiMode: MOBILE_UI ? 'mobile' : 'desktop',
  caps: MOBILE_UI ? caps.ANDROID : caps.DESKTOP,
  server: remote.status(),
  settings: settings.all(),
  musicDir: paths.musicDir(),
  tools: tools.status(),
  mp3Qualities: MP3_QUALITIES,
  version: app.getVersion(),
  // For the Windows media overlay, which only takes http(s) or data: artwork.
  iconDataUrl: iconDataUrl(),
  covers: coverDirs(),
  // Whether the Mini Player is open (the player bar's button shows it).
  miniOpen: mini.isOpen(),
  // Whether the window is in the tray (a start with the computer): its page draws nothing until it is shown.
  away: inTray,
});

/**
 * Where the window finds covers (Store.coverSrc): Local Files' folder, and
 * the server's when one is in use ('' otherwise).
 */
function coverDirs() {
  return { local: covers.dirOf(covers.LOCAL), server: remote.coverDir() };
}

// A cover arrived: the window shows it in place of the note.
covers.onUpdated((scope, ids, size) => sendToWindow('covers:updated', { scope, ids, size, dirs: coverDirs() }));
// Rows on screen whose cover file is not here yet: a server's come down first.
// { ids, size }: 'small' for the lists, 'big' for Details, the visualizers, the lock screen.
handle('covers:want', (arg) => {
  if (remote.active()) remote.wantCovers(Array.isArray(arg) ? arg : arg && arg.ids, arg && arg.size);
});
// Settings: the covers kept here (Local Files', and the servers').
handle('covers:stats', () => ({
  local: { small: covers.localStore().size('small'), big: covers.localStore().size('big') },
  server: remote.active() ? remote.coverStats() : null,
}));
// size: 'small' (Cover thumbnails cache) or 'big' (Clear big cover cache).
handle('covers:clear', (size) => remote.clearCoverCache(size === 'small' || size === 'big' ? size : null));
// Add Songs: a song's cover as soon as it is downloaded, before it is saved.
covers.onStaged((info) => sendToWindow('covers:staged', info));
handle('covers:staged', (cachePath) => covers.stagedCover(String(cachePath || '')));

// A song's lyrics (4.0): the server's for its songs, LRCLIB's for the others,
// kept in the Lyrics folder (4.0); with Settings' "Fetch/Sync Lyrics" off
// only what is kept there.
const lyricsClient = createLyricsClient({
  remote,
  library,
  folder: createLyricsFolder(env.lyricsFiles),
  jsonFiles: env.jsonFiles,
  fetchOn: () => settings.get('lyricsOn') !== false,
  syncEveryMs: 15 * 60 * 1000,
  // Local Files songs that are a server's too (copies, or uploaded and kept) have the server's lyrics.
  skip: (id) => remote.active() && (remote.isServerCopy(id) || !!remote.serverSongOf(id)),
  onChange: () => sendToWindow('lyrics:changed'),
});
// Every Local Files song's lyrics looked up in the background (4.0): soon
// after a change of the library, and once the window is up (startup).
library.onChange(() => lyricsClient.fillSoon());
handle('song:lyrics', (songId) => lyricsClient.get(songId));
// Settings' Lyrics cache: { count, none, bytes, left }; cleared but for those written here for Local Files songs.
handle('lyrics:stats', () => lyricsClient.stats());
handle('lyrics:clear', () => lyricsClient.clear());
// Lyrics picked by hand from LRCLIB's search (4.0).
handle('lyrics:search', (params) => lyricsClient.search(params));
// Lyrics written in Flow published on LRCLIB (4.0): its challenge solved in a worker thread.
handle('lyrics:publish', (meta) => lyricsClient.publish(meta, solveChallenge));
// Lyrics written or edited here (4.0): kept for good, a server's song's on the server.
handle('song:setLyrics', ({ songId, lines, server }) => lyricsClient.set(songId, lines, { server: !!server }));
// A song just downloaded (Add Songs), not in the library yet: looked up by its names.
handle('song:lookupLyrics', (meta) => lyricsClient.lookup(meta));
// A Local Files song's own lyrics go up to the server after it.
remote.useOwnLyrics((localId) => lyricsClient.ownLines(localId));

// Being a guest in another server's session on this network (4.0, @flow/core/client/guest).
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
  onLive: (ev) => sendToWindow('guest:live', ev),
  onChange: () => sendToWindow('guest:changed', guest.list()),
});
handle('guest:look', () => guest.look());

/**
 * One of this app's songs into the session it is a guest in (4.0): its file
 * here, else streamed from this app's own server into the cache first, sent
 * as a session song. Resolves { gid }, the id the session knows it by.
 */
async function bringSong(songId) {
  const song = actions.currentLibrary().songs.find((s) => s.id === songId);
  if (!song) throw new Error(T('common.songNotInLibrary'));
  const audio = remote.active() ? await remote.songAudio(songId) : { file: song.file, temp: false };
  if (!audio.file || !fs.existsSync(audio.file)) throw new Error(T('common.error.noFileToSend', { song: song.title }));
  const gid = `g-${settings.clientId().slice(0, 12)}-${songId}`.replace(/[^\w-]/g, '').slice(0, 64);
  const format = (path.extname(song.file || audio.file).slice(1) || song.format || 'mp3').toLowerCase();
  try {
    await guest.upload(gid, {
      title: song.title, artist: song.artist, mix: song.mix, duration: song.duration, format,
    }, audio.file);
  } finally {
    if (audio.temp) fs.rmSync(audio.file, { force: true });
  }
  return { gid };
}
handle('guest:call', ({ action, args = {} }) => {
  if (action === 'join') return guest.join(args.serverId, args.sessionId, args.mode);
  if (action === 'session') return guest.session(args.body || {});
  if (action === 'leave') return guest.leave();
  if (action === 'songs') return guest.songs();
  if (action === 'bring') return bringSong(String(args.songId || ''));
  if (action === 'status') return guest.status();
  if (action === 'list') return guest.list();
  throw new Error(T('common.error.unknownGuestAction', { action }));
});

// Sharing the server by QR code (4.0): the link, a link pasted, and a code's squares.
handle('server:shareLink', () => remote.shareLink());
handle('server:connectLink', (text) => remote.connectLink(String(text || '')));
handle('qr:encode', (text) => require('@flow/core/qr').encode(String(text || '')));

// Backups (4.0, @flow/core/backup): library.json's data once a week, the
// last 6 kept in Flow's folder (backups), never the songs' files.
const backups = createBackupStore({
  dir: path.join(paths.rootDir(), 'backups'),
  kind: 'app',
  collect: () => ({ library: JSON.parse(JSON.stringify(library.get())) }),
});
// Looked at when the app starts and every 6 hours while it runs.
const BACKUP_CHECK_MS = 6 * 60 * 60 * 1000;
handle('backups:list', () => backups.list());
handle('backups:make', () => backups.make('manual'));
/**
 * A backup put back (a backup of now made first): the songs' names,
 * playlists, favourites and stats as they were; songs whose files are gone
 * stay out, songs added since stay in.
 */
handle('backups:restore', (name) => library.quietly(async () => {
  const doc = backups.read(String(name || ''));
  if (doc.kind !== 'app') throw new Error(T('desktop.error.serverBackup'));
  backups.make('restore', String(name));
  const counts = library.mutate((d) => {
    const { data, counts: c } = mergeRestore(d, model.sanitize(doc.library));
    for (const k of Object.keys(d)) delete d[k];
    Object.assign(d, model.sanitize(data));
    return c;
  });
  setTimeout(() => {
    library.scan().catch(() => {});
    coverFiller.run();
    infoFiller.run();
    loudnessFiller.run();
  }, 0);
  return counts;
}));

handle('settings:set', (patch) => {
  // The password only ever arrives through server:setSecret, to be encrypted.
  const clean = { ...(patch || {}) };
  delete clean.serverSecret;
  const wasRemote = remote.active();
  const next = settings.set(clean);
  if ('language' in clean) useLanguage();
  mini.settingsChanged(clean);
  if (clean.normalize === true) loudnessFiller.run();
  remote.reconfigure(clean);
  if (clean.lyricsOn === true) {
    lyricsClient.sync();
    lyricsClient.fill();
  }
  if (remote.active() !== wasRemote) {
    sendToWindow('covers:updated', { scope: '', ids: null, dirs: coverDirs() });
    toWindow.whole(currentLibrary());
  }
  return next;
});
// The language picked in Settings, or the computer's: for the window (i18n.js
// reads it before drawing) and for the dialogs here.
function useLanguage() {
  I18n.setLanguage(settings.get('language') || (/^de\b/i.test(app.getLocale()) ? 'de' : 'en'));
}
// The window drawn again in the language just picked (will-navigate stops a reload from the page itself).
ipcMain.on('app:reload', () => {
  mini.reload();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
});
ipcMain.on('i18n:language', (event) => {
  event.returnValue = settings.get('language') || '';
});
ipcMain.on('settings:setSync', (event, patch) => {
  settings.set(patch);
  event.returnValue = true;
});

// Each change goes to the Local Files library, or with a server to the
// server as a command (@flow/core/client/actions, shared with the Android app).
handle('library:createPlaylist', (name) => actions.createPlaylist(name));
handle('library:createSmartPlaylist', (arg) => actions.createSmartPlaylist(arg));
handle('library:setPlaylistRules', (arg) => actions.setPlaylistRules(arg));
handle('library:renamePlaylist', (arg) => actions.renamePlaylist(arg));
handle('library:deletePlaylist', (arg) => actions.deletePlaylist(arg));
handle('library:createGroup', (name) => actions.createGroup(name));
handle('library:renameGroup', (arg) => actions.renameGroup(arg));
handle('library:deleteGroup', (id) => actions.deleteGroup(id));
handle('library:addToGroup', (arg) => actions.addToGroup(arg));
handle('library:removeFromGroup', (arg) => actions.removeFromGroup(arg));
handle('library:setPlaylistShared', (arg) => actions.setPlaylistShared(arg));
handle('library:setFollowing', (arg) => actions.setFollowing(arg));
handle('library:setGroupShared', (arg) => actions.setGroupShared(arg));
handle('library:setGroupFollowing', (arg) => actions.setGroupFollowing(arg));
handle('library:setGroupPlaylistFollowed', (arg) => actions.setGroupPlaylistFollowed(arg));
handle('library:addSongToPlaylists', (arg) => actions.addSongToPlaylists(arg));
handle('library:addSongsToPlaylist', (arg) => actions.addSongsToPlaylist(arg));
handle('library:removeFromPlaylist', (arg) => actions.removeFromPlaylist(arg));
handle('library:deleteSong', (arg) => actions.deleteSong(arg));
handle('library:editSong', (arg) => actions.editSong(arg));
handle('library:trimSong', (arg) => actions.trimSong(arg));
handle('library:setFavourite', (arg) => actions.setFavourite(arg));
handle('library:recordListen', (arg) => actions.recordListen(arg));
handle('library:recordAwayListen', (arg) => actions.recordAwayListen(arg));
handle('stats:private', () => privateStats.get());
handle('stats:removeTracked', ({ serverId, profileId }) => remote.removeTracked(serverId, profileId));
// Fetched when the window shows them (4.3): the profile's Statistics, the playlists others share, one of them.
handle('stats:server', () => remote.loadStatistics());
handle('shared:list', () => remote.loadShared());
handle('shared:open', (id) => remote.openShared(id));
handle('library:findBySource', (arg) => actions.findBySource(arg));
handle('library:findByMeta', (meta) => actions.findByMeta(meta));

// ---- the Flow Server (Settings: Use a Flow Server) ----

handle('server:setSecret', (text) => remote.setSecret(text));
handle('server:syncNow', () => remote.syncNow());
handle('server:setOffline', ({ playlistId, on }) => remote.setOffline(playlistId, !!on));
handle('server:downloadSong', (songId) => remote.downloadSong(songId));
handle('server:songPeaks', (songId) => remote.songPeaks(songId));
// A song's whole file as bytes, as the player plays it (seekCheck.js decodes it).
handle('audio:song', async (songId) => {
  if (!remote.active()) {
    const song = model.songById(library.get(), songId);
    if (!song || !song.file) throw new Error(T('desktop.error.noSuchSong'));
    return fs.promises.readFile(song.file);
  }
  const { file, temp } = await remote.songAudio(songId);
  try {
    return await fs.promises.readFile(file);
  } finally {
    if (temp) fs.promises.rm(file, { force: true }).catch(() => {});
  }
});
handle('server:removeDownload', (songId) => remote.removeDownload(songId));
// Downloaded Songs: a song here that is not the server's, deleted from this computer.
handle('server:removeDeviceSong', (songId) => remote.removeDeviceSong(songId));
// Settings' Switch server: to a server used before, or one forgotten.
handle('server:switch', (id) => remote.switchServer(id));
handle('server:forget', (id) => remote.forgetServer(id));
handle('server:profiles', () => remote.loadProfiles());
handle('server:profileLogin', ({ profileId, pin }) => remote.loginProfile(profileId, pin));
handle('server:profileCreate', ({ name, pin }) => remote.createProfile(name, pin));
handle('server:profileLogout', () => remote.logoutProfile());
handle('server:profileRename', ({ name, pin }) => remote.renameProfile(name, pin));
handle('server:profilePin', ({ pin, newPin }) => remote.changePin(pin, newPin));
handle('server:profileDelete', () => remote.deleteProfile());
handle('server:admin', ({ route, body }) => remote.admin(route, body));
handle('server:changePassword', (args) => remote.changeServerPassword(args || {}));
// Active Sessions: a POST body, or nothing for the list.
handle('server:sessions', (body) => remote.sessions(body || null));
// Downloads by the server: they stay there, so closing the app asks nothing.
// With "Share session cookies with the server", a new download takes the
// link's site's cookies from the browser chosen along.
handle('server:downloads', async ({ action, ...args }) => {
  const browser = settings.get('useCookies') && settings.get('shareCookies') ? settings.get('cookiesBrowser') : '';
  if ((action === 'create' || action === 'check') && args.url && browser) args.cookies = await cookieJar.siteCookies(args.url, browser);
  const result = await remote.serverDownloads(action, args);
  // A song saved on the server from here is one this device added.
  if (action === 'finish' && result && result.song) privateStats.added(1);
  return result;
});
// The browsers the cookies can come from (Settings, Media Management).
handle('cookies:browsers', () => cookieJar.browsers());

handle('shell:openMusicFolder', () => shell.openPath(paths.musicDir()));
// "Downloads?" on Add Songs: where yt-dlp(.exe) goes, and whether it is there now.
handle('tools:openFolder', () => shell.openPath(tools.toolsDir()));
handle('tools:status', () => tools.status());

// ---- the save folder (Settings) ----

/** How many songs there are and how much room their files take. */
handle('library:folderStats', () => {
  let bytes = 0;
  let missing = 0;
  for (const s of library.get().songs) {
    try {
      bytes += fs.statSync(s.file).size;
    } catch {
      missing += 1;
    }
  }
  return { count: library.get().songs.length, bytes, missing, dir: paths.musicDir() };
});

handle('folder:choose', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: T('desktop.pick.musicFolder.title'),
    defaultPath: paths.musicDir(),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// ---- "Open local File(s) / Folder" on Add Songs ----
//
// Windows' dialog picks files or a folder, never both at once: two buttons.

handle('local:pickFiles', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: T('desktop.pick.files.title'),
    buttonLabel: T('desktop.pick.files.button'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: T('desktop.pick.files.filter.media'), extensions: LOCAL_EXTS },
      { name: T('desktop.pick.files.filter.all'), extensions: ['*'] },
    ],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths;
});

handle('local:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: T('common.openLocalFolder'),
    buttonLabel: T('desktop.pick.files.button'),
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths;
});

// ---- a visualizer's picture (Halo's cover and background) ----
//
// Kept in Flow's own folder as <name>-<stamp>.jpg, a new name each time (no
// stale copy shown), the one before deleted.

handle('viz:savePicture', ({ name, bytes } = {}) => {
  // A JPEG, a PNG (one with see-through parts), or an MP4 or WebM (a background's video).
  const ext = vizPicture.check(name, bytes, 300);
  const dir = paths.ensure(path.join(paths.rootDir(), 'Visualizer'));
  for (const old of fs.readdirSync(dir)) {
    if (vizPicture.keptBefore(old, name)) fs.rmSync(path.join(dir, old), { force: true });
  }
  const file = path.join(dir, `${name}-${Date.now().toString(36)}.${ext}`);
  fs.writeFileSync(file, bytes);
  return file;
});

let moving = false;
handle('folder:move', async (dir) => {
  refuseDuringImport();
  if (downloadToken) throw new Error(T('desktop.error.downloadRunning'));
  if (moving) throw new Error(T('desktop.error.alreadyMoving'));
  moving = true;
  try {
    const oldDir = paths.musicDir();
    const result = await library.relocate(dir, (done, total, name) => {
      sendToWindow('folder:progress', { done, total, name });
    });
    covers.moveFolder(oldDir, result.dir);
    covers.moveFolder(oldDir, result.dir, paths.LYRICS);
    settings.set({ musicDir: result.dir });
    sendToWindow('covers:updated', { scope: '', ids: null, dirs: coverDirs() });
    return result;
  } finally {
    moving = false;
  }
});

// ---- downloading and saving ----

function knownArtists() {
  return [...new Set(currentLibrary().songs.map((s) => s.artist).filter(Boolean))];
}

function refuseDuringImport() {
  if (importRunning || importSaves) throw new Error(T('desktop.error.importRunning'));
}

// A new read or download waits only for the import task itself: songs of
// another batch may be saved meanwhile (Add Songs has a panel per batch, 4.4).
function refuseDuringTask() {
  if (importRunning) throw new Error(T('desktop.error.importRunning'));
}

handle('download:probe', async (url) => {
  refuseDuringTask();
  downloadToken = { cancelled: false };
  try {
    return await downloader.probe(url, downloadToken, { knownArtists: knownArtists() });
  } finally {
    downloadToken = null;
  }
});

// ---- whole playlists ----
//
// One import task at a time: reading a list or a folder, fetching its songs,
// saving them. The window numbers its tasks (`run`) and every progress
// message carries the number, so one that arrives late from a cancelled task
// is never taken for the next one's. Cancel stops the whole task at once:
// no message gets out of it afterwards, and a new one may start right away.

let importToken = null;
let importRunning = false;

function beginImport(run) {
  refuseDuringTask();
  const token = importer.groupToken();
  importToken = token;
  importRunning = true;
  const onProgress = (p) => {
    if (token.cancelled) return;
    // A song downloaded: its cover is looked for now, while it is trimmed and named.
    if (p.phase === 'item' && p.status === 'ready' && p.media && p.song) {
      const meta = p.song.meta || {};
      covers.stage(p.media.path, {
        sourceKey: p.song.key,
        sourceUrl: p.song.url,
        artist: meta.artist,
        title: meta.title || p.song.title,
        duration: p.media.duration,
        thumbnails: p.song.thumbnails,
        noSearch: p.song.noSearch,
        embeddedFrom: p.song.originalPath,
      });
    }
    sendToWindow('import:progress', { ...p, run });
  };
  return { token, onProgress };
}

function endImport(token) {
  if (importToken !== token) return;
  importToken = null;
  importRunning = false;
}

handle('import:list', async ({ url, run }) => {
  const { token, onProgress } = beginImport(run);
  try {
    return await importer.list(url, token, onProgress, { knownArtists: knownArtists() });
  } finally {
    endImport(token);
  }
});

// A playlist's Update: its link read in the background, apart from the import
// task (an import may run meanwhile, and its Cancel leaves this alone). The
// same link checked again stops the check before.
const checkTokens = new Map();
handle('import:check', async ({ url }) => {
  const before = checkTokens.get(url);
  if (before) before.cancel();
  const token = importer.groupToken();
  checkTokens.set(url, token);
  try {
    return await importer.list(url, token, () => {}, { knownArtists: knownArtists() });
  } finally {
    if (checkTokens.get(url) === token) checkTokens.delete(url);
  }
});

// A song's name typed instead of a link (Add Songs): the uploads found. One
// search at a time, apart from imports; a new one, or Cancel, stops the one
// before.
let searchToken = null;
handle('search:songs', async ({ query, page }) => {
  if (searchToken) searchToken.cancel();
  const token = importer.groupToken();
  searchToken = token;
  try {
    return await importer.search(query, token, { page });
  } finally {
    if (searchToken === token) searchToken = null;
  }
});

handle('search:cancel', () => {
  if (searchToken) searchToken.cancel();
  searchToken = null;
});

// Local files take the playlist's steps: listed (a folder looked through),
// prepared into the cache (import:download with `local`), then saved by
// import:finish.
handle('import:listLocal', async ({ picked, run }) => {
  const { token, onProgress } = beginImport(run);
  try {
    return await importer.listLocal(picked, token, onProgress);
  } finally {
    endImport(token);
  }
});

handle('import:download', async ({ items, opts, local, run }) => {
  const { token, onProgress } = beginImport(run);
  try {
    if (local) return await importer.prepareLocal(items, opts, token, onProgress);
    return await importer.download(items, opts, token, onProgress, { knownArtists: knownArtists() });
  } finally {
    endImport(token);
  }
});

// Saving is not part of the import task: "Finish this song" saves one song
// while the others are still downloading. Saves run one after another.
let importSaving = Promise.resolve();
let importSaves = 0;

handle('import:finish', ({ job, run }) => {
  importSaves += 1;
  const onProgress = (p) => sendToWindow('import:progress', { ...p, run });
  const saving = importSaving.then(() => finishImport(job, onProgress)).then((summary) => {
    privateStats.added(summary && summary.songIds ? summary.songIds.length : 0);
    return summary;
  });
  importSaving = saving.catch(() => {});
  return saving.finally(() => {
    importSaves -= 1;
    loudnessFiller.run();
    coverFiller.run();
    infoFiller.run();
  });
});

async function finishImport(job, onProgress) {
  // Lyrics written for a song in Add Songs: kept under its id once saved (before it goes up).
  const ownLyrics = (summary) => {
    for (const e of job.entries) {
      const id = e.lyrics && summary.byPosition && summary.byPosition[e.position];
      if (!id) continue;
      try {
        lyricsClient.keepOwn(id, e.lyrics);
      } catch {
        // As in song:finish.
      }
    }
    return summary;
  };
  if (!remote.active()) return ownLyrics(await importer.finish(job, onProgress));
  // With a server the songs are saved into Local Files first, as always,
  // then go up. The playlist to add to and the songs already in the
  // library are the server's, which Local Files does not have; only the
  // playlist an earlier "Finish this song" made in Local Files is merged
  // into here.
  const existingIds = job.entries.filter((e) => e.existingId).map((e) => e.existingId);
  const ownList = job.mergeInto && model.playlistById(library.get(), job.mergeInto) ? job.mergeInto : null;
  const localJob = { ...job, mergeInto: ownList, playlistIds: [], entries: job.entries.filter((e) => !e.existingId) };
  const summary = ownLyrics(await importer.finish(localJob, onProgress));
  // The times the library songs get, as the saved ones did (see importer.finish).
  const base = Number(job.base) || Date.now();
  job.entries.forEach((e, i) => {
    if (e.existingId) summary.times[e.existingId] = base - (Number.isInteger(e.position) ? e.position : i) * 1000;
  });
  remote.pushImport({
    localPlaylistId: summary.playlistId,
    mergeInto: ownList ? null : (job.mergeInto || null),
    existingIds,
    playlistIds: job.playlistIds || [],
    songIds: summary.songIds,
    times: summary.times,
  });
  summary.fromLibrary = existingIds.length;
  return summary;
}

// How many songs wait to be saved and which links wait in the Client queue:
// before 4.5.3 closing asked about them; now they are kept (downloads:save).
handle('import:pending', () => {});
handle('queue:pending', () => {});

// Add Songs' downloads kept over a restart (4.5.3): the window sends them at
// every change, once more as it closes (sync, so it lands before the window
// goes), and reads them back once it has started.
handle('downloads:save', (state) => keptDownloads.save(state));
ipcMain.on('downloads:saveSync', (e, state) => {
  try {
    keptDownloads.save(state);
  } catch {
    // The last one sent stays.
  }
  e.returnValue = true;
});
handle('downloads:load', () => {
  const kept = keptDownloads.load();
  if (!kept) return null;
  importer.allowLocal(kept.originals);
  return kept.state;
});

// A link put into Add Songs' Client queue (4.4): its name and song count at
// once (listing.peek), apart from the import task and the download; the
// whole read is its turn's. Each queued link has its own (id), and its
// Cancel stops it.
const peekTokens = new Map();
handle('download:peek', async ({ id, url, song }) => {
  const key = String(id || '');
  const token = importer.groupToken();
  peekTokens.set(key, token);
  try {
    return await importer.peek(String(url || ''), token, { song: !!song });
  } finally {
    if (peekTokens.get(key) === token) peekTokens.delete(key);
  }
});

handle('download:peekCancel', (id) => {
  const token = peekTokens.get(String(id || ''));
  if (token) token.cancel();
  peekTokens.delete(String(id || ''));
});

handle('import:cancel', () => {
  if (!importToken) return;
  // The task's processes are killed; what it leaves behind in the cache it
  // removes itself (importer.eachItem, downloader). The window has moved on.
  importToken.cancel();
  importToken = null;
  importRunning = false;
});

// ---- the sleep timer's shutdown ----
//
// The shutdown is handed to Windows as soon as the timer starts (shutdown /s
// /t), so it happens even if Flow is closed or stuck by then; Cancel Timer
// calls it off again (shutdown /a). Windows' own shutdown closes programs
// without asking once the time is up.
//
// On Linux the same goes through systemd's shutdown (-P +minutes, -c), which
// logind allows for the user at the screen without a password; it counts in
// whole minutes, and the timer's times are whole minutes anyway.

function linuxShutdown() {
  for (const file of ['/usr/sbin/shutdown', '/sbin/shutdown', '/usr/bin/shutdown']) {
    if (fs.existsSync(file)) return file;
  }
  return 'shutdown';
}

function runShutdown(args) {
  const exe = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'shutdown.exe')
    : linuxShutdown();
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, text: String(stderr || stdout || (err && err.message) || '').trim() });
    });
  });
}

handle('sleep:scheduleShutdown', async (seconds) => {
  const s = Math.round(Number(seconds));
  if (!Number.isFinite(s) || s < 60 || s > 315360000) throw new Error(T('desktop.shutdown.badTime'));
  if (process.platform !== 'win32') {
    // A new plan replaces an earlier one here.
    const r = await runShutdown(['-P', `+${Math.ceil(s / 60)}`, T('desktop.shutdown.reason')]);
    // Its last line says why ("Failed to schedule shutdown: Access denied ...").
    const why = r.text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (!r.ok) throw new Error(why ? T('desktop.shutdown.refused.why', { reason: why }) : T('desktop.shutdown.refused'));
    return;
  }
  // An earlier plan (a timer set again) would make Windows refuse the new one.
  await runShutdown(['/a']);
  const r = await runShutdown(['/s', '/t', String(s), '/c', T('desktop.shutdown.reason')]);
  if (!r.ok) throw new Error(r.text ? T('desktop.shutdown.refusedWindows.why', { reason: r.text }) : T('desktop.shutdown.refusedWindows'));
});

handle('sleep:cancelShutdown', async () => {
  const r = await runShutdown([process.platform === 'win32' ? '/a' : '-c']);
  // "Unable to abort the system shutdown because no shutdown was in progress" is fine too.
  return r.ok;
});

handle('sleep:notify', (body) => {
  if (!Notification.isSupported()) return false;
  new Notification({ title: T('desktop.window.sleepTimer'), body: String(body || ''), icon: paths.appIconPath() || undefined }).show();
  return true;
});

// Active Sessions: someone asks to join, or this app became the host. A click brings Flow to the front.
handle('session:notify', (body) => {
  // In the tray there is no taskbar button to flash: the notification alone tells.
  if (mainWindow && !mainWindow.isDestroyed() && !inTray && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: T('desktop.window.activeSessions'), body: String(body || ''), icon: paths.appIconPath() || undefined });
  n.on('click', () => showMain());
  n.show();
  return true;
});

// A link out of the app, e.g. a matched YouTube upload to check. Web only.
handle('shell:openUrl', (url) => {
  if (/^https:\/\//i.test(String(url || ''))) shell.openExternal(String(url));
});

handle('download:start', async ({ probed, opts }) => {
  downloadToken = { cancelled: false };
  sponsorSegments(probed.key, probed.url);
  try {
    const media = await downloader.download(probed, opts, (stage, frac, text) => {
      sendToWindow('download:progress', { stage, frac, text });
    }, downloadToken);
    covers.stage(media.path, {
      sourceKey: probed.key,
      sourceUrl: probed.url,
      artist: probed.guess && probed.guess.artist,
      title: (probed.guess && probed.guess.title) || probed.title,
      duration: media.duration,
      thumbnails: probed.thumbnails,
    });
    return media;
  } finally {
    downloadToken = null;
  }
});

handle('download:cancel', () => {
  if (downloadToken && downloadToken.cancel) downloadToken.cancel();
  else if (downloadToken) downloadToken.cancelled = true;
});

handle('download:discard', (file) => {
  // Only ever something inside the cache folder.
  const cache = path.resolve(paths.cacheDir()).toLowerCase() + path.sep;
  if (file && path.resolve(file).toLowerCase().startsWith(cache)) {
    fs.rmSync(file, { force: true });
    covers.dropStaged(file);
  }
});

handle('audio:peaks', ({ file, duration }) => waveform.peaksFor(file, duration));

// SponsorBlock's marked parts of a YouTube song, for the trim editor (asked
// for while it downloads, so they are usually there when the editor opens).
// Kept while the app runs; a failed lookup is asked again next time.
const sponsorCache = new Map();
function sponsorSegments(key, url) {
  if (!settings.get('sponsorBlock')) return Promise.resolve([]);
  const id = sponsorblock.videoId(key, url);
  if (!id) return Promise.resolve([]);
  if (!sponsorCache.has(id)) {
    if (sponsorCache.size >= 200) sponsorCache.delete(sponsorCache.keys().next().value);
    const ask = sponsorblock.segmentsFor(id).then((list) => {
      if (!list.length) sponsorCache.delete(id);
      return list;
    });
    sponsorCache.set(id, ask);
  }
  return sponsorCache.get(id);
}
handle('sponsor:segments', ({ key, url }) => sponsorSegments(key, url));

// One song's album, genre and Info from Apple's and Discogs' search, for Add Songs' editor.
handle('song:lookupInfo', (song) => lookupInfo(song || {}));

// ---- startup ----

app.whenReady().then(() => {
  if (!isFirstInstance) return;
  // Windows shows notifications under the id of the Start menu shortcut,
  // which the installer gives the build's appId.
  if (app.isPackaged) app.setAppUserModelId('com.ceeser.flow');
  settings.load();
  useLanguage();
  // Started with the computer: the Mini Player first, with the song it showed last, before the library is read.
  if (START_MINI) mini.open({ byComputer: true });
  if (settings.get('musicDir')) paths.setMusicDir(settings.get('musicDir'));
  library.load();
  // But for the songs of the batches kept over the restart (4.5.3).
  downloader.clearCache(keptDownloads.cacheFiles());
  remote.init({
    onView: (view) => toWindow.update(view),
    onStatus: (st) => sendToWindow('server:status', st),
    onNotice: (text, kind) => sendToWindow('server:notice', { text, kind }),
    onSettings: (patch) => sendToWindow('settings:changed', patch),
    // The live channel's events (Active Sessions).
    onLive: (ev) => sendToWindow('server:live', ev),
    // fromOthers: how many are copies downloaded from other servers; returning:
    // songs that came here while another server was in use.
    confirmUpload: async ({
      count, name, fromOthers = 0, returning = false,
    }) => {
      const others = fromOthers
        ? `${fromOthers === count ? T(count === 1 ? 'common.upload.fromOthers.it' : 'common.upload.fromOthers.all') : T('common.upload.fromOthers.some', { count: fromOthers })} ` : '';
      const { response } = await dialog.showMessageBox(dialogOwner(), {
        type: 'question',
        title: 'Flow',
        message: T(returning ? 'desktop.upload.text.afterOther' : 'desktop.upload.text', { count, server: name }),
        detail: returning
          ? T('desktop.upload.detail.known', { fromOthers: others })
          : T('desktop.upload.detail.newServer', { fromOthers: others }),
        buttons: [T('common.upload'), T('common.notNow')],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    },
    // An upload the server has already, under other names.
    askExisting: async ({ local, server, name }) => {
      const label = (n) => `${[n.artist, n.title].filter(Boolean).join(' - ')}${n.mix ? ` (${n.mix})` : ''}`;
      const { response, checkboxChecked } = await dialog.showMessageBox(dialogOwner(), {
        type: 'question',
        title: 'Flow',
        message: T('desktop.sameSong.text', { song: label(local), server: name, serverSong: label(server) }),
        detail: T('desktop.sameSong.detail'),
        buttons: [T('desktop.sameSong.useThese'), T('common.sameSong.keepServers'), T('desktop.sameSong.uploadNew')],
        defaultId: 1,
        cancelId: 1,
        checkboxLabel: T('common.sameSong.forAll'),
      });
      return { choice: ['apply', 'keep', 'new'][response] || 'keep', all: checkboxChecked };
    },
  });
  createWindow();
  syncTray();
  // Both in the background, once the window is up. The scan tells the window
  // itself when it changed anything, and from then on the folder is watched.
  library.onScanned((result) => {
    sendToWindow('library:scanned', result);
    if (result.added) {
      loudnessFiller.run();
      coverFiller.run();
      infoFiller.run();
    }
  });
  covers.watchLocal();
  library.onChange(() => tagger.run());
  tagger.run();
  // Songs looked up before Discogs: once more for what is still empty.
  if (model.startInfoRound(library.get())) library.save();
  setTimeout(() => {
    library.scan().catch(() => {}).then(() => {
      loudnessFiller.run();
      coverFiller.run();
      infoFiller.run();
      lyricsClient.fill();
      // After the scan: a first start's backup holds the songs found.
      backups.weekly();
    });
    library.watch();
    tools.refreshYtDlp();
    mini.refreshAutostart();
    setInterval(() => backups.weekly(), BACKUP_CHECK_MS);
  }, 1500);
});

// Quitting by any other way than the window's X (the tray's Quit Flow, the system): the X's way into the tray is off.
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => tray.set(false));

app.on('window-all-closed', async () => {
  // Out of an Active Session first: a host hands it on at once.
  await remote.leaveSession(1500);
  await guest.leave();
  remote.stop();
  library.unwatch();
  loudnessFiller.stop();
  coverFiller.stop();
  covers.flush();
  infoFiller.stop();
  tagger.stop();
  if (importToken) importToken.cancel();
  if (searchToken) searchToken.cancel();
  waveform.abort();
  if (downloadToken && downloadToken.cancel) downloadToken.cancel();
  app.quit();
});
