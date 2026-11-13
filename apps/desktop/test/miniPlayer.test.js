'use strict';

// The Mini Player (5.0): what its settings may hold, and "Open on PC Start"
// (the start with the computer asked for by --mini, Linux's autostart file).

const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/settings');
const autostart = require('../src/autostart');
const caps = require('@flow/core/client/caps');

test('the Mini Player\'s settings: on top by default, the ticks are true or false, a place needs both numbers', () => {
  const fresh = settings.clean({});
  assert.equal(fresh.miniOnTop, true);
  assert.equal(fresh.miniLocked, false);
  assert.equal(fresh.miniAutostart, false);
  assert.equal(fresh.miniBounds, null);
  assert.equal(fresh.miniLast, null);
  const s = settings.clean({
    miniOnTop: false, miniLocked: 'yes', miniAutostart: true, miniBounds: { x: 12.6, y: '40' },
  });
  assert.equal(s.miniOnTop, false);
  assert.equal(s.miniLocked, false);
  assert.equal(s.miniAutostart, true);
  assert.deepEqual(s.miniBounds, { x: 13, y: 40 });
  assert.equal(settings.clean({ miniBounds: { x: 5 } }).miniBounds, null);
  assert.equal(settings.clean({ miniBounds: 'left' }).miniBounds, null);
});

test('the song the Mini Player showed last: its texts and seconds, nothing without a title', () => {
  const s = settings.clean({
    miniLast: {
      songId: 'abc', title: 'Bohemian Rhapsody', artist: 'Queen', cover: 'file:///c/covers/abc.webp', position: '61.5', duration: 354, list: 'Rock', extra: 1,
    },
  });
  assert.deepEqual(s.miniLast, {
    songId: 'abc', title: 'Bohemian Rhapsody', artist: 'Queen', cover: 'file:///c/covers/abc.webp', position: 61.5, duration: 354, list: 'Rock',
  });
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
