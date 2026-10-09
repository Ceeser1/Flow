'use strict';

// Active Sessions with the iPhone as the host: a second device (this script,
// as an app on the server: its live channel and POST /api/sessions) sees the
// iPhone's session, asks to join, is let in by the page's Join request
// (Accept), hears what plays, and its Pause and Play are carried out on the
// iPhone. With Flow out of sight the session stays on the server (iOS stops
// the page: SessionKeeper tells it from the native player), and the second
// device leaves at the end.

const http = require('http');

const {
  wait, song, playing, start,
} = require('./common');

const BASE = 'http://127.0.0.1:7878';
const CLIENT = 'ci-second-device';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The second device: its live channel's events, in order, and its requests. */
function secondDevice() {
  const events = [];
  const stream = http.get(`${BASE}/api/live?client=${CLIENT}&device=CI`, (res) => {
    res.setEncoding('utf8');
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let type = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) type = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        try {
          events.push({ type, data: JSON.parse(data), at: Date.now() });
        } catch {
          // Not JSON: not one of the server's.
        }
      }
    });
  });
  stream.on('error', () => {});
  const call = async (method, body) => {
    const r = await fetch(`${BASE}/api/sessions${method === 'GET' ? `?client=${CLIENT}` : ''}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify({ ...body, client: CLIENT }) : undefined,
    });
    const answer = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`the server answered ${r.status}: ${answer.error || ''}`);
    return answer;
  };
  return {
    events,
    close: () => stream.destroy(),
    list: () => call('GET'),
    post: (body) => call('POST', body),
    /** The first event since `since` (ms) that `test` likes. */
    async heard(test, since = 0, ms = 15000) {
      const end = Date.now() + ms;
      for (;;) {
        const e = events.find((x) => x.at >= since && test(x));
        if (e) return e;
        if (Date.now() > end) throw new Error(`not heard within ${ms / 1000} s (${events.length} events)`);
        await sleep(200);
      }
    },
  };
}

/** The second device's button, and what the iPhone's page then does. */
const control = (action, paused) => ({
  name: `${action} from the second device`,
  run: async (ctx) => {
    await ctx.other.post({ type: 'control', action });
    return action;
  },
  until: `return Player.engine.paused === ${paused} && { paused: Player.engine.paused, t: Math.round(Player.engine.time) };`,
  timeout: 10000,
});

module.exports = [
  ...start,
  { name: 'playing', js: `Player.load(${song('Sine B')}.id, 'all'); ${wait(3000)} ${playing}`, expect: (v) => v.now === 'Sine B' && !v.paused },
  {
    name: 'its session, seen by a second device',
    run: async (ctx) => {
      ctx.other = secondDevice();
      await ctx.other.heard((e) => e.type === 'hello', 0, 10000);
      for (let i = 0; i < 40; i += 1) {
        const s = ((await ctx.other.list()).sessions || []).find((x) => x.host.client !== CLIENT && x.song);
        if (s) {
          ctx.session = s;
          return s;
        }
        await sleep(500);
      }
      throw new Error('no session listed');
    },
    timeout: 30000,
    expect: (v) => v.song.title === 'Sine B' && v.playing,
  },
  {
    name: 'asks to join',
    run: async (ctx) => {
      ctx.asked = Date.now();
      return (await ctx.other.post({ type: 'join', sessionId: ctx.session.id, mode: 'remote' })).requestId;
    },
    until: 'return Session._prompts.size > 0 && Session._prompts.size;',
    timeout: 15000,
    wait: 800,
    shot: '01-join-request',
  },
  {
    name: 'Accept',
    js: `
      const accept = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Accept');
      if (accept) accept.click();
      return !!accept;
    `,
    expect: (v) => v === true,
  },
  {
    name: 'let in, hears what plays',
    run: async (ctx) => {
      const e = await ctx.other.heard((x) => x.type === 'joinResult', ctx.asked);
      const st = e.data.state || {};
      return { ok: e.data.ok, songId: st.songId, title: st.title, playing: st.playing, members: (e.data.session || {}).members?.length };
    },
    expect: (v) => v.ok === true && v.title === 'Sine B' && v.playing === true,
  },
  {
    name: 'the iPhone hosts it, with company',
    until: 'return Session.isHost && Session.mine.session.members.length === 2 && Session.mine.session.members.map((m) => m.device || m.profileName);',
    timeout: 10000,
    wait: 1000,
    shot: '02-in-session',
  },
  control('pause', true),
  control('play', false),
  {
    name: 'out of sight, a while',
    background: true,
    run: async (ctx) => {
      ctx.away = Date.now();
      return 'away';
    },
    wait: 25000,
  },
  {
    // Longer than the server's grace for a host's dropped live channel (15 s).
    name: 'the session is still there, playing',
    run: async (ctx) => {
      const s = ((await ctx.other.list()).sessions || []).find((x) => x.id === ctx.session.id);
      const told = ctx.other.events.filter((x) => x.type === 'state' && x.at >= ctx.away + 15000).length;
      return { listed: !!s, playing: s ? s.playing : null, song: s && s.song ? s.song.title : null, toldSince: told };
    },
    expect: (v) => v.listed && v.playing === true,
  },
  { name: 'native player, playing', native: 'player', expect: (v) => v.pwr && v.st === 3 },
  { name: 'back to Flow', foreground: true, wait: 3000, shot: '03-back' },
  {
    name: 'the second device leaves',
    run: async (ctx) => {
      await ctx.other.post({ type: 'leave' });
      ctx.other.close();
      return 'left';
    },
    until: 'return Session.isHost && Session.mine.session.members.length === 1 && "alone again";',
    timeout: 15000,
  },
  { name: 'pause', js: `Player.pause(); ${wait(800)} return Player.engine.paused;`, expect: (v) => v === true },
];
