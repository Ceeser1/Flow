'use strict';

// A Flow Server used for the first time while the app still looks through its
// music folder (a first start: Flow installed again, the folder still full):
// the songs that look finds were here before the server, so they are asked
// about once it has ended. Taken up before, they counted as added afterwards
// and all went up without the question.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-firstscan-'));
process.env.FLOW_HOME = path.join(scratch, 'home');
process.env.FLOW_MUSIC = path.join(scratch, 'music');
process.env.FLOW_SERVER_FFMPEG = 'off';

const { startServer } = require('../../linux-server/src/server');
const model = require('@flow/core/libraryModel');
const settings = require('../src/settings');
const library = require('../src/library');
const remote = require('../src/remote');

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1997, 7)]);
let server = null;

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

test.after(async () => {
  remote.stop();
  if (server) await server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('a server connected to while the music folder is still looked through: its songs are asked about after', async () => {
  server = await startServer({
    home: path.join(scratch, 'server', 'home'), music: path.join(scratch, 'server', 'music'), port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const serverSongs = async () => (await (await fetch(`${base}/api/library`)).json()).library.songs;
  const put = await fetch(`${base}/api/songs/s-glory?meta=${encodeURIComponent(JSON.stringify({
    title: 'Glory Box', artist: 'Portishead', duration: 306, format: 'mp3',
  }))}`, { method: 'PUT', body: FAKE_MP3 });
  assert.equal(put.status, 200);

  library.load();
  // As the app starts: the folder will be looked through in a moment.
  library.expectFirstScan();
  assert.ok(library.firstScan());

  const questions = [];
  const transfers = [];
  settings.set({ serverOn: true, serverHome: `127.0.0.1:${server.port}` });
  remote.init({
    confirmUpload: async (q) => {
      questions.push(q);
      return true;
    },
    onStatus: (st) => {
      if (st.transferUp && st.transfer) transfers.push(st.transfer);
    },
  });
  await until(() => remote.status().state === 'online', 'online');

  // The look finds two songs: one the server has, one it lacks.
  fs.mkdirSync(process.env.FLOW_MUSIC, { recursive: true });
  for (const [id, title, duration] of [['g1', 'Glory Box', 306], ['r1', 'Roads', 305]]) {
    const file = path.join(process.env.FLOW_MUSIC, `${id}.mp3`);
    fs.writeFileSync(file, FAKE_MP3);
    library.mutate((d) => model.addSong(d, {
      id, file, title, artist: 'Portishead', mix: '', duration, format: 'mp3', addedAt: Date.now(),
    }));
  }
  // Until it has ended nothing is asked and nothing goes up.
  await wait(500);
  assert.equal(questions.length, 0);
  assert.equal(remote.status().queued, 0);
  assert.deepEqual(puts, []);
  assert.equal((await serverSongs()).length, 1);

  // It ends: asked about the one song the server lacks, which then goes up.
  await library.scan();
  assert.equal(library.firstScan(), null);
  await until(() => questions.length === 1, 'the question');
  assert.equal(questions[0].count, 1);
  assert.equal(questions[0].known, 1);
  await until(async () => (await serverSongs()).length === 2, 'the upload');
  await until(() => remote.status().queued === 0 && !remote.status().transfer, 'the queue sent');
  assert.deepEqual(puts, ['r1']);
  assert.ok(transfers.every((x) => /^Uploading 1 of 1\b.*Roads/.test(x)), transfers.join(' | '));
  assert.equal(remote.serverSongOf('g1'), 's-glory');
  assert.equal(remote.serverSongOf('r1'), 'r1');
});
