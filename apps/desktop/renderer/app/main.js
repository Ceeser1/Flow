'use strict';

// Startup: fetch the library and settings, wire every part, then put the
// window back where the last session left it.

(async () => {
  let init;
  try {
    init = await window.flow.init();
  } catch (err) {
    document.body.textContent = 'Flow could not start: ' + err.message;
    return;
  }
  Store.settings = init.settings;
  Store.musicDir = init.musicDir;
  Store.iconDataUrl = init.iconDataUrl;
  Store.mp3Qualities = init.mp3Qualities;
  Store.setServer(init.server);
  Store.setLibrary(init.library);
  Covers.init(init.covers);

  Player.init();
  Output.init();
  Session.init();
  Ambient.init();
  ScreenFlash.init();
  Nav.init();
  SearchPage.init();
  AddPage.init();
  ImportPanel.init();
  ServerImport.init();
  PlaylistsPage.init();
  FollowedPage.init();
  SessionsPage.init();
  PlaylistPage.init();
  SettingsPanel.init();
  SongActions.init();
  SleepTimer.init();
  Keys.init();

  window.flow.onLibraryChanged((lib) => Store.setLibrary(lib));
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
    if (added) parts.push(`${Util.plural(added, 'song')} added`);
    if (removed) parts.push(`${Util.plural(removed, 'song')} removed`);
    if (moved) parts.push(`${Util.plural(moved, 'song')} renamed or moved`);
    if (parts.length) toast(`Local Files: ${parts.join(', ')}`, 'success');
  });

  const missing = Object.entries(init.tools).filter(([, ok]) => !ok).map(([name]) => name);
  if (missing.length) {
    toast(`Missing tools: ${missing.join(', ')}. Downloading will not work until Flow is reinstalled.`, 'error');
  }

  Player.restore();
  Nav.openPlaylist(init.settings.lastPlaylistId || 'all');
  document.body.classList.add('ready');
})();
