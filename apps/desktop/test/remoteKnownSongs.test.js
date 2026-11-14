'use strict';

// Songs here that the Flow Server has already (src/remote.js, against a real
// Flow Server on a free port): they are not sent to be told so, and not asked
// about. Only the songs the server lacks are asked about and go up; with
// "Not now" nothing goes up and nothing is tied; a song the server has under
// other names is asked about without its file going up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-known-'));
process.env.FLOW_HOME = path.join(scratch, 'home');
process.env.FLOW_MUSIC = path.join(scratch, 'music');
// The fake songs below are no real audio: ffprobe would call them broken.
process.env.FLOW_SERVER_FFMPEG = 'off';

const { startServer } = require('../../linux-server/src/server');
const model = require('@flow/core/libraryModel');
const settings = require('../src/settings');
const library = require('../src/library');
const remote = require('../src/remote');

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1997, 7)]);
let server = null;
let base = '';

// The songs' files the app sends (its PUT /api/songs/<id>?meta=), counted where they leave: the test's own
// requests go through fetch, the app's through http.request.
const http = require('http');
const puts = [];
const realRequest = http.request;
http.request = function request(...args) {
  const opts = args.find((x) => x && typeof x === 'object' && !(x instanceof URL)) || {};
  const m = /\/api\/songs\/([^/?]+)\?meta=/.exec(String(args[0]));
  if (m && opts.method === 'PUT') puts.push(decodeURIComponent(m[1]));
  return realRequest.apply(this, args);
};

async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const serverSongs = async () => (await (await fetch(`${base}/api/library`)).json()).library.songs;

/** A song put on the server by another device. */
async function onServer(id, meta) {
  const r = await fetch(`${base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify({ format: 'mp3', ...meta }))}`, { method: 'PUT', body: FAKE_MP3 });
  assert.equal(r.status, 200);
}

/** A song in Local Files, its file in the music folder. */
function here(id, meta) {
  const file = path.join(process.env.FLOW_MUSIC, `${id}.mp3`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, FAKE_MP3);
  library.mutate((d) => model.addSong(d, {
    id, file, mix: '', format: 'mp3', addedAt: Date.now(), ...meta,
  }));
  return file;
}

const questions = [];
const existing = [];
const transfers = [];
let answerUpload = false;

test.after(async () => {
  remote.stop();
  if (server) await server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('songs the server has already are not uploaded', async (t) => {
  server = await startServer({
    home: path.join(scratch, 'server', 'home'), music: path.join(scratch, 'server', 'music'), port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null,
  });
  base = `http://127.0.0.1:${server.port}`;
  await onServer('s-glory', { title: 'Glory Box', artist: 'Portishead', duration: 306 });
  await onServer('s-tear', { title: 'Teardrop', artist: 'Massive Attack', duration: 330 });
  await onServer('s-angel', { title: 'Angel', artist: 'Massive Attack', duration: 379 });
  await onServer('s-unfin', { title: 'Unfinished Sympathy', artist: 'Massive Attack', duration: 308, sourceUrl: 'https://example.com/watch?v=unfinished' });

  library.load();
  // Here from before the server: two it has (one written differently, a second longer), one it lacks.
  const gloryFile = here('g1', { title: 'Glory Box', artist: 'Portishead', duration: 306 });
  here('t1', { title: 'teardrop', artist: 'MASSIVE ATTACK', duration: 331 });
  here('r1', { title: 'Roads', artist: 'Portishead', duration: 305 });

  settings.set({ serverOn: true, serverHome: `127.0.0.1:${server.port}` });
  remote.init({
    confirmUpload: async (q) => {
      questions.push(q);
      return answerUpload;
    },
    askExisting: async (q) => {
      existing.push(q);
      return { choice: 'keep', all: false };
    },
    onStatus: (st) => {
      if (st.transferUp && st.transfer) transfers.push(st.transfer);
    },
  });

  await t.test('only the song the server lacks is asked about; Not now: nothing goes up, nothing is tied', async () => {
    await until(() => remote.status().state === 'online', 'online');
    await until(() => questions.length === 1, 'the question');
    assert.equal(questions[0].count, 1);
    assert.equal(questions[0].known, 2);
    await wait(300);
    assert.equal((await serverSongs()).length, 4);
    assert.deepEqual(puts, []);
    assert.deepEqual(transfers, []);
    assert.equal(remote.status().queued, 0);
    assert.equal(remote.serverSongOf('g1'), '');
    // The server's song plays from its copy here all the same.
    await until(() => remote.view().songs.length === 4, 'the view');
    assert.equal(remote.localFileOf('s-glory'), gloryFile);
    // The one the server lacks stays a song of this computer only.
    assert.deepEqual(remote.view().deviceSongs.map((s) => s.localId), ['r1']);
  });

  await t.test('Synchronize now asks again; Upload: the one song goes up, the others are tied to the server\'s songs', async () => {
    answerUpload = true;
    await remote.syncNow();
    await until(async () => (await serverSongs()).length === 5, 'the upload');
    assert.equal(questions.length, 2);
    assert.equal(questions[1].count, 1);
    assert.equal(questions[1].known, 2);
    await until(() => remote.status().queued === 0 && !remote.status().transfer, 'the queue sent');
    // One file went up: Roads, as number 1 of 1.
    assert.deepEqual(puts, ['r1']);
    assert.ok(transfers.every((x) => /^Uploading 1 of 1\b.*Roads/.test(x)), transfers.join(' | '));
    assert.equal(remote.serverSongOf('g1'), 's-glory');
    assert.equal(remote.serverSongOf('t1'), 's-tear');
    assert.equal(remote.serverSongOf('r1'), 'r1');
    await until(() => remote.view().songs.length === 5 && remote.view().deviceSongs.length === 0, 'the view without doubles');
    assert.equal(remote.localFileOf('s-glory'), gloryFile);
    assert.deepEqual(existing, []);
  });

  await t.test('a song that comes here later and is on the server already is tied, not sent', async () => {
    const before = puts.length;
    const file = here('a1', { title: 'Angel', artist: 'Massive Attack', duration: 379 });
    await remote.syncNow();
    await until(() => remote.serverSongOf('a1') === 's-angel', 'tied');
    assert.equal(remote.status().queued, 0);
    assert.equal(puts.length, before);
    assert.equal((await serverSongs()).length, 5);
    assert.equal(remote.localFileOf('s-angel'), file);
  });

  await t.test('one the server has under other names is asked about, without its file going up', async () => {
    const before = puts.length;
    here('u1', { title: 'Unfinished Sympathy (Remastered)', artist: 'Massive Attack', duration: 309, sourceUrl: 'https://example.com/watch?v=unfinished' });
    await remote.syncNow();
    await until(() => existing.length === 1, 'the question about the names');
    assert.equal(existing[0].local.title, 'Unfinished Sympathy (Remastered)');
    assert.equal(existing[0].server.title, 'Unfinished Sympathy');
    await until(() => remote.serverSongOf('u1') === 's-unfin', 'tied');
    await until(() => remote.status().queued === 0, 'the queue sent');
    assert.equal(puts.length, before);
    assert.equal((await serverSongs()).length, 5);
    // The server's names were kept.
    assert.equal((await serverSongs()).find((s) => s.id === 's-unfin').title, 'Unfinished Sympathy');
  });
});
