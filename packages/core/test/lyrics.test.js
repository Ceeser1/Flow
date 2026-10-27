'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lyrics = require('../src/lyrics');
const { createLyricsClient } = require('../src/client/lyrics');
const { createLyricsFolder } = require('../src/client/lyricsFolder');

// A failed lookup's tries (RETRY) without the 51 s between them.
lyrics.RETRY.unitMs = 0;

const LRC = '[ar: Moby]\n[00:12.50]In my dreams I\'m dying all the time\n[00:20.01][01:40.5]As I wake\n[00:30.00]\n\nno time here';

test('LRC lines with their times, and the line playing', () => {
  const lines = lyrics.parseLrc(LRC);
  assert.deepEqual(lines, [
    { t: 12.5, text: 'In my dreams I\'m dying all the time' },
    { t: 20.01, text: 'As I wake' },
    { t: 30, text: '' },
    { t: 100.5, text: 'As I wake' },
  ]);
  assert.equal(lyrics.lineAt(lines, 5), -1);
  assert.equal(lyrics.lineAt(lines, 12.5), 0);
  assert.equal(lyrics.lineAt(lines, 25), 1);
  assert.equal(lyrics.lineAt(lines, 99), 2);
  assert.equal(lyrics.lineAt(lines, 500), 3);
  assert.equal(lyrics.lineAt([], 3), -1);
});

test('a record kept: lines in step only when the lengths match', () => {
  const r = { syncedLyrics: LRC, plainLyrics: 'In my dreams\nAs I wake', duration: 239, instrumental: false };
  assert.equal(lyrics.fromRecord(r, 241).synced.length, 4);
  const other = lyrics.fromRecord(r, 262);
  assert.equal(other.synced, null, 'a longer version: out of step');
  assert.equal(other.plain, 'In my dreams\nAs I wake');
  assert.equal(lyrics.fromRecord({ instrumental: true, duration: 200 }, 200).instrumental, true);
  assert.equal(lyrics.fromRecord({ plainLyrics: '', syncedLyrics: '' }, 0).found, false);
  // Only times: the plain text from the lines.
  assert.equal(lyrics.fromRecord({ syncedLyrics: '[00:01.00]One\n[00:02.00]Two', duration: 10 }, 10).plain, 'One\nTwo');
});

test('the search result that fits: the same title, an artist in common, the length closest', () => {
  const results = [
    { trackName: 'Teardrop', artistName: 'Massive Attack', duration: 400, plainLyrics: 'live' },
    { trackName: 'Teardrop', artistName: 'Some Cover Band', duration: 330, plainLyrics: 'cover' },
    { trackName: 'Teardrop', artistName: 'Massive Attack', duration: 331, plainLyrics: 'album' },
    { trackName: 'Teardrop', artistName: 'Massive Attack', duration: 329, plainLyrics: 'synced', syncedLyrics: '[00:01.00]x' },
    { trackName: 'Angel', artistName: 'Massive Attack', duration: 330, plainLyrics: 'other song' },
  ];
  assert.equal(lyrics.pick(results, { artist: 'Massive Attack', title: 'Teardrop', duration: 330 }).plainLyrics, 'synced');
  assert.equal(lyrics.pick(results.slice(0, 3), { artist: 'Massive Attack, Elizabeth Fraser', title: 'Teardrop', duration: 330 }).plainLyrics, 'album');
  assert.equal(lyrics.pick(results, { artist: 'Moby', title: 'Teardrop', duration: 330 }), null);
  assert.equal(lyrics.firstArtist('Broiler, Tessa Odden'), 'Broiler');
  assert.equal(lyrics.firstArtist('Calvin Harris feat. Rihanna'), 'Calvin Harris');
});

function fakeFetch(routes, asked = []) {
  return async (url, opts) => {
    asked.push({ url, agent: opts.headers['User-Agent'] || '' });
    const u = new URL(url);
    const key = `${u.pathname.split('/').pop()}?${[...u.searchParams.entries()].map(([k, v]) => `${k}=${v}`).join('&')}`;
    if (routes.down) throw new TypeError('fetch failed');
    const body = routes[key];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
}

test('a lookup: LRCLIB\'s search, then the first artist alone', async () => {
  const asked = [];
  const exact = {
    'search?track_name=Porcelain&artist_name=Moby': [{ trackName: 'Porcelain', artistName: 'Moby', duration: 239, syncedLyrics: LRC, plainLyrics: 'x' }],
  };
  const r = await lyrics.lookupLyrics({ artist: 'Moby', title: 'Porcelain', duration: 241 }, { fetch: fakeFetch(exact, asked) });
  assert.equal(r.found, true);
  assert.equal(r.synced[0].t, 12.5);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].agent, 'Flow Client');

  const searched = {
    'search?track_name=Teardrop&artist_name=Massive Attack': [],
    'search?track_name=Teardrop&artist_name=Massive Attack, Elizabeth Fraser': [],
  };
  const firstOnly = fakeFetch({ ...searched, 'search?track_name=Teardrop&artist_name=Massive Attack': [{ trackName: 'Teardrop', artistName: 'Massive Attack', duration: 330, plainLyrics: 'Love, love is a verb' }] }, []);
  const r2 = await lyrics.lookupLyrics({ artist: 'Massive Attack, Elizabeth Fraser', title: 'Teardrop', duration: 331 }, { fetch: firstOnly, agent: false });
  assert.equal(r2.plain, 'Love, love is a verb');
  assert.deepEqual(await lyrics.lookupLyrics({ artist: 'Nobody', title: 'Nothing', duration: 10 }, { fetch: fakeFetch({}) }), lyrics.NONE);
  await assert.rejects(() => lyrics.lookupLyrics({ artist: 'Moby', title: 'Porcelain', duration: 241 }, { fetch: fakeFetch({ down: true }) }));
});

test('a failed lookup tried again: nine times over 51 s, until one answers in full', async () => {
  const song = { artist: 'Moby', title: 'Porcelain', duration: 241 };
  const found = { 'search?track_name=Porcelain&artist_name=Moby': [{ trackName: 'Porcelain', artistName: 'Moby', duration: 241, plainLyrics: 'In my dreams' }] };
  // LRCLIB out of reach twice, then there.
  let calls = 0;
  const flaky = async (url, opts) => {
    calls++;
    return fakeFetch(calls <= 2 ? { down: true } : found)(url, opts);
  };
  assert.equal((await lyrics.lookupLyrics(song, { fetch: flaky })).plain, 'In my dreams');
  assert.equal(calls, 3);
  // Never there: nine tries, then the error; one with tries: 1.
  calls = 0;
  const down = async (url, opts) => {
    calls++;
    return fakeFetch({ down: true })(url, opts);
  };
  await assert.rejects(() => lyrics.lookupLyrics(song, { fetch: down }));
  assert.equal(calls, 9);
  calls = 0;
  await assert.rejects(() => lyrics.lookupLyrics(song, { fetch: down, tries: 1 }));
  assert.equal(calls, 1);
  // Not on LRCLIB, lyrics.ovh out of reach once: asked again.
  const asked = [];
  let ovhDown = 1;
  const ovh = async (url) => {
    asked.push(url);
    if (url.startsWith('https://lrclib.net/')) return { ok: true, status: 200, json: async () => [] };
    if (ovhDown-- > 0) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ lyrics: 'Numb words' }) };
  };
  const r = await lyrics.lookupLyrics({ artist: 'Linkin Park', title: 'Numb', duration: 185 }, { fetch: ovh });
  assert.equal(r.plain, 'Numb words');
  assert.equal(asked.filter((u) => u.includes('lyrics.ovh')).length, 2);
  // Spread out: three tries 3 s apart, three 6 s, three 9 s (a second is 10 ms here).
  lyrics.RETRY.unitMs = 10;
  try {
    const at = [];
    const t0 = Date.now();
    await assert.rejects(() => lyrics.lookupLyrics(song, {
      fetch: async () => {
        at.push(Date.now() - t0);
        throw new TypeError('fetch failed');
      },
    }));
    assert.equal(at.length, 9);
    const want = [30, 30, 60, 60, 60, 90, 90, 90];
    for (let i = 1; i < 9; i++) assert.ok(at[i] - at[i - 1] >= want[i - 1] - 2, `gap ${i}: ${at[i] - at[i - 1]} ms, want ${want[i - 1]}`);
    assert.ok(at[8] >= 500, `all nine over ${at[8]} ms`);
  } finally {
    lyrics.RETRY.unitMs = 0;
  }
});

/** A Lyrics folder in memory: `files` path -> text. */
function memFolder(files = new Map()) {
  const join = (...parts) => parts.join('/');
  const fs = {
    readText: (p) => (files.has(p) ? files.get(p) : null),
    writeText: (p, text) => files.set(p, text),
    list: (dir) => {
      const out = new Map();
      for (const [p, text] of files) {
        if (!p.startsWith(`${dir}/`)) continue;
        const [name, ...rest] = p.slice(dir.length + 1).split('/');
        out.set(name, { name, dir: rest.length > 0, size: rest.length ? 0 : text.length });
      }
      return [...out.values()];
    },
    remove: (p, { recursive = false } = {}) => {
      if (!files.delete(p) && recursive) for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k);
    },
    mkdir: () => {},
  };
  return { files, folder: createLyricsFolder({ dir: () => 'Lyrics', fs, join }) };
}

test('the app\'s lyrics: the server\'s for its songs (a copy kept), its own looked up once and kept', async () => {
  const { files, folder } = memFolder();
  const local = { songs: [{ id: 'l1', artist: 'Moby', title: 'Porcelain', duration: 241 }] };
  const serverView = { songs: [{ id: 's1', artist: 'Moby', title: 'Natural Blues', duration: 250 }], deviceSongs: [{ ...local.songs[0], id: 'dev:l1', localId: 'l1', isDevice: true }] };
  let online = true;
  const remote = {
    active: () => true,
    view: () => serverView,
    serverId: () => 'srv',
    songLyrics: async (id) => (online ? { found: true, synced: null, plain: `server ${id}`, instrumental: false, v: 'st1' } : null),
  };
  const asked = [];
  const fetch = fakeFetch({ 'search?track_name=Porcelain&artist_name=Moby': [{ trackName: 'Porcelain', artistName: 'Moby', duration: 241, plainLyrics: 'own' }] }, asked);
  const client = createLyricsClient({ remote, library: { get: () => local }, folder, fetch });
  assert.equal((await client.get('s1')).plain, 'server s1');
  assert.equal(JSON.parse(files.get('Lyrics/srv/s1.json')).v, 'st1', 'the copy, with its stamp');
  assert.equal((await client.get('dev:l1')).plain, 'own');
  assert.equal((await client.get('dev:l1')).plain, 'own');
  assert.equal(asked.length, 1, 'kept');
  assert.ok(files.has('Lyrics/local/l1.json'));
  // The server out of reach: its copy.
  online = false;
  assert.equal((await client.get('s1')).plain, 'server s1');
  assert.equal(asked.length, 1);
  // A song without a copy: looked up here, none found kept as .none.
  serverView.songs.push({ id: 's2', artist: 'Moby', title: 'Extreme Ways', duration: 200 });
  assert.equal((await client.get('s2')).found, false);
  assert.ok(asked.some((x) => /Extreme/.test(x.url)));
  assert.ok(files.has('Lyrics/srv/s2.none.json'));
  assert.deepEqual(client.stats(), {
    count: 2, none: 1, bytes: [...files.values()].reduce((n, t) => n + t.length, 0), left: 0,
  }, 'the .none one counted apart');
  // LRCLIB never answering: none found, kept an hour (partial), and so for a song looked up by its names.
  const down = memFolder();
  const downClient = createLyricsClient({ remote, library: { get: () => local }, folder: down.folder, fetch: fakeFetch({ down: true }) });
  assert.deepEqual(await downClient.get('s1'), lyrics.NONE);
  assert.equal(JSON.parse(down.files.get('Lyrics/srv/s1.none.json')).partial, true);
  assert.deepEqual(await downClient.lookup({ artist: 'Moby', title: 'Porcelain', duration: 241 }), lyrics.NONE);
  await assert.rejects(() => client.get('nope'), /not here/);
});

test('Fetch/Sync Lyrics off: nothing looked up or synchronized; the server still asked for the song playing, nothing kept', async () => {
  const { files, folder } = memFolder();
  const local = { songs: [{ id: 'l1', artist: 'Moby', title: 'Porcelain', duration: 241 }, { id: 'l2', artist: 'Moby', title: 'Natural Blues', duration: 250 }] };
  let on = true;
  let serverAsked = 0;
  let indexAsked = 0;
  let serverHas = { found: true, synced: null, plain: 'from the server', instrumental: false, v: 'a' };
  const remote = {
    active: () => true,
    view: () => ({ songs: [{ id: 's1', artist: 'Moby', title: 'Bodyrock', duration: 220 }], deviceSongs: [] }),
    serverId: () => 'srv',
    songLyrics: async () => {
      serverAsked += 1;
      return serverHas;
    },
    lyricsIndex: async () => {
      indexAsked += 1;
      return { serverId: 'srv', songs: {} };
    },
  };
  const asked = [];
  const fetch = fakeFetch({ 'search?track_name=Porcelain&artist_name=Moby': [{ trackName: 'Porcelain', artistName: 'Moby', duration: 241, plainLyrics: 'words' }] }, asked);
  const client = createLyricsClient({ remote, library: { get: () => local }, folder, fetch, fetchOn: () => on });
  await client.get('l1');
  await client.get('s1');
  on = false;
  const before = asked.length;
  assert.equal((await client.get('l1')).plain, 'words', 'kept');
  serverHas = { ...lyrics.ownLyrics([{ t: null, text: 'Written on the server' }]), v: 'b' };
  assert.equal((await client.get('s1')).plain, 'Written on the server', 'asked of the server');
  assert.equal(JSON.parse(files.get('Lyrics/srv/s1.json')).plain, 'from the server', 'no new copy kept');
  serverHas = null;
  assert.equal((await client.get('s1')).plain, 'from the server', 'the server out of reach: the copy');
  assert.equal((await client.get('l2')).found, false);
  assert.equal((await client.get({ id: 'x', artist: 'Moby', title: 'Why Does My Heart' })).found, false);
  assert.equal((await client.lookup({ artist: 'Moby', title: 'Porcelain', duration: 241 })).found, false);
  await client.sync();
  assert.equal(asked.length, before, 'nothing looked up');
  assert.equal(serverAsked, 3, 'the server asked for the song each time');
  assert.equal(indexAsked, 0, 'nothing synchronized');
  assert.ok(!files.has('Lyrics/local/l2.none.json'));
  // Written by hand still works.
  assert.equal((await client.set('l2', [{ t: null, end: null, text: 'Mine' }])).plain, 'Mine');
});

test('not on LRCLIB: lyrics.ovh\'s words, without times; kept answers from fewer sources asked again', async () => {
  const ovh = (routes, asked = []) => async (url, opts) => {
    asked.push(url);
    if (url.startsWith('https://lrclib.net/')) return { ok: true, status: 200, json: async () => [] };
    if (routes.down) return { ok: false, status: 503, json: async () => ({}) };
    const body = routes[decodeURIComponent(new URL(url).pathname.replace('/v1/', ''))];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
  const words = { lyrics: 'Paroles de la chanson Numb par Linkin Park\r\n[Chester Bennington]\r\nI\'m tired of being what you want me to be\r\n\r\n\r\n\r\n[Chorus]\r\nI\'ve become so numb' };
  const asked = [];
  const r = await lyrics.lookupLyrics({ artist: 'Linkin Park, Jay-Z', title: 'Numb', duration: 185 }, { fetch: ovh({ 'Linkin Park/Numb': words }, asked) });
  assert.deepEqual(r, {
    found: true, synced: null, plain: 'I\'m tired of being what you want me to be\n\nI\'ve become so numb', instrumental: false, source: 'lyrics.ovh',
  });
  assert.equal(asked.filter((u) => u.includes('lyrics.ovh')).length, 2, 'the whole artist, then the first');
  assert.equal(lyrics.clean(r).source, 'lyrics.ovh');
  assert.deepEqual(await lyrics.lookupLyrics({ artist: 'Nobody', title: 'Nothing' }, { fetch: ovh({}) }), lyrics.NONE);
  const partial = await lyrics.lookupLyrics({ artist: 'Nobody', title: 'Nothing' }, { fetch: ovh({ down: true }) });
  assert.equal(partial.found, false);
  assert.equal(partial.partial, true);

  const song = { artist: 'Nobody', title: 'Nothing', duration: 100 };
  const now = Date.now();
  const none = lyrics.toKeep(lyrics.NONE, song, now);
  assert.equal(lyrics.stillGood(none, song, now + 1000), true);
  assert.equal(lyrics.settled(none, song), true);
  // From before lyrics.ovh (LRCLIB only): looked up again.
  const old = { ...lyrics.NONE, key: lyrics.lyricsKey(song), at: now };
  assert.equal(lyrics.stillGood(old, song, now + 1000), false);
  assert.equal(lyrics.settled(old, song), false);
  assert.equal(lyrics.settled({ ...old, found: true, plain: 'x' }, song), true);
  // lyrics.ovh out of reach: again after an hour, and by the filler at the next start.
  const half = lyrics.toKeep(partial, song, now);
  assert.equal(lyrics.stillGood(half, song, now + 1000), true);
  assert.equal(lyrics.stillGood(half, song, now + lyrics.PARTIAL_RETRY_MS + 1), false);
  assert.equal(lyrics.settled(half, song), false);
  assert.equal(lyrics.clean({ found: true, plain: 'x' }).source, 'LRCLIB', 'kept before sources were named');
});

test('own lyrics (4.0.1): every line timed or none, ends kept, never looked up again', () => {
  const own = lyrics.ownLyrics([
    { t: 20, end: 24.5, text: 'As I wake' },
    { t: 12.5, end: null, text: ' In my dreams ' },
    { t: 16, end: 15, text: '' },
    { t: null, end: null, text: '' },
  ]);
  assert.deepEqual(own.synced, [{ t: 12.5, text: 'In my dreams' }, { t: 16, text: '' }, { t: 20, end: 24.5, text: 'As I wake' }]);
  assert.equal(own.plain, 'In my dreams\n\nAs I wake');
  assert.equal(own.source, 'own');
  assert.equal(own.own, true);
  const words = lyrics.ownLyrics([{ text: '' }, { text: 'Verse one' }, { text: '' }, { text: '' }, { text: '' }, { text: 'Verse two' }]);
  assert.equal(words.synced, null);
  assert.equal(words.plain, 'Verse one\n\nVerse two');
  assert.throws(() => lyrics.ownLyrics([{ t: 1, text: 'a' }, { t: null, text: 'b' }]), /every line/);
  assert.equal(lyrics.ownLyrics([{ t: 1, text: ' ' }]), null);
  assert.equal(lyrics.ownLyrics(null), null);
  const song = { artist: 'Moby', title: 'Porcelain', duration: 241 };
  const kept = lyrics.toKeep(own, song);
  const renamed = { ...song, title: 'Porcelain (Live)', duration: 300 };
  assert.equal(lyrics.stillGood(kept, renamed), true, 'kept, renamed or trimmed');
  assert.equal(lyrics.settled(kept, renamed), true);
  const out = lyrics.clean(kept);
  assert.equal(out.source, 'own');
  assert.equal(out.own, true);
  assert.deepEqual(out.synced[2], { t: 20, end: 24.5, text: 'As I wake' });
  assert.equal(lyrics.clean(lyrics.toKeep({ found: true, plain: 'x', source: 'LRCLIB' }, song)).own, undefined);
});

test('the app\'s own lyrics: a server song\'s on the server, a local one\'s kept for good', async () => {
  const { files, folder } = memFolder();
  const local = { songs: [{ id: 'l1', artist: 'Moby', title: 'Porcelain', duration: 241 }, { id: 'l2', artist: 'Moby', title: 'Bodyrock', duration: 220 }] };
  const sent = [];
  const remote = {
    active: () => true,
    view: () => ({ songs: [{ id: 's1', artist: 'Moby', title: 'Natural Blues', duration: 250 }], deviceSongs: [] }),
    serverId: () => 'srv',
    songLyrics: async () => null,
    setSongLyrics: async (id, lines) => {
      sent.push([id, lines]);
      return { ...lyrics.ownLyrics(lines), v: 'w1' };
    },
  };
  const asked = [];
  const fetch = fakeFetch({}, asked);
  const client = createLyricsClient({ remote, library: { get: () => local }, folder, fetch });
  const lines = [{ t: 1, end: 2, text: 'In my dreams' }];
  assert.equal((await client.set('s1', lines)).source, 'own');
  assert.deepEqual(sent, [['s1', lines]]);
  assert.equal(JSON.parse(files.get('Lyrics/srv/s1.json')).v, 'w1', 'a copy here');
  await client.set('new1', lines, { server: true });
  assert.equal(sent[1][0], 'new1', 'a song the server just saved');
  // Local Files: kept, renamed or not, and given back as lines for the upload.
  const saved = await client.set('l1', lines);
  assert.deepEqual(saved.synced, [{ t: 1, end: 2, text: 'In my dreams' }]);
  local.songs[0].title = 'Porcelain (Live)';
  assert.equal((await client.get('l1')).own, true);
  assert.equal(asked.length, 0, 'never looked up');
  assert.deepEqual(client.ownLines('l1'), [{ t: 1, end: 2, text: 'In my dreams' }]);
  assert.equal(client.ownLines('nope'), null);
  client.keepOwn('l2', [{ t: null, end: null, text: 'Words only' }]);
  assert.deepEqual(client.ownLines('l2'), [{ t: null, end: null, text: 'Words only' }]);
  // Taken away: looked up again.
  await client.set('l1', null);
  assert.equal(JSON.parse(files.get('Lyrics/local/l1.none.json')).own, undefined);
  assert.equal(asked.length > 0, true);
  assert.equal((await client.lookup({ artist: 'Moby', title: 'Porcelain', duration: 241 })).found, false);
});

test('the server\'s lyrics synchronized: those whose stamp changed come down, those of songs gone go', async () => {
  const { files, folder } = memFolder();
  const serverSongs = [{ id: 's1', artist: 'Moby', title: 'Porcelain' }, { id: 's2', artist: 'Moby', title: 'Bodyrock' }, { id: 's3', artist: 'Moby', title: 'Honey' }];
  let index = { s1: 'a', s2: 'b' };
  const fetched = [];
  let hook = null;
  const remote = {
    active: () => true,
    view: () => ({ songs: serverSongs, deviceSongs: [] }),
    serverId: () => 'srv',
    useLyricsSync: (fn) => {
      hook = fn;
    },
    lyricsIndex: async () => ({ serverId: 'srv', songs: index }),
    lyricsOf: async (ids) => {
      fetched.push(...ids);
      return Object.fromEntries(ids.map((id) => [id, {
        found: id !== 's2', synced: null, plain: id === 's2' ? '' : `words ${id}`, instrumental: false, v: index[id],
      }]));
    },
    songLyrics: async () => null,
  };
  const client = createLyricsClient({ remote, library: { get: () => ({ songs: [] }) }, folder, fetch: fakeFetch({ down: true }) });
  assert.equal(typeof hook, 'function', 'told when the server\'s library changes');
  await client.sync();
  assert.deepEqual(fetched, ['s1', 's2']);
  assert.ok(files.has('Lyrics/srv/s1.json'));
  assert.ok(files.has('Lyrics/srv/s2.none.json'));
  assert.equal((await client.get('s1')).plain, 'words s1', 'the copy while the server cannot say');
  // Nothing changed: nothing comes down. s1 changed, s2 gone from the server.
  await client.sync();
  assert.equal(fetched.length, 2);
  index = { s1: 'c' };
  serverSongs.splice(1, 1);
  await client.sync();
  assert.deepEqual(fetched.slice(2), ['s1']);
  assert.ok(!files.has('Lyrics/srv/s2.none.json'));
  assert.equal(client.stats().count, 1);
});

test('Clear lyrics cache: all but those written for Local Files songs, the server\'s again; the old lyrics.json moved over', async () => {
  const { files, folder } = memFolder();
  const old = {
    l1: { found: true, synced: null, plain: 'Mine', own: true, source: 'own', used: 5 },
    l2: { found: true, synced: null, plain: 'Looked up', source: 'LRCLIB', used: 6 },
  };
  const removed = [];
  const jsonFiles = { read: (n) => (n === 'lyrics.json' && !removed.length ? old : null), write: () => {}, remove: (n) => removed.push(n) };
  const local = { songs: [{ id: 'l1', artist: 'Moby', title: 'Porcelain', duration: 241 }, { id: 'l2', artist: 'Moby', title: 'Bodyrock', duration: 220 }] };
  let synced = 0;
  const remote = {
    active: () => false,
    view: () => ({ songs: [], deviceSongs: [] }),
    serverId: () => '',
    lyricsIndex: async () => {
      synced += 1;
      return null;
    },
  };
  const client = createLyricsClient({ remote, library: { get: () => local }, folder, jsonFiles, fetch: fakeFetch({ down: true }) });
  assert.deepEqual(removed, ['lyrics.json']);
  assert.equal(JSON.parse(files.get('Lyrics/local/l1.json')).plain, 'Mine', 'only those written by hand');
  assert.ok(!files.has('Lyrics/local/l2.json'));
  folder.write('local', 'l2', { found: true, plain: 'Looked up' });
  folder.write('local', 'gone', { found: true, plain: 'A song deleted' });
  folder.write('local', 'goneOwn', { found: true, plain: 'Written for a song deleted here', own: true });
  folder.write('srv', 's1', { found: true, plain: 'Copy', server: true });
  assert.equal(client.stats().count, 4, 'the deleted song\'s gone when first counted, not one written by hand');
  assert.equal(client.clear().count, 2);
  assert.deepEqual([...files.keys()].sort(), ['Lyrics/local/goneOwn.json', 'Lyrics/local/l1.json']);
  assert.equal(synced, 1, 'the server\'s asked for again');
});

test('a server song uploaded from here: the lyrics written for its Local Files copy, fetching on or off', async () => {
  const { folder } = memFolder();
  // Written while it was only in Local Files (kept under its local id), then uploaded.
  folder.write('local', 'l1', { ...lyrics.ownLyrics([{ t: null, text: 'Another mission' }]), key: 'x' });
  let on = false;
  let serverHas = { found: true, synced: null, plain: 'Looked up by the server', instrumental: false, source: 'LRCLIB' };
  const remote = {
    active: () => true,
    view: () => ({ songs: [{ id: 's1', artist: 'Disturbed', title: 'Indestructible', duration: 278 }], deviceSongs: [] }),
    serverId: () => 'srv',
    localOf: (sid) => (sid === 's1' ? 'l1' : ''),
    songLyrics: async () => serverHas,
  };
  const client = createLyricsClient({
    remote, library: { get: () => ({ songs: [{ id: 'l1', artist: 'Disturbed', title: 'Indestructible', duration: 278 }] }) }, folder, fetch: fakeFetch({}), fetchOn: () => on,
  });
  assert.equal((await client.get('s1')).plain, 'Another mission', 'off: the own ones of its copy');
  on = true;
  assert.equal((await client.get('s1')).plain, 'Another mission', 'on: before the server\'s looked-up ones');
  serverHas = { ...lyrics.ownLyrics([{ t: null, text: 'Edited on the server' }]) };
  assert.equal((await client.get('s1')).plain, 'Edited on the server', 'the server\'s own ones (edited later) first');
});

test('a busy LRCLIB\'s Retry-After: waited for when longer than the gap, at most a minute', async () => {
  lyrics.RETRY.unitMs = 10;
  try {
    const at = [];
    const t0 = Date.now();
    let calls = 0;
    const busy = async () => {
      at.push(Date.now() - t0);
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, headers: { get: (name) => (name === 'retry-after' ? '12' : null) }, json: async () => ({}) };
      if (calls === 2) return { ok: false, status: 503, headers: { get: () => '9999' }, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [{ trackName: 'Porcelain', artistName: 'Moby', plainLyrics: 'In my dreams' }] };
    };
    const r = await lyrics.lookupLyrics({ artist: 'Moby', title: 'Porcelain' }, { fetch: busy });
    assert.equal(r.plain, 'In my dreams');
    assert.ok(at[1] - at[0] >= 118, `12 s asked, not the 3 s gap: ${at[1] - at[0]} ms`);
    assert.ok(at[2] - at[1] >= 598 && at[2] - at[1] < 900, `at most 60 s: ${at[2] - at[1]} ms`);
  } finally {
    lyrics.RETRY.unitMs = 0;
  }
});

test('LRCLIB\'s search for picking by hand: those with times first, then the closest length', async () => {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => [
        { id: 1, trackName: 'Porcelain', artistName: 'Moby', albumName: 'Play', duration: 300, plainLyrics: 'Plain only' },
        { id: 2, trackName: 'Porcelain', artistName: 'Moby', albumName: 'Play', duration: 260, syncedLyrics: '[00:12.50] In my dreams' },
        { id: 3, trackName: 'Porcelain', artistName: 'Moby', albumName: 'Play', duration: 241, syncedLyrics: '[00:12.00] In my dreams', plainLyrics: 'In my dreams' },
        { id: 4, trackName: 'Porcelain', artistName: 'Moby', duration: 241, instrumental: true },
      ],
    };
  };
  const found = await lyrics.searchLyrics({ title: 'Porcelain', artist: 'Moby', duration: 241 }, { fetch });
  assert.deepEqual(found.map((r) => r.id), [3, 2, 1], 'timed first, closest first; none without words');
  assert.deepEqual(found[1].synced, [{ t: 12.5, text: 'In my dreams' }]);
  assert.equal(found[1].plain, 'In my dreams', 'the words from the lines');
  assert.equal(found[0].album, 'Play');
  assert.match(asked[0], /search\?track_name=Porcelain&artist_name=Moby$/);
  await lyrics.searchLyrics({ q: 'moby porcelain', title: 'x' }, { fetch });
  assert.match(asked[1], /search\?q=moby\+porcelain$/);
  assert.deepEqual(await lyrics.searchLyrics({}, { fetch }), []);
  await assert.rejects(() => lyrics.searchLyrics({ q: 'x' }, { fetch: async () => ({ ok: false, status: 429, headers: { get: () => null } }) }), /busy/);
  await assert.rejects(() => lyrics.searchLyrics({ q: 'x' }, {
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  }), /cannot be reached/);
});

test('publishing on LRCLIB: the challenge solved, the lines as LRC with their ends, the words plain', async () => {
  assert.equal(lyrics.toLrc([
    { t: 0, text: '' }, { t: 12.5, end: 15, text: 'In my dreams' }, { t: 15, end: 18.004, text: 'As I wake' }, { t: 61.239, end: 65, text: 'Last' },
  ]), ['[00:00.00]', '[00:12.50] In my dreams', '[00:15.00] As I wake', '[00:18.00]', '[01:01.24] Last', '[01:05.00]'].join('\n'));
  const sent = [];
  const fetch = async (url, opts) => {
    sent.push({ url, opts });
    if (url.endsWith('/request-challenge')) return { ok: true, status: 200, json: async () => ({ prefix: 'abc', target: '00ff' }) };
    return { ok: true, status: 201, json: async () => ({}) };
  };
  const solved = [];
  const solve = async (prefix, target) => {
    solved.push([prefix, target]);
    return '4711';
  };
  const meta = {
    title: 'Porcelain', artist: 'Moby', album: 'Play', duration: 241.4, lines: [{ t: 12.5, end: 15, text: 'In my dreams' }, { t: 16, end: null, text: 'As I wake' }],
  };
  await lyrics.publishLyrics(meta, { fetch, solve });
  assert.deepEqual(solved, [['abc', '00ff']]);
  const pub = sent[1];
  assert.match(pub.url, /\/api\/publish$/);
  assert.equal(pub.opts.method, 'POST');
  assert.equal(pub.opts.headers['X-Publish-Token'], 'abc:4711');
  assert.deepEqual(JSON.parse(pub.opts.body), {
    trackName: 'Porcelain',
    artistName: 'Moby',
    albumName: 'Play',
    duration: 241,
    plainLyrics: ['In my dreams', 'As I wake'].join('\n'),
    syncedLyrics: ['[00:12.50] In my dreams', '[00:15.00]', '[00:16.00] As I wake'].join('\n'),
  });
  // Words only: no LRC. Without an album, words or a length: refused before asking.
  sent.length = 0;
  await lyrics.publishLyrics({ ...meta, lines: [{ t: null, text: 'Verse' }, { t: null, text: '' }, { t: null, text: 'Two' }] }, { fetch, solve });
  assert.equal(JSON.parse(sent[1].opts.body).plainLyrics, ['Verse', '', 'Two'].join('\n'));
  assert.equal(JSON.parse(sent[1].opts.body).syncedLyrics, undefined);
  await assert.rejects(() => lyrics.publishLyrics({ ...meta, album: ' ' }, { fetch, solve }), /album/);
  await assert.rejects(() => lyrics.publishLyrics({ ...meta, lines: [] }, { fetch, solve }), /Write the lyrics/);
  await assert.rejects(() => lyrics.publishLyrics({ ...meta, duration: 0 }, { fetch, solve }), /length/);
  // LRCLIB saying no: its reason.
  const no = async (url) => (url.endsWith('/request-challenge')
    ? { ok: true, status: 200, json: async () => ({ prefix: 'p', target: 'ff' }) }
    : { ok: false, status: 400, json: async () => ({ message: 'Invalid publish token' }) });
  await assert.rejects(() => lyrics.publishLyrics(meta, { fetch: no, solve }), /did not take them: Invalid publish token/);
});

test('the filler: every Local Files song\'s lyrics in the background, once each, copies of a server\'s left out', async () => {
  const { folder } = memFolder();
  const local = {
    songs: [
      { id: 'l1', artist: 'Moby', title: 'Porcelain', duration: 241 },
      { id: 'l2', artist: 'Massive Attack', title: 'Teardrop', duration: 330 },
      { id: 'l3', artist: 'Portishead', title: 'Glory Box', duration: 300 },
    ],
  };
  const asked = [];
  const fetch = fakeFetch({ 'search?track_name=Porcelain&artist_name=Moby': [{ trackName: 'Porcelain', artistName: 'Moby', duration: 241, plainLyrics: 'words' }] }, asked);
  let told = 0;
  const client = createLyricsClient({
    library: { get: () => local },
    folder,
    fetch,
    skip: (id) => id === 'l3',
    onChange: () => {
      told += 1;
    },
    fillPauseMs: 0,
  });
  await client.fill();
  const lrclibAsked = () => asked.filter((a) => a.url.startsWith('https://lrclib.net/')).map((a) => new URL(a.url).searchParams.get('track_name'));
  assert.deepEqual(lrclibAsked(), ['Porcelain', 'Teardrop'], 'l3 left out');
  assert.equal(folder.read('local', 'l1').plain, 'words');
  assert.equal(folder.read('local', 'l2').found, false, 'none found kept too');
  assert.ok(told >= 2);
  assert.equal(client.stats().left, 0);
  await client.fill();
  assert.equal(lrclibAsked().length, 2, 'each once');
  // Renamed: once more.
  local.songs[0].title = 'Porcelain (Live)';
  await client.fill();
  assert.deepEqual(lrclibAsked().slice(2), ['Porcelain (Live)']);
  // Off: nothing.
  const off = createLyricsClient({
    library: { get: () => local }, folder: memFolder().folder, fetch, fetchOn: () => false,
  });
  const n = asked.length;
  await off.fill();
  assert.equal(asked.length, n);
});

test('the filler with LRCLIB out of reach: stops at the first song, the rest later', async () => {
  const local = { songs: [{ id: 'l1', artist: 'Moby', title: 'Porcelain' }, { id: 'l2', artist: 'Moby', title: 'Honey' }] };
  let calls = 0;
  const down = async (url, opts) => {
    calls += 1;
    return fakeFetch({ down: true })(url, opts);
  };
  const client = createLyricsClient({
    library: { get: () => local }, folder: memFolder().folder, fetch: down, fillPauseMs: 0,
  });
  await client.fill();
  const first = calls;
  assert.equal(first, 9, 'one song, its nine tries');
  await client.fill();
  assert.equal(calls, first, 'waits before trying again');
});
