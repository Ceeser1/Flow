'use strict';

// Songs on the iPhone itself: server songs downloaded for offline play from
// the phone's own copy, also with the server gone, while a song not
// downloaded waits for it; files from the phone imported with their names,
// cover and waveform (iOS's picker hands Flow a copy: here the test puts one
// into the app's tmp folder), an Ogg Vorbis file among them.

const fs = require('fs');
const path = require('path');

const {
  wait, song, loadAndPlay, start,
} = require('./common');

const BUNDLE = 'io.github.ceeser1.flow';

/** A test song's file put into the app's tmp folder: its file:// address there. */
function intoApp(ctx, name) {
  const data = ctx.sh('xcrun', ['simctl', 'get_app_container', ctx.udid, BUNDLE, 'data']);
  const dest = path.join(data, 'tmp', name.replace(/^Flow Test - /, ''));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ctx.server.base, 'music', name), dest);
  return `file://${encodeURI(dest)}`;
}

/** Imports a file into the import folder as the page's Add Songs does (localFiles.js), then its waveform. */
const imports = (label, name) => ({
  name: `imports ${label}`,
  run: async (ctx) => {
    ctx.uri = intoApp(ctx, name);
    return ctx.uri.replace(/.*\/tmp\//, 'tmp/');
  },
  jsWith: (ctx) => `
    const stem = '/Flow/cache/import/test-' + Date.now();
    let r;
    try {
      r = await Capacitor.Plugins.FlowNative.importAudio({ uri: ${JSON.stringify(ctx.uri)}, stem, cover: stem + '.jpg' });
    } catch (err) {
      return { error: err.message };
    }
    const peaks = await window.flow.peaks(r.path, r.duration);
    return { ...r, peaks: peaks.length, loud: Math.max(...peaks.map(Math.abs)) };
  `,
  timeout: 30000,
});

module.exports = [
  ...start,
  {
    // Sine C is Ogg Vorbis: the server sends the phone an Opus copy.
    name: 'three songs downloaded (mp3, opus, Vorbis)',
    js: `
      const out = {};
      for (const title of ['Sine A', 'Sine B', 'Sine C']) {
        const s = Store.library.songs.find((x) => x.title === title);
        await window.flow.downloadServerSong(s.id);
        for (let i = 0; i < 40 && !(Store.song(s.id) || {}).file; i += 1) ${wait(250)}
        out[title] = (Store.song(s.id) || {}).file || null;
      }
      return out;
    `,
    timeout: 60000,
    wait: 1000,
    shot: '01-downloaded',
    expect: (v) => !!v['Sine A'] && !!v['Sine B'] && !!v['Sine C'],
  },
  {
    name: 'plays its own copy',
    js: loadAndPlay('Sine A'),
    timeout: 20000,
    expect: (v) => v.now === 'Sine A' && v.t >= 2 && !v.paused,
  },
  {
    name: 'from the phone, not the server',
    native: 'source',
    expect: (v) => typeof v === 'string' && v.startsWith('/') && /Library\/(Caches\/)?Flow\//.test(v),
  },
  {
    name: 'the server goes away',
    run: async (ctx) => {
      ctx.server.child.kill();
      return 'stopped';
    },
    until: 'return Store.server.state !== "online" && Store.server.state;',
    timeout: 60000,
    wait: 500,
    shot: '02-server-gone',
  },
  {
    name: 'plays its own Opus copy without it',
    js: loadAndPlay('Sine B'),
    timeout: 15000,
    expect: (v) => v.now === 'Sine B' && v.t >= 2 && !v.paused,
  },
  {
    name: 'and its Vorbis song, downloaded as Opus',
    js: loadAndPlay('Sine C'),
    timeout: 20000,
    expect: (v) => v.now === 'Sine C' && v.t >= 2 && !v.paused,
  },
  {
    // Streamed: it waits for the server (StreamLoader tries again for minutes).
    name: 'a song not downloaded waits',
    js: `
      const s = ${song('Sine D')};
      const src = Store.audioSrc(s);
      if (src) Player.load(s.id, 'all');
      ${wait(5000)}
      const e = Player.engine;
      return { src: src ? 'stream' : 'none', now: (Store.song(Player.currentId) || {}).title, t: Math.round(e.time * 10) / 10, paused: e.paused };
    `,
    timeout: 15000,
    wait: 500,
    shot: '03-not-downloaded',
    expect: (v) => v.src === 'none' || v.t < 1,
  },
  { name: 'stopped', js: `Player.pause(); ${wait(500)} return Player.engine.paused;` },
  { ...imports('an mp3', 'Flow Test - Sine A.mp3'), expect: (v) => v.format === 'mp3' && v.title === 'Sine A' && Math.round(v.duration) === 45 && v.peaks > 100 && v.loud > 0.1 },
  // Their names from their Vorbis comments (VorbisComments.swift: iOS reads none).
  {
    ...imports('an Opus file', 'Flow Test - Sine B.opus'),
    expect: (v) => v.format === 'opus' && v.title === 'Sine B' && v.artist === 'Flow Test' && Math.round(v.duration) === 45 && v.peaks > 100 && v.loud > 0.1,
  },
  {
    ...imports('a FLAC file with a picture', 'Flow Test - Sine E.flac'),
    expect: (v) => v.format === 'flac' && v.title === 'Sine E' && v.artist === 'Flow Test' && v.cover === true && v.peaks > 100,
  },
  // iOS has no Vorbis: refused with a reason, or (a later iOS) imported.
  { ...imports('an Ogg Vorbis file', 'Flow Test - Sine G.ogg'), expect: (v) => (v.error ? /Vorbis/.test(v.error) : v.peaks > 100) },
];
