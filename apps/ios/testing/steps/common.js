'use strict';

// What the steps files share: the page started and connected to the CI's
// Flow Server (typed in), its songs listed.

const wait = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;

/** The page's song of a test song's title (run.js: "Sine A" ... "Sine G"). */
const song = (title) => `Store.library.songs.find((x) => x.title === ${JSON.stringify(title)})`;

/** The page's player: its song, place and whether it plays. */
const playing = `
  const e = Player.engine;
  return { now: (Store.song(Player.currentId) || {}).title, t: Math.round(e.time * 10) / 10, paused: e.paused };
`;

/** A test song loaded and played: the page's player once it has played 2 s (a busy Simulator starts slowly), at most 12 s on. */
const loadAndPlay = (title) => `
  const s = ${song(title)};
  Player.load(s.id, 'all');
  for (let i = 0; i < 48 && Player.currentId === s.id && Player.engine.time < 2; i += 1) ${wait(250)}
  ${playing}
`;

const start = [
  {
    name: 'the page started',
    until: 'return typeof Store !== "undefined" && !!Store.version && Store.platform;',
    timeout: 30000,
    expect: (v) => v === 'ios',
  },
  {
    name: 'connected',
    js: `
      await Store.saveSettings({ serverOn: true, serverHome: '127.0.0.1:7878' });
      for (let i = 0; i < 60 && Store.server.state !== 'online'; i += 1) ${wait(500)}
      return Store.server.state;
    `,
    timeout: 40000,
    expect: (v) => v === 'online',
  },
  {
    name: 'its songs',
    jsWith: (ctx) => `
      for (let i = 0; i < 60 && Store.library.songs.length < ${ctx.server.made}; i += 1) ${wait(500)}
      return Store.library.songs.length;
    `,
    timeout: 40000,
    expect: (v) => v >= 6,
  },
];

module.exports = {
  wait, song, playing, loadAndPlay, start,
};
