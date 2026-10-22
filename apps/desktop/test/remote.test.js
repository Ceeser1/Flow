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

const { startServer } = require('../../linux-server/src/server');
const configMod = require('../../linux-server/src/config');
const model = require('@flow/core/libraryModel');
const settings = require('../src/settings');
const library = require('../src/library');
const remote = require('../src/remote');

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1997, 7)]);
const servers = [];
let second = null; // the server with a password, from its step on

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
const questions = [];
let answerUpload = true;
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
    confirmUpload: async (q) => {
      asked.push(q.count);
      questions.push(q);
      return answerUpload;
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

  await t.test('Statistics: the profile signed in to is tracked with its listens, kept after logout until removed', async () => {
    const night = (await remote.loadProfiles()).find((p) => p.name === 'Night Listener');
    await remote.loginProfile(night.id, '4321');
    assert.equal(remote.status().statistics, true);
    remote.command('recordListen', {
      songId: 'roads1', listened: 120, duration: 305, tz: 0,
    });
    // Shown at once, before the server has it.
    const row = await until(() => remote.status().tracked.find((r) => r.profileId === night.id && r.statistics.seconds === 120), 'the tracked row');
    assert.equal(row.profileName, 'Night Listener');
    assert.equal(row.serverId, remote.status().serverId);
    assert.equal(row.serverName, remote.status().serverName);
    assert.equal(row.supported, true);
    assert.equal(row.statistics.listens, 1);
    assert.ok(row.statistics.since > 0);
    await until(async () => (await serverLibrary(one.base, remote.status().token)).statistics.seconds === 120, 'the listen on the server');
    assert.throws(() => remote.removeTracked(row.serverId, night.id), /in use/);
    await remote.logoutProfile();
    // The Default heard it too; it gets no row of its own.
    assert.equal(remote.view().statistics.seconds, 120);
    assert.deepEqual(remote.status().tracked.map((r) => r.profileId), [night.id]);
    remote.removeTracked(row.serverId, night.id);
    assert.deepEqual(remote.status().tracked, []);
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
    two.server.library.addUploaded = add;
    second = two;
  });

  await t.test('switching between two servers: each keeps its marks, songs from the other are asked about, a file both use stays', async () => {
    const two = second;
    const token = () => remote.status().token;
    const switchTo = async (s, what) => {
      settings.set({ serverHome: s.address });
      remote.reconfigure({ serverHome: s.address });
      await until(() => remote.status().state === 'online' && remote.status().address === s.address, what);
    };
    const meta = { title: 'Unfinished Sympathy', artist: 'Massive Attack', format: 'mp3', duration: 308 };
    const put = await fetch(`${two.base}/api/songs/unfin1?meta=${encodeURIComponent(JSON.stringify(meta))}`, {
      method: 'PUT', body: FAKE_MP3, headers: { Authorization: `Bearer ${token()}` },
    });
    assert.equal(put.status, 200);
    await remote.syncNow();
    await remote.setOffline(model.ALL_SONGS_ID, true);
    await until(() => remote.localFileOf('unfin1'), 'the second server\'s song');
    const unfinFile = remote.localFileOf('unfin1');

    // To the first server: its own marks (none), and the song that came meanwhile asked about.
    questions.length = 0;
    await switchTo(one, 'the first server again');
    assert.ok(notices.some(([, text]) => /^Back with/.test(text)));
    assert.deepEqual(remote.status().offline, []);
    await until(() => questions.length === 1, 'the question about the new song');
    assert.deepEqual({ ...questions[0], name: undefined }, {
      count: 1, fromOthers: 1, returning: true, name: undefined,
    });
    await until(async () => (await serverLibrary(one.base)).songs.some((s) => s.title === 'Unfinished Sympathy'), 'the upload to the first server');
    await remote.setOffline(model.ALL_SONGS_ID, true);
    await until(() => remote.localFileOf('glory1'), 'the first server\'s songs');
    const gloryFile = remote.localFileOf('glory1');

    // Back to the second: All Songs is still marked there; the first one's copies are not uploaded when declined.
    answerUpload = false;
    questions.length = 0;
    await switchTo(two, 'the second server again');
    assert.deepEqual(remote.status().offline, [model.ALL_SONGS_ID]);
    assert.equal(remote.localFileOf('unfin1'), unfinFile);
    await until(() => questions.length === 1, 'the question about the first server\'s songs');
    assert.equal(questions[0].returning, true);
    assert.equal(questions[0].fromOthers, questions[0].count);
    await remote.syncNow().catch(() => {});
    assert.ok(!(await serverLibrary(two.base, token())).songs.some((s) => s.title === 'Glory Box'));

    // Unmarked here: its copy is still the first server's song, so the file stays (and still counts
    // as this server's song here, the same one); the first one's copies stay too.
    await remote.setOffline(model.ALL_SONGS_ID, false);
    assert.equal(remote.localFileOf('unfin1'), unfinFile);
    assert.equal(model.songById(remote.view(), 'unfin1').file, unfinFile);
    assert.ok(fs.existsSync(unfinFile));
    assert.ok(library.get().songs.some((s) => s.file === unfinFile));
    assert.ok(fs.existsSync(gloryFile));

    // Downloaded Songs: the songs here that are not this server's, with ids of their own and the servers they are on.
    const device = await until(() => {
      const list = remote.view().deviceSongs;
      return list.some((s) => s.file === gloryFile) && list;
    }, 'the songs in Downloaded Songs');
    const glory = device.find((s) => s.file === gloryFile);
    assert.match(glory.id, /^device:/);
    assert.equal(glory.isDevice, true);
    assert.equal(glory.servers.length, 1);
    assert.ok(!device.some((s) => s.file === roadsFile), 'a song of this server is in its All Songs');
    assert.ok(!device.some((s) => s.file === unfinFile), 'this server\'s song, here as the first one\'s copy');
    assert.equal(remote.localFileOf(glory.id), gloryFile);
    await assert.rejects(remote.removeDeviceSong('roads1'), /not one of this device/);

    // The same song reaches this server from elsewhere: the file held back here counts as its copy, nothing goes up.
    const gloryMeta = { title: 'Glory Box', artist: 'Portishead', format: 'mp3', duration: 301 };
    const put2 = await fetch(`${two.base}/api/songs/glory2?meta=${encodeURIComponent(JSON.stringify(gloryMeta))}`, {
      method: 'PUT', body: FAKE_MP3, headers: { Authorization: `Bearer ${token()}` },
    });
    assert.equal(put2.status, 200);
    await remote.syncNow().catch(() => {});
    await until(() => remote.localFileOf('glory2') === gloryFile, 'the copy here counted');
    assert.equal(model.songById(remote.view(), 'glory2').file, gloryFile);
    assert.ok(!remote.view().deviceSongs.some((s) => s.file === gloryFile));
    assert.equal((await serverLibrary(two.base, token())).songs.filter((s) => s.title === 'Glory Box').length, 1);
    // Deleted from here: the file goes, the first server no longer counts it as here; this one keeps its song.
    await remote.removeDownload('glory2');
    assert.equal(fs.existsSync(gloryFile), false);
    assert.equal(remote.localFileOf('glory2'), null);
    assert.ok(model.songById(remote.view(), 'glory2'));
    answerUpload = true;
  });

  await t.test('Switch server: the servers used before, switched to with their password, one away stays away, forgotten', async () => {
    const two = second;
    let list = remote.status().servers;
    assert.equal(list.length, 2);
    assert.equal(list[0].current, true);
    assert.equal(list[0].address, two.address);
    const other = list[1];
    assert.equal(other.address, one.address);
    await assert.rejects(remote.switchServer(list[0].id), /has not used that server/);

    await remote.switchServer(other.id);
    await until(() => remote.status().state === 'online' && remote.status().address === one.address, 'the first server');
    assert.equal(settings.get('serverHome'), one.address);
    assert.deepEqual(remote.status().offline, [model.ALL_SONGS_ID], 'its own mark');
    // The second one's password is forgotten in the box, and still known to Switch server.
    remote.setSecret('');
    await until(() => remote.status().state === 'online' && !remote.status().hasSecret, 'online without a password');
    const back = remote.status().servers.find((x) => !x.current);
    await remote.switchServer(back.id);
    await until(() => remote.status().state === 'online' && remote.status().address === two.address, 'the second server, with its password');
    assert.equal(remote.status().hasSecret, true);

    // A server that does not answer: this one stays in use.
    await one.server.close();
    servers.splice(servers.indexOf(one.server), 1);
    const away = remote.status().servers.find((x) => !x.current);
    await assert.rejects(remote.switchServer(away.id), /cannot be reached right now, so Flow stays with/);
    assert.equal(remote.status().state, 'online');
    assert.equal(remote.status().address, two.address);

    remote.forgetServer(away.id);
    list = remote.status().servers;
    assert.deepEqual(list.map((x) => x.current), [true]);
  });

  await t.test('switched off: no server, the window shows Local Files', async () => {
    settings.set({ serverOn: false });
    remote.reconfigure({ serverOn: false });
    assert.equal(remote.active(), false);
    assert.equal(remote.status().state, 'off');
  });
});
