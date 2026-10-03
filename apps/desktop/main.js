'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme, screen, dialog, Notification } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const paths = require('./src/paths');

// Before the app is ready, or Chromium has already opened its files in the
// default (Roaming) location.
app.setPath('userData', paths.userDataDir());

const settings = require('./src/settings');
const cookieJar = require('./src/cookieJar');
const library = require('./src/library');
const model = require('@flow/core/libraryModel');
const tools = require('./src/tools');
const downloader = require('./src/downloader');
const importer = require('./src/importer');
const exporter = require('./src/exporter');
const waveform = require('./src/waveform');
const loudness = require('./src/loudness');
const covers = require('./src/covers');
const remote = require('./src/remote');
const { MP3_QUALITIES, LOCAL_EXTS } = require('@flow/core/formats');
const { ProcessCancelledError } = require('@flow/core/processRunner');

let mainWindow = null;
let downloadToken = null;
// Imported songs downloaded but not saved yet (the window says how many).
let importPending = 0;
// Measures the songs' loudness in the background while "Equalize volume" is on.
const loudnessFiller = loudness.createFiller(library, model, () => settings.get('normalize'));
// Finds covers for Local Files songs in the background; copies of a server's
// songs get the server's.
const coverFiller = covers.createFiller({ skip: (id) => remote.active() && remote.isServerCopy(id) });

// A second start just brings the running window forward.
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
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

function createWindow() {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  const bounds = restoredBounds();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    ...(bounds || {}),
    minWidth: 960,
    minHeight: 640,
    show: false,
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
  if (settings.get('windowMaximized')) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => {
    // Imported songs not yet saved live in the cache, which the next start
    // empties: ask before throwing them away.
    if (importPending > 0) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        title: 'Flow',
        message: `${importPending} imported ${importPending === 1 ? 'song is' : 'songs are'} not saved yet.`,
        detail: 'They are only kept until Flow closes. Go back and press "Finish all" to save them, or quit and lose them.',
        buttons: ['Go back', 'Quit anyway'],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice === 0) {
        e.preventDefault();
        return;
      }
      importPending = 0;
    }
    settings.set({
      windowBounds: mainWindow.getNormalBounds(),
      windowMaximized: mainWindow.isMaximized(),
    });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // A join request flashed the taskbar button (session:notify): looked at now.
  mainWindow.on('focus', () => mainWindow.flashFrame(false));

  // Links never open inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

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

// With a Flow Server the window shows the server's library (remote.js), and
// Local Files changes reach it through that.
library.onChange((data) => {
  if (!remote.active()) sendToWindow('library:changed', data);
});

/** The library the window works with: the server's, or Local Files. */
function currentLibrary() {
  return remote.active() ? remote.view() : library.get();
}

function iconDataUrl() {
  try {
    const png = fs.readFileSync(path.join(__dirname, 'renderer', 'assets', 'icon.png'));
    return 'data:image/png;base64,' + png.toString('base64');
  } catch {
    return '';
  }
}

handle('app:init', () => ({
  library: currentLibrary(),
  server: remote.status(),
  settings: settings.all(),
  musicDir: paths.musicDir(),
  tools: tools.status(),
  mp3Qualities: MP3_QUALITIES,
  version: app.getVersion(),
  // For the Windows media overlay, which only takes http(s) or data: artwork.
  iconDataUrl: iconDataUrl(),
  covers: coverDirs(),
}));

/**
 * Where the window finds covers (Store.coverSrc): Local Files' folder, and
 * the server's when one is in use ('' otherwise).
 */
function coverDirs() {
  return { local: covers.dirOf(covers.LOCAL), server: remote.coverDir() };
}

// A cover arrived: the window shows it in place of the note.
covers.onUpdated((scope, ids) => sendToWindow('covers:updated', { scope, ids, dirs: coverDirs() }));
// Rows on screen whose cover file is not here yet: a server's come down first.
handle('covers:want', (ids) => {
  if (remote.active()) remote.wantCovers(ids);
});
// Settings: how many songs have a cover, and the server covers kept here.
handle('covers:stats', () => ({ local: covers.localStore().size(), server: remote.active() ? remote.coverStats() : null }));
handle('covers:clear', () => remote.clearCoverCache());

handle('settings:set', (patch) => {
  // The password only ever arrives through server:setSecret, to be encrypted.
  const clean = { ...(patch || {}) };
  delete clean.serverSecret;
  const wasRemote = remote.active();
  const next = settings.set(clean);
  if (clean.normalize === true) loudnessFiller.run();
  remote.reconfigure(clean);
  if (remote.active() !== wasRemote) {
    sendToWindow('covers:updated', { scope: '', ids: null, dirs: coverDirs() });
    sendToWindow('library:changed', currentLibrary());
  }
  return next;
});
ipcMain.on('settings:setSync', (event, patch) => {
  settings.set(patch);
  event.returnValue = true;
});

// Each change goes to the Local Files library, or with a server to the
// server as a command (remote.js).
function change(localFn, type, args) {
  if (remote.active()) return remote.command(type, args);
  return library.mutate(localFn);
}

handle('library:createPlaylist', (name) => {
  if (!remote.active()) return library.mutate((d) => model.createPlaylist(d, name, library.newId()));
  const clean = model.checkPlaylistName(remote.view(), name);
  const id = library.newId();
  remote.command('createPlaylist', { playlistId: id, name: clean });
  return model.playlistById(remote.view(), id);
});
handle('library:renamePlaylist', ({ id, name }) =>
  change((d) => model.renamePlaylist(d, id, name), 'renamePlaylist', { playlistId: id, name }));
// deleteSongs: the songs in no other playlist go too. With a server it decides
// which (another profile may have them); here a file that cannot be deleted
// (playing, open elsewhere) keeps its song. Resolves { deleted, kept }, null
// for a server.
handle('library:deletePlaylist', ({ id, deleteSongs }) => {
  if (remote.active()) {
    remote.setOffline(id, false).catch(() => {});
    remote.command('deletePlaylist', { playlistId: id, deleteSongs: !!deleteSongs });
    return null;
  }
  return library.quietly(() => {
    const gone = [];
    let kept = 0;
    for (const sid of deleteSongs ? model.songsOnlyIn(library.get(), id) : []) {
      const song = model.songById(library.get(), sid);
      try {
        if (song.file && fs.existsSync(song.file)) fs.rmSync(song.file);
        gone.push(sid);
      } catch {
        kept += 1;
      }
    }
    library.mutate((d) => {
      model.deletePlaylist(d, id);
      for (const sid of gone) if (model.songById(d, sid)) model.removeSong(d, sid, false);
    });
    return { deleted: gone.length, kept };
  });
});
// Sharing a playlist with the server's other profiles, and following one they share.
handle('library:setPlaylistShared', ({ id, shared }) =>
  change((d) => model.setPlaylistShared(d, id, !!shared), 'setPlaylistShared', { playlistId: id, shared: !!shared }));
handle('library:setFollowing', ({ id, on }) => {
  if (!remote.active()) throw new Error('Following playlists needs a Flow Server.');
  const result = remote.command(on ? 'followPlaylist' : 'unfollowPlaylist', { playlistId: id });
  // Unfollowed: its downloaded songs go too, unless another downloaded
  // playlist (or All Songs) still holds them.
  if (!on) remote.setOffline(id, false).catch(() => {});
  return result;
});
handle('library:addSongToPlaylists', ({ songId, playlistIds }) =>
  change((d) => model.addSongToPlaylists(d, songId, playlistIds), 'addSongToPlaylists', { songId, playlistIds }));
handle('library:addSongsToPlaylist', ({ playlistId, songIds }) =>
  change((d) => model.addSongsToPlaylist(d, playlistId, songIds), 'addSongsToPlaylist', { playlistId, songIds }));
handle('library:removeFromPlaylist', ({ playlistId, songId }) =>
  change((d) => model.removeFromPlaylist(d, playlistId, songId), 'removeFromPlaylist', { playlistId, songId }));

handle('library:deleteSong', ({ songId, deleteFile }) => {
  if (remote.active()) return remote.deleteSong(songId, !!deleteFile);
  return library.quietly(() => {
    const song = model.songById(library.get(), songId);
    if (!song) throw new Error('That song no longer exists.');
    if (deleteFile && fs.existsSync(song.file)) {
      try {
        fs.rmSync(song.file);
      } catch {
        throw new Error('The file could not be deleted. It may be open in another program.');
      }
    }
    return library.mutate((d) => model.removeSong(d, songId, !deleteFile));
  });
});

handle('library:editSong', ({ songId, artist, title, mix }) => {
  const meta = { artist: String(artist || '').trim(), title: String(title || '').trim(), mix: String(mix || '').trim() };
  if (!meta.title) throw new Error('Please enter a title.');
  // The server renames its own file; a copy here follows at the next look.
  if (remote.active()) return remote.command('editSong', { songId, ...meta });
  return library.quietly(async () => {
    const song = model.songById(library.get(), songId);
    if (!song) throw new Error('That song no longer exists.');
    let file = song.file;
    if (fs.existsSync(song.file)) {
      try {
        file = await exporter.retagSong(song, meta);
      } catch {
        throw new Error('The file could not be renamed. It may be open in another program.');
      }
    }
    return library.mutate((d) => model.updateSong(d, songId, { ...meta, file }));
  });
});

handle('library:setFavourite', ({ songId, on }) => {
  change((d) => model.setFavourite(d, songId, !!on), 'setFavourite', { songId, on: !!on });
});

handle('library:recordListen', ({ songId, listened, duration, contextId }) => {
  // The song may have been deleted while it played; nothing to count then.
  if (!model.songById(currentLibrary(), songId)) return null;
  return change((d) => model.recordListen(d, songId, { listened, duration, contextId }), 'recordListen', { songId, listened, duration, contextId });
});

handle('library:findBySource', ({ url, key }) => model.findBySource(currentLibrary(), { url, key }));
handle('library:findByMeta', (meta) => model.findByMeta(currentLibrary(), meta));
handle('library:rescan', () => library.scan());

// ---- the Flow Server (Settings: Streaming, Download and Synchronization) ----

handle('server:status', () => remote.status());
handle('server:setSecret', (text) => remote.setSecret(text));
handle('server:syncNow', () => remote.syncNow());
handle('server:setOffline', ({ playlistId, on }) => remote.setOffline(playlistId, !!on));
handle('server:downloadSong', (songId) => remote.downloadSong(songId));
handle('server:removeDownload', (songId) => remote.removeDownload(songId));
handle('server:profiles', () => remote.loadProfiles());
handle('server:profileLogin', ({ profileId, pin }) => remote.loginProfile(profileId, pin));
handle('server:profileCreate', ({ name, pin }) => remote.createProfile(name, pin));
handle('server:profileLogout', () => remote.logoutProfile());
handle('server:profileRename', (name) => remote.renameProfile(name));
handle('server:profileDelete', () => remote.deleteProfile());
// Active Sessions: a POST body, or nothing for the list.
handle('server:sessions', (body) => remote.sessions(body || null));
// Downloads by the server: they stay there, so closing the app asks nothing.
// With "Share session cookies with the server", a new download takes the
// link's site's cookies from the browser chosen along.
handle('server:downloads', async ({ action, ...args }) => {
  const browser = settings.get('useCookies') && settings.get('shareCookies') ? settings.get('cookiesBrowser') : '';
  if (action === 'create' && browser) args.cookies = await cookieJar.siteCookies(args.url, browser);
  return remote.serverDownloads(action, args);
});
// The browsers the cookies can come from (Settings, Website Downloads).
handle('cookies:browsers', () => cookieJar.browsers());

handle('shell:showSong', (songId) => {
  const file = remote.active() ? remote.localFileOf(songId) : (model.songById(library.get(), songId) || {}).file;
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
  else shell.openPath(paths.musicDir());
});
handle('shell:openMusicFolder', () => shell.openPath(paths.musicDir()));

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
    title: 'Choose where Flow saves your songs',
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
    title: 'Open local files',
    buttonLabel: 'Select',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio and video files', extensions: LOCAL_EXTS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths;
});

handle('local:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a local folder',
    buttonLabel: 'Select',
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths;
});

let moving = false;
handle('folder:move', async (dir) => {
  refuseDuringImport();
  if (downloadToken) throw new Error('A download is running. Wait for it to finish first.');
  if (moving) throw new Error('The songs are already being moved.');
  moving = true;
  try {
    const oldDir = paths.musicDir();
    const result = await library.relocate(dir, (done, total, name) => {
      sendToWindow('folder:progress', { done, total, name });
    });
    covers.moveFolder(oldDir, result.dir);
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
  if (importRunning || importSaves) throw new Error('A playlist import is running. Wait for it to finish, or cancel it.');
}

handle('download:probe', async (url) => {
  refuseDuringImport();
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
  refuseDuringImport();
  const token = importer.groupToken();
  importToken = token;
  importRunning = true;
  const onProgress = (p) => {
    if (!token.cancelled) sendToWindow('import:progress', { ...p, run });
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
  const saving = importSaving.then(() => finishImport(job, onProgress));
  importSaving = saving.catch(() => {});
  return saving.finally(() => {
    importSaves -= 1;
    loudnessFiller.run();
    coverFiller.run();
  });
});

async function finishImport(job, onProgress) {
  if (!remote.active()) return importer.finish(job, onProgress);
  // With a server the songs are saved into Local Files first, as always,
  // then go up. The playlist to add to and the songs already in the
  // library are the server's, which Local Files does not have; only the
  // playlist an earlier "Finish this song" made in Local Files is merged
  // into here.
  const existingIds = job.entries.filter((e) => e.existingId).map((e) => e.existingId);
  const ownList = job.mergeInto && model.playlistById(library.get(), job.mergeInto) ? job.mergeInto : null;
  const localJob = { ...job, mergeInto: ownList, playlistIds: [], entries: job.entries.filter((e) => !e.existingId) };
  const summary = await importer.finish(localJob, onProgress);
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

handle('import:pending', (count) => {
  importPending = Math.max(0, Number(count) || 0);
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

function runShutdown(args) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'shutdown.exe');
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, text: String(stderr || stdout || (err && err.message) || '').trim() });
    });
  });
}

handle('sleep:scheduleShutdown', async (seconds) => {
  const s = Math.round(Number(seconds));
  if (!Number.isFinite(s) || s < 60 || s > 315360000) throw new Error('That is not a time the shutdown can be set to.');
  // An earlier plan (a timer set again) would make Windows refuse the new one.
  await runShutdown(['/a']);
  const r = await runShutdown(['/s', '/t', String(s), '/c', 'Flow sleep timer']);
  if (!r.ok) throw new Error(`Windows did not accept the shutdown${r.text ? `: ${r.text}` : '.'}`);
});

handle('sleep:cancelShutdown', async () => {
  const r = await runShutdown(['/a']);
  // "Unable to abort the system shutdown because no shutdown was in progress" is fine too.
  return r.ok;
});

handle('sleep:notify', (body) => {
  if (!Notification.isSupported()) return false;
  new Notification({ title: 'Flow: Sleep Timer', body: String(body || ''), icon: paths.appIconPath() || undefined }).show();
  return true;
});

// Active Sessions: someone asks to join, or this app became the host. A click brings Flow to the front.
handle('session:notify', (body) => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: 'Flow: Active Sessions', body: String(body || ''), icon: paths.appIconPath() || undefined });
  n.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  n.show();
  return true;
});

// A link out of the app, e.g. a matched YouTube upload to check. Web only.
handle('shell:openUrl', (url) => {
  if (/^https:\/\//i.test(String(url || ''))) shell.openExternal(String(url));
});

handle('download:start', async ({ probed, opts }) => {
  downloadToken = { cancelled: false };
  try {
    return await downloader.download(probed, opts, (stage, frac, text) => {
      sendToWindow('download:progress', { stage, frac, text });
    }, downloadToken);
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
  if (file && path.resolve(file).toLowerCase().startsWith(cache)) fs.rmSync(file, { force: true });
});

handle('audio:peaks', ({ file, duration }) => waveform.peaksFor(file, duration));

handle('song:finish', (job) => library.quietly(async () => {
  const meta = {
    artist: String(job.artist || '').trim(),
    title: String(job.title || '').trim(),
    mix: String(job.mix || '').trim(),
  };
  if (!meta.title) throw new Error('Please enter a title.');
  const saved = await exporter.saveSong({
    cachePath: job.cachePath, start: job.start, end: job.end, duration: job.duration,
    ...meta, sourceUrl: job.sourceUrl,
  });
  const song = {
    id: library.newId(),
    file: saved.file,
    ...meta,
    duration: saved.duration,
    format: saved.format,
    sourceUrl: String(job.sourceUrl || ''),
    sourceKey: String(job.sourceKey || ''),
    addedAt: Date.now(),
  };
  library.mutate((d) => {
    model.addSong(d, song);
    const lists = (job.playlistIds || []).filter((id) => model.playlistById(d, id));
    model.addSongToPlaylists(d, song.id, lists, song.addedAt);
  });
  // With a server it goes up now, into the server playlists picked for it.
  if (remote.active()) remote.pushNew({ [song.id]: job.playlistIds || [] });
  fs.rmSync(job.cachePath, { force: true });
  loudnessFiller.run();
  coverFiller.run();
  return song;
}));

// ---- startup ----

app.whenReady().then(() => {
  if (!isFirstInstance) return;
  // Windows shows notifications under the id of the Start menu shortcut,
  // which the installer gives the build's appId.
  if (app.isPackaged) app.setAppUserModelId('com.ceeser.flow');
  settings.load();
  if (settings.get('musicDir')) paths.setMusicDir(settings.get('musicDir'));
  library.load();
  downloader.clearCache();
  remote.init({
    onView: (view) => sendToWindow('library:changed', view),
    onStatus: (st) => sendToWindow('server:status', st),
    onNotice: (text, kind) => sendToWindow('server:notice', { text, kind }),
    onSettings: (patch) => sendToWindow('settings:changed', patch),
    // The live channel's events (Active Sessions).
    onLive: (ev) => sendToWindow('server:live', ev),
    confirmUpload: async ({ count, name }) => {
      const { response } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
        type: 'question',
        title: 'Flow',
        message: `Upload your ${count} Local Files ${count === 1 ? 'song' : 'songs'} to "${name}"?`,
        detail: 'This is a Flow Server you have not used before. If you are not sure it is yours, choose Not now: your songs stay on this computer, and Synchronize now in Settings uploads them later.',
        buttons: ['Upload', 'Not now'],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    },
  });
  createWindow();
  // Both in the background, once the window is up. The scan tells the window
  // itself when it changed anything, and from then on the folder is watched.
  library.onScanned((result) => {
    sendToWindow('library:scanned', result);
    if (result.added) {
      loudnessFiller.run();
      coverFiller.run();
    }
  });
  covers.watchLocal();
  setTimeout(() => {
    library.scan().catch(() => {}).then(() => {
      loudnessFiller.run();
      coverFiller.run();
    });
    library.watch();
    tools.refreshYtDlp();
  }, 1500);
});

app.on('window-all-closed', async () => {
  // Out of an Active Session first: a host hands it on at once.
  await remote.leaveSession(1500);
  remote.stop();
  library.unwatch();
  loudnessFiller.stop();
  coverFiller.stop();
  if (importToken) importToken.cancel();
  waveform.abort();
  if (downloadToken && downloadToken.cancel) downloadToken.cancel();
  app.quit();
});
