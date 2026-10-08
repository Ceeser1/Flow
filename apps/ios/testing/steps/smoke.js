'use strict';

// Flow's first start on the iPhone: it finds the CI's Flow Server by itself,
// lists its songs, plays each kind of file Flow keeps (Ogg too: iOS 18.4),
// plays on with Flow out of sight, and its main screens are photographed.

const FORMATS = ['mp3', 'opus', 'ogg', 'm4a', 'flac', 'wav'];

const wait = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;

const plays = (format) => ({
  name: `plays ${format}`,
  js: `
    const s = Store.library.songs.find((x) => x.format === '${format}');
    if (!s) return { missing: true };
    Player.load(s.id, 'all');
    ${wait(5000)}
    const e = Player.engine;
    return { title: s.title, t: Math.round(e.time * 10) / 10, paused: e.paused, d: Math.round(e.duration), ready: e.readyState };
  `,
  timeout: 20000,
  expect: (v) => v && !v.missing && v.t >= 2 && !v.paused,
});

module.exports = [
  {
    name: 'the page started',
    until: 'return typeof Store !== "undefined" && !!Store.platform && { platform: Store.platform, ui: Store.uiMode, version: Store.version };',
    timeout: 30000,
    wait: 1500,
    shot: '01-start',
    expect: (v) => v.platform === 'ios',
  },
  {
    name: 'the phone (FlowSync)',
    js: `
      const info = JSON.parse(window.FlowSync.info());
      const secret = window.FlowSync.encrypt('flow');
      return { info, metered: window.FlowSync.isMetered(), keychain: !!secret && window.FlowSync.decrypt(secret) === 'flow' };
    `,
    expect: (v) => v.info.files === '/Flow/files' && v.keychain,
  },
  { name: 'what iOS plays', native: 'codecs' },
  {
    name: 'found the CI server by itself',
    until: 'return Store.server.state === "online" && { name: Store.server.name, home: Store.settings.serverHome };',
    timeout: 30000,
    wait: 1500,
    shot: '02-online',
    expect: (v) => v.name === 'Flow CI',
  },
  {
    // Not found: typed in, so the rest still runs.
    name: 'connected',
    js: `
      if (Store.server.state === 'online') return 'already';
      await Store.saveSettings({ serverOn: true, serverHome: '127.0.0.1:7878' });
      return 'typed in';
    `,
  },
  {
    name: 'by the Mac\'s own network address',
    run: async (ctx) => {
      const nets = Object.values(require('os').networkInterfaces()).flat();
      const lan = nets.find((n) => n && n.family === 'IPv4' && !n.internal);
      ctx.lan = lan ? lan.address : '';
      return ctx.lan;
    },
    jsWith: (ctx) => `
      if (!'${ctx.lan}') return 'no network address';
      await Store.saveSettings({ serverOn: true, serverHome: '${ctx.lan}:7878' });
      for (let i = 0; i < 40 && !(Store.server.state === 'online' && Store.settings.serverHome === '${ctx.lan}:7878'); i += 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
      return { state: Store.server.state, home: Store.settings.serverHome };
    `,
    timeout: 30000,
    expect: (v) => v === 'no network address' || v.state === 'online',
  },
  {
    name: 'its songs',
    until: 'return Store.library.songs.length >= 6 && Store.library.songs.map((s) => [s.format, s.title, Math.round(s.duration)]);',
    timeout: 30000,
    wait: 1000,
    shot: '03-songs',
  },
  ...FORMATS.map(plays),
  { name: 'Now Playing', js: 'Mobile.expandPlayer(); return true;', wait: 1500, shot: '04-now-playing' },
  { name: 'into the background', background: true, wait: 12000 },
  {
    name: 'plays on in the background',
    native: 'player',
    expect: (v) => v && v.pwr && v.st === 3 && v.t > 5,
  },
  { name: 'back to Flow', foreground: true, wait: 2500, shot: '05-back' },
  { name: 'the page caught up', js: 'return { t: Math.round(Player.engine.time), paused: Player.engine.paused, id: Player.currentId };' },
  {
    name: 'pause',
    js: `Player.pause(); ${wait(800)} return Player.engine.paused;`,
    expect: (v) => v === true,
  },
  { name: 'the menu', js: 'Mobile.collapsePlayer(); Mobile.openDrawer(); return true;', wait: 1200, shot: '06-menu' },
  { name: 'Settings', js: 'Mobile.closeDrawer(); SettingsPanel.open(); return true;', wait: 1500, shot: '07-settings' },
  { name: 'Add Songs', js: 'if (SettingsPanel.close) SettingsPanel.close(); Nav.show("add"); return true;', wait: 1500, shot: '08-add' },
];
