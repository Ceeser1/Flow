'use strict';

// Guests from other servers (4.0): an app of another Flow Server joins a
// session here with its own pass, sees and streams this server's songs while
// in it, and is never the host.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../src/server');
const { connect } = require('../testing/liveClient');
const { makeReply, parseReply } = require('@flow/core/discovery');

process.env.FLOW_SERVER_FFMPEG = 'off';

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);

async function call(base, route, { body, token, method } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${route}`, body === undefined && !method ? { headers } : { method: method || 'POST', headers, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, size: text.length };
}

const state = (songId, extra = {}) => ({
  songId, title: songId, artist: 'Moby', duration: 200, playing: true, position: 10, ids: ['s1', 's2'], name: 'Anna - Speakers', ...extra,
});

test('a guest from another server: let in by the admins and the host, its songs, never the host', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-guest-test-'));
  const server = await startServer({
    home: path.join(root, 'home'), music: path.join(root, 'music'), port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null, livePingMs: 200,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const open = [];
  try {
    for (const id of ['s1', 's2']) {
      await fetch(`${base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify({ title: id, artist: 'Moby', format: 'mp3', duration: 200 }))}`, { method: 'PUT', body: FAKE_MP3 });
    }
    const host = await connect(base, 'hostclient01', { device: 'PC' });
    const second = await connect(base, 'secondclient1', { device: 'Laptop' });
    open.push(host, second);
    await host.next('hello', 2000);
    const started = await call(base, '/api/sessions', { body: { type: 'state', client: 'hostclient01', state: state('s1') } });
    const sessionId = started.json.sessionId;
    assert.ok(sessionId);

    // Off until an admin allows it.
    const hello = { client: 'guestclient01', device: 'Galaxy', profileName: 'Ben', serverName: 'Pi' };
    assert.equal((await call(base, '/api/guest/hello', { body: hello })).status, 403);
    assert.ok(!(await call(base, '/api/hello')).json.features.includes('guests'));
    server.config.set({ guests: true });
    assert.ok((await call(base, '/api/hello')).json.features.includes('guests'));
    assert.equal(parseReply(makeReply({ id: 'x', name: 'Home', port: 7878, guests: true }), '192.168.0.2').guests, true);

    const pass = await call(base, '/api/guest/hello', { body: hello });
    assert.equal(pass.status, 200);
    const gt = pass.json.token;
    assert.equal(pass.json.name, server.config.get().name);
    assert.equal((await call(base, '/api/guest/sessions')).status, 401, 'not without the pass');
    const listed = await call(base, '/api/guest/sessions', { token: gt });
    assert.deepEqual(listed.json.sessions.map((s) => s.id), [sessionId]);
    // Before joining: no songs.
    assert.equal((await call(base, '/api/guest/library', { token: gt })).status, 403);

    const guest = await connect(base, 'guestclient01', { guest: gt });
    open.push(guest);
    assert.equal(guest.status, 200);
    await guest.next('hello', 2000);
    // Only a guest's own requests: not hosting, not answering.
    assert.equal((await call(base, '/api/guest/session', { token: gt, body: { type: 'state', state: state('s2') } })).status, 403);
    await call(base, '/api/guest/session', { token: gt, body: { type: 'join', sessionId, mode: 'here' } });
    const asked = await host.next('joinRequest', 2000);
    assert.deepEqual([asked.profileName, asked.device, asked.guest, asked.serverName], ['Ben', 'Galaxy', true, 'Pi']);
    await call(base, '/api/sessions', { body: { type: 'answer', client: 'hostclient01', requestId: asked.requestId, accept: true } });
    const joined = await guest.next('joinResult', 2000);
    assert.equal(joined.ok, true);
    assert.equal(joined.state.songId, 's1');
    const g = joined.session.members.find((m) => m.client === 'guestclient01');
    assert.deepEqual([g.guest, g.serverName], [true, 'Pi']);

    // The songs, to see and stream; nothing about files or who added them.
    const lib = await call(base, '/api/guest/library', { token: gt });
    assert.deepEqual(lib.json.songs.map((s) => s.id).sort(), ['s1', 's2']);
    assert.equal(lib.json.songs[0].file, undefined);
    assert.equal(lib.json.songs[0].addedBy, undefined);
    const audio = await fetch(`${base}/api/guest/songs/s1/audio?gt=${gt}`);
    assert.equal(audio.status, 200);
    assert.equal((await audio.arrayBuffer()).byteLength, FAKE_MP3.length);
    assert.equal((await call(base, '/api/guest/time', { token: gt })).status, 200);

    // Its buttons go to the host; this server's playlists are not for guests.
    await call(base, '/api/guest/session', { token: gt, body: { type: 'control', action: 'next' } });
    assert.equal((await host.next('control', 2000)).action, 'next');
    assert.equal((await call(base, '/api/guest/session', { token: gt, body: { type: 'control', action: 'playPlaylist', name: 'All Songs' } })).status, 403);
    assert.equal((await call(base, '/api/guest/session', { token: gt, body: { type: 'control', action: 'queueAdd', songId: 's2' } })).status, 200);

    // One of the guest's own songs, brought into the session: the members see it, play and queue it.
    const meta = encodeURIComponent(JSON.stringify({ title: 'Roads', artist: 'Portishead', duration: 300, format: 'mp3' }));
    const brought = await fetch(`${base}/api/guest/songs/g-guestclient01-r1?meta=${meta}`, { method: 'PUT', body: FAKE_MP3, headers: { Authorization: `Bearer ${gt}` } });
    assert.equal(brought.status, 200);
    let told = await host.next('session', 2000);
    // (The one before told of the guest joining.)
    while (!told.session.songs.length) told = await host.next('session', 2000);
    assert.deepEqual(told.session.songs.map((x) => [x.id, x.title, x.by]), [['g-guestclient01-r1', 'Roads', 'Ben - Galaxy']]);
    assert.equal((await call(base, '/api/guest/session', { token: gt, body: { type: 'control', action: 'queueAdd', songId: 'g-guestclient01-r1' } })).status, 200);
    assert.equal((await host.next('control', 2000)).args.songId, 's2', 'the queued library song before');
    assert.equal((await host.next('control', 2000)).args.songId, 'g-guestclient01-r1');
    const hostHears = await fetch(`${base}/api/sessions/songs/g-guestclient01-r1/audio?client=hostclient01`);
    assert.equal(hostHears.status, 200);
    assert.equal((await hostHears.arrayBuffer()).byteLength, FAKE_MP3.length);
    assert.equal((await fetch(`${base}/api/sessions/songs/g-guestclient01-r1/audio?client=strangerclient`)).status, 404, 'not for apps outside the session');
    assert.equal((await fetch(`${base}/api/guest/songs/g-guestclient01-r1/audio?gt=${gt}`)).status, 200);
    const badMeta = encodeURIComponent(JSON.stringify({ title: 'x', format: 'exe' }));
    assert.equal((await fetch(`${base}/api/guest/songs/g-bad?meta=${badMeta}`, { method: 'PUT', body: FAKE_MP3, headers: { Authorization: `Bearer ${gt}` } })).status, 415);
    const songDir = path.join(root, 'home', 'session-songs', sessionId);
    assert.ok(fs.existsSync(path.join(songDir, 'g-guestclient01-r1.mp3')));

    // A member of this server joins too; the host leaves: that member hosts, not the guest.
    await call(base, '/api/sessions', { body: { type: 'join', client: 'secondclient1', sessionId, mode: 'remote' } });
    const asked2 = await host.next('joinRequest', 2000);
    await call(base, '/api/sessions', { body: { type: 'answer', client: 'hostclient01', requestId: asked2.requestId, accept: true } });
    await second.next('joinResult', 2000);
    await call(base, '/api/sessions', { body: { type: 'leave', client: 'hostclient01' } });
    const handed = await second.next('hostChanged', 2000);
    assert.equal(handed.session.hostClient, 'secondclient1');
    // That one leaves too: only the guest is left, and the session is over.
    await call(base, '/api/sessions', { body: { type: 'leave', client: 'secondclient1' } });
    const over = await guest.next('left', 2000);
    assert.equal(over.reason, 'hostLeft');
    assert.ok(!fs.existsSync(songDir), 'the songs brought along went with the session');
    assert.equal((await call(base, '/api/guest/library', { token: gt })).status, 403, 'out of the session: no songs');

    // The door closed: the guest's channel ends.
    server.config.set({ guests: false });
    const end = await guest.next('end', 3000);
    assert.equal(end.reason, 'auth');
    assert.equal((await call(base, '/api/guest/sessions', { token: gt })).status, 403);
  } finally {
    for (const c of open) c.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
