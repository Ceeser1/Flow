'use strict';

// Flow's first start on the iPhone: it finds the CI's Flow Server by itself,
// lists its songs, plays each kind of file Flow keeps, plays on with Flow out
// of sight, and its main screens are photographed. Ogg Vorbis (two encoders),
// which iOS cannot play, plays too: the Flow Server sends it as Opus.

// [what, the test song's title (run.js)]
const SONGS = [
  ['mp3', 'Sine A'], ['opus', 'Sine B'], ['ogg (ffmpeg\'s Vorbis, as Opus)', 'Sine C'], ['m4a', 'Sine D'],
  ['flac', 'Sine E'], ['wav', 'Sine F'], ['ogg (libvorbis, as Opus)', 'Sine G'],
];

// The native player's song while Flow is out of sight: before and after Next.
const away = {};

const wait = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;

const plays = ([what, title]) => ({
  name: `plays ${what}`,
  js: `
    const s = Store.library.songs.find((x) => x.title === '${title}');
    if (!s) return { missing: true };
    // The engine's errors while it plays: (status, kind).
    window.flowCiErrors = [];
    if (!window.flowCiHeard) {
      window.flowCiHeard = true;
      Player.engine.on('error', (status, kind) => window.flowCiErrors.push({ status, kind }));
    }
    Player.load(s.id, 'all');
    // Until it has played 2 s (a busy Simulator starts slowly), or failed, or another one plays.
    for (let i = 0; i < 48; i += 1) {
      ${wait(250)}
      if (window.flowCiErrors.length || Player.currentId !== s.id || Player.engine.time >= 2) break;
    }
    const e = Player.engine;
    return {
      title: s.title, format: s.format, own: Player.currentId === s.id, now: (Store.song(Player.currentId) || {}).title,
      t: Math.round(e.time * 10) / 10, paused: e.paused, d: Math.round(e.duration), errors: window.flowCiErrors,
    };
  `,
  timeout: 20000,
  shot: title === 'Sine G' ? '03b-vorbis' : undefined,
  expect: (v) => !!v && !v.missing && v.own && v.t >= 2 && !v.paused && !v.errors.length,
});

module.exports = [
  {
    name: 'the page started',
    until: 'return typeof Store !== "undefined" && !!Store.version && { platform: Store.platform, ui: Store.uiMode, version: Store.version };',
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
  { name: 'the types the songs are given', native: 'types' },
  {
    name: 'what the web view plays',
    js: `
      const a = document.createElement('audio');
      return ['audio/ogg; codecs="vorbis"', 'audio/ogg; codecs="opus"', 'audio/webm; codecs="opus"', 'audio/flac']
        .map((t) => [t, a.canPlayType(t)]);
    `,
  },
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
    jsWith: (ctx) => `
      for (let i = 0; i < 60 && Store.library.songs.length < ${ctx.server.made}; i += 1) await new Promise((r) => setTimeout(r, 500));
      return Store.library.songs.map((s) => [s.format, s.title, Math.round(s.duration)]);
    `,
    expect: (v) => v.length >= 6,
    timeout: 40000,
    wait: 1000,
    shot: '03-songs',
  },
  ...SONGS.map(plays),
  {
    // Opus, from its start: the song played on in the background.
    name: 'Now Playing',
    js: `
      Player.load(Store.library.songs.find((x) => x.title === 'Sine B').id, 'all');
      ${wait(2000)}
      Mobile.expandPlayer();
      return Store.song(Player.currentId).title;
    `,
    wait: 1500,
    shot: '04-now-playing',
  },
  { name: 'into the background', background: true, wait: 12000 },
  {
    name: 'plays on in the background',
    native: 'player',
    expect: (v) => {
      away.before = v && v.key;
      return v && v.pwr && v.st === 3 && v.t > 5;
    },
  },
  {
    name: 'the lock screen shows it',
    native: 'nowplaying',
    expect: (v) => v.title === 'Sine B' && v.artist === 'Flow Test' && v.duration > 40 && v.rate > 0,
  },
  { name: 'Next on the lock screen', native: 'next', wait: 3000, expect: (v) => v === true },
  {
    name: 'on to the next song, out of sight',
    native: 'player',
    expect: (v) => {
      away.after = v.key;
      return v.pwr && v.st === 3 && v.key !== away.before;
    },
  },
  { name: 'the lock screen shows the next one', native: 'nowplaying', expect: (v) => !!v.title && v.title !== 'Sine B' && v.rate > 0 },
  { name: 'back to Flow', foreground: true, wait: 2500, shot: '05-back' },
  {
    // Coming back can take the Simulator long (40 s once): the song may have ended meanwhile.
    name: 'the native player now',
    native: 'player',
    expect: (v) => {
      away.back = v.key;
      return v.pwr && v.key !== away.before;
    },
  },
  {
    name: 'the page caught up',
    js: 'return { t: Math.round(Player.engine.time), paused: Player.engine.paused, id: Player.currentId };',
    expect: (v) => v.id === away.back && !v.paused,
  },
  // iOS ends the page of an app out of sight when it wants the memory: the
  // music plays on, and the page, started again, picks up the song playing.
  { name: 'this page marked', js: 'window.flowCiMark = true; return true;' },
  { name: 'out of sight again', background: true, wait: 3000 },
  { name: 'the page ended, as iOS does', native: 'killpage', wait: 3000, expect: (v) => v === true },
  { name: 'the music plays on without it', native: 'player', expect: (v) => v.pwr && v.st === 3 },
  { name: 'back to Flow once more', foreground: true, wait: 2000 },
  {
    name: 'a new page',
    until: `return typeof Store !== 'undefined' && !!Store.version && !!Player.currentId
      && { mark: !!window.flowCiMark, id: Player.currentId, paused: Player.engine.paused, t: Math.round(Player.engine.time) };`,
    timeout: 40000,
    wait: 1500,
    shot: '05b-new-page',
    expect: (v) => !v.mark,
  },
  {
    name: 'the native player now',
    native: 'player',
    expect: (v) => {
      away.now = v.key;
      return v.pwr && v.st === 3;
    },
  },
  {
    name: 'the new page has the song playing',
    js: 'return { id: Player.currentId, paused: Player.engine.paused, t: Math.round(Player.engine.time) };',
    expect: (v) => v.id === away.now && !v.paused,
  },
  {
    name: 'pause',
    js: `Player.pause(); ${wait(800)} return Player.engine.paused;`,
    expect: (v) => v === true,
  },
  { name: 'the menu', js: 'Mobile.collapsePlayer(); Mobile.openDrawer(); return true;', wait: 1200, shot: '06-menu' },
  { name: 'Settings', js: 'Mobile.closeDrawer(); SettingsPanel.open(); return true;', wait: 1500, shot: '07-settings' },
  { name: 'Add Songs', js: 'if (SettingsPanel.modal) SettingsPanel.modal.close(); Nav.show("add"); return true;', wait: 1500, shot: '08-add' },
];
