'use strict';

// Internet Radio on the iPhone (5.3.1): a station played live through the
// phone's own player, what it plays read from its stream (ICY StreamTitle)
// into the page and onto the lock screen, the station's name above it; on in
// the background; paused and connected anew; a station that says nothing
// ("No Song Info"); a song taking the player back. The stations run on this
// Mac (a fake Icecast: a sine tone made here, sent at a steady pace, with
// ICY metadata every 16000 bytes for whoever asks for it).

const fs = require('fs');
const net = require('net');
const path = require('path');
const { wait, loadAndPlay, start } = require('./common');

const FIRST = 'Sine Artist - First Song';
const SECOND = 'Sine Artist - Second Song';
const stations = {};

function metaBlock(text) {
  const body = Buffer.from(text, 'utf8');
  const len = Math.ceil(body.length / 16);
  return Buffer.concat([Buffer.from([len]), body, Buffer.alloc(len * 16 - body.length)]);
}

/** A station sending `file` (its ID3 tag left out) at about 40 KB a second; titles: [[from byte, title]]. */
function startStation({ file, name, titles = [], meta = true }) {
  let sound = fs.readFileSync(file);
  if (sound.slice(0, 3).toString('latin1') === 'ID3') {
    const size = ((sound[6] & 127) << 21) | ((sound[7] & 127) << 14) | ((sound[8] & 127) << 7) | (sound[9] & 127);
    sound = sound.slice(10 + size);
  }
  const every = 16000;
  const asked = [];
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => {});
    s.on('close', () => sockets.delete(s));
    let head = '';
    const onData = (c) => {
      head += c.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      s.removeListener('data', onData);
      asked.push(head.split('\r\n').slice(0, 12).join(' | '));
      const withMeta = meta && /icy-metadata:\s*1/i.test(head);
      const lines = ['HTTP/1.0 200 OK', `icy-name: ${name}`, 'Content-Type: audio/mpeg', 'Cache-Control: no-cache'];
      if (withMeta) lines.push(`icy-metaint: ${every}`);
      s.write(`${lines.join('\r\n')}\r\n\r\n`);
      let at = 0;
      let left = every;
      let told = null;
      const titleAt = (pos) => titles.reduce((t, [from, title]) => (pos >= from ? title : t), '');
      const send = (n) => {
        const out = [];
        let todo = n;
        while (todo > 0) {
          if (at >= sound.length) at = 0;
          const take = Math.min(todo, withMeta ? left : todo, sound.length - at);
          out.push(sound.slice(at, at + take));
          at += take;
          todo -= take;
          if (withMeta) {
            left -= take;
            if (left === 0) {
              const t = titleAt(at);
              out.push(t !== told ? metaBlock(`StreamTitle='${t}';StreamUrl='';`) : Buffer.from([0]));
              told = t;
              left = every;
            }
          }
        }
        if (!s.destroyed) s.write(Buffer.concat(out));
      };
      send(96000);
      const timer = setInterval(() => (s.destroyed ? clearInterval(timer) : send(4000)), 100);
      s.on('close', () => clearInterval(timer));
    };
    s.on('data', onData);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/live`,
      asked,
      close: () => {
        for (const x of sockets) x.destroy();
        server.close();
      },
    }));
  });
}

module.exports = [
  ...start,
  {
    name: 'two stations on this Mac',
    run: async (ctx) => {
      const file = path.join(ctx.out, 'station.mp3');
      ctx.sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=240', '-ac', '2', '-ar', '44100', '-b:a', '128k', file]);
      stations.a = await startStation({ file, name: 'Fake FM', titles: [[0, FIRST], [600000, SECOND]] });
      stations.b = await startStation({ file, name: 'Quiet FM', meta: false });
      return [stations.a.url, stations.b.url];
    },
    expect: (v) => v.length === 2,
  },
  {
    name: 'Internet Radio in the menu',
    js: 'return Store.can("radio") && !$("menuRadio").hidden;',
    expect: (v) => v === true,
  },
  {
    name: 'a station plays',
    jsWith: () => `
      Radio.play({ id: 'url:${stations.a.url}', name: 'Fake FM', url: '${stations.a.url}', own: true });
      for (let i = 0; i < 80 && !(Radio.playing && !Radio.connecting); i += 1) ${wait(250)}
      return { playing: Radio.playing, connecting: Radio.connecting };
    `,
    timeout: 30000,
    expect: (v) => v.playing && !v.connecting,
  },
  { name: 'the phone\'s player plays it live', native: 'player', waitFor: (v) => v.pwr && v.st === 3, timeout: 20000 },
  {
    name: 'what it plays, from its stream',
    until: 'return Radio.info && Radio.info.title ? Radio.songLine() : null;',
    timeout: 25000,
    expect: (v) => v === FIRST,
  },
  {
    name: 'the bar: the station, the song below',
    js: 'return [$("playerTitle").textContent, $("playerSub").textContent];',
    expect: (v) => v[0] === 'Fake FM' && v[1] === FIRST,
  },
  {
    name: 'the lock screen: the station, the song, live',
    native: 'nowplaying',
    waitFor: (v) => v.title === 'Fake FM' && v.artist === FIRST && v.live === true,
    timeout: 10000,
    shot: '01-station',
  },
  {
    name: 'the station asked for its metadata',
    run: async () => stations.a.asked,
    expect: (v) => v.some((h) => /icy-metadata: *1/i.test(h)),
  },
  {
    name: 'the next song when the station says so',
    until: `return Radio.songLine() === ${JSON.stringify(SECOND)};`,
    timeout: 40000,
  },
  {
    name: 'out of sight it plays on, the lock screen follows',
    background: true,
    native: 'nowplaying',
    waitFor: (v) => v.title === 'Fake FM' && v.artist === SECOND && v.rate > 0,
    timeout: 15000,
  },
  { name: 'back', foreground: true, js: 'return Radio.playing;', wait: 1000 },
  {
    name: 'paused',
    js: `Radio.toggle(); ${wait(1200)} return { playing: Radio.playing, owns: Radio.owns() };`,
    expect: (v) => !v.playing && v.owns,
  },
  { name: 'the player paused', native: 'player', waitFor: (v) => !v.pwr, timeout: 10000 },
  {
    name: 'and connected anew, live',
    js: `Radio.toggle(); for (let i = 0; i < 80 && !(Radio.playing && !Radio.connecting); i += 1) ${wait(250)} return Radio.playing && !Radio.connecting;`,
    timeout: 30000,
    expect: (v) => v === true,
  },
  {
    name: 'a station that says nothing: No Song Info',
    jsWith: () => `
      Radio.play({ id: 'url:${stations.b.url}', name: 'Quiet FM', url: '${stations.b.url}', own: true });
      for (let i = 0; i < 120 && !(Radio.playing && Radio.info && Radio.info.meta === false); i += 1) ${wait(250)}
      return [Radio.songLine(), $("playerSub").textContent];
    `,
    timeout: 40000,
    expect: (v) => v[0] === 'No Song Info' && v[1] === 'No Song Info',
  },
  {
    name: 'the lock screen says so',
    native: 'nowplaying',
    waitFor: (v) => v.title === 'Quiet FM' && v.artist === 'No Song Info',
    timeout: 10000,
    shot: '02-no-song-info',
  },
  {
    name: 'a song takes the player back',
    js: loadAndPlay('Sine A'),
    timeout: 20000,
    expect: (v) => v.now === 'Sine A' && !v.paused,
  },
  { name: 'the station let go of', js: 'return !Radio.owns();', expect: (v) => v === true },
  {
    name: 'the stations stop',
    run: async () => {
      stations.a.close();
      stations.b.close();
      return true;
    },
  },
];
