'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lyrics = require('../src/lyrics');
const { createLyricsClient } = require('../src/client/lyrics');

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

test('the app\'s lyrics: the server\'s for its songs, its own looked up once and kept', async () => {
  const files = {};
  const jsonFiles = { read: (n) => files[n] || null, write: (n, v) => { files[n] = JSON.parse(JSON.stringify(v)); } };
  const local = { songs: [{ id: 'l1', artist: 'Moby', title: 'Porcelain', duration: 241 }] };
  const serverView = { songs: [{ id: 's1', artist: 'Moby', title: 'Natural Blues', duration: 250 }], deviceSongs: [{ ...local.songs[0], id: 'dev:l1', localId: 'l1', isDevice: true }] };
  let online = true;
  const remote = {
    active: () => true,
    view: () => serverView,
    songLyrics: async (id) => (online ? { found: true, synced: null, plain: `server ${id}`, instrumental: false } : null),
  };
  const asked = [];
  const fetch = fakeFetch({ 'search?track_name=Porcelain&artist_name=Moby': [{ trackName: 'Porcelain', artistName: 'Moby', duration: 241, plainLyrics: 'own' }] }, asked);
  const client = createLyricsClient({ remote, library: { get: () => local }, jsonFiles, fetch });
  assert.equal((await client.get('s1')).plain, 'server s1');
  assert.equal((await client.get('dev:l1')).plain, 'own');
  assert.equal((await client.get('dev:l1')).plain, 'own');
  assert.equal(asked.length, 1, 'kept');
  assert.ok(files['lyrics.json'].l1);
  // The server out of reach: its song looked up here.
  online = false;
  assert.equal((await client.get('s1')).found, false);
  assert.ok(asked.some((a) => /Natural/.test(a.url)));
  const down = createLyricsClient({ remote, library: { get: () => local }, jsonFiles: { read: () => null, write() {} }, fetch: fakeFetch({ down: true }) });
  await assert.rejects(() => down.get('s1'), /could not be looked up/);
  await assert.rejects(() => client.get('nope'), /not here/);
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
  const files = {};
  const jsonFiles = { read: (n) => files[n] || null, write: (n, v) => { files[n] = JSON.parse(JSON.stringify(v)); } };
  const local = { songs: [{ id: 'l1', artist: 'Moby', title: 'Porcelain', duration: 241 }] };
  const sent = [];
  const remote = {
    active: () => true,
    view: () => ({ songs: [{ id: 's1', artist: 'Moby', title: 'Natural Blues', duration: 250 }], deviceSongs: [] }),
    songLyrics: async () => null,
    setSongLyrics: async (id, lines) => {
      sent.push([id, lines]);
      return { ...lyrics.ownLyrics(lines) };
    },
  };
  const asked = [];
  const fetch = fakeFetch({}, asked);
  const client = createLyricsClient({ remote, library: { get: () => local }, jsonFiles, fetch });
  const lines = [{ t: 1, end: 2, text: 'In my dreams' }];
  assert.equal((await client.set('s1', lines)).source, 'own');
  assert.deepEqual(sent, [['s1', lines]]);
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
  // Never let go among the looked-up ones.
  for (let i = 0; i < 405; i++) files['lyrics.json'][`x${i}`] = { found: false, used: Date.now() + i };
  client.keepOwn('l2', [{ t: null, end: null, text: 'Words only' }]);
  assert.ok(files['lyrics.json'].l1.own);
  assert.deepEqual(client.ownLines('l2'), [{ t: null, end: null, text: 'Words only' }]);
  // Taken away: looked up again.
  await client.set('l1', null);
  assert.equal(files['lyrics.json'].l1.own, undefined);
  assert.equal(asked.length > 0, true);
  assert.equal((await client.lookup({ artist: 'Moby', title: 'Porcelain', duration: 241 })).found, false);
});
