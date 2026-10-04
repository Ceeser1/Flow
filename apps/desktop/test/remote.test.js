'use strict';

// "Use a Flow Server" (src/remote.js) against real Flow Servers on free ports,
// one step after another as a user would: connecting, the songs here held
// until OK'd and then uploaded, changes made here reaching the server, a song
// downloaded and dropped again, All Songs marked for download, the live
// channel, profiles, and a server with a password.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-remote-'));
process.env.FLOW_HOME = path.join(scratch, 'home');
process.env.FLOW_MUSIC = path.join(scratch, 'music');
// The fake songs below are no real audio: ffprobe would call them broken.
process.env.FLOW_SERVER_FFMPEG = 'off';

const { startServer } = require('../../server/src/server');
const configMod = require('../../server/src/config');
const model = require('@flow/core/libraryModel');
const settings = require('../src/settings');
const library = require('../src/library');
const remote = require('../src/remote');

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1997, 7)]);
const servers = [];

async function serve({ password } = {}) {
  const dirs = { home: path.join(scratch, `server${servers.length}`, 'home'), music: path.join(scratch, `server${servers.length}`, 'music') };
  if (password) configMod.open(dirs).set({ password: configMod.passwordEntry(password) });
  const server = await startServer({
    ...dirs, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null,
  });
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}`, address: `127.0.0.1:${server.port}` };
}

async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const serverLibrary = async (base, token) => (await (await fetch(`${base}/api/library`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})).json()).library;

const asked = [];
const notices = [];
const live = [];

test.after(async () => {
  remote.stop();
  await Promise.all(servers.map((s) => s.close()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('a Flow Server as the library, step by step', async (t) => {
  const one = await serve();
  library.load();
  // A song in Local Files from before there was a server.
  const roadsFile = path.join(process.env.FLOW_MUSIC, 'Portishead - Roads.mp3');
  fs.mkdirSync(process.env.FLOW_MUSIC, { recursive: true });
  fs.writeFileSync(roadsFile, FAKE_MP3);
  library.mutate((d) => model.addSong(d, {
    id: 'roads1', file: roadsFile, title: 'Roads', artist: 'Portishead', mix: '', duration: 305, format: 'mp3', addedAt: Date.now(),
  }));

  settings.set({ serverOn: true, serverHome: one.address });
  remote.init({
    confirmUpload: async ({ count }) => {
      asked.push(count);
      return true;
    },
    onNotice: (text, kind) => notices.push([kind, text]),
    onLive: (e) => live.push(e.type),
  });

  await t.test('connects, asks before the songs here go up, then uploads them', async () => {
    await until(() => remote.status().state === 'online', 'online');
    assert.equal(remote.active(), true);
    await until(async () => (await serverLibrary(one.base)).songs.length === 1, 'the upload');
    assert.deepEqual(asked, [1]);
    const there = (await serverLibrary(one.base)).songs[0];
    assert.equal(there.id, 'roads1');
    assert.equal(there.title, 'Roads');
    // Kept here (Keep downloaded files), and the window plays it from here.
    await until(() => remote.view().songs.length === 1, 'the view');
    assert.equal(remote.localFileOf('roads1'), roadsFile);
    assert.equal(remote.status().queued, 0);
  });

  await t.test('a change made here reaches the server', async () => {
    remote.command('createPlaylist', { playlistId: 'eve1', name: 'Evening' });
    remote.command('addSongsToPlaylist', { playlistId: 'eve1', songIds: ['roads1'] });
    // Shows at once, before the server has it.
    assert.ok(model.playlistById(remote.view(), 'eve1'));
    await until(async () => {
      const p = (await serverLibrary(one.base)).playlists.find((x) => x.id === 'eve1');
      return p && p.entries.length === 1;
    }, 'the playlist on the server');
    assert.throws(() => remote.command('createPlaylist', { playlistId: '', name: 'No id' }));
  });

  await t.test('a song only the server has: downloaded, and dropped again', async () => {
    const meta = { title: 'Glory Box', artist: 'Portishead', format: 'mp3', duration: 301 };
    const r = await fetch(`${one.base}/api/songs/glory1?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: 'PUT', body: FAKE_MP3 });
    assert.equal(r.status, 200);
    const result = await remote.syncNow();
    assert.equal(result.queued, 0);
    assert.ok(model.songById(remote.view(), 'glory1'));
    assert.equal(remote.localFileOf('glory1'), null);

    await remote.downloadSong('glory1');
    const copy = remote.localFileOf('glory1');
    assert.ok(copy && fs.existsSync(copy));
    assert.deepEqual(fs.readFileSync(copy), FAKE_MP3);
    assert.equal(path.dirname(copy), process.env.FLOW_MUSIC);

    await remote.removeDownload('glory1');
    assert.equal(remote.localFileOf('glory1'), null);
    assert.equal(fs.existsSync(copy), false);
    // A song the server does not have cannot be downloaded.
    await assert.rejects(remote.downloadSong('nope'), /not on the server/);
  });

  await t.test('All Songs marked for download comes down, and goes again when unmarked', async () => {
    await remote.setOffline(model.ALL_SONGS_ID, true);
    assert.deepEqual(remote.status().offline, [model.ALL_SONGS_ID]);
    await until(() => remote.localFileOf('glory1'), 'the marked song');
    await assert.rejects(remote.removeDownload('glory1'), /marked for download/);
    await remote.setOffline(model.ALL_SONGS_ID, false);
    assert.equal(remote.localFileOf('glory1'), null);
    assert.equal(remote.localFileOf('roads1'), roadsFile);
  });

  await t.test('every download removed at once: the songs that began here stay', async () => {
    await remote.downloadSong('glory1');
    await remote.setOffline(model.ALL_SONGS_ID, true);
    const copy = remote.localFileOf('glory1');
    assert.ok(copy);
    assert.deepEqual(await remote.removeAllDownloads(), { removed: 1, inUse: 0 });
    assert.deepEqual(remote.status().offline, []);
    assert.equal(remote.localFileOf('glory1'), null);
    assert.equal(fs.existsSync(copy), false);
    assert.equal(remote.localFileOf('roads1'), roadsFile);
  });

  await t.test('the live channel opens, and Active Sessions answer', async () => {
    await until(() => remote.status().live, 'the live channel');
    assert.ok(live.includes('hello'));
    assert.equal(remote.status().sessions, true);
    const list = await remote.sessions(null);
    assert.ok(list && typeof list === 'object');
    await remote.leaveSession(1500);

    // An event reaches the window; a stream the server ends opens again.
    const client = remote.status().clientId;
    assert.ok(one.server.live.send(client, 'test', { n: 1 }));
    await until(() => live.includes('test'), 'the event');
    const hellos = live.filter((x) => x === 'hello').length;
    one.server.live.kick(client, 'bye', {});
    await until(() => live.includes('down'), 'the channel down');
    await until(() => live.filter((x) => x === 'hello').length > hellos && remote.status().live, 'the channel open again');
  });

  await t.test('without ffmpeg the server cannot trim; Download (Server) has no batch', async () => {
    assert.equal(remote.status().trim, false);
    await assert.rejects(remote.trimSong('roads1', { start: 1, end: 100 }), /cannot trim/);
    const batch = await remote.serverDownloads('get').catch((err) => err);
    assert.ok(batch === null || !(batch instanceof Error) || /does not download/.test(batch.message));
  });

  await t.test('profiles: made, signed in to, its own playlists, signed out', async () => {
    assert.equal(remote.status().profilesSupported, true);
    const made = await remote.createProfile('Evening Listener', '');
    assert.equal(made.name, 'Evening Listener');
    assert.equal(remote.status().profile.name, 'Evening Listener');
    const token = remote.status().token;
    assert.ok(token);
    remote.command('createPlaylist', { playlistId: 'mine1', name: 'Only Mine' });
    await until(async () => (await serverLibrary(one.base, token)).playlists.some((p) => p.id === 'mine1'), 'the profile playlist');
    assert.ok(!(await serverLibrary(one.base)).playlists.some((p) => p.id === 'mine1'));
    const list = await remote.loadProfiles();
    assert.ok(list.some((p) => p.name === 'Evening Listener'));
    const renamed = await remote.renameProfile('Night Listener');
    assert.equal(renamed.name, 'Night Listener');
    await remote.logoutProfile();
    assert.equal(remote.status().profile, null);
    assert.ok(!model.playlistById(remote.view(), 'mine1'));
  });

  await t.test('a server with a password: asked for, refused when wrong, then the songs here go up there too', async () => {
    const two = await serve({ password: 'Secret123' });
    settings.set({ serverHome: two.address });
    remote.reconfigure({ serverHome: two.address });
    await until(() => remote.status().state === 'password', 'the password state');
    assert.equal(remote.status().hasSecret, false);

    remote.setSecret('Wrong4567');
    await until(() => remote.status().state === 'password' && /Wrong password/.test(remote.status().message), 'the wrong password');

    remote.setSecret('Secret123');
    await until(() => remote.status().state === 'online', 'online with the password');
    assert.equal(remote.status().hasSecret, true);
    assert.ok(notices.some(([, text]) => /different Flow Server/.test(text)));
    await until(() => asked.length === 2, 'asked again for the new server');
    const token = remote.status().token;
    await until(async () => (await serverLibrary(two.base, token)).songs.some((s) => s.title === 'Roads'), 'the upload to the second server');
    assert.equal(remote.localFileOf('roads1'), roadsFile);
  });

  await t.test('switched off: no server, the window shows Local Files', async () => {
    settings.set({ serverOn: false });
    remote.reconfigure({ serverOn: false });
    assert.equal(remote.active(), false);
    assert.equal(remote.status().state, 'off');
  });
});
