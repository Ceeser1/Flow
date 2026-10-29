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
  // Smart playlists (4.0): rules { match, conditions, sort, limit } (libraryModel cleanRules).
  createSmartPlaylist: (name, rules) => call('library:createSmartPlaylist', { name, rules }),
  setPlaylistRules: (id, rules) => call('library:setPlaylistRules', { id, rules }),
  renamePlaylist: (id, name) => call('library:renamePlaylist', { id, name }),
  deletePlaylist: (id, deleteSongs = false) => call('library:deletePlaylist', { id, deleteSongs }),
  setPlaylistShared: (id, shared) => call('library:setPlaylistShared', { id, shared }),
  setFollowing: (id, on) => call('library:setFollowing', { id, on }),
  addSongToPlaylists: (songId, playlistIds) => call('library:addSongToPlaylists', { songId, playlistIds }),
  addSongsToPlaylist: (playlistId, songIds) => call('library:addSongsToPlaylist', { playlistId, songIds }),
  removeFromPlaylist: (playlistId, songId) => call('library:removeFromPlaylist', { playlistId, songId }),
  deleteSong: (songId, deleteFile) => call('library:deleteSong', { songId, deleteFile }),
  editSong: (songId, meta) => call('library:editSong', { songId, ...meta }),
  trimSong: (songId, start, end) => call('library:trimSong', { songId, start, end }),
  serverSongPeaks: (songId) => call('server:songPeaks', songId),
  songAudio: (songId) => call('audio:song', songId),
  setFavourite: (songId, on) => call('library:setFavourite', { songId, on }),
  privateStatistics: () => call('stats:private'),
  onPrivateStatistics: (fn) => ipcRenderer.on('stats:private', (_e, data) => fn(data)),
  removeTrackedProfile: (serverId, profileId) => call('stats:removeTracked', { serverId, profileId }),
  recordListen: (songId, listened, duration, contextId, jamMember) => call('library:recordListen', {
    songId, listened, duration, contextId, jamMember: !!jamMember,
  }),
  findBySource: (url, key) => call('library:findBySource', { url, key }),
  findByMeta: (meta) => call('library:findByMeta', meta),
  rescan: () => call('library:rescan'),
  showSong: (songId) => call('shell:showSong', songId),
  openMusicFolder: () => call('shell:openMusicFolder'),
  openToolsFolder: () => call('tools:openFolder'),
  toolStatus: () => call('tools:status'),
  folderStats: () => call('library:folderStats'),
  chooseFolder: () => call('folder:choose'),
  moveMusicFolder: (dir) => call('folder:move', dir),
  onFolderProgress: (fn) => ipcRenderer.on('folder:progress', (_e, p) => fn(p)),

  probe: (url) => call('download:probe', url),
  // `run` numbers the import task; its progress messages carry it.
  listImport: (url, run) => call('import:list', { url, run }),
  // A playlist's Update: its link read in the background, no progress (main.js).
  checkImport: (url) => call('import:check', { url }),
  // A song's name typed instead of a link: the uploads found (importer.search).
  searchSongs: (query, page) => call('search:songs', { query, page }),
  cancelSearch: () => call('search:cancel'),
  downloadImport: (items, opts, run) => call('import:download', { items, opts, run }),
  pickLocalFiles: () => call('local:pickFiles'),
  // A visualizer's picture picked in its cogwheel (a JPEG's or PNG's bytes, or an MP4's or WebM's): kept, its path back.
  saveVizPicture: (name, bytes) => call('viz:savePicture', { name, bytes }),
  pickLocalFolder: () => call('local:pickFolder'),
  listLocal: (picked, run) => call('import:listLocal', { picked, run }),
  prepareLocal: (items, opts, run) => call('import:download', { items, opts, local: true, run }),
  finishImport: (job, run) => call('import:finish', { job, run }),
  setImportPending: (count) => call('import:pending', count),
  cancelImport: () => call('import:cancel'),
  onImportProgress: (fn) => ipcRenderer.on('import:progress', (_e, p) => fn(p)),
  openUrl: (url) => call('shell:openUrl', url),
  scheduleShutdown: (seconds) => call('sleep:scheduleShutdown', seconds),
  cancelShutdown: () => call('sleep:cancelShutdown'),
  notify: (body) => call('sleep:notify', body),
  notifySession: (body) => call('session:notify', body),
  download: (probed, opts) => call('download:start', { probed, opts }),
  cancelDownload: () => call('download:cancel'),
  discardDownload: (file) => call('download:discard', file),
  onDownloadProgress: (fn) => ipcRenderer.on('download:progress', (_e, p) => fn(p)),
  peaks: (file, duration) => call('audio:peaks', { file, duration }),
  sponsorSegments: (key, url) => call('sponsor:segments', { key, url }),

  // A Flow Server (Settings: Use a Flow Server).
  serverStatus: () => call('server:status'),
  setServerSecret: (text) => call('server:setSecret', text),
  syncNow: () => call('server:syncNow'),
  setOffline: (playlistId, on) => call('server:setOffline', { playlistId, on }),
  downloadServerSong: (songId) => call('server:downloadSong', songId),
  removeServerDownload: (songId) => call('server:removeDownload', songId),
  removeDeviceSong: (songId) => call('server:removeDeviceSong', songId),
  switchServer: (id) => call('server:switch', id),
  forgetServer: (id) => call('server:forget', id),
  profiles: () => call('server:profiles'),
  profileLogin: (profileId, pin) => call('server:profileLogin', { profileId, pin }),
  profileCreate: (name, pin) => call('server:profileCreate', { name, pin }),
  profileLogout: () => call('server:profileLogout'),
  profileRename: (name, pin) => call('server:profileRename', { name, pin }),
  profilePin: (pin, newPin) => call('server:profilePin', { pin, newPin }),
  profileDelete: () => call('server:profileDelete'),
  // Administration (3.5): an admins' route, and the master's password change.
  admin: (route, body) => call('server:admin', { route, body }),
  changeServerPassword: (args) => call('server:changePassword', args),
  onServerStatus: (fn) => ipcRenderer.on('server:status', (_e, st) => fn(st)),
  // Downloads by the server ("Download (Server)"): see remote.serverDownloads.
  serverDownloads: (action, args = {}) => call('server:downloads', { action, ...args }),
  cookieBrowsers: () => call('cookies:browsers'),
  onServerNotice: (fn) => ipcRenderer.on('server:notice', (_e, n) => fn(n)),
  // Active Sessions: sessions({ type, ... }) takes part, sessions() is the list
  // and this app's place in it.
  sessions: (body) => call('server:sessions', body),
  // The live channel's events: { type, data } (Active Sessions).
  onServerLive: (fn) => ipcRenderer.on('server:live', (_e, ev) => fn(ev)),
  onSettingsChanged: (fn) => ipcRenderer.on('settings:changed', (_e, patch) => fn(patch)),
  finishSong: (job) => call('song:finish', job),
  lookupInfo: (song) => call('song:lookupInfo', song),
  // A song's lyrics (4.0): { found, synced: [{ t, text }] | null, plain, instrumental }.
  lyrics: (songId) => call('song:lyrics', songId),
  // Lyrics written or edited here (4.0.1): lines [{ t, end, text }], or null to
  // look them up again; server: songId is a server's song just saved there.
  setLyrics: (songId, lines, server = false) => call('song:setLyrics', { songId, lines, server }),
  // A song just downloaded, by its names: { artist, title, duration }.
  lookupLyrics: (meta) => call('song:lookupLyrics', meta),
  // Settings' Lyrics cache (4.0.1): { count, none, bytes, left }; Clear lyrics cache resolves them after.
  lyricsStats: () => call('lyrics:stats'),
  clearLyricsCache: () => call('lyrics:clear'),
  // Lyrics kept, or the background lookups moved on (4.0.1).
  onLyricsChanged: (fn) => ipcRenderer.on('lyrics:changed', () => fn()),
  // LRCLIB (4.0.1): its search ({ q } or { title, artist, album, duration }),
  // and lyrics written here published there ({ title, artist, album, duration, lines }).
  searchLyrics: (params) => call('lyrics:search', params),
  publishLyrics: (meta) => call('lyrics:publish', meta),
  // Sharing the server by QR code (4.0): { link, code, name }; a flow://connect link
  // connected to ({ name }); a QR code's squares ({ size, modules }).
  shareLink: () => call('server:shareLink'),
  // Away listens (a guest in another server's session): totals only.
  recordAwayListen: (song, listened, duration) => call('library:recordAwayListen', { song, listened, duration }),
  // A guest in another server's session (4.0): look for them, then join,
  // session ({ body }), leave, songs, status, list.
  guestLook: () => call('guest:look'),
  guest: (action, args) => call('guest:call', { action, args }),
  onGuestLive: (fn) => ipcRenderer.on('guest:live', (_e, ev) => fn(ev)),
  onGuestChanged: (fn) => ipcRenderer.on('guest:changed', (_e, list) => fn(list)),
  connectLink: (text) => call('server:connectLink', text),
  qr: (text) => call('qr:encode', text),
  // Covers: files in Music\FlowPlayer\Covers (Store.coverSrc).
  wantCovers: (ids) => call('covers:want', ids),
  coverStats: () => call('covers:stats'),
  clearCoverCache: () => call('covers:clear'),
  onCoversUpdated: (fn) => ipcRenderer.on('covers:updated', (_e, info) => fn(info)),
  // Add Songs: the cover of a song downloaded but not saved yet ({ file, version } or null).
  stagedCover: (cachePath) => call('covers:staged', cachePath),
  onCoverStaged: (fn) => ipcRenderer.on('covers:staged', (_e, info) => fn(info)),
  // Backups of this computer's library.json (4.0): the list, one now, one put back.
  backups: () => call('backups:list'),
  makeBackup: () => call('backups:make'),
  restoreBackup: (name) => call('backups:restore', name),
});
