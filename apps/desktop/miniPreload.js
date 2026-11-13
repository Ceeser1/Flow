'use strict';

// The Mini Player's window (mini/mini.html) as it reaches Flow: see src/miniPlayer.js.

const { contextBridge, ipcRenderer } = require('electron');

// The texts' language chosen in Settings, as the main window has it (i18n.js reads window.flow.language).
contextBridge.exposeInMainWorld('flow', {
  language: ipcRenderer.sendSync('i18n:language'),
});

contextBridge.exposeInMainWorld('mini', {
  /** { state, ticks: { locked, onTop, autostart, canAutostart }, platform } as the window starts. */
  hello: () => ipcRenderer.invoke('mini:hello'),
  /** What Flow plays: { hasSong, songId, title, artist, cover, list, playing, position, duration, at, volume, canVolume, live }. */
  onState: (fn) => ipcRenderer.on('mini:state', (_e, state) => fn(state)),
  /** A button: toggle, prev, next, back10, fwd10, seek (seconds), volume (0-1). */
  do: (action, value) => ipcRenderer.send('mini:do', { action, value }),
  /** A tick of the cogwheel (locked, onTop, autostart): { ticks, error }. */
  set: (name, value) => ipcRenderer.invoke('mini:set', { name, value }),
  openFlow: () => ipcRenderer.send('mini:openFlow'),
  close: () => ipcRenderer.send('mini:close'),
});
