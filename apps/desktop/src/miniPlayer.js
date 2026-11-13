'use strict';

// The Mini Player (5.0): a small window of its own, drawn as a widget (no
// frame, rounded, see-through round its corners), with the song playing, its
// timeline, the player's five buttons and the volume. It plays nothing
// itself: Flow's window does, tells here what it plays ('mini:state', passed
// on to the Mini Player), and takes the Mini Player's buttons as commands
// ('mini:command'). Its page is mini/mini.html, with miniPreload.js.
//
// Its cogwheel: Lock position (the window can no longer be dragged), Always
// on top, Open on PC Start (autostart.js: Flow starts with the computer,
// minimized, showing the Mini Player at once with the song it showed last,
// kept in the settings as miniLast), Open Flow and Close Mini Player.
//
// Opening it from Flow's player bar minimizes Flow's window; Open Flow brings
// that back, on the list playing. It goes when Flow's window is closed.

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const autostart = require('./autostart');

const WIDTH = 380;
const HEIGHT = 200;
// From the screen's edges, where it opens the first time (bottom right).
const MARGIN = 24;
// How often what it shows is written to the settings while a song plays (ms).
const KEEP_MS = 5000;
// What the Mini Player's buttons may ask of Flow's window.
const COMMANDS = new Set(['toggle', 'prev', 'next', 'back10', 'fwd10', 'seek', 'volume', 'mute', 'openFlow']);
// Its cogwheel's ticks, by their settings.
const TOGGLES = { locked: 'miniLocked', onTop: 'miniOnTop', autostart: 'miniAutostart' };

/**
 * `settings`: src/settings. `mainWindow()`: Flow's window (or null). `icon`:
 * the window's icon file. `language()`: the texts' language chosen ('' the
 * computer's). `onOpenChange(open)`: told when it opens and closes.
 */
function createMiniPlayer({
  settings, mainWindow, icon, language, onOpenChange = () => {},
}) {
  let win = null;
  // What Flow's window last said it plays; null until it has (a start with the computer).
  let state = null;
  // Commands from the Mini Player while Flow's window is still starting.
  let waiting = [];
  let keptAt = 0;
  let keptKey = '';
  let moveTimer = null;

  const main = () => {
    const w = mainWindow();
    return w && !w.isDestroyed() ? w : null;
  };
  const isOpen = () => !!win && !win.isDestroyed();
  const fromMini = (event) => isOpen() && event.sender === win.webContents;
  const fromMain = (event) => !!main() && event.sender === main().webContents;
  const toMini = (channel, payload) => {
    if (isOpen()) win.webContents.send(channel, payload);
  };
  const ticks = () => ({
    locked: settings.get('miniLocked'),
    onTop: settings.get('miniOnTop'),
    autostart: settings.get('miniAutostart'),
    canAutostart: autostart.supported(),
  });

  /** The song shown last as a state: paused, at the place it was left. */
  function lastState() {
    const last = settings.get('miniLast');
    if (!last) return { hasSong: false, live: false };
    return {
      ...last, hasSong: true, playing: false, at: Date.now(), live: false,
    };
  }

  /** Where it was left, if that still is on a screen; else the bottom right of Flow's screen. */
  function place() {
    const b = settings.get('miniBounds');
    const onScreen = b && screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + WIDTH > a.x + 40 && b.x < a.x + a.width - 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
    });
    if (onScreen) return { x: b.x, y: b.y };
    const w = main();
    const display = w ? screen.getDisplayMatching(w.getNormalBounds()) : screen.getPrimaryDisplay();
    const a = display.workArea;
    return { x: a.x + a.width - WIDTH - MARGIN, y: a.y + a.height - HEIGHT - MARGIN };
  }

  /** `byComputer`: started with the computer, Flow's window is not there yet (and stays minimized). */
  function open({ byComputer = false } = {}) {
    if (isOpen()) {
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      ...place(),
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: settings.get('miniOnTop'),
      show: false,
      title: 'Flow Mini Player',
      icon: icon || undefined,
      webPreferences: {
        preload: path.join(__dirname, '..', 'miniPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const w = win;
    w.setMenuBarVisibility(false);
    w.once('ready-to-show', () => w.show());
    // A right click on a place that drags the window: no system menu of a window without a frame.
    w.on('system-context-menu', (e) => e.preventDefault());
    w.on('moved', keepPlace);
    w.on('move', () => {
      // Linux tells no 'moved'.
      clearTimeout(moveTimer);
      moveTimer = setTimeout(keepPlace, 400);
    });
    w.on('closed', () => {
      clearTimeout(moveTimer);
      if (win === w) win = null;
      waiting = [];
      onOpenChange(false);
    });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.loadFile(path.join(__dirname, '..', 'mini', 'mini.html'));
    onOpenChange(true);
    // Opened from Flow: its window makes room.
    if (!byComputer && main() && !main().isMinimized()) main().minimize();
  }

  function keepPlace() {
    if (!isOpen()) return;
    const [x, y] = win.getPosition();
    const b = settings.get('miniBounds');
    if (!b || b.x !== x || b.y !== y) settings.set({ miniBounds: { x, y } });
  }

  function close() {
    if (isOpen()) win.close();
  }

  /** Flow's window in front, on the list playing (the page's part: 'openFlow'). */
  function openFlow() {
    const w = main();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    command({ action: 'openFlow' });
  }

  /** A button of the Mini Player's, for Flow's window; kept while that is still starting. */
  function command(cmd) {
    if (!cmd || !COMMANDS.has(cmd.action)) return;
    const clean = { action: cmd.action, value: Number.isFinite(Number(cmd.value)) ? Number(cmd.value) : 0 };
    const w = main();
    if (w && state) w.webContents.send('mini:command', clean);
    else if (waiting.length < 8) waiting.push(clean);
  }

  /** What Flow's window plays: on to the Mini Player, and kept for the next start. */
  function took(next) {
    const first = !state;
    state = { ...(next || {}), live: true };
    toMini('mini:state', state);
    keep();
    if (!first) return;
    const w = main();
    const list = waiting;
    waiting = [];
    if (w) for (const cmd of list) w.webContents.send('mini:command', cmd);
  }

  /** The song shown into the settings: at once when it or its playing changes, else every few seconds. */
  function keep(now = false) {
    if (!state) return;
    if (!state.hasSong) {
      if (settings.get('miniLast')) settings.set({ miniLast: null });
      keptKey = '';
      return;
    }
    const key = `${state.songId}|${state.playing ? 1 : 0}|${state.cover || ''}`;
    const t = Date.now();
    if (!now && key === keptKey && t - keptAt < KEEP_MS) return;
    keptKey = key;
    keptAt = t;
    // Where the song is by now, not where it was when the window last said.
    const moved = state.playing ? (t - (state.at || t)) / 1000 : 0;
    const position = Math.max(0, Math.min(state.duration || Infinity, (Number(state.position) || 0) + moved));
    settings.set({
      miniLast: {
        songId: state.songId, title: state.title, artist: state.artist, cover: state.cover, position, duration: state.duration, list: state.list,
      },
    });
  }

  /** A tick of the cogwheel: applied and kept. Answers the ticks as they are now. */
  function setTick(name, value) {
    const key = TOGGLES[name];
    if (!key) return ticks();
    const on = !!value;
    if (name === 'autostart') autostart.set(on);
    settings.set({ [key]: on });
    if (name === 'onTop' && isOpen()) win.setAlwaysOnTop(on);
    return ticks();
  }

  ipcMain.on('mini:state', (event, next) => {
    if (fromMain(event)) took(next);
  });
  ipcMain.on('mini:toggle', (event) => {
    if (!fromMain(event)) return;
    if (isOpen()) close();
    else open();
  });
  ipcMain.handle('mini:hello', (event) => {
    if (!fromMini(event)) return null;
    return {
      state: state || lastState(), ticks: ticks(), language: language(), platform: process.platform,
    };
  });
  ipcMain.on('mini:do', (event, cmd) => {
    if (fromMini(event)) command(cmd);
  });
  ipcMain.handle('mini:set', (event, arg) => {
    if (!fromMini(event)) return null;
    try {
      return { ticks: setTick(arg && arg.name, arg && arg.value) };
    } catch (err) {
      return { ticks: ticks(), error: (err && err.message) || String(err) };
    }
  });
  ipcMain.on('mini:openFlow', (event) => {
    if (fromMini(event)) openFlow();
  });
  ipcMain.on('mini:close', (event) => {
    if (fromMini(event)) close();
  });

  return {
    open,
    close,
    isOpen,
    /** Flow's window is going (or the computer shuts down): the song shown is kept as it is now. */
    keepNow: () => keep(true),
    /** Flow's window loads again (the language switched): its state comes anew, and the Mini Player's texts too. */
    reload() {
      state = null;
      if (isOpen()) win.webContents.reload();
    },
    /** Open on PC Start is on: the login item names this program (it may have moved since). */
    refreshAutostart() {
      if (!settings.get('miniAutostart')) return;
      try {
        autostart.set(true);
      } catch {
        // Tried again at the next start.
      }
    },
  };
}

module.exports = { createMiniPlayer, WIDTH, HEIGHT };
