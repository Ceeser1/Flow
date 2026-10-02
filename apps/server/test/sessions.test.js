'use strict';

// Active Sessions (src/sessions.js): the state machine on its own, with a
// fake live hub and a fake clock, then over HTTP with simulated apps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createSessions, REQUEST_MS, COOLDOWN_MS, GRACE_MS, PAUSED_LISTED_MS, MAX_MEMBERS,
} = require('../src/sessions');
const { startServer } = require('../src/server');
const { connect } = require('../testing/liveClient');

process.env.FLOW_SERVER_FFMPEG = 'off';

function fakeClock() {
  let t = 1000000;
  let timers = [];
  let n = 0;
  return {
    now: () => t,
    setTimeout(fn, ms) {
      n += 1;
      timers.push({ id: n, at: t + ms, fn });
      return n;
    },
    clearTimeout(id) {
      timers = timers.filter((x) => x.id !== id);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        t = due.at;
        due.fn();
      }
      t = end;
    },
  };
}

function fakeLive() {
  const clients = new Map(); // client -> info
  const inbox = new Map(); // client -> [{ type, data }]
  const opens = [];
  const closes = [];
  return {
    send(client, type, data) {
      if (!clients.has(client)) return false;
      inbox.get(client).push({ type, data });
      return true;
    },
    has: (c) => clients.has(c),
    info: (c) => clients.get(c) || null,
    clients: () => [...clients.entries()].map(([client, info]) => ({ ...info, client })),
    onOpen: (fn) => opens.push(fn),
    onClose: (fn) => closes.push(fn),
    // test side
    connect(client, info) {
      clients.set(client, { profileId: null, profileName: '', device: '', ip: '192.168.0.9', ...info });
      if (!inbox.has(client)) inbox.set(client, []);
      for (const fn of opens) fn(client, clients.get(client));
    },
    drop(client) {
      const info = clients.get(client);
      clients.delete(client);
      for (const fn of closes) fn(client, info, 'closed');
    },
    take(client, type) {
      const box = inbox.get(client) || [];
      const i = box.findIndex((e) => e.type === type);
      if (i < 0) return null;
      return box.splice(i, 1)[0].data;
    },
    all(client, type) {
      const box = inbox.get(client) || [];
      const got = box.filter((e) => e.type === type).map((e) => e.data);
      inbox.set(client, box.filter((e) => e.type !== type));
      return got;
    },
    clear(client) {
      inbox.set(client, []);
    },
  };
}

const SONGS = new Set(['s1', 's2', 's3', 's4']);
const library = {
  songExists: (id) => SONGS.has(id),
  playlist: (profileId, ref) => (ref.id === 'p1' || ref.name === 'evening' ? { id: 'p1', name: 'Evening', ids: ['s3', 's1', 'gone'] } : null),
};

function setup() {
  const clock = fakeClock();
  const live = fakeLive();
  const sessions = createSessions({ live, library, clock });
  live.connect('host-aaaaaaaa', { profileName: 'Ceeser', device: 'Living room' });
  live.connect('join-bbbbbbbb', { profileName: 'Anna', device: 'Laptop' });
  live.connect('join-cccccccc', { profileName: '', device: 'Kitchen' });
  return { clock, live, sessions };
}

const playing = (more = {}) => ({
  songId: 's1', title: 'Teardrop', artist: 'Massive Attack', duration: 330, playing: true, position: 10, ids: ['s1', 's2', 's3'], contextName: 'Evening', name: 'Ceeser - Sony GTK', ...more,
});

/** host plays, joiner asks, host accepts. */
function joined(t, joiner = 'join-bbbbbbbb', mode = 'remote') {
  const { sessionId } = t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing() });
  const { requestId } = t.sessions.handle(joiner, { type: 'join', sessionId, mode });
  t.sessions.handle('host-aaaaaaaa', { type: 'answer', requestId, accept: true });
  t.clock.advance(200);
  return sessionId;
}

test('a device that plays is a listed session; paused alone it drops after two minutes', () => {
  const t = setup();
  assert.deepEqual(t.sessions.handle('host-aaaaaaaa', { type: 'state', state: { songId: null } }), { sessionId: null });
  const { sessionId } = t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing() });
  assert.ok(sessionId);
  t.clock.advance(200);
  const list = t.live.all('join-bbbbbbbb', 'sessions').pop().sessions;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].song, { id: 's1', title: 'Teardrop', artist: 'Massive Attack', mix: '' });
  assert.equal(list[0].name, 'Ceeser - Sony GTK');
  assert.equal(list[0].listeners, 0);
  assert.equal(list[0].host.device, 'Living room');

  t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing({ playing: false }) });
  t.clock.advance(PAUSED_LISTED_MS - 1000);
  assert.equal(t.sessions.list().length, 1);
  t.clock.advance(2000);
  assert.equal(t.sessions.list().length, 0);
  assert.equal(t.sessions.view('host-aaaaaaaa').mine, null, 'dropped');
  // Playing again is a new session.
  assert.ok(t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing() }).sessionId);
  // Stopped (nothing loaded) alone: gone at once.
  t.sessions.handle('host-aaaaaaaa', { type: 'state', state: { songId: null } });
  assert.equal(t.sessions.list().length, 0);
});

test('joining: the host is asked, accepts; the joiner gets the session and the state', () => {
  const t = setup();
  const { sessionId } = t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing() });
  const { requestId, expiresIn } = t.sessions.handle('join-bbbbbbbb', { type: 'join', sessionId, mode: 'here' });
  assert.equal(expiresIn, REQUEST_MS);
  const ask = t.live.take('host-aaaaaaaa', 'joinRequest');
  assert.equal(ask.requestId, requestId);
  assert.equal(ask.profileName, 'Anna');
  assert.equal(ask.device, 'Laptop');
  assert.equal(ask.ip, '192.168.0.9');
  assert.throws(() => t.sessions.handle('join-bbbbbbbb', { type: 'answer', requestId, accept: true }), /Only the session's host/);

  t.clock.advance(4000);
  t.sessions.handle('host-aaaaaaaa', { type: 'answer', requestId, accept: true });
  const result = t.live.take('join-bbbbbbbb', 'joinResult');
  assert.equal(result.ok, true);
  assert.deepEqual(result.session.members.map((m) => [m.profileName, m.mode]), [['Ceeser', 'host'], ['Anna', 'here']]);
  assert.equal(result.state.songId, 's1');
  assert.equal(Math.round(result.state.position), 14, 'moved on by the 4 s since the host sent it');
  assert.ok(t.live.take('host-aaaaaaaa', 'session').joined);
  t.clock.advance(200);
  assert.equal(t.sessions.list()[0].listeners, 1);
  assert.throws(() => t.sessions.handle('join-bbbbbbbb', { type: 'join', sessionId }), /already/);

  // The host's playback reaches the members.
  t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing({ playing: false, position: 20 }) });
  const st = t.live.take('join-bbbbbbbb', 'state');
  assert.equal(st.state.playing, false);
  assert.equal(st.state.position, 20);
  assert.throws(() => t.sessions.handle('join-bbbbbbbb', { type: 'state', state: playing() }), /Only the session's host/);
  // Paused with members, it stays.
  t.clock.advance(PAUSED_LISTED_MS * 2);
  assert.equal(t.sessions.list().length, 1);
});

test('the list and the queue are only sent when they change; the host\'s own time is taken', () => {
  const t = setup();
  const sessionId = joined(t);
  t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing({ queue: { manual: ['s4'], auto: ['s2'] } }) });
  t.live.clear('join-bbbbbbbb');
  const heartbeat = playing({ position: 30, at: t.clock.now() - 2000 });
  delete heartbeat.ids;
  t.sessions.handle('host-aaaaaaaa', { type: 'state', state: heartbeat });
  const { state } = t.live.take('join-bbbbbbbb', 'state');
  assert.deepEqual(state.ids, ['s1', 's2', 's3']);
  assert.deepEqual(state.queue.manual, ['s4']);
  assert.equal(Math.round(state.position), 32, 'read 2 s ago');
  assert.equal(state.at, undefined);
  // A clock far out is not believed.
  t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing({ position: 40, at: t.clock.now() + 60000 }) });
  assert.equal(t.live.take('join-bbbbbbbb', 'state').state.position, 40);
  assert.equal(t.sessions.view('join-bbbbbbbb').mine.session.id, sessionId);
});

test('declined: told, and no new request for a minute; unanswered: expires', () => {
  const t = setup();
  const { sessionId } = t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing() });
  const { requestId } = t.sessions.handle('join-bbbbbbbb', { type: 'join', sessionId });
  t.sessions.handle('host-aaaaaaaa', { type: 'answer', requestId, accept: false });
  const result = t.live.take('join-bbbbbbbb', 'joinResult');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'declined');
  assert.equal(result.retryIn, 60);
  assert.throws(() => t.sessions.handle('join-bbbbbbbb', { type: 'join', sessionId }), (err) => err.status === 429 && err.extra.retryIn === 60);
  t.clock.advance(COOLDOWN_MS - 5000);
  assert.throws(() => t.sessions.handle('join-bbbbbbbb', { type: 'join', sessionId }), (err) => err.extra.retryIn === 5);
  t.clock.advance(5000);
  const again = t.sessions.handle('join-bbbbbbbb', { type: 'join', sessionId });
  t.live.clear('host-aaaaaaaa');
  // Nobody answers.
  t.clock.advance(REQUEST_MS);
  assert.equal(t.live.take('join-bbbbbbbb', 'joinResult').reason, 'expired');
  assert.equal(t.live.take('host-aaaaaaaa', 'joinCancelled').requestId, again.requestId);
  assert.throws(() => t.sessions.handle('host-aaaaaaaa', { type: 'answer', requestId: again.requestId, accept: true }), /no longer open/);
  // Others are not held back by someone else's decline.
  assert.ok(t.sessions.handle('join-cccccccc', { type: 'join', sessionId }).requestId);
});

test('one request at a time; taking it back tells the host', () => {
  const t = setup();
  const { sessionId } = t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing() });
  const first = t.sessions.handle('join-bbbbbbbb', { type: 'join', sessionId });
  const second = t.sessions.handle('join-bbbbbbbb', { type: 'join', sessionId });
  assert.equal(t.live.take('host-aaaaaaaa', 'joinCancelled').requestId, first.requestId);
  t.sessions.handle('join-bbbbbbbb', { type: 'cancelJoin' });
  assert.equal(t.live.take('host-aaaaaaaa', 'joinCancelled').requestId, second.requestId);
  assert.throws(() => t.sessions.handle('host-aaaaaaaa', { type: 'answer', requestId: second.requestId, accept: true }), /no longer open/);
});

test('controls: members only, a whitelist, songs checked, carried to the host', () => {
  const t = setup();
  joined(t);
  assert.throws(() => t.sessions.handle('join-cccccccc', { type: 'control', action: 'pause' }), /Join the session first/);
  assert.throws(() => t.sessions.handle('host-aaaaaaaa', { type: 'control', action: 'pause' }), /plays on its own/);
  t.sessions.handle('join-bbbbbbbb', { type: 'control', action: 'pause' });
  const c = t.live.take('host-aaaaaaaa', 'control');
  assert.equal(c.action, 'pause');
  assert.deepEqual(c.from, { client: 'join-bbbbbbbb', profileName: 'Anna', device: 'Laptop' });

  t.sessions.handle('join-bbbbbbbb', { type: 'control', action: 'seek', position: 99.5 });
  assert.deepEqual(t.live.take('host-aaaaaaaa', 'control').args, { position: 99.5 });
  t.sessions.handle('join-bbbbbbbb', {
    type: 'control', action: 'playSong', songId: 's2', ids: ['s3', 'nope', 's4'], contextName: 'Anna\'s list',
  });
  assert.deepEqual(t.live.take('host-aaaaaaaa', 'control').args, {
    songId: 's2', ids: ['s2', 's3', 's4'], contextName: 'Anna\'s list', contextId: null,
  });
  t.sessions.handle('join-bbbbbbbb', { type: 'control', action: 'playPlaylist', playlistId: 'p1' });
  assert.deepEqual(t.live.take('host-aaaaaaaa', 'control').args, {
    ids: ['s3', 's1', 'gone'], contextName: 'Evening', contextId: 'p1', songId: null,
  });
  assert.throws(() => t.sessions.handle('join-bbbbbbbb', { type: 'control', action: 'queueAdd', songId: 'zzz' }), /not on the server/);
  assert.throws(() => t.sessions.handle('join-bbbbbbbb', { type: 'control', action: 'shutdown' }), /not something a session can do/);
  assert.throws(() => t.sessions.handle('join-bbbbbbbb', { type: 'control', action: 'volume', value: 0.2 }), /does not let others/);
  t.sessions.handle('host-aaaaaaaa', { type: 'state', state: playing({ allowVolume: true }) });
  t.sessions.handle('join-bbbbbbbb', { type: 'control', action: 'volume', value: 0.2 });
  assert.deepEqual(t.live.all('host-aaaaaaaa', 'control').pop().args, { value: 0.2 });

  // Too many too fast.
  assert.throws(() => {
    for (let i = 0; i < 40; i += 1) t.sessions.handle('join-bbbbbbbb', { type: 'control', action: 'toggle' });
  }, (err) => err.status === 429);
  t.clock.advance(11000);
  t.sessions.handle('join-bbbbbbbb', { type: 'control', action: 'next' });
});

test('the host leaving hands over to the next in line, which plays on from where it was', () => {
  const t = setup();
  const sessionId = joined(t);
  const { requestId } = t.sessions.handle('join-cccccccc', { type: 'join', sessionId });
  t.sessions.handle('host-aaaaaaaa', { type: 'answer', requestId, accept: true });
  t.live.clear('join-bbbbbbbb');
  t.live.clear('join-cccccccc');
  t.clock.advance(5000);
  t.sessions.handle('host-aaaaaaaa', { type: 'leave' });
  const changed = t.live.take('join-bbbbbbbb', 'hostChanged');
  assert.equal(changed.sessionId, sessionId);
  assert.deepEqual(changed.previous, { client: 'host-aaaaaaaa', profileName: 'Ceeser', device: 'Living room' });
  assert.equal(changed.reason, 'left');
  assert.equal(changed.state.songId, 's1');
  assert.equal(Math.round(changed.state.position), 15, 'it went on playing for the 5 s');
  assert.equal(changed.session.hostClient, 'join-bbbbbbbb');
  assert.equal(changed.state.name, '', 'the new host names it after itself');
  const told = t.live.take('join-cccccccc', 'session');
  assert.equal(told.hostChanged.previous.profileName, 'Ceeser');
  assert.equal(told.session.hostClient, 'join-bbbbbbbb');
  assert.equal(t.live.take('host-aaaaaaaa', 'left').reason, 'left');
  // The new host's controls come from the one left.
  t.sessions.handle('join-cccccccc', { type: 'control', action: 'next' });
  assert.equal(t.live.take('join-bbbbbbbb', 'control').action, 'next');
  t.clock.advance(200);
  const [s] = t.sessions.list();
  assert.equal(s.name, 'Anna - Laptop', 'named after the new host until it says otherwise');

  // The last ones out end it.
  t.sessions.handle('join-cccccccc', { type: 'leave' });
  t.sessions.handle('join-bbbbbbbb', { type: 'leave' });
  t.clock.advance(200);
  assert.equal(t.sessions.list().length, 0);
});

test('a dropped live channel counts as leaving after 15 s, unless it is back', () => {
  const t = setup();
  const sessionId = joined(t);
  t.live.drop('host-aaaaaaaa');
  t.live.clear('host-aaaaaaaa');
  t.clock.advance(GRACE_MS - 1000);
  assert.equal(t.live.take('join-bbbbbbbb', 'hostChanged'), null);
  t.live.connect('host-aaaaaaaa', { profileName: 'Ceeser', device: 'Living room' });
  assert.ok(t.live.take('host-aaaaaaaa', 'session').resumed);
  t.clock.advance(GRACE_MS);
  assert.equal(t.sessions.view('host-aaaaaaaa').mine.host, true);

  // A member reconnecting gets the session and where it is.
  t.live.drop('join-bbbbbbbb');
  t.clock.advance(3000);
  t.live.connect('join-bbbbbbbb', { profileName: 'Anna', device: 'Laptop' });
  assert.equal(t.live.take('join-bbbbbbbb', 'state').sessionId, sessionId);

  // Gone for good.
  t.live.drop('host-aaaaaaaa');
  t.clock.advance(GRACE_MS + 10);
  const changed = t.live.take('join-bbbbbbbb', 'hostChanged');
  assert.equal(changed.reason, 'dropped');
});

test('a join request outlives its host\'s handover and reaches the new host', () => {
  const t = setup();
  const sessionId = joined(t);
  const { requestId } = t.sessions.handle('join-cccccccc', { type: 'join', sessionId });
  t.live.clear('join-bbbbbbbb');
  t.sessions.handle('host-aaaaaaaa', { type: 'leave' });
  assert.equal(t.live.take('join-bbbbbbbb', 'joinRequest').requestId, requestId);
  t.sessions.handle('join-bbbbbbbb', { type: 'answer', requestId, accept: true });
  assert.equal(t.live.take('join-cccccccc', 'joinResult').ok, true);
});

test('joining another session leaves the one you are in; a full session takes nobody', () => {
  const t = setup();
  const sessionId = joined(t);
  // Kitchen plays something of its own, then joins: its own session ends.
  t.sessions.handle('join-cccccccc', { type: 'state', state: playing({ songId: 's3' }) });
  t.clock.advance(200);
  assert.equal(t.sessions.list().length, 2);
  const { requestId } = t.sessions.handle('join-cccccccc', { type: 'join', sessionId });
  t.sessions.handle('host-aaaaaaaa', { type: 'answer', requestId, accept: true });
  t.clock.advance(200);
  assert.equal(t.sessions.list().length, 1);
  assert.equal(t.sessions.list()[0].listeners, 2);

  for (let i = 3; i < MAX_MEMBERS; i += 1) {
    const c = `extra-${i}-xxxxxx`;
    t.live.connect(c, { device: `PC ${i}` });
    const r = t.sessions.handle(c, { type: 'join', sessionId });
    t.sessions.handle('host-aaaaaaaa', { type: 'answer', requestId: r.requestId, accept: true });
  }
  t.live.connect('late-zzzzzzzz', { device: 'Late' });
  assert.throws(() => t.sessions.handle('late-zzzzzzzz', { type: 'join', sessionId }), /full/);
});

test('controllers (a smart home, later) reach sessions and idle players without joining', () => {
  const t = setup();
  const sessionId = joined(t);
  t.sessions.controlSession(sessionId, 'pause', {}, { profileName: 'Alexa' });
  assert.equal(t.live.take('host-aaaaaaaa', 'control').from.profileName, 'Alexa');
  t.sessions.controlPlayer('join-cccccccc', 'playPlaylist', { name: 'evening' }, { profileName: 'Alexa' });
  const c = t.live.take('join-cccccccc', 'control');
  assert.equal(c.sessionId, null);
  assert.equal(c.args.contextName, 'Evening');
  const players = t.sessions.players();
  assert.equal(players.length, 3);
  assert.deepEqual(players.find((p) => p.client === 'host-aaaaaaaa'), {
    client: 'host-aaaaaaaa', profileName: 'Ceeser', device: 'Living room', sessionId, host: true,
  });
  assert.equal(players.find((p) => p.client === 'join-cccccccc').sessionId, null);
});

test('only apps with a live channel take part', () => {
  const t = setup();
  assert.throws(() => t.sessions.handle('nolive-00000000', { type: 'state', state: playing() }), /not connected to the server's live channel/);
  assert.throws(() => t.sessions.handle('x', { type: 'state', state: playing() }), /app's id/);
  assert.throws(() => t.sessions.handle('host-aaaaaaaa', { type: 'dance' }), /Unknown/);
});

// ---- over HTTP ----

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sessions-test-'));
  const server = await startServer({
    home: path.join(root, 'home'), music: path.join(root, 'music'), port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null,
  });
  try {
    await fn({ server, base: `http://127.0.0.1:${server.port}` });
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function post(base, body) {
  const r = await fetch(`${base}/api/sessions`, { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

test('over HTTP: two apps, one plays, the other joins and pauses it', async () => {
  await withServer(async ({ server, base }) => {
    const song = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);
    await fetch(`${base}/api/songs/s1?meta=${encodeURIComponent(JSON.stringify({ title: 'Roads', artist: 'Portishead', format: 'mp3' }))}`, { method: 'PUT', body: song });
    const host = await connect(base, 'host-aaaaaaaa', { device: 'Living room' });
    const joiner = await connect(base, 'join-bbbbbbbb', { device: 'Laptop' });
    await host.next('hello');
    await joiner.next('hello');

    const st = await post(base, { client: 'host-aaaaaaaa', type: 'state', state: { songId: 's1', title: 'Roads', playing: true, position: 3 } });
    assert.equal(st.status, 200);
    const { sessionId } = st.json;
    let list;
    do list = (await joiner.next('sessions')).sessions; while (!list.length);
    assert.equal(list[0].id, sessionId);
    assert.equal(list[0].name, 'Default - Living room');

    const asked = await post(base, { client: 'join-bbbbbbbb', type: 'join', sessionId, mode: 'remote' });
    const request = await host.next('joinRequest');
    assert.equal(request.requestId, asked.json.requestId);
    assert.equal(request.device, 'Laptop');
    await post(base, { client: 'host-aaaaaaaa', type: 'answer', requestId: request.requestId, accept: true });
    const result = await joiner.next('joinResult');
    assert.equal(result.ok, true);

    assert.equal((await post(base, { client: 'join-bbbbbbbb', type: 'control', action: 'pause' })).status, 200);
    assert.equal((await host.next('control')).action, 'pause');
    const bad = await post(base, { client: 'join-bbbbbbbb', type: 'control', action: 'playSong', songId: 'nope' });
    assert.equal(bad.status, 404);
    const view = await (await fetch(`${base}/api/sessions?client=join-bbbbbbbb`)).json();
    assert.equal(view.mine.session.id, sessionId);
    assert.equal(view.mine.host, false);
    assert.equal(server.sessions.players().length, 2);

    // Declined: the wait comes back with the error.
    await post(base, { client: 'join-bbbbbbbb', type: 'leave' });
    const again = await post(base, { client: 'join-bbbbbbbb', type: 'join', sessionId });
    await post(base, { client: 'host-aaaaaaaa', type: 'answer', requestId: again.json.requestId, accept: false });
    const third = await post(base, { client: 'join-bbbbbbbb', type: 'join', sessionId });
    assert.equal(third.status, 429);
    assert.equal(third.json.retryIn, 60);

    // A controller's "play my playlist" is worked out from the server's library.
    await fetch(`${base}/api/commands`, {
      method: 'POST',
      body: JSON.stringify({
        commands: [{ cid: 'c1', at: Date.now(), type: 'createPlaylist', playlistId: 'p1', name: 'Evening' },
          { cid: 'c2', at: Date.now(), type: 'addSongToPlaylists', songId: 's1', playlistIds: ['p1'] }],
      }),
    });
    server.sessions.controlPlayer('join-bbbbbbbb', 'playPlaylist', { name: 'evening' }, { profileName: 'Alexa' });
    assert.deepEqual((await joiner.next('control')).args, {
      ids: ['s1'], contextName: 'Evening', contextId: 'p1', songId: null,
    });
    server.sessions.controlPlayer('join-bbbbbbbb', 'playPlaylist', { playlistId: 'all' });
    assert.deepEqual((await joiner.next('control')).args.ids, ['s1']);
    host.close();
    joiner.close();
  });
});
