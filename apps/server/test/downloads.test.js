'use strict';

// Downloads by the server (downloads.js), with a fake yt-dlp and real
// ffmpeg: the songs are made up, the audio, its conversion, cut and waveform
// are not. The fake is testing/fake-yt-dlp.js, outside test/ so node --test
// does not run it as a test. Without ffmpeg on the PATH (or beside the
// desktop app) only the first test runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer } = require('../src/server');

const EXE = process.platform === 'win32' ? '.exe' : '';
const FAKE = path.join(__dirname, '..', 'testing', 'fake-yt-dlp.js');

function ffmpegDir() {
  const bundled = path.join(__dirname, '..', '..', 'desktop', 'tools');
  if (fs.existsSync(path.join(bundled, `ffmpeg${EXE}`)) && fs.existsSync(path.join(bundled, `ffprobe${EXE}`))) return bundled;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, `ffmpeg${EXE}`)) && fs.existsSync(path.join(dir, `ffprobe${EXE}`))) return dir;
  }
  return null;
}

const tools = ffmpegDir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dl-test-'));
// Windows: a fake yt-dlp just killed may still hold a file in it for a moment.
test.after(() => fs.rmSync(scratch, {
  recursive: true, force: true, maxRetries: 10, retryDelay: 200,
}));

process.env.FLOW_SERVER_YTDLP = FAKE;
process.env.FLOW_SERVER_FFMPEG = tools || 'off';
process.env.FAKE_YTDLP_PIDS = path.join(scratch, 'pids.txt');
if (tools) {
  process.env.FAKE_YTDLP_AUDIO = path.join(scratch, 'tone.wav');
  execFileSync(path.join(tools, `ffmpeg${EXE}`), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', process.env.FAKE_YTDLP_AUDIO]);
}
const needsFfmpeg = { skip: !tools && 'no ffmpeg' };

let dirNo = 0;
function dirs() {
  dirNo += 1;
  const root = path.join(scratch, `s${dirNo}`);
  return { root, home: path.join(root, 'home'), music: path.join(root, 'music') };
}

async function start(d) {
  const server = await startServer({ home: d.home, music: d.music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

async function withServer(fn) {
  const d = dirs();
  const { server, base } = await start(d);
  try {
    await fn({ server, base, dirs: d });
  } finally {
    await server.close();
  }
}

async function api(base, method, p, body, headers = {}) {
  const r = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

async function waitFor(fn, what, ms = 20000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const batchOf = async (base, headers) => (await api(base, 'GET', '/api/downloads', undefined, headers)).json.batch;
const allSettled = (base, headers) => waitFor(async () => {
  const b = await batchOf(base, headers);
  return b && b.state === 'ready' && b.items.every((it) => !['queued', 'downloading', 'converting'].includes(it.state)) && b;
}, 'the downloads');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A playlist's titles as the apps show it: newest first. */
async function playlistTitles(base, playlistId, headers) {
  const lib = (await api(base, 'GET', '/api/library', undefined, headers)).json.library;
  const p = lib.playlists.find((x) => x.id === playlistId);
  return [...p.entries].sort((a, b) => b.addedAt - a.addedAt).map((e) => lib.songs.find((s) => s.id === e.songId).title);
}

test('downloading is offered only with yt-dlp and ffmpeg', async () => {
  const keep = process.env.FLOW_SERVER_YTDLP;
  process.env.FLOW_SERVER_YTDLP = 'off';
  try {
    await withServer(async ({ base }) => {
      const hello = (await api(base, 'GET', '/api/hello')).json;
      assert.ok(!hello.features.includes('download'));
      const r = await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/a' });
      assert.equal(r.status, 501);
    });
  } finally {
    process.env.FLOW_SERVER_YTDLP = keep;
  }
  if (!tools) return;
  await withServer(async ({ base }) => {
    assert.ok((await api(base, 'GET', '/api/hello')).json.features.includes('download'));
  });
});

test('a playlist is read, downloaded in the background, and its songs can be heard and drawn', needsFfmpeg, async () => {
  await withServer(async ({ base, dirs: d }) => {
    const made = await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/3', kind: 'list', options: { alwaysMp3: true, quality: 128 } });
    assert.equal(made.status, 200);
    assert.equal(made.json.batch.state, 'listing');
    assert.equal((await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/zz' })).status, 409);

    const batch = await allSettled(base);
    assert.equal(batch.source.name, 'Fake List');
    assert.deepEqual(batch.items.map((it) => it.state), ['ready', 'ready', 'ready']);
    assert.equal(batch.items[0].meta.artist, 'Daft Punk');
    assert.match(batch.items[0].summary, /MP3 128/);
    // Nothing of it is in the library or the music folder yet.
    assert.equal((await api(base, 'GET', '/api/library')).json.library.songs.length, 0);
    assert.deepEqual(fs.readdirSync(d.music).filter((f) => !f.startsWith('.')), []);

    const peaks = (await api(base, 'GET', '/api/downloads/items/1/peaks')).json.peaks;
    assert.ok(peaks.length > 100);
    const part = await fetch(`${base}/api/downloads/items/1/audio`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
  });
});

test('songs finished in any order go into the playlist in the source\'s order, which is made once', needsFfmpeg, async () => {
  await withServer(async ({ base }) => {
    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/8', kind: 'list' });
    await allSettled(base);
    const finish = (i, extra = {}) => api(base, 'POST', `/api/downloads/items/${i}/finish`, {
      meta: { artist: 'Daft Punk', title: `Song v${i + 1}`, mix: '' }, start: 0, end: 3, playlist: { name: 'Homework' }, ...extra,
    });
    // 7 and 2 at the same moment (two devices), then 5, with a cut.
    const [a, b] = await Promise.all([finish(7), finish(2)]);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(b.status, 200, JSON.stringify(b.json));
    const c = await finish(5, { start: 1, end: 2.5 });
    const batch = c.json.batch;
    assert.equal((await api(base, 'POST', '/api/downloads/items/5/finish', { meta: { title: 'x' }, start: 0, end: 3 })).status, 409);

    const lib = (await api(base, 'GET', '/api/library')).json.library;
    assert.equal(lib.playlists.filter((p) => p.name.startsWith('Homework')).length, 1);
    assert.deepEqual(await playlistTitles(base, batch.playlistId), ['Song v3', 'Song v6', 'Song v8']);
    const cut = lib.songs.find((s) => s.title === 'Song v6');
    assert.ok(Math.abs(cut.duration - 1.5) < 0.2, `cut to 1.5 s, got ${cut.duration}`);
    assert.equal(lib.songs.length, 3);
    assert.equal(batch.items.filter((it) => it.state === 'saved').length, 3);
  });
});

test('a song the library has is not downloaded again, and goes into the playlist at its place', needsFfmpeg, async () => {
  await withServer(async ({ base, server }) => {
    // v2 is in the library already, by its source.
    const fake = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);
    await fetch(`${base}/api/songs/old2?meta=${encodeURIComponent(JSON.stringify({ title: 'Old Two', format: 'mp3', sourceKey: 'youtube:v2' }))}`, { method: 'PUT', body: fake });
    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/3', kind: 'list' });
    let batch = await allSettled(base);
    assert.deepEqual(batch.items.map((it) => it.state), ['ready', 'library', 'ready']);
    await api(base, 'POST', '/api/downloads/items/2/finish', {
      meta: { title: 'Three' }, start: 0, end: 3, playlist: { name: 'Mixed' }, existing: [1],
    });
    const done = await api(base, 'POST', '/api/downloads/items/0/finish', { meta: { title: 'One' }, start: 0, end: 3, playlist: { name: 'Mixed' } });
    // Every song dealt with: the batch is over, and its folder gone.
    assert.equal(done.json.batch, null);
    assert.equal(await batchOf(base), null);
    const pl = (await api(base, 'GET', '/api/library')).json.library.playlists.find((p) => p.name === 'Mixed');
    assert.deepEqual(await playlistTitles(base, pl.id), ['One', 'Old Two', 'Three']);
    assert.deepEqual(fs.readdirSync(path.join(server.config.home, 'staging')), []);
  });
});

test('a failed song can be tried again or thrown away', needsFfmpeg, async () => {
  await withServer(async ({ base }) => {
    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/fail/x', kind: 'song' });
    const failed = await waitFor(async () => {
      const b = await batchOf(base);
      return b && (b.state === 'failed' || b.items.some((it) => it.state === 'failed')) && b;
    }, 'the failure');
    // One song that cannot even be read: the batch says why.
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /not available/);
    assert.equal((await api(base, 'DELETE', '/api/downloads')).status, 200);
    assert.equal(await batchOf(base), null);

    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/2?fail=2', kind: 'list' });
    let b = await allSettled(base);
    assert.deepEqual(b.items.map((it) => it.state), ['ready', 'failed']);
    assert.match(b.items[1].error, /not available/);
    assert.equal((await api(base, 'POST', '/api/downloads/items/0/retry')).status, 409);
    const again = await api(base, 'POST', '/api/downloads/items/1/retry');
    assert.ok(['queued', 'downloading'].includes(again.json.batch.items[1].state));
    b = await allSettled(base);
    assert.equal(b.items[1].state, 'failed', 'still not available');
    // Throwing away the one left to do ends the batch (a failed song does not hold it).
    const gone = await api(base, 'DELETE', '/api/downloads/items/0');
    assert.equal(gone.json.batch, null);
  });
});

test('Cancel stops the download at once and leaves nothing behind', needsFfmpeg, async () => {
  await withServer(async ({ base, server }) => {
    fs.writeFileSync(process.env.FAKE_YTDLP_PIDS, '');
    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/slow/s1', kind: 'song' });
    await waitFor(async () => {
      const b = await batchOf(base);
      return b && b.items[0] && b.items[0].state === 'downloading' && b.items[0].progress && b.items[0].progress.frac;
    }, 'the download to start');
    const pid = Number(fs.readFileSync(process.env.FAKE_YTDLP_PIDS, 'utf8').trim().split('\n').pop());
    assert.ok(alive(pid));
    assert.equal((await api(base, 'DELETE', '/api/downloads')).status, 200);
    await waitFor(() => !alive(pid), 'yt-dlp to be stopped', 5000);
    assert.equal(await batchOf(base), null);
    assert.deepEqual(fs.readdirSync(path.join(server.config.home, 'staging')), []);
  });
});

test('after a restart the batch is still there, and a cut-off download starts over', needsFfmpeg, async () => {
  const d = dirs();
  let { server, base } = await start(d);
  try {
    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/2?slow=2', kind: 'list' });
    await waitFor(async () => {
      const b = await batchOf(base);
      return b && b.items.length && b.items[0].state === 'ready' && b.items[1].state === 'downloading';
    }, 'song 1 ready, song 2 downloading');
    await server.close();
    // A server that was killed rather than stopped leaves the half-done file.
    const staging = path.join(d.home, 'staging', '_shared');
    const partial = path.join(staging, 'i1_youtube_v2.src.wav.part');
    fs.writeFileSync(partial, 'half');

    ({ server, base } = await start(d));
    const b = await batchOf(base);
    assert.equal(b.items[0].state, 'ready');
    assert.ok(['queued', 'downloading'].includes(b.items[1].state));
    assert.ok(!fs.existsSync(partial) || fs.readFileSync(partial, 'utf8') !== 'half', 'the half-done file was cleaned up');
    assert.equal((await api(base, 'GET', '/api/downloads/items/0/peaks')).status, 200);
  } finally {
    await server.close();
  }
});

test('a batch nobody looks at expires, and each profile sees only its own', needsFfmpeg, async () => {
  await withServer(async ({ base, server }) => {
    const profile = async (name) => (await api(base, 'POST', '/api/profiles', { name, device: name })).json.token;
    const a = { Authorization: `Bearer ${await profile('Anna')}` };
    const b = { Authorization: `Bearer ${await profile('Ben')}` };
    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/a1', kind: 'song' }, a);
    await allSettled(base, a);
    assert.equal(await batchOf(base, b), null);
    assert.equal(await batchOf(base), null);
    assert.equal((await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/b1', kind: 'song' }, b)).status, 200);
    await allSettled(base, b);
    assert.equal((await fetch(`${base}/api/downloads/items/0/audio`, { headers: b })).status, 200);
    assert.equal((await fetch(`${base}/api/downloads/items/0/audio`, { headers: a })).status, 200);
    // A song finished is the profile's that had it downloaded.
    const done = await api(base, 'POST', '/api/downloads/items/0/finish', { meta: { title: 'Mine' }, start: 0, end: 3 }, b);
    assert.equal(done.status, 200);
    assert.equal(server.library.data.songs.find((s) => s.id === done.json.song.id).addedBy, server.config.get().profiles.find((p) => p.name === 'Ben').id);

    server.downloads.expire(Date.now() + 31 * 24 * 60 * 60 * 1000);
    assert.equal(await batchOf(base, a), null);
    assert.equal(await batchOf(base, b), null);

    // A deleted profile's batch goes with it.
    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/a2', kind: 'song' }, a);
    await allSettled(base, a);
    await api(base, 'POST', '/api/profiles/delete', {}, a);
    assert.deepEqual(fs.readdirSync(path.join(server.config.home, 'staging')), []);
  });
});

test('only links to the internet are downloaded, never this machine or the home network', () => {
  const { checkLink } = require('../src/downloads');
  for (const bad of ['http://127.0.0.1/x', 'http://localhost:7878/api/library', 'http://192.168.0.1/', 'http://10.0.0.5/a',
    'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://2130706433/', 'http://router.local/', 'http://nas/',
    'file:///etc/passwd', 'ftp://example.com/a.mp3', 'https://user:pass@example.com/x', 'http://100.101.102.103/']) {
    assert.throws(() => checkLink(bad), (err) => err.status === 400, bad);
  }
  assert.equal(checkLink('youtube.com/watch?v=abc'), 'https://youtube.com/watch?v=abc');
  assert.equal(checkLink('https://soundcloud.com/a/b'), 'https://soundcloud.com/a/b');
  assert.equal(checkLink('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
});

test('downloads turned off stay off, with yt-dlp and ffmpeg there', needsFfmpeg, async () => {
  await withServer(async ({ base, server }) => {
    server.config.set({ downloads: false });
    assert.ok(!(await api(base, 'GET', '/api/hello')).json.features.includes('download'));
    const r = await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/a', kind: 'song' });
    assert.equal(r.status, 501);
    assert.match(r.json.error, /turned off/);
    server.config.set({ downloads: true });
    assert.ok((await api(base, 'GET', '/api/hello')).json.features.includes('download'));
  });
});

test('browser cookies sent along reach every yt-dlp run of that download, only the site\'s, and go with it', needsFfmpeg, async () => {
  await withServer(async ({ base, server }) => {
    const log = path.join(scratch, 'args.txt');
    fs.writeFileSync(log, '');
    process.env.FAKE_YTDLP_ARGS = log;
    // The cover's search on YouTube Music is another site's: not the download's.
    const runs = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((run) => !run.args.some((a) => a.includes('music.youtube.com')));
    try {
      const jar = [
        '# Netscape HTTP Cookie File',
        '.fake.test\tTRUE\t/\tTRUE\t0\tSID\tsecret',
        '#HttpOnly_www.fake.test\tFALSE\t/\tTRUE\t0\tHID\thidden',
        '.example.org\tTRUE\t/\tTRUE\t0\tother\tnot-for-this-site',
      ].join('\n');
      const r = await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/2', kind: 'list', cookies: jar });
      assert.equal(r.status, 200);
      assert.equal(r.json.batch.cookies, true);
      await allSettled(base);
      // The listing, and a probe and a download per song.
      assert.ok(runs().length >= 5, `${runs().length} runs`);
      for (const run of runs()) {
        assert.ok(run.args.includes('--cookies'));
        assert.match(run.cookies, /SID\tsecret/);
        assert.match(run.cookies, /HID\thidden/);
        assert.doesNotMatch(run.cookies, /example\.org/);
      }
      const file = path.join(server.config.home, 'staging', '_shared', 'cookies.txt');
      assert.ok(fs.existsSync(file));
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal((await api(base, 'DELETE', '/api/downloads')).status, 200);
      assert.ok(!fs.existsSync(file), 'gone with the batch');

      // None sent, none used; none of the site's: none kept.
      fs.writeFileSync(log, '');
      await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/plain', kind: 'song' });
      await allSettled(base);
      assert.ok(runs().every((run) => !run.args.includes('--cookies')));
      await api(base, 'DELETE', '/api/downloads');
      const other = await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/other', kind: 'song', cookies: '.example.org\tTRUE\t/\tTRUE\t0\ta\tb' });
      assert.equal(other.json.batch.cookies, false);
      await api(base, 'DELETE', '/api/downloads');
      assert.equal((await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/x', kind: 'song', cookies: 12 })).status, 400);
      assert.equal((await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/x', kind: 'song', cookies: 'x'.repeat(300 * 1024) })).status, 400);
    } finally {
      delete process.env.FAKE_YTDLP_ARGS;
    }
  });
});

test('a downloaded song\'s cover is looked for at once: shown while it waits, the song\'s when finished', needsFfmpeg, async () => {
  const d = dirs();
  const topic = path.join(scratch, 'topic.jpg');
  execFileSync(path.join(tools, `ffmpeg${EXE}`), ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=0x3c3526:s=1280x720[bg];testsrc=s=720x720[fg];[bg][fg]overlay=280:0', '-frames:v', '1', topic]);
  // YouTube Music's search finds the song; its thumbnail is the picture above.
  const coverDeps = {
    fetchImage: async () => fs.readFileSync(topic),
    readInfo: async () => { throw new Error('not available'); },
    searchMusic: async (track) => [{ id: 'CCCCCCCCCCC', title: track.title, duration: track.duration }],
    pauseMs: 0,
  };
  const server = await startServer({
    home: d.home, music: d.music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null, coverDeps,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/2', kind: 'list', options: {} });
    await allSettled(base);
    const batch = await waitFor(async () => {
      const b = await batchOf(base);
      return b.items.every((it) => it.cover) && b;
    }, 'the covers');
    assert.match(batch.items[0].cover, /^[0-9a-f]{10}$/);
    const pic = await fetch(`${base}/api/downloads/items/0/cover?v=${batch.items[0].cover}`);
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get('content-type'), 'image/jpeg');
    assert.equal(pic.headers.get('etag'), `"${batch.items[0].cover}"`);
    assert.equal((await fetch(`${base}/api/downloads/items/5/cover`)).status, 404);

    const done = await api(base, 'POST', '/api/downloads/items/0/finish', { meta: { title: 'One' }, start: 0, end: 3 });
    assert.equal(done.status, 200);
    const song = (await api(base, 'GET', '/api/library')).json.library.songs.find((s) => s.id === done.json.song.id);
    assert.equal(song.cover, batch.items[0].cover);
    const after = await batchOf(base);
    assert.equal(after.items[0].state, 'saved');
    assert.equal(after.items[0].cover, '');
    assert.equal((await fetch(`${base}/api/downloads/items/0/cover`)).status, 404);
  } finally {
    await server.close();
  }
});
