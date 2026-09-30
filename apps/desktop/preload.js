'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Routes answer { ok, value } or { ok: false, error }; see handle() in main.js.
async function call(channel, arg) {
  const r = await ipcRenderer.invoke(channel, arg);
  if (r && r.ok) return r.value;
  const err = new Error((r && r.error) || 'Something went wrong.');
  err.cancelled = !!(r && r.cancelled);
  throw err;
}

contextBridge.exposeInMainWorld('flow', {
  init: () => call('app:init'),
  setSettings: (patch) => call('settings:set', patch),
  // For the window closing, where an async call may not get out in time.
  setSettingsNow: (patch) => ipcRenderer.sendSync('settings:setSync', patch),
  onLibraryChanged: (fn) => ipcRenderer.on('library:changed', (_e, data) => fn(data)),
  onFolderScanned: (fn) => ipcRenderer.on('library:scanned', (_e, result) => fn(result)),

  createPlaylist: (name) => call('library:createPlaylist', name),
  renamePlaylist: (id, name) => call('library:renamePlaylist', { id, name }),
  deletePlaylist: (id) => call('library:deletePlaylist', id),
  addSongToPlaylists: (songId, playlistIds) => call('library:addSongToPlaylists', { songId, playlistIds }),
  addSongsToPlaylist: (playlistId, songIds) => call('library:addSongsToPlaylist', { playlistId, songIds }),
  removeFromPlaylist: (playlistId, songId) => call('library:removeFromPlaylist', { playlistId, songId }),
  deleteSong: (songId, deleteFile) => call('library:deleteSong', { songId, deleteFile }),
  editSong: (songId, meta) => call('library:editSong', { songId, ...meta }),
  setFavourite: (songId, on) => call('library:setFavourite', { songId, on }),
  recordListen: (songId, listened, duration) => call('library:recordListen', { songId, listened, duration }),
  findBySource: (url, key) => call('library:findBySource', { url, key }),
  findByMeta: (meta) => call('library:findByMeta', meta),
  rescan: () => call('library:rescan'),
  showSong: (songId) => call('shell:showSong', songId),
  openMusicFolder: () => call('shell:openMusicFolder'),
  folderStats: () => call('library:folderStats'),
  chooseFolder: () => call('folder:choose'),
  moveMusicFolder: (dir) => call('folder:move', dir),
  onFolderProgress: (fn) => ipcRenderer.on('folder:progress', (_e, p) => fn(p)),

  probe: (url) => call('download:probe', url),
  listImport: (url) => call('import:list', url),
  downloadImport: (items, opts) => call('import:download', { items, opts }),
  pickLocalFiles: () => call('local:pickFiles'),
  pickLocalFolder: () => call('local:pickFolder'),
  listLocal: (picked) => call('import:listLocal', picked),
  prepareLocal: (items, opts) => call('import:download', { items, opts, local: true }),
  finishImport: (job) => call('import:finish', job),
  setImportPending: (count) => call('import:pending', count),
  cancelImport: () => call('import:cancel'),
  onImportProgress: (fn) => ipcRenderer.on('import:progress', (_e, p) => fn(p)),
  openUrl: (url) => call('shell:openUrl', url),
  scheduleShutdown: (seconds) => call('sleep:scheduleShutdown', seconds),
  cancelShutdown: () => call('sleep:cancelShutdown'),
  notify: (body) => call('sleep:notify', body),
  download: (probed, opts) => call('download:start', { probed, opts }),
  cancelDownload: () => call('download:cancel'),
  discardDownload: (file) => call('download:discard', file),
  onDownloadProgress: (fn) => ipcRenderer.on('download:progress', (_e, p) => fn(p)),
  peaks: (file, duration) => call('audio:peaks', { file, duration }),

  // A Flow Server (Settings: Streaming, Download and Synchronization).
  serverStatus: () => call('server:status'),
  setServerSecret: (text) => call('server:setSecret', text),
  syncNow: () => call('server:syncNow'),
  setOffline: (playlistId, on) => call('server:setOffline', { playlistId, on }),
  profiles: () => call('server:profiles'),
  profileLogin: (profileId, pin) => call('server:profileLogin', { profileId, pin }),
  profileCreate: (name, pin) => call('server:profileCreate', { name, pin }),
  profileLogout: () => call('server:profileLogout'),
  profileRename: (name) => call('server:profileRename', name),
  profileDelete: () => call('server:profileDelete'),
  onServerStatus: (fn) => ipcRenderer.on('server:status', (_e, st) => fn(st)),
  onServerNotice: (fn) => ipcRenderer.on('server:notice', (_e, n) => fn(n)),
  onSettingsChanged: (fn) => ipcRenderer.on('settings:changed', (_e, patch) => fn(patch)),
  finishSong: (job) => call('song:finish', job),
});
