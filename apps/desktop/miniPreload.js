'use strict';

// The Mini Player's window (mini/mini.html) as it reaches Flow: see src/miniPlayer.js.

const { contextBridge, ipcRenderer } = require('electron');

// The texts' language chosen in Settings, as the main window has it (i18n.js reads window.flow.language).
contextBridge.exposeInMainWorld('flow', {
  language: ipcRenderer.sendSync('i18n:language'),
});

contextBridge.exposeInMainWorld('mini', {
  /** { state, ticks: { eq, coverBg, locked, onTop, autostart, canAutostart }, look (the equalizer's, from Flow's Settings), platform } as the window starts. */
  hello: () => ipcRenderer.invoke('mini:hello'),
  /** What Flow plays: { hasSong, songId, title, artist, cover, list, playing, position, duration, at, volume, canVolume, live }. */
  onState: (fn) => ipcRenderer.on('mini:state', (_e, state) => fn(state)),
  /** A button: toggle, prev, next, back10, fwd10, seek (seconds), volume (0-1). */
  do: (action, value) => ipcRenderer.send('mini:do', { action, value }),
  /** A tick of the cogwheel (eq, coverBg, locked, onTop, autostart): { ticks, error }. */
  set: (name, value) => ipcRenderer.invoke('mini:set', { name, value }),
  /** An edge dragged to resize: 'start' with the edge ('n', 'se', ...), 'move' as the mouse moves, 'end'. */
  resize: (phase, edge) => ipcRenderer.send('mini:resize', { phase, edge }),
  /** Show Equalizer: the levels of `bars` bars asked of Flow's window (0..255 each, they come to onLevels), and its looks when they change. */
  wantLevels: (bars) => ipcRenderer.send('mini:eq', bars),
  onLevels: (fn) => ipcRenderer.on('mini:levels', (_e, levels) => fn(levels)),
  onLook: (fn) => ipcRenderer.on('mini:look', (_e, look) => fn(look)),
  openFlow: () => ipcRenderer.send('mini:openFlow'),
  close: () => ipcRenderer.send('mini:close'),
});
