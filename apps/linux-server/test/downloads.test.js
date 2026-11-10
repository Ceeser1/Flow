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
    const { id } = await batchOf(base);
    await server.close();
    // A server that was killed rather than stopped leaves the half-done file.
    const staging = path.join(d.home, 'staging', '_shared', id);
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
    const profile = async (name) => (await api(base, 'POST', '/api/profiles', { name, pin: '1111', device: name })).json.token;
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
      const file = path.join(server.config.home, 'staging', '_shared', r.json.batch.id, 'cookies.txt');
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
    // Its cover made into the two sizes (4.3.1) right after.
    let song = null;
    for (let i = 0; i < 100 && !(song && song.cover); i += 1) {
      song = (await api(base, 'GET', '/api/library')).json.library.songs.find((s) => s.id === done.json.song.id);
      if (!song.cover) await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(song.cover, /^[0-9a-f]{10}$/);
    const after = await batchOf(base);
    assert.equal(after.items[0].state, 'saved');
    assert.equal(after.items[0].cover, '');
    assert.equal((await fetch(`${base}/api/downloads/items/0/cover`)).status, 404);
  } finally {
    await server.close();
  }
});

test('a song\'s name typed instead of a link is searched for; the upload picked downloads as one song', needsFfmpeg, async () => {
  await withServer(async ({ base }) => {
    assert.ok((await api(base, 'GET', '/api/hello')).json.features.includes('search'));
    const r = await api(base, 'POST', '/api/downloads/search', { query: '  Daft Punk  -  One More Time ' });
    assert.equal(r.status, 200);
    assert.equal(r.json.query, 'Daft Punk - One More Time');
    assert.equal(r.json.artist, 'Daft Punk');
    // The album audio (YouTube Music's, read for its artist) first, the live upload by a fan last.
    assert.deepEqual(r.json.results.map((x) => x.id), ['m1', 's1', 's2']);
    assert.equal(r.json.results[0].album, 'Discovery');
    assert.equal(r.json.results[0].url, 'https://www.youtube.com/watch?v=m1');
    assert.deepEqual(r.json.results[2].versions, ['live']);
    // Nothing is downloaded until one is picked.
    assert.equal(await batchOf(base), null);
    assert.equal((await api(base, 'POST', '/api/downloads/search', { query: '   ' })).status, 400);
    assert.equal((await api(base, 'POST', '/api/downloads/search', { query: 'x'.repeat(201) })).status, 400);
    assert.equal((await api(base, 'POST', '/api/downloads/search', {})).status, 400);

    const picked = await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/m1', kind: 'song' });
    assert.equal(picked.status, 200);
    assert.equal(picked.json.batch.single, true);
  });
  const keep = process.env.FLOW_SERVER_YTDLP;
  process.env.FLOW_SERVER_YTDLP = 'off';
  try {
    await withServer(async ({ base }) => {
      assert.ok(!(await api(base, 'GET', '/api/hello')).json.features.includes('search'));
      assert.equal((await api(base, 'POST', '/api/downloads/search', { query: 'Daft Punk - One More Time' })).status, 501);
    });
  } finally {
    process.env.FLOW_SERVER_YTDLP = keep;
  }
});

test('several uploads picked from a search are one batch, ready at once, saved into All Songs without a playlist', needsFfmpeg, async () => {
  await withServer(async ({ base }) => {
    const pick = (id) => ({ url: `https://fake.test/v/${id}`, title: `Song ${id}`, duration: 3 });
    assert.equal((await api(base, 'POST', '/api/downloads', { items: [] })).status, 400);
    assert.equal((await api(base, 'POST', '/api/downloads', { items: [{ url: 'http://192.168.0.1/x' }] })).status, 400);
    assert.equal((await api(base, 'POST', '/api/downloads', { items: Array.from({ length: 51 }, (_, i) => pick(`p${i}`)) })).status, 400);
    assert.equal(await batchOf(base), null, 'nothing made by the refused ones');

    const r = await api(base, 'POST', '/api/downloads', { items: [pick('a'), pick('b')], name: 'Daft Punk - One More Time' });
    assert.equal(r.status, 200);
    assert.equal(r.json.batch.state, 'ready');
    assert.equal(r.json.batch.single, false);
    assert.deepEqual(r.json.batch.source, { url: '', name: 'Daft Punk - One More Time', kind: 'search' });
    assert.deepEqual(r.json.batch.items.map((x) => x.url), ['https://fake.test/v/a', 'https://fake.test/v/b']);
    const done = await allSettled(base);
    assert.deepEqual(done.items.map((x) => x.state), ['ready', 'ready']);

    const f = await api(base, 'POST', '/api/downloads/items/0/finish', { meta: { artist: 'Daft Punk', title: 'Song a', mix: '' }, start: 0, end: 3, playlist: null });
    assert.equal(f.status, 200);
    assert.equal(f.json.playlistId, null);
    const lib = (await api(base, 'GET', '/api/library')).json.library;
    assert.deepEqual(lib.songs.map((s) => s.title), ['Song a']);
    assert.equal(lib.songs[0].sourcePlaylistUrl || '', '');
    assert.equal(lib.playlists.filter((p) => !p.favourites).length, 0);
    assert.equal(lib.songs[0].file, 'Daft Punk - Song a.wav');
  });
});

test('a playlist\'s Update: its link is checked without a batch, and the songs ticked come back as a batch that keeps it', needsFfmpeg, async () => {
  await withServer(async ({ base }) => {
    assert.ok((await api(base, 'GET', '/api/hello')).json.features.includes('downloadCheck'));
    const fake = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);
    await fetch(`${base}/api/songs/old2?meta=${encodeURIComponent(JSON.stringify({ title: 'Old Two', format: 'mp3', sourceKey: 'youtube:v2' }))}`, { method: 'PUT', body: fake });

    const r = await api(base, 'POST', '/api/downloads/check', { url: 'https://fake.test/list/3' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const l = r.json.listing;
    assert.equal(l.name, 'Fake List');
    assert.equal(l.items.length, 3);
    assert.deepEqual(l.items.map((it) => (it.existing ? it.existing.id : null)), [null, 'old2', null]);
    // Nothing downloaded, no batch.
    assert.equal(await batchOf(base), null);
    assert.equal((await api(base, 'POST', '/api/downloads/check', { url: 'http://192.168.0.1/x' })).status, 400);
    assert.equal((await api(base, 'POST', '/api/downloads/check', { url: 'https://fake.test/fail/x' })).status, 502);

    // The first song and the library's one ticked; the library's needs no link.
    const made = await api(base, 'POST', '/api/downloads', {
      items: [
        { url: l.items[0].url, title: l.items[0].title, duration: 3, key: l.items[0].key, meta: l.items[0].meta },
        { url: '', title: l.items[1].title, existing: 'old2' },
      ],
      name: l.name,
      source: { url: l.sourceUrl, kind: l.source },
    });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.equal(made.json.batch.source.url, l.sourceUrl);
    assert.notEqual(made.json.batch.source.kind, 'search');
    const batch = await allSettled(base);
    assert.deepEqual(batch.items.map((it) => it.state), ['ready', 'library']);
    const done = await api(base, 'POST', '/api/downloads/items/0/finish', {
      meta: { artist: 'Daft Punk', title: 'One' }, start: 0, end: 3, playlist: { name: 'Fake List' }, existing: [1],
    });
    assert.equal(done.json.batch, null);
    assert.deepEqual(await playlistTitles(base, done.json.playlistId), ['One', 'Old Two']);
    const lib = (await api(base, 'GET', '/api/library')).json.library;
    assert.equal(lib.songs.find((s) => s.title === 'One').sourcePlaylistUrl, l.sourceUrl);
    // A song not in the library still needs a link it may download.
    const bad = await api(base, 'POST', '/api/downloads', { items: [{ url: '', title: 'x', existing: 'nope' }], name: 'x', source: { url: l.sourceUrl, kind: 'youtube' } });
    assert.equal(bad.status, 400);
  });
});

test('several links pasted at once: one batch named after the first, each song keeping its own link, one that fails skipped, and the Update reads them all', needsFfmpeg, async () => {
  await withServer(async ({ base }) => {
    const first = 'https://fake.test/list/2?ids=a&name=First';
    const second = 'https://fake.test/list/3?ids=a&name=Second';
    // Spaces around the commas do not count; the second list repeats the first's two songs.
    const pasted = ` ${first} ,https://fake.test/fail/x,   ${second}`;
    const r = await api(base, 'POST', '/api/downloads', { url: pasted, kind: 'list' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const batch = await allSettled(base);
    assert.equal(batch.source.name, 'First');
    assert.equal(batch.source.url, `${first}, https://fake.test/fail/x, ${second}`);
    assert.deepEqual(batch.items.map((it) => it.title), ['Daft Punk - Song a1', 'Daft Punk - Song a2', 'Daft Punk - Song a3']);
    assert.deepEqual(batch.items.map((it) => it.state), ['ready', 'ready', 'ready']);
    assert.equal(batch.truncated, 'links');
    assert.deepEqual(batch.links.map((l) => [l.url, l.name, l.songs, !!l.error]), [
      [first, 'First', 2, false], ['https://fake.test/fail/x', '', 0, true], [second, 'Second', 1, false],
    ]);

    // One song of each list saved into the playlist.
    const one = await api(base, 'POST', '/api/downloads/items/0/finish', { meta: { artist: 'Daft Punk', title: 'A one' }, start: 0, end: 3, playlist: { name: 'First' } });
    assert.equal(one.status, 200, JSON.stringify(one.json));
    const three = await api(base, 'POST', '/api/downloads/items/2/finish', { meta: { artist: 'Daft Punk', title: 'A three' }, start: 0, end: 3, playlist: { name: 'First' } });
    assert.equal(three.status, 200, JSON.stringify(three.json));
    const lib = (await api(base, 'GET', '/api/library')).json.library;
    assert.equal(lib.songs.find((s) => s.title === 'A one').sourcePlaylistUrl, first);
    assert.equal(lib.songs.find((s) => s.title === 'A three').sourcePlaylistUrl, second);
    const list = lib.playlists.find((p) => p.id === one.json.playlistId);
    assert.equal(list.name, 'First');
    assert.equal(list.source.url, batch.source.url);

    // The Update reads every link again as one list.
    const check = await api(base, 'POST', '/api/downloads/check', { url: list.source.url });
    assert.equal(check.status, 200, JSON.stringify(check.json));
    assert.equal(check.json.listing.sourceUrl, list.source.url);
    assert.equal(check.json.listing.items.length, 3);
    assert.deepEqual(check.json.listing.items.map((it) => it.listUrl), [first, first, second]);
    assert.ok(check.json.listing.items[0].existing);
    assert.equal(check.json.listing.links.length, 3);

    // The songs ticked there come back as a batch, each still with its own link.
    await api(base, 'DELETE', '/api/downloads');
    const picked = await api(base, 'POST', '/api/downloads', {
      items: [{ url: check.json.listing.items[1].url, title: 'Daft Punk - Song a2', duration: 3, key: check.json.listing.items[1].key, listUrl: first }],
      name: 'First',
      source: { url: list.source.url, kind: 'youtube' },
    });
    assert.equal(picked.status, 200, JSON.stringify(picked.json));
    await allSettled(base);
    const two = await api(base, 'POST', '/api/downloads/items/0/finish', { meta: { artist: 'Daft Punk', title: 'A two' }, start: 0, end: 3, playlist: { name: 'First', mergeInto: list.id } });
    assert.equal(two.status, 200, JSON.stringify(two.json));
    const after = (await api(base, 'GET', '/api/library')).json.library;
    assert.equal(after.songs.find((s) => s.title === 'A two').sourcePlaylistUrl, first);

    // Links the server would not download from are refused, however many there are.
    assert.equal((await api(base, 'POST', '/api/downloads/check', { url: `${first}, http://192.168.0.1/x` })).status, 400);
    // None of them can be read: that is an error.
    assert.equal((await api(base, 'POST', '/api/downloads/check', { url: 'https://fake.test/fail/x, https://fake.test/fail/y' })).status, 502);
  });
});

test('with separate folders a song the server downloads goes into Downloads/', needsFfmpeg, async () => {
  await withServer(async ({ server, base }) => {
    server.config.set({ separateFolders: true, keepFolders: true });
    await api(base, 'POST', '/api/downloads', { items: [{ url: 'https://fake.test/v/a', title: 'Song a', duration: 3 }], name: 'x' });
    await allSettled(base);
    const f = await api(base, 'POST', '/api/downloads/items/0/finish', { meta: { artist: 'Daft Punk', title: 'Song a', mix: '' }, start: 0, end: 3, playlist: null });
    assert.equal(f.status, 200);
    const lib = (await api(base, 'GET', '/api/library')).json.library;
    assert.equal(lib.songs[0].file, 'Downloads/Daft Punk - Song a.wav');
  });
});

test('a downloaded song gets its album and genre looked up; one left empty is its title; a song from the folder is looked up later', needsFfmpeg, async () => {
  const d = dirs();
  const asked = [];
  const lookupInfo = async (s) => {
    asked.push(s.title);
    return s.title === 'Song a' ? { album: 'Homework', genre: 'House' } : { album: '', genre: 'Techno' };
  };
  const server = await startServer({
    home: d.home, music: d.music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null, lookupInfo,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const pick = (id) => ({ url: `https://fake.test/v/${id}`, title: `Song ${id}`, duration: 3 });
    await api(base, 'POST', '/api/downloads', { items: [pick('a'), pick('b'), pick('c')], name: 'Picked' });
    const done = await allSettled(base);
    // What the apps show in the frames before anything is saved.
    assert.deepEqual(done.items.map((x) => [x.meta.album, x.meta.genre]), [['Homework', 'House'], ['', 'Techno'], ['', 'Techno']]);
    const finish = (i, meta) => api(base, 'POST', `/api/downloads/items/${i}/finish`, { meta, start: 0, end: 3, playlist: null });
    // An app from before albums sends none: the ones found; empty: the title.
    assert.equal((await finish(0, { artist: 'Daft Punk', title: 'Song a', mix: '' })).status, 200);
    assert.equal((await finish(1, { artist: 'Daft Punk', title: 'Song b', mix: '', album: '', genre: '' })).status, 200);
    assert.equal((await finish(2, { artist: 'Daft Punk', title: 'Song c', mix: '', album: 'Given', genre: 'Hardstyle', subGenre: 'Melodic' })).status, 200);
    let lib = (await api(base, 'GET', '/api/library')).json.library;
    const info = (title) => {
      const s = lib.songs.find((x) => x.title === title);
      return s && [s.album, s.genre, s.subGenre, s.infoLooked];
    };
    assert.deepEqual(info('Song a'), ['Homework', 'House', '', true]);
    assert.deepEqual(info('Song b'), ['Song b', '', '', true]);
    assert.deepEqual(info('Song c'), ['Given', 'Hardstyle', 'Melodic', true]);

    // A file put into the folder by hand (a WAV: its title tag, no album): looked up in the background.
    const src = lib.songs.find((x) => x.title === 'Song a').file;
    const copy = path.join(d.music, 'Someone - Dropped.wav');
    fs.copyFileSync(path.join(d.music, src), copy);
    const old = (Date.now() - 60000) / 1000;
    fs.utimesSync(copy, old, old);
    asked.length = 0;
    await api(base, 'POST', '/api/rescan');
    await waitFor(async () => {
      lib = (await api(base, 'GET', '/api/library')).json.library;
      const s = lib.songs.find((x) => x.file === 'Someone - Dropped.wav');
      return s && s.infoLooked;
    }, 'the dropped song looked up');
    assert.deepEqual(asked, ['Song a']);
    const dropped = lib.songs.find((x) => x.file === 'Someone - Dropped.wav');
    assert.deepEqual([dropped.album, dropped.genre], ['Homework', 'House']);
  } finally {
    await server.close();
  }
});

// ---- the download queue (4.4) ----

const queueOf = async (base, headers) => (await api(base, 'GET', '/api/downloads?queue=1', undefined, headers)).json;

test('with the queue a profile may queue several batches: they take turns with every profile\'s, each named at once', needsFfmpeg, async () => {
  await withServer(async ({ base }) => {
    assert.ok((await api(base, 'GET', '/api/hello')).json.features.includes('downloadQueue'));
    const profile = async (name) => ({ Authorization: `Bearer ${(await api(base, 'POST', '/api/profiles', { name, pin: '1111', device: name })).json.token}` });
    const a = await profile('Anna');
    const b = await profile('Ben');
    // Its third song downloads forever: once it has started, the next batch has its turn.
    const first = (await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/3?slow=3', kind: 'list', queue: true }, a)).json.batch;
    assert.equal(first.state, 'listing');
    const second = (await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/2?ids=q&name=Second', kind: 'list', queue: true }, a)).json.batch;
    assert.equal(second.state, 'queued');
    assert.equal(second.place, 1);
    const third = (await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/b1', kind: 'song', queue: true }, b)).json.batch;
    assert.equal(third.place, 2);
    // An app from before the queue cannot start a second one, and sees the oldest.
    assert.equal((await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/zz', kind: 'song' }, a)).status, 409);
    assert.equal((await batchOf(base, a)).id, first.id);

    // Named and counted while they wait; every profile sees every line, its own marked.
    const named = await waitFor(async () => {
      const q = await queueOf(base, b);
      const rows = Object.fromEntries(q.queue.map((r) => [r.id, r]));
      return rows[second.id] && rows[second.id].name === 'Second' && rows[third.id] && rows[third.id].name && q;
    }, 'the queued batches named');
    const rows = Object.fromEntries(named.queue.map((r) => [r.id, r]));
    assert.deepEqual([rows[second.id].profileName, rows[second.id].count, rows[second.id].own, rows[second.id].state], ['Anna', 2, false, 'queued']);
    assert.deepEqual([rows[third.id].profileName, rows[third.id].count, rows[third.id].own, rows[third.id].single], ['Ben', 1, true, true]);
    assert.equal(rows[second.id].url, 'https://fake.test/list/2?ids=q&name=Second');
    assert.deepEqual(named.batches.map((x) => x.id), [third.id]);
    // Only a profile's own can be cancelled, or looked into.
    assert.equal((await api(base, 'DELETE', `/api/downloads/${second.id}`, undefined, b)).status, 404);
    assert.equal((await api(base, 'GET', `/api/downloads/${second.id}/items/0/peaks`, undefined, b)).status, 404);

    // The first batch's last song has started: the next one is read meanwhile,
    // its songs waiting for the one download there is (downloadJobs 1).
    await waitFor(async () => {
      const q = await queueOf(base, a);
      const mine = Object.fromEntries(q.batches.map((x) => [x.id, x]));
      return mine[second.id].state === 'ready' && mine[second.id].items.length === 2
        && mine[first.id].items[2].state === 'downloading' && q;
    }, 'the second batch read');
    // The song that never ends thrown away: the rest download.
    assert.equal((await api(base, 'DELETE', `/api/downloads/${first.id}/items/2`, undefined, a)).status, 200);
    await waitFor(async () => {
      const q = await queueOf(base, a);
      const mine = Object.fromEntries(q.batches.map((x) => [x.id, x]));
      return mine[second.id].items.every((it) => it.state === 'ready') && q;
    }, 'the second batch downloaded');
    const ben = await waitFor(async () => {
      const q = await queueOf(base, b);
      return q.batches[0] && q.batches[0].items[0] && q.batches[0].items[0].state === 'ready' && q;
    }, 'the song of the other profile downloaded');
    // A batch whose songs have all come is no longer a line of the queue.
    assert.ok(!ben.queue.some((r) => r.id === third.id));

    // One of them finished by its id, another cancelled: the rest stay.
    const peaks = await api(base, 'GET', `/api/downloads/${second.id}/items/1/peaks`, undefined, a);
    assert.equal(peaks.status, 200);
    const fin = await api(base, 'POST', `/api/downloads/${second.id}/items/0/finish`, { meta: { title: 'Kept' }, start: 0, end: 3 }, a);
    assert.equal(fin.status, 200);
    assert.equal(fin.json.batch.id, second.id);
    assert.equal((await api(base, 'DELETE', `/api/downloads/${first.id}`, undefined, a)).status, 200);
    assert.deepEqual((await queueOf(base, a)).batches.map((x) => x.id), [second.id]);
  });
});

test('a batch asked to finish by itself saves every song as it came, into a playlist named after the list', needsFfmpeg, async () => {
  await withServer(async ({ base, server }) => {
    const auto = { complete: true, finish: true };
    const one = (await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/2?name=Road%20trip', kind: 'list', queue: true, auto })).json.batch;
    // Another list of the same name goes into the same playlist; one of its songs fails.
    const two = (await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/3?ids=r&name=Road%20trip&fail=2', kind: 'list', queue: true, auto })).json.batch;
    const song = (await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/solo', kind: 'song', queue: true, auto })).json.batch;
    const q = await waitFor(async () => {
      const got = await queueOf(base);
      return !got.batches.length && got.done.length === 3 && got;
    }, 'all three finished by themselves', 60000);
    const done = Object.fromEntries(q.done.map((x) => [x.id, x]));
    assert.equal(done[one.id].saved, 2);
    assert.equal(done[two.id].saved, 2);
    assert.equal(done[two.id].failed.length, 1);
    assert.equal(done[one.id].playlistId, done[two.id].playlistId);
    assert.equal(done[song.id].saved, 1);
    assert.equal(done[song.id].playlistId, null);
    const lib = (await api(base, 'GET', '/api/library')).json.library;
    const lists = lib.playlists.filter((p) => p.name.startsWith('Road trip'));
    assert.equal(lists.length, 1);
    assert.equal(lists[0].entries.length, 4);
    assert.equal(lib.songs.length, 5);
    assert.deepEqual(fs.readdirSync(path.join(server.config.home, 'staging')), []);

    // Auto-complete: a single song the library has already is skipped, with or without finishing.
    const again = (await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/solo', kind: 'song', queue: true, auto: { complete: true } })).json.batch;
    const skipped = await waitFor(async () => {
      const got = await queueOf(base);
      return got.done.find((x) => x.id === again.id);
    }, 'the song skipped');
    assert.equal(skipped.skipped, true);
    assert.ok(skipped.existing && skipped.existing.id);
    assert.equal((await api(base, 'GET', '/api/library')).json.library.songs.length, 5);
    // Without auto, a batch waits for its app as before.
    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/v/later', kind: 'song', queue: true });
    const waiting = await allSettled(base);
    assert.equal(waiting.items[0].state, 'ready');
  });
});

test('a list read for an app that chooses its songs waits with its checklist, holds no one up, and downloads only the songs ticked', needsFfmpeg, async () => {
  await withServer(async ({ base }) => {
    const hello = (await api(base, 'GET', '/api/hello')).json;
    assert.ok(hello.features.includes('downloadReview'));
    const list = (await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/3?ids=c&name=Pick%20me', kind: 'list', queue: true, review: true })).json.batch;
    // Named at once by its quick read, though it is read now.
    const named = await waitFor(async () => {
      const got = await queueOf(base);
      const b = got.batches.find((x) => x.id === list.id);
      return b && b.peek && b.peek.name && b;
    }, 'its quick read');
    assert.equal(named.peek.name, 'Pick me');
    const review = await waitFor(async () => {
      const got = await queueOf(base);
      const b = got.batches.find((x) => x.id === list.id);
      return b && b.state === 'review' && b;
    }, 'its checklist');
    assert.equal(review.items.length, 3);
    assert.ok(review.items.every((it) => it.state === 'queued' && it.status === 'ok'));
    // Nothing downloads meanwhile, and the next one is not held up.
    const next = (await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/2?ids=n&name=Next', kind: 'list', queue: true })).json.batch;
    const nextDone = await waitFor(async () => {
      const got = await queueOf(base);
      const b = got.batches.find((x) => x.id === next.id);
      return b && b.state === 'ready' && b.items.every((it) => it.state === 'ready') && got;
    }, 'the next batch downloaded', 60000);
    assert.equal(nextDone.batches.find((x) => x.id === list.id).state, 'review');
    // Nothing ticked is refused; the songs ticked download, the others go.
    assert.equal((await api(base, 'POST', `/api/downloads/${list.id}/choose`, { indexes: [] })).status, 400);
    const chosen = (await api(base, 'POST', `/api/downloads/${list.id}/choose`, { indexes: [0, 2] })).json.batch;
    assert.equal(chosen.state, 'ready');
    assert.deepEqual(chosen.items.map((it) => it.index), [0, 2]);
    assert.ok(chosen.items.every((it) => it.status === undefined && it.match === undefined));
    assert.equal((await api(base, 'POST', `/api/downloads/${list.id}/choose`, { indexes: [1] })).status, 409);
    const ready = await waitFor(async () => {
      const got = await queueOf(base);
      const b = got.batches.find((x) => x.id === list.id);
      return b && b.items.every((it) => it.state === 'ready') && b;
    }, 'the songs ticked downloaded', 60000);
    assert.deepEqual(ready.items.map((it) => it.index), [0, 2]);
    // An app that auto-accepts never gets a checklist.
    const auto = (await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/2?ids=a&name=Auto', kind: 'list', queue: true, review: true, auto: { complete: true } })).json.batch;
    const autoReady = await waitFor(async () => {
      const got = await queueOf(base);
      const b = got.batches.find((x) => x.id === auto.id);
      return b && b.state === 'ready' && b;
    }, 'the auto-accepted list read');
    assert.equal(autoReady.items.length, 2);
  });
});

test('a batch kept by a server from before the queue is moved into a folder of its own and stays usable', needsFfmpeg, async () => {
  const d = dirs();
  let { server, base } = await start(d);
  try {
    await api(base, 'POST', '/api/downloads', { url: 'https://fake.test/list/2', kind: 'list' });
    const b = await allSettled(base);
    await server.close();
    // As 4.3 kept it: right in the profile's folder.
    const shared = path.join(d.home, 'staging', '_shared');
    for (const f of fs.readdirSync(path.join(shared, b.id))) fs.renameSync(path.join(shared, b.id, f), path.join(shared, f));
    fs.rmdirSync(path.join(shared, b.id));
    ({ server, base } = await start(d));
    const again = await batchOf(base);
    assert.equal(again.id, b.id);
    assert.deepEqual(again.items.map((it) => it.state), ['ready', 'ready']);
    assert.ok(fs.existsSync(path.join(shared, b.id, 'batch.json')));
    assert.ok(!fs.existsSync(path.join(shared, 'batch.json')));
    assert.equal((await api(base, 'GET', '/api/downloads/items/1/peaks')).status, 200);
    assert.equal((await api(base, 'GET', `/api/downloads/${b.id}/items/1/peaks`)).status, 200);
  } finally {
    await server.close();
  }
});
