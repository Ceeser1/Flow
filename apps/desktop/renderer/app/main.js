'use strict';

// Startup: fetch the library and settings, wire every part, then put the
// window back where the last session left it.

(async () => {
  let init;
  try {
    init = await window.flow.init();
  } catch (err) {
    document.body.textContent = T('startup.couldNotStart', { reason: err.message });
    return;
  }
  Store.platform = init.platform || 'desktop';
  Store.os = init.os || 'win32';
  Store.uiMode = init.uiMode || 'desktop';
  Store.caps = init.caps || {};
  Store.version = init.version || '';
  document.body.classList.toggle('mobile', Store.uiMode === 'mobile');
  document.body.classList.toggle('web', Store.web);
  Store.settings = init.settings;
  Store.musicDir = init.musicDir;
  Store.iconDataUrl = init.iconDataUrl;
  Store.mp3Qualities = init.mp3Qualities;
  // The computer's ffmpeg, ffprobe and yt-dlp (downloadsHelp.js).
  Store.tools = init.tools || {};
  Store.setServer(init.server);
  Store.takeLibrary({ library: init.library, seq: init.librarySeq });
  Covers.init(init.covers);

  Player.init();
  Output.init();
  Session.init();
  Ambient.init();
  Nav.init();
  SearchPage.init();
  AddPage.init();
  ImportPanel.init();
  ServerImport.init();
  ClientQueue.init();
  SongSearch.init();
  PlaylistsPage.init();
  FollowedPage.init();
  SessionsPage.init();
  TrendPage.init();
  PlaylistPage.init();
  SettingsPanel.init();
  SongActions.init();
  SleepTimer.init();
  Keys.init();
  Mobile.init();
  // After Mobile: the phone's Now Playing has its lyrics frame by then.
  Lyrics.init();
  Welcome.init();
  BackgroundHelp.init();

  // The chosen visualizer's shaders compiled ahead, once the window has
  // settled, so opening it the first time does not wait for them.
  setTimeout(() => Visualizer.warm(), 3000);

  window.flow.onLibraryChanged((msg) => Store.takeLibrary(msg));
  window.flow.onServerStatus((st) => Store.setServer(st));
  // A setting Flow changed by itself (the Remote address filled in).
  window.flow.onSettingsChanged((patch) => Store.previewSettings(patch));
  // The same word from the server twice within half a minute is shown once.
  const noticed = new Map();
  window.flow.onServerNotice(({ text, kind }) => {
    if (noticed.get(text) > Date.now() - 30000) return;
    noticed.set(text, Date.now());
    toast(text, kind === 'error' ? 'error' : 'info');
  });
  ServerChip.init();
  // Songs added, deleted or renamed in Local Files from outside.
  window.flow.onFolderScanned(({ added, removed, moved }) => {
    const parts = [];
    if (added) parts.push(T('startup.localFiles.added', { songs: Util.plural(added, 'song') }));
    if (removed) parts.push(T('startup.localFiles.removed', { songs: Util.plural(removed, 'song') }));
    if (moved) parts.push(T('startup.localFiles.moved', { songs: Util.plural(moved, 'song') }));
    if (parts.length) toast(T('startup.localFiles.changed', { changes: parts.join(', ') }), 'success');
  });

  // yt-dlp is not shipped (downloadsHelp.js): only ffmpeg and ffprobe are missed.
  const missing = Object.entries(init.tools || {}).filter(([name, ok]) => !ok && name !== 'ytDlp').map(([name]) => name);
  if (missing.length) {
    toast(T('startup.missingTools', { tools: missing.join(', ') }), 'error');
  }

  Player.restore();
  // A listening trend list last open stays shut while they are hidden.
  const last = init.settings.lastPlaylistId || 'all';
  Nav.openPlaylist(Store.settings.showTrend === false && SmartLists.isSmart(last) ? 'all' : last);
  document.body.classList.add('ready');
})();
