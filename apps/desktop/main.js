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
const library = require('./src/library');
const model = require('@flow/core/libraryModel');
const tools = require('./src/tools');
const downloader = require('./src/downloader');
const importer = require('./src/importer');
const exporter = require('./src/exporter');
const waveform = require('./src/waveform');
const loudness = require('./src/loudness');
const { MP3_QUALITIES, LOCAL_EXTS } = require('@flow/core/formats');
const { ProcessCancelledError } = require('./src/processRunner');

let mainWindow = null;
let downloadToken = null;
// Imported songs downloaded but not saved yet (the window says how many).
let importPending = 0;
// Measures the songs' loudness in the background while "Equalize volume" is on.
const loudnessFiller = loudness.createFiller(library, model, () => settings.get('normalize'));

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
        cancelled: err instanceof ProcessCancelledError,
        error: (err && err.message) || String(err),
      };
    }
  });
}

library.onChange((data) => sendToWindow('library:changed', data));

function iconDataUrl() {
  try {
    const png = fs.readFileSync(path.join(__dirname, 'renderer', 'assets', 'icon.png'));
    return 'data:image/png;base64,' + png.toString('base64');
  } catch {
    return '';
  }
}

handle('app:init', () => ({
  library: library.get(),
  settings: settings.all(),
  musicDir: paths.musicDir(),
  tools: tools.status(),
  mp3Qualities: MP3_QUALITIES,
  version: app.getVersion(),
  // For the Windows media overlay, which only takes http(s) or data: artwork.
  iconDataUrl: iconDataUrl(),
}));

handle('settings:set', (patch) => {
  const next = settings.set(patch);
  if (patch && patch.normalize === true) loudnessFiller.run();
  return next;
});
ipcMain.on('settings:setSync', (event, patch) => {
  settings.set(patch);
  event.returnValue = true;
});

handle('library:createPlaylist', (name) =>
  library.mutate((d) => model.createPlaylist(d, name, library.newId())));
handle('library:renamePlaylist', ({ id, name }) =>
  library.mutate((d) => model.renamePlaylist(d, id, name)));
handle('library:deletePlaylist', (id) =>
  library.mutate((d) => model.deletePlaylist(d, id)));
handle('library:addSongToPlaylists', ({ songId, playlistIds }) =>
  library.mutate((d) => model.addSongToPlaylists(d, songId, playlistIds)));
handle('library:addSongsToPlaylist', ({ playlistId, songIds }) =>
  library.mutate((d) => model.addSongsToPlaylist(d, playlistId, songIds)));
handle('library:removeFromPlaylist', ({ playlistId, songId }) =>
  library.mutate((d) => model.removeFromPlaylist(d, playlistId, songId)));

handle('library:deleteSong', ({ songId, deleteFile }) => library.quietly(() => {
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
}));

handle('library:editSong', ({ songId, artist, title, mix }) => library.quietly(async () => {
  const song = model.songById(library.get(), songId);
  if (!song) throw new Error('That song no longer exists.');
  const meta = { artist: String(artist || '').trim(), title: String(title || '').trim(), mix: String(mix || '').trim() };
  if (!meta.title) throw new Error('Please enter a title.');
  let file = song.file;
  if (fs.existsSync(song.file)) {
    try {
      file = await exporter.retagSong(song, meta);
    } catch {
      throw new Error('The file could not be renamed. It may be open in another program.');
    }
  }
  return library.mutate((d) => model.updateSong(d, songId, { ...meta, file }));
}));

handle('library:setFavourite', ({ songId, on }) => library.mutate((d) => {
  model.setFavourite(d, songId, !!on);
}));

handle('library:recordListen', ({ songId, listened, duration }) => {
  // The song may have been deleted while it played; nothing to count then.
  if (!model.songById(library.get(), songId)) return null;
  return library.mutate((d) => model.recordListen(d, songId, { listened, duration }));
});

handle('library:findBySource', ({ url, key }) => model.findBySource(library.get(), { url, key }));
handle('library:findByMeta', (meta) => model.findByMeta(library.get(), meta));
handle('library:rescan', () => library.scan());

handle('shell:showSong', (songId) => {
  const song = model.songById(library.get(), songId);
  if (song && fs.existsSync(song.file)) shell.showItemInFolder(song.file);
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
    const result = await library.relocate(dir, (done, total, name) => {
      sendToWindow('folder:progress', { done, total, name });
    });
    settings.set({ musicDir: result.dir });
    return result;
  } finally {
    moving = false;
  }
});

// ---- downloading and saving ----

function knownArtists() {
  return [...new Set(library.get().songs.map((s) => s.artist).filter(Boolean))];
}

function refuseDuringImport() {
  if (importRunning) throw new Error('A playlist import is running. Wait for it to finish, or cancel it.');
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

let importToken = null;
let importRunning = false;

handle('import:list', async (url) => {
  refuseDuringImport();
  importToken = importer.groupToken();
  try {
    return await importer.list(url, importToken, (p) => sendToWindow('import:progress', p),
      { knownArtists: knownArtists() });
  } finally {
    importToken = null;
  }
});

// Local files take the playlist's steps: listed, prepared into the cache
// (import:download with `local`), then saved by import:finish.
handle('import:listLocal', (picked) => {
  refuseDuringImport();
  return importer.listLocal(picked);
});

handle('import:download', async ({ items, opts, local }) => {
  refuseDuringImport();
  importRunning = true;
  importToken = importer.groupToken();
  const onProgress = (p) => sendToWindow('import:progress', p);
  try {
    if (local) return await importer.prepareLocal(items, opts, importToken, onProgress);
    return await importer.download(items, opts, importToken, onProgress, { knownArtists: knownArtists() });
  } finally {
    importRunning = false;
    importToken = null;
  }
});

handle('import:finish', async (job) => {
  refuseDuringImport();
  importRunning = true;
  try {
    return await importer.finish(job, (p) => sendToWindow('import:progress', p));
  } finally {
    importRunning = false;
    loudnessFiller.run();
  }
});

handle('import:pending', (count) => {
  importPending = Math.max(0, Number(count) || 0);
});

handle('import:cancel', () => {
  if (importToken) importToken.cancel();
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
  fs.rmSync(job.cachePath, { force: true });
  loudnessFiller.run();
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
  createWindow();
  // Both in the background, once the window is up. The scan tells the window
  // itself when it changed anything, and from then on the folder is watched.
  library.onScanned((result) => {
    sendToWindow('library:scanned', result);
    if (result.added) loudnessFiller.run();
  });
  setTimeout(() => {
    library.scan().catch(() => {}).then(() => loudnessFiller.run());
    library.watch();
    tools.refreshYtDlp();
  }, 1500);
});

app.on('window-all-closed', () => {
  library.unwatch();
  loudnessFiller.stop();
  if (importToken) importToken.cancel();
  waveform.abort();
  if (downloadToken && downloadToken.cancel) downloadToken.cancel();
  app.quit();
});
