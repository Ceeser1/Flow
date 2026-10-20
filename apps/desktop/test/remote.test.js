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
  // The server keeps an upload's folders from the app's music folder.
  one.server.config.set({ keepFolders: true });
  library.load();
  // A song in Local Files from before there was a server, in a folder of its own.
  const roadsFile = path.join(process.env.FLOW_MUSIC, 'Portishead', 'Dummy', 'Roads.mp3');
  fs.mkdirSync(path.dirname(roadsFile), { recursive: true });
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
    assert.equal(there.file, 'Portishead/Dummy/Roads.mp3');
    // Kept here (Keep local files after server upload), and the window plays it from here.
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
    // The server's first profile becomes its admin, so it needs a PIN.
    await assert.rejects(remote.createProfile('Evening Listener', ''), /needs a PIN/);
    const made = await remote.createProfile('Evening Listener', '2468');
    assert.equal(made.name, 'Evening Listener');
    assert.equal(remote.status().profile.name, 'Evening Listener');
    const token = remote.status().token;
    assert.ok(token);
    remote.command('createPlaylist', { playlistId: 'mine1', name: 'Only Mine' });
    await until(async () => (await serverLibrary(one.base, token)).playlists.some((p) => p.id === 'mine1'), 'the profile playlist');
    assert.ok(!(await serverLibrary(one.base)).playlists.some((p) => p.id === 'mine1'));
    const list = await remote.loadProfiles();
    assert.ok(list.some((p) => p.name === 'Evening Listener'));
    // Renaming needs the PIN; a new PIN is the one asked for then. An admin keeps one.
    await assert.rejects(remote.renameProfile('Night Listener'), /Enter the current PIN/);
    await new Promise((r) => setTimeout(r, 1100)); // the wait after a wrong try
    assert.equal((await remote.renameProfile('Night Listener', '2468')).name, 'Night Listener');
    assert.equal((await remote.changePin('2468', '4321')).pin, true);
    assert.equal(remote.status().profile.pin, true);
    await assert.rejects(remote.renameProfile('Late Listener', '2468'), /Wrong current PIN/);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await remote.renameProfile('Night Listener', '4321')).name, 'Night Listener');
    await assert.rejects(remote.changePin('4321', ''), /An admin profile needs a PIN/);
    await remote.logoutProfile();
    assert.equal(remote.status().profile, null);
    assert.ok(!model.playlistById(remote.view(), 'mine1'));
  });

  await t.test('Administration: an admin profile, the rules, the master changing the password', async () => {
    const night = (await remote.loadProfiles()).find((p) => p.name === 'Night Listener');
    await remote.loginProfile(night.id, '4321');
    // The first profile on the server: an admin.
    assert.equal(remote.status().admin, true);
    assert.equal(remote.status().master, false);
    const list = await remote.admin('profiles');
    assert.equal(list.me, night.id);
    assert.ok(list.profiles.some((p) => p.id === night.id && p.admin));
    assert.deepEqual(await remote.admin('rules', { songDelete: 'owner' }), { profileCreation: 'anyone', songDelete: 'owner' });
    assert.equal(remote.status().rules.songDelete, 'anyone', 'an admin may delete any song');
    await assert.rejects(remote.admin('../hello'), /No such page/);
    await assert.rejects(remote.changeServerPassword({ password: 'abcd' }), /master/);

    // The master: the password changed, this app carries on with its new token and keeps the password.
    // Made the master on the server (flow-server admin master) while signed in:
    // the library is unchanged, so the profiles list (fetched on every
    // connect) is what tells this app.
    one.server.config.set({ profiles: one.server.config.get().profiles.map((p) => (p.id === night.id ? { ...p, master: true } : p)) });
    assert.equal(remote.status().master, false);
    await remote.loadProfiles();
    assert.equal(remote.status().master, true);
    const before = remote.status().token;
    await remote.changeServerPassword({ password: 'abcd' });
    assert.notEqual(remote.status().token, before);
    assert.ok(one.server.config.get().password);
    assert.equal(remote.status().hasSecret, true);
    assert.ok((await remote.admin('profiles')).profiles.length >= 1, 'still in');
    assert.equal((await fetch(`${one.base}/api/library`)).status, 401, 'everyone else needs it');
    await remote.changeServerPassword({ current: 'abcd', remove: true });
    assert.equal(one.server.config.get().password, null);
    await remote.admin('rules', { songDelete: 'anyone' });
    one.server.config.set({ profiles: one.server.config.get().profiles.map((p) => ({ ...p, master: false })) });
    await remote.logoutProfile();
    assert.equal(remote.status().admin, false);
  });

  await t.test('the songs one profile added, marked for download: only those, new ones too, unmarked once it is gone', async () => {
    const post = async (route, body, token) => (await fetch(`${one.base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })).json();
    const upload = (id, title, token) => fetch(`${one.base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify({ title, artist: 'Massive Attack', format: 'mp3' }))}`, {
      method: 'PUT', body: FAKE_MP3, headers: { Authorization: `Bearer ${token}` },
    });
    const anna = await post('/api/profiles', { name: 'Anna', device: 'annas-phone' });
    await upload('tear1', 'Teardrop', anna.token);
    await remote.syncNow();
    const mark = `from:${anna.profile.id}`;
    await remote.setOffline(mark, true);
    await until(() => remote.localFileOf('tear1'), 'Anna\'s song');
    assert.equal(remote.localFileOf('glory1'), null, 'nobody\'s song stays on the server');
    await upload('angel1', 'Angel', anna.token);
    await remote.syncNow();
    await until(() => remote.localFileOf('angel1'), 'Anna\'s new song');
    await assert.rejects(remote.removeDownload('tear1'), /marked for download/);

    await remote.setOffline(mark, false);
    assert.equal(remote.localFileOf('tear1'), null);
    assert.equal(remote.localFileOf('roads1'), roadsFile);

    // Her profile deleted: the list is gone from the menu, so the mark goes too.
    await remote.setOffline(mark, true);
    await until(() => remote.localFileOf('tear1') && remote.localFileOf('angel1'), 'her songs again');
    await post('/api/profiles/delete', {}, anna.token);
    await remote.loadProfiles();
    assert.deepEqual(remote.status().offline, []);
    // Nothing of hers left here for the steps after.
    await remote.removeAllDownloads();
    assert.equal(remote.localFileOf('tear1'), null);
  });

  await t.test('away on a metered connection: marked songs wait, come down once allowed, and stop when no longer', async () => {
    const network = require('../src/network');
    const isMetered = network.isMetered;
    network.isMetered = async () => true;
    settings.set({ serverHomeOn: false, serverRemote: one.address, serverMetered: false });
    remote.reconfigure({ serverHomeOn: false, serverRemote: one.address });
    await until(() => remote.status().state === 'online' && remote.status().via === 'remote', 'online away from home');
    const onServer = () => remote.view().songs.filter((s) => s.id !== 'roads1').map((s) => s.id);
    const here = () => onServer().filter((id) => remote.localFileOf(id));
    const all = onServer();
    assert.ok(all.length >= 2, 'songs to come down');

    // Not allowed: nothing comes down, and the window says why.
    await remote.setOffline(model.ALL_SONGS_ID, true);
    await until(() => /wait to be downloaded until the connection is not metered/.test(remote.status().note), 'the waiting note');
    assert.deepEqual(here(), []);

    // Allowed, then taken back after the first song: the rest waits again.
    let takeBack = true;
    library.onChange(() => {
      if (!takeBack || !here().length) return;
      takeBack = false;
      settings.set({ serverMetered: false });
      remote.reconfigure({ serverMetered: false });
    });
    settings.set({ serverMetered: true });
    remote.reconfigure({ serverMetered: true });
    const left = all.length - 1;
    await until(() => remote.status().note.startsWith(`${left} ${left === 1 ? 'song waits' : 'songs wait'} to be downloaded`), 'the rest waiting');
    assert.equal(here().length, 1);

    // Allowed again: the rest comes down, and the note goes.
    settings.set({ serverMetered: true });
    remote.reconfigure({ serverMetered: true });
    await until(() => here().length === all.length, 'the rest of the songs');
    await until(() => remote.status().note === '', 'the note gone');

    await remote.setOffline(model.ALL_SONGS_ID, false);
    await remote.removeAllDownloads();
    network.isMetered = isMetered;
    settings.set({ serverHomeOn: true, serverRemote: '', serverMetered: false });
    remote.reconfigure({ serverHomeOn: true, serverRemote: '' });
    await until(() => remote.status().state === 'online' && remote.status().via === 'home', 'home again');
  });

  await t.test('a server with a password: asked for, refused when wrong, then the songs here go up there too', async () => {
    const two = await serve({ password: 'Secret123' });
    // As a phone: its uploads carry Settings' MP3 choice for the server to convert by.
    const env = require('../src/env');
    env.convertUploads = true;
    settings.set({ alwaysMp3: true, mp3Quality: 160 });
    const sent = [];
    const add = two.server.library.addUploaded;
    two.server.library.addUploaded = (...args) => {
      sent.push(args[2].convert);
      return add(...args);
    };
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
    assert.deepEqual(sent, [{ alwaysMp3: true, quality: 160, keepMp3: true }]);
    env.convertUploads = false;
    settings.set({ alwaysMp3: false });
  });

  await t.test('switched off: no server, the window shows Local Files', async () => {
    settings.set({ serverOn: false });
    remote.reconfigure({ serverOn: false });
    assert.equal(remote.active(), false);
    assert.equal(remote.status().state, 'off');
  });
});
