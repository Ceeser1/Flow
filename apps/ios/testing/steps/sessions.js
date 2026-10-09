'use strict';

// Active Sessions with the iPhone as the host: a second device (this script,
// as an app on the server: its live channel and POST /api/sessions) sees the
// iPhone's session, asks to join, is let in by the page's Join request
// (Accept), hears what plays, and its Pause and Play are carried out on the
// iPhone. With Flow out of sight the session stays on the server (iOS stops
// the page: SessionKeeper tells it from the native player), and the second
// device leaves.
//
// Then the iPhone as a member: another device (this script again) hosts a
// session, playing a song as an app tells it; the iPhone asks to join with
// Play here, is let in and plays the host's song at the host's place, follows
// its Pause and Play, and, back to remote, its own Pause goes to the host.

const http = require('http');

const {
  wait, song, playing, start,
} = require('./common');

const BASE = 'http://127.0.0.1:7878';
const CLIENT = 'ci-second-device';
const HOST = 'ci-host-device';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The second device: its live channel's events, in order, and its requests. */
function secondDevice(client = CLIENT) {
  const events = [];
  const stream = http.get(`${BASE}/api/live?client=${client}&device=CI`, (res) => {
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
    const r = await fetch(`${BASE}/api/sessions${method === 'GET' ? `?client=${client}` : ''}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify({ ...body, client }) : undefined,
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

// The other device hosting: the song it plays, from where, since when.
const hosting = {};

/** Where the host's song is at `at` (ms). */
const hostPlace = (at = Date.now()) => hosting.position + (hosting.playing ? (at - hosting.since) / 1000 : 0);

/** The host's playback, told to the server as an app tells it. */
async function tellHost(dev) {
  const { song: s } = hosting;
  const at = Date.now();
  await dev.post({
    type: 'state',
    state: {
      songId: s.id, title: s.title, artist: s.artist, duration: s.duration, playing: hosting.playing,
      position: hostPlace(at), at, shared: true, name: 'CI - Speakers', ids: [s.id],
    },
  });
}

/** The host playing (or paused) from its place now. */
async function hostPlays(dev, play) {
  hosting.position = hostPlace();
  hosting.since = Date.now();
  hosting.playing = play;
  await tellHost(dev);
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

  // ---- the iPhone as a member ----
  {
    name: 'the song another device plays',
    js: `const s = ${song('Sine A')}; return { id: s.id, title: s.title, artist: s.artist, duration: s.duration };`,
    expect: (v) => {
      hosting.song = v;
      return !!v.id;
    },
  },
  {
    name: 'another device hosts a session',
    run: async (ctx) => {
      ctx.host = secondDevice(HOST);
      await ctx.host.heard((e) => e.type === 'hello', 0, 10000);
      Object.assign(hosting, { position: 3, since: Date.now(), playing: true });
      await tellHost(ctx.host);
      // Every few seconds while playing, as an app does.
      ctx.beat = setInterval(() => tellHost(ctx.host).catch(() => {}), 4000);
      return 'playing';
    },
    until: `
      const s = Session.others().find((x) => x.song && x.song.title === 'Sine A');
      return s && { name: s.name, playing: s.playing };
    `,
    timeout: 15000,
  },
  {
    name: 'the iPhone asks to join, to play along',
    js: `
      await Store.saveSettings({ sessionPlayHere: true });
      const s = Session.others().find((x) => x.song && x.song.title === 'Sine A');
      await Session.join(s.id);
      return !!Session.request;
    `,
    expect: (v) => v === true,
  },
  {
    name: 'the host lets it in',
    run: async (ctx) => {
      const e = await ctx.host.heard((x) => x.type === 'joinRequest');
      await ctx.host.post({ type: 'answer', requestId: e.data.requestId, accept: true });
      return e.data.device || e.data.profileName;
    },
    until: `
      const e = Player.engine;
      return Session.isMember && !!Player.remote && Player.remote.here && !e.paused && e.time > 0
        && { now: (Store.song(Player.currentId) || {}).title, t: Math.round(e.time * 10) / 10, members: Session.mine.session.members.length };
    `,
    timeout: 20000,
    wait: 4000,
    shot: '04-member',
    expect: (v) => v.now === 'Sine A' && v.members === 2,
  },
  {
    // The native player's own place, at the moment it was read, against the host's then.
    name: 'in step with the host',
    native: 'player',
    expect: (v) => {
      hosting.drift = Math.round((v.t - hostPlace(v.at)) * 1000);
      return v.pwr && v.st === 3 && Math.abs(hosting.drift) < 250;
    },
  },
  { name: 'how far apart (ms)', run: async () => hosting.drift },
  {
    name: 'the host pauses: the iPhone too',
    run: async (ctx) => {
      await hostPlays(ctx.host, false);
      return hostPlace();
    },
    until: 'return Player.engine.paused && { t: Math.round(Player.engine.time * 10) / 10 };',
    timeout: 10000,
  },
  {
    name: 'the host plays on: the iPhone too',
    run: async (ctx) => {
      await hostPlays(ctx.host, true);
      return hostPlace();
    },
    until: 'return !Player.engine.paused && Player.engine.time > 0 && { t: Math.round(Player.engine.time * 10) / 10 };',
    timeout: 10000,
    wait: 3000,
  },
  {
    name: 'in step again',
    native: 'player',
    expect: (v) => {
      hosting.drift = Math.round((v.t - hostPlace(v.at)) * 1000);
      return v.pwr && Math.abs(hosting.drift) < 250;
    },
  },
  { name: 'how far apart now (ms)', run: async () => hosting.drift },
  {
    // For the record: the native player's place against the host's, and what
    // the page reckons (its place, the target, the drift it eases away), every
    // 3/4 s; `speed` how fast the native place moved since the sample before.
    name: 'playing along, closely',
    js: `
      const out = [];
      for (let i = 0; i < 8; i += 1) {
        const st = await Capacitor.Plugins.FlowAudio.run({ ops: [] });
        out.push({
          t: st.t, at: st.at, rate: st.rate, page: Player.engine.time, target: Player._hereTarget(),
          drift: Player.remote ? Player.remote.drift : null, shift: Output.shift(),
        });
        ${wait(750)}
      }
      return out;
    `,
    timeout: 20000,
    expect: (v) => {
      hosting.samples = v.map((s, i) => ({
        vsHost: Math.round((s.t - hostPlace(s.at)) * 1000),
        speed: i ? Math.round(((s.t - v[i - 1].t) / ((s.at - v[i - 1].at) / 1000)) * 1000) / 1000 : null,
        rate: s.rate,
        pageVsNative: Math.round((s.page - s.t) * 1000),
        drift: s.drift === null ? null : Math.round(s.drift * 1000),
        shift: s.shift,
      }));
      return true;
    },
  },
  { name: 'the samples', run: async () => hosting.samples },
  {
    name: 'remote only: the iPhone stops playing along',
    js: `Session.setHere(false); ${wait(1500)} return { here: Player.remote.here, playing: !Player.engine.paused && !!Player.engine.loaded };`,
    expect: (v) => v.here === false && !v.playing,
  },
  {
    name: 'Pause on the iPhone',
    run: async (ctx) => {
      ctx.pressed = Date.now();
      return 'pressed';
    },
    js: 'Player.pause(); return true;',
  },
  {
    name: 'goes to the host',
    run: async (ctx) => (await ctx.host.heard((x) => x.type === 'control', ctx.pressed, 10000)).data.action,
    expect: (v) => v === 'pause',
  },
  {
    name: 'the iPhone leaves',
    js: 'await Session.leave(); return { member: Session.isMember, mine: !!Session.mine };',
    expect: (v) => !v.member,
  },
  {
    name: 'the host alone again',
    run: async (ctx) => {
      const e = await ctx.host.heard((x) => x.type === 'session' && x.data.session && x.data.session.members.length === 1, ctx.pressed, 10000);
      clearInterval(ctx.beat);
      await ctx.host.post({ type: 'leave' });
      ctx.host.close();
      return e.data.session.members.length;
    },
    expect: (v) => v === 1,
  },
];
