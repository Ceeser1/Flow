'use strict';

// The Mini Player (5.0): a small window of its own, drawn as a widget (no
// frame, rounded, see-through round its corners), with the song playing, its
// timeline, the player's five buttons and the volume. It plays nothing
// itself: Flow's window does, tells here what it plays ('mini:state', passed
// on to the Mini Player), and takes the Mini Player's buttons as commands
// ('mini:command'). Its page is mini/mini.html, with miniPreload.js.
//
// Its cogwheel: Show Equalizer (the app's equalizer, with the looks set in
// Flow's Settings, standing on the widget's bottom edge: the Mini Player asks
// for the bars' levels with each of its frames, 'mini:eq', Flow's window
// answers them, 'mini:levels', so nothing is worked out while the Mini Player
// does not draw), Cover as background, Lock position (the window can no longer
// be dragged or resized), Always on top, Open on PC Start (autostart.js: Flow
// starts with the computer, in the tray, showing the Mini Player at once with
// the song it showed last, kept in the settings as miniLast), Open Flow and
// Close Mini Player.
//
// Its edges and corners resize it while Lock position is off. A see-through
// window cannot be resized by the system, so the page tells when an edge is
// held and moved ('mini:resize') and the size is set here, by where the mouse
// is, within the limits below.
//
// Opening it from Flow's player bar sends Flow's window into the tray
// (main.js, src/tray.js); Open Flow brings that back, on the list playing.
// Closed while Flow's window is in the tray, Flow quits with it; while the
// Mini Player is open, the X of Flow's window only sends that into the tray.

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const autostart = require('./autostart');

// As it first opens.
const WIDTH = 380;
const HEIGHT = 192;
// The smallest: the five buttons and the volume beside each other; the title
// row, one line of title and one of artist with the cover as high, the
// timeline and the buttons (mini.css lays it out for these). The biggest:
// one and a half times 380 x 200.
const MIN_WIDTH = 300;
const MIN_HEIGHT = 152;
const MAX_WIDTH = 570;
const MAX_HEIGHT = 300;
// From the screen's edges, where it opens the first time (bottom right).
const MARGIN = 24;
// How often what it shows is written to the settings while a song plays (ms).
const KEEP_MS = 5000;
// What the Mini Player's buttons may ask of Flow's window.
const COMMANDS = new Set(['toggle', 'prev', 'next', 'back10', 'fwd10', 'seek', 'volume', 'mute', 'openFlow']);
// Its cogwheel's ticks, by their settings.
const TOGGLES = {
  eq: 'miniEq', coverBg: 'miniCoverBg', locked: 'miniLocked', onTop: 'miniOnTop', autostart: 'miniAutostart',
};
// The equalizer's looks, from Flow's Settings: the Mini Player's follows them.
const LOOK = ['eqColors', 'eqHeight', 'eqShine', 'eqShineSpread', 'eqVisibility'];
// How many bars the Mini Player may ask levels for (it has one every 4 px).
const MOST_BARS = 512;
const SIDES = ['x', 'y', 'width', 'height'];

const within = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

/** A size kept or asked for, within the limits; the first size where there is none. */
function sizeOf(b) {
  const has = !!b && Number(b.width) > 0 && Number(b.height) > 0;
  return {
    width: has ? within(b.width, MIN_WIDTH, MAX_WIDTH) : WIDTH,
    height: has ? within(b.height, MIN_HEIGHT, MAX_HEIGHT) : HEIGHT,
  };
}

/**
 * The window's place and size while one of its edges is dragged: `start` its
 * bounds when the edge was taken, `edge` which ('n', 's', 'e', 'w' or a
 * corner as 'ne', 'sw', ...), `dx` / `dy` how far the mouse has gone since.
 * The edge across stays where it is, also once a limit is reached.
 */
function resized(start, edge, dx, dy) {
  const e = String(edge || '');
  let {
    x, y, width, height,
  } = start;
  if (e.includes('e')) width = within(start.width + dx, MIN_WIDTH, MAX_WIDTH);
  if (e.includes('w')) {
    width = within(start.width - dx, MIN_WIDTH, MAX_WIDTH);
    x = start.x + start.width - width;
  }
  if (e.includes('s')) height = within(start.height + dy, MIN_HEIGHT, MAX_HEIGHT);
  if (e.includes('n')) {
    height = within(start.height - dy, MIN_HEIGHT, MAX_HEIGHT);
    y = start.y + start.height - height;
  }
  return {
    x, y, width, height,
  };
}

/**
 * `settings`: src/settings. `mainWindow()`: Flow's window (or null). `icon`:
 * the window's icon file. `language()`: the texts' language chosen ('' the
 * computer's). `hideFlow()`: Flow's window into the tray. `showFlow()`: it
 * in front again. `onOpenChange(open)`: told when it opens and closes.
 */
function createMiniPlayer({
  settings, mainWindow, icon, language, hideFlow = () => {}, showFlow = () => {}, onOpenChange = () => {},
}) {
  let win = null;
  // What Flow's window last said it plays; null until it has (a start with the computer).
  let state = null;
  // Commands from the Mini Player while Flow's window is still starting.
  let waiting = [];
  let keptAt = 0;
  let keptKey = '';
  let moveTimer = null;
  // An edge being dragged: { edge, bounds, cursor } as it was taken.
  let sizing = null;

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
  const look = () => Object.fromEntries(LOOK.map((k) => [k, settings.get(k)]));
  const ticks = () => ({
    eq: settings.get('miniEq'),
    coverBg: settings.get('miniCoverBg'),
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

  /** Where it was left and how big, if that still is on a screen; else the bottom right of Flow's screen. */
  function place() {
    const b = settings.get('miniBounds');
    const size = sizeOf(b);
    const onScreen = b && screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + size.width > a.x + 40 && b.x < a.x + a.width - 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
    });
    if (onScreen) return { x: b.x, y: b.y, ...size };
    const w = main();
    const display = w ? screen.getDisplayMatching(w.getNormalBounds()) : screen.getPrimaryDisplay();
    const a = display.workArea;
    return { x: a.x + a.width - size.width - MARGIN, y: a.y + a.height - size.height - MARGIN, ...size };
  }

  /** `byComputer`: started with the computer, Flow's window is not there yet (and starts in the tray). */
  function open({ byComputer = false } = {}) {
    if (isOpen()) {
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      ...place(),
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
      sizing = null;
      if (win === w) win = null;
      waiting = [];
      onOpenChange(false);
    });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.loadFile(path.join(__dirname, '..', 'mini', 'mini.html'));
    onOpenChange(true);
    // Opened from Flow: its window makes room, into the tray.
    if (!byComputer) hideFlow();
  }

  function keepPlace() {
    if (!isOpen()) return;
    const now = win.getBounds();
    const b = settings.get('miniBounds');
    if (!b || SIDES.some((k) => b[k] !== now[k])) settings.set({ miniBounds: now });
  }

  /**
   * An edge of the Mini Player dragged (its page tells: 'start' with the edge,
   * 'move' with each move of the mouse, 'end'). The size follows the mouse
   * from where the edge was taken, so nothing adds up over the moves.
   */
  function resize(phase, edge) {
    if (!isOpen()) return;
    if (phase === 'start') {
      sizing = settings.get('miniLocked') ? null : { edge, bounds: win.getBounds(), cursor: screen.getCursorScreenPoint() };
    } else if (phase === 'move' && sizing) {
      const at = screen.getCursorScreenPoint();
      const to = resized(sizing.bounds, sizing.edge, at.x - sizing.cursor.x, at.y - sizing.cursor.y);
      const now = win.getBounds();
      if (SIDES.some((k) => to[k] !== now[k])) win.setBounds(to);
    } else if (phase === 'end' && sizing) {
      sizing = null;
      keepPlace();
    }
  }

  function close() {
    if (isOpen()) win.close();
  }

  /** Flow's window in front, on the list playing (the page's part: 'openFlow'). */
  function openFlow() {
    if (!main()) return;
    showFlow();
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
    const key = `${state.songId}|${state.playing ? 1 : 0}|${state.cover || ''}|${state.coverBig || ''}`;
    const t = Date.now();
    if (!now && key === keptKey && t - keptAt < KEEP_MS) return;
    keptKey = key;
    keptAt = t;
    // Where the song is by now, not where it was when the window last said.
    const moved = state.playing ? (t - (state.at || t)) / 1000 : 0;
    const position = Math.max(0, Math.min(state.duration || Infinity, (Number(state.position) || 0) + moved));
    settings.set({
      miniLast: {
        songId: state.songId, title: state.title, artist: state.artist, cover: state.cover, coverBig: state.coverBig, position, duration: state.duration, list: state.list,
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
    if (name === 'locked' && on) sizing = null;
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
      state: state || lastState(), ticks: ticks(), look: look(), language: language(), platform: process.platform,
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
  // The equalizer: the Mini Player asks for the levels of so many bars, Flow's window answers them.
  ipcMain.on('mini:eq', (event, bars) => {
    const w = main();
    if (!fromMini(event) || !w || !state) return;
    w.webContents.send('mini:eq', within(bars, 16, MOST_BARS));
  });
  ipcMain.on('mini:levels', (event, levels) => {
    if (fromMain(event) && Array.isArray(levels) && levels.length <= MOST_BARS) toMini('mini:levels', levels);
  });
  ipcMain.on('mini:resize', (event, arg) => {
    if (fromMini(event)) resize(arg && arg.phase, arg && arg.edge);
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
    /** Settings changed in Flow's window: the equalizer's looks go on to the Mini Player. */
    settingsChanged(patch) {
      if (patch && LOOK.some((k) => k in patch)) toMini('mini:look', look());
    },
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

module.exports = {
  createMiniPlayer, sizeOf, resized, WIDTH, HEIGHT, MIN_WIDTH, MIN_HEIGHT, MAX_WIDTH, MAX_HEIGHT,
};
