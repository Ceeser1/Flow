'use strict';

// The Mini Player (5.0): what its settings may hold, "Open on PC Start" (the
// start with the computer asked for by --mini, Linux's autostart file), and
// the menu of the tray icon Flow has while its window is hidden.

const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/settings');
const autostart = require('../src/autostart');
const mini = require('../src/miniPlayer');
const tray = require('../src/tray');
const caps = require('@flow/core/client/caps');

test('the Mini Player\'s settings: on top by default, the ticks are true or false, a place needs both numbers', () => {
  const fresh = settings.clean({});
  assert.equal(fresh.miniOnTop, true);
  assert.equal(fresh.miniLocked, false);
  assert.equal(fresh.miniAutostart, false);
  assert.equal(fresh.miniCoverBg, false);
  assert.equal(fresh.miniEq, false);
  assert.equal(fresh.miniBounds, null);
  assert.equal(fresh.miniLast, null);
  const s = settings.clean({
    miniOnTop: false, miniLocked: 'yes', miniAutostart: true, miniCoverBg: true, miniBounds: { x: 12.6, y: '40' },
  });
  assert.equal(s.miniOnTop, false);
  assert.equal(s.miniLocked, false);
  assert.equal(s.miniAutostart, true);
  assert.equal(s.miniCoverBg, true);
  assert.equal(settings.clean({ miniCoverBg: 1 }).miniCoverBg, false);
  assert.equal(settings.clean({ miniEq: true }).miniEq, true);
  assert.equal(settings.clean({ miniEq: 'on' }).miniEq, false);
  assert.deepEqual(s.miniBounds, { x: 13, y: 40 });
  assert.equal(settings.clean({ miniBounds: { x: 5 } }).miniBounds, null);
  assert.equal(settings.clean({ miniBounds: 'left' }).miniBounds, null);
});

test('the Mini Player\'s size is kept with its place once it has one, both numbers or none', () => {
  assert.deepEqual(settings.clean({
    miniBounds: {
      x: 10, y: 20, width: 420.4, height: '260',
    },
  }).miniBounds, {
    x: 10, y: 20, width: 420, height: 260,
  });
  assert.deepEqual(settings.clean({ miniBounds: { x: 10, y: 20, width: 420 } }).miniBounds, { x: 10, y: 20 });
  assert.deepEqual(settings.clean({ miniBounds: { x: 10, y: 20, width: 0, height: 200 } }).miniBounds, { x: 10, y: 20 });
  assert.deepEqual(settings.clean({ miniBounds: { x: 10, y: 20, width: 'wide', height: 200 } }).miniBounds, { x: 10, y: 20 });
  assert.equal(settings.clean({ miniBounds: { width: 400, height: 200 } }).miniBounds, null);
});

test('the Mini Player opens 380 x 192, and a kept size stays within 300 x 152 and 570 x 300', () => {
  assert.deepEqual(mini.sizeOf(null), { width: 380, height: 192 });
  assert.deepEqual(mini.sizeOf({ x: 5, y: 5 }), { width: 380, height: 192 });
  assert.deepEqual(mini.sizeOf({ width: 400, height: 250 }), { width: 400, height: 250 });
  assert.deepEqual(mini.sizeOf({ width: 100, height: 100 }), { width: 300, height: 152 });
  assert.deepEqual(mini.sizeOf({ width: 4000, height: 4000 }), { width: 570, height: 300 });
  // One and a half times the size it had when the limits were set (380 x 200).
  assert.equal(mini.MAX_WIDTH, 380 * 1.5);
  assert.equal(mini.MAX_HEIGHT, 200 * 1.5);
});

test('dragging an edge of the Mini Player: that edge follows the mouse, the one across stays, the limits hold', () => {
  const start = {
    x: 1000, y: 500, width: 380, height: 192,
  };
  const at = (edge, dx, dy) => mini.resized(start, edge, dx, dy);
  // Right and bottom: the place stays.
  assert.deepEqual(at('e', 50, 99), {
    x: 1000, y: 500, width: 430, height: 192,
  });
  assert.deepEqual(at('s', 99, 40), {
    x: 1000, y: 500, width: 380, height: 232,
  });
  assert.deepEqual(at('se', -30, -20), {
    x: 1000, y: 500, width: 350, height: 172,
  });
  // Left and top: the place moves so the right and bottom edges stay (1380, 692).
  assert.deepEqual(at('w', -60, 0), {
    x: 940, y: 500, width: 440, height: 192,
  });
  assert.deepEqual(at('n', 0, 25), {
    x: 1000, y: 525, width: 380, height: 167,
  });
  assert.deepEqual(at('nw', 20, -30), {
    x: 1020, y: 470, width: 360, height: 222,
  });
  assert.deepEqual(at('ne', 20, -30), {
    x: 1000, y: 470, width: 400, height: 222,
  });
  assert.deepEqual(at('sw', 20, -30), {
    x: 1020, y: 500, width: 360, height: 162,
  });
  // Past the limits: no further, and the edge across still where it was.
  assert.deepEqual(at('se', 900, 900), {
    x: 1000, y: 500, width: 570, height: 300,
  });
  assert.deepEqual(at('se', -900, -900), {
    x: 1000, y: 500, width: 300, height: 152,
  });
  assert.deepEqual(at('nw', -900, -900), {
    x: 810, y: 392, width: 570, height: 300,
  });
  assert.deepEqual(at('nw', 900, 900), {
    x: 1080, y: 540, width: 300, height: 152,
  });
  // No edge: as it was.
  assert.deepEqual(at('', 40, 40), start);
  assert.deepEqual(at(undefined, 40, 40), start);
});

test('the song the Mini Player showed last: its texts and seconds, nothing without a title', () => {
  const s = settings.clean({
    miniLast: {
      songId: 'abc', title: 'Bohemian Rhapsody', artist: 'Queen', cover: 'file:///c/covers/abc.webp', coverBig: 'file:///c/covers/big/abc.webp', position: '61.5', duration: 354, list: 'Rock', extra: 1,
    },
  });
  assert.deepEqual(s.miniLast, {
    songId: 'abc', title: 'Bohemian Rhapsody', artist: 'Queen', cover: 'file:///c/covers/abc.webp', coverBig: 'file:///c/covers/big/abc.webp', position: 61.5, duration: 354, list: 'Rock',
  });
  // One kept before the big cover was (no coverBig): the small one stands in.
  assert.equal(settings.clean({ miniLast: { songId: 'abc', title: 'x' } }).miniLast.coverBig, '');
  assert.equal(settings.clean({ miniLast: { songId: 'abc' } }).miniLast, null);
  const odd = settings.clean({ miniLast: { title: 'x'.repeat(500), position: -4, duration: 'long', artist: 7 } }).miniLast;
  assert.equal(odd.title.length, 300);
  assert.equal(odd.position, 0);
  assert.equal(odd.duration, 0);
  assert.equal(odd.artist, '');
});

test('only the computer\'s app has a Mini Player, only the Android app an Alarm Clock', () => {
  assert.equal(caps.DESKTOP.miniPlayer, true);
  assert.equal(caps.ANDROID.miniPlayer, false);
  assert.equal(caps.IOS.miniPlayer, false);
  assert.equal(caps.WEB.miniPlayer, false);
  assert.equal(caps.ANDROID.alarm, true);
  assert.equal(caps.DESKTOP.alarm, false);
  assert.equal(caps.IOS.alarm, false);
  assert.equal(caps.WEB.alarm, false);
});

test('Open on PC Start: --mini asks for the Mini Player alone', () => {
  assert.equal(autostart.FLAG, '--mini');
  assert.equal(autostart.asked(['C:\\Program Files\\Flow\\Flow.exe', '--mini']), true);
  assert.equal(autostart.asked(['electron', '.', '--mini']), true);
  assert.equal(autostart.asked(['C:\\Program Files\\Flow\\Flow.exe']), false);
  assert.equal(autostart.asked(['flow', '--minimal']), false);
  assert.equal(autostart.asked(undefined), false);
});

test('Open on PC Start on Linux: an autostart entry that runs Flow with --mini, paths with spaces quoted', () => {
  const entry = autostart.desktopEntry('/opt/Flow/flow', ['--mini']);
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\nName=Flow Mini Player\n/);
  assert.match(entry, /\nExec=\/opt\/Flow\/flow --mini\n/);
  assert.match(entry, /\nTerminal=false\n/);
  assert.ok(entry.endsWith('\n'));
  // An AppImage in a folder with a space; in development Electron with the app's folder.
  assert.match(autostart.desktopEntry('/home/anna/My Apps/Flow-5.0.0.AppImage', ['--mini']), /\nExec="\/home\/anna\/My Apps\/Flow-5\.0\.0\.AppImage" --mini\n/);
  assert.equal(autostart.quoteExec('/a/b$c "d" 100%'), '"/a/b\\$c \\"d\\" 100%%"');
  assert.equal(autostart.quoteExec('/usr/bin/flow'), '/usr/bin/flow');
});

test('the tray icon\'s menu: Open Flow, Open Mini Player, a line, Quit Flow, each doing its own', () => {
  const done = [];
  const menu = tray.menuTemplate({
    texts: { openFlow: 'Open Flow', openMini: 'Open Mini Player', quit: 'Quit Flow' },
    onOpen: () => done.push('open'),
    onMini: () => done.push('mini'),
    onQuit: () => done.push('quit'),
  });
  assert.deepEqual(menu.map((m) => m.label || m.type), ['Open Flow', 'Open Mini Player', 'separator', 'Quit Flow']);
  for (const m of menu) if (m.click) m.click();
  assert.deepEqual(done, ['open', 'mini', 'quit']);
  // Its texts are there in both languages.
  const I18n = require('../renderer/app/i18n');
  for (const key of ['mini.settings.openFlow', 'desktop.tray.openMini', 'desktop.tray.quit']) assert.ok(I18n.has(key), key);
});
