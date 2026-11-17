'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const radio = require('../src/radio');
const { clean } = require('../src/client/settings');

// A fetch answering from a table: url -> { status, type, body, headers }.
function fakeFetch(table) {
  return async (url) => {
    const r = table[url];
    if (!r) throw new TypeError('fetch failed');
    if (r.throws) throw r.throws;
    const headers = new Map(Object.entries({ 'content-type': r.type || '', ...(r.headers || {}) }));
    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      url,
      headers: { get: (k) => headers.get(k.toLowerCase()) || null },
      body: null,
      text: async () => r.body || '',
      json: async () => JSON.parse(r.body),
    };
  };
}

test('playlist files give their first stream', () => {
  assert.equal(radio.parsePls('[playlist]\nNumberOfEntries=2\nFile1=http://a.example/live\nFile2=http://b.example/live\n'), 'http://a.example/live');
  assert.equal(radio.parseM3u('#EXTM3U\n#EXTINF:-1,Station\nhttps://c.example/stream.mp3\n'), 'https://c.example/stream.mp3');
  assert.equal(radio.parseM3u('#EXTM3U\n'), null);
  assert.ok(radio.isHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8'));
  assert.ok(!radio.isHls('#EXTM3U\nhttp://x.example/a'));
});

test('addresses: only http(s), a bare host gets http://', () => {
  assert.equal(radio.httpUrl('stream.example.org/live'), 'http://stream.example.org/live');
  assert.equal(radio.httpUrl('ftp://x.example/a'), null);
  assert.equal(radio.httpUrl('not an address'), null);
  assert.equal(radio.httpUrl(''), null);
});

test('a sound stream is taken, with the name it sends', async () => {
  const get = fakeFetch({ 'http://s.example/live': { type: 'audio/mpeg', headers: { 'icy-name': 'Test FM' } } });
  assert.deepEqual(await radio.checkStream('http://s.example/live', { fetch: get }), { url: 'http://s.example/live', name: 'Test FM', checked: true });
});

test('a .pls leads to the stream inside it', async () => {
  const get = fakeFetch({
    'http://s.example/listen.pls': { type: 'audio/x-scpls', body: '[playlist]\nFile1=http://s.example:8000/stream\n' },
    'http://s.example:8000/stream': { type: 'audio/aacp' },
  });
  const r = await radio.checkStream('http://s.example/listen.pls', { fetch: get });
  assert.equal(r.url, 'http://s.example:8000/stream');
  assert.equal(r.checked, true);
});

test('web pages, HLS, errors and nothing there are refused', async () => {
  const get = fakeFetch({
    'http://page.example/': { type: 'text/html', body: '<html>' },
    'http://hls.example/a.m3u8': { type: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n' },
    'http://gone.example/x': { status: 404, type: 'text/plain' },
  });
  await assert.rejects(radio.checkStream('http://page.example/', { fetch: get }), /web page/);
  await assert.rejects(radio.checkStream('http://hls.example/a.m3u8', { fetch: get }), /HLS/);
  await assert.rejects(radio.checkStream('http://gone.example/x', { fetch: get }), /404/);
  await assert.rejects(radio.checkStream('http://nobody.example/x', { fetch: get }), /cannot be reached/);
  await assert.rejects(radio.checkStream('nonsense address', { fetch: get }), /not a web address/);
});

test('an unknown type, or a Shoutcast ICY answer, is taken unchecked', async () => {
  const icy = new TypeError('fetch failed');
  icy.cause = new Error('Parse Error: Expected HTTP/, RTSP/ or ICE/');
  const get = fakeFetch({
    'http://odd.example/s': { type: '' },
    'http://icy.example:8000/': { throws: icy },
  });
  assert.equal((await radio.checkStream('http://odd.example/s', { fetch: get })).checked, false);
  assert.equal((await radio.checkStream('http://icy.example:8000/', { fetch: get })).checked, false);
});

// A directory of a few stations, answering the whole-list pages (the first page holds them all).
function fakeDirectory(stations, calls = []) {
  return async (url) => {
    calls.push(url);
    if (url.startsWith('https://all.')) throw new TypeError('fetch failed');
    const offset = Number(new URL(url).searchParams.get('offset')) || 0;
    return { ok: true, status: 200, json: async () => (offset === 0 ? stations : []) };
  };
}

const STATIONS = [
  { stationuuid: '11111111-aaaa', name: 'Rock One', url: 'http://one.example/live', countrycode: 'de', country: 'Germany', tags: 'rock,2000s', codec: 'MP3', bitrate: 320, clickcount: 50, hls: 0 },
  { stationuuid: '22222222-bbbb', name: 'Two', url: 'http://two.example/a.m3u8', countrycode: 'de', tags: 'rock', hls: 1 },
  { stationuuid: '33333333-cccc', name: 'Café 2000', url: 'http://three.example/live', countrycode: 'fr', country: 'France', tags: '2000s', codec: 'AAC', bitrate: 128, clickcount: 90, hls: 0 },
  { stationuuid: '44444444-dddd', name: 'Rock Unknown', url: 'http://four.example/live', countrycode: 'de', country: 'Germany', tags: 'Rock, Pop', bitrate: 0, clickcount: 10, hls: 0 },
];

test('the directory: the whole list fetched once, HLS left out, filtered here, the most played first', async () => {
  const calls = [];
  const d = radio.createDirectory({ fetch: fakeDirectory(STATIONS, calls), minGenre: 1 });
  const r = await d.search({});
  assert.deepEqual(r.stations.map((s) => s.name), ['Café 2000', 'Rock One', 'Rock Unknown']);
  assert.equal(r.total, 3);
  assert.equal(r.more, false);
  assert.equal((await d.search({ quality: 320 })).all, 3, 'the whole list, whatever the filters');
  // Three pages at once, from the second host (the first failed), the answer short: done.
  assert.equal(calls.filter((u) => u.startsWith('https://de1.')).length, 3);
  const before = calls.length;
  assert.deepEqual((await d.search({ country: 'de', genre: 'rock' })).stations.map((s) => s.name), ['Rock One', 'Rock Unknown']);
  assert.deepEqual((await d.search({ name: 'cafe' })).stations.map((s) => s.name), ['Café 2000']);
  assert.deepEqual((await d.search({ quality: 192 })).stations.map((s) => s.name), ['Rock One']);
  assert.deepEqual((await d.search({ quality: radio.RADIO_NO_INFO })).stations.map((s) => s.name), ['Rock Unknown']);
  assert.equal((await d.search({ quality: 100 })).total, 3);
  assert.equal(calls.length, before, 'filtering asks the directory nothing');
});

test('each picker offers only what is there under the other filters, with counts', async () => {
  const d = radio.createDirectory({ fetch: fakeDirectory(STATIONS), minGenre: 1 });
  const f = (await d.search({ quality: 320 })).facets;
  assert.deepEqual(f.genres, [{ name: 'rock', stations: 1 }, { name: '2000s', stations: 1 }]);
  assert.deepEqual(f.countries, [{ code: 'DE', name: 'Germany', stations: 1 }]);
  // Its own filter left out of its own counts.
  assert.equal(f.qualities[320], 1);
  assert.equal(f.qualities[128], 2);
  assert.equal(f.qualities[radio.RADIO_NO_INFO], 1);
  const g = (await d.search({ genre: '2000s' })).facets;
  assert.deepEqual(g.countries.map((c) => c.code).sort(), ['DE', 'FR']);
  assert.equal(g.qualities[320], 1);
  assert.equal(g.qualities[radio.RADIO_NO_INFO], 0);
  const n = (await d.search({ name: 'rock' })).facets;
  assert.deepEqual(n.countries, [{ code: 'DE', name: 'Germany', stations: 2 }]);
  // A genre few stations name is not offered.
  const few = radio.createDirectory({ fetch: fakeDirectory(STATIONS), minGenre: 2 });
  assert.deepEqual((await few.search({})).facets.genres.map((x) => x.name).sort(), ['2000s', 'rock']);
});

test('a column order sorts the whole list before the pages, those without a value last', async () => {
  const d = radio.createDirectory({ fetch: fakeDirectory(STATIONS), minGenre: 1 });
  const names = async (sort, q = {}) => (await d.search({ ...q, sort, lang: 'en' })).stations.map((s) => s.name);
  assert.deepEqual(await names({ key: 'quality', dir: 'asc' }), ['Café 2000', 'Rock One', 'Rock Unknown']);
  assert.deepEqual(await names({ key: 'quality', dir: 'desc' }), ['Rock One', 'Café 2000', 'Rock Unknown']);
  assert.deepEqual(await names({ key: 'name', dir: 'desc' }), ['Rock Unknown', 'Rock One', 'Café 2000']);
  assert.deepEqual(await names({ key: 'country', dir: 'asc' }), ['Café 2000', 'Rock One', 'Rock Unknown']);
  assert.deepEqual(await names({ key: 'quality', dir: 'asc' }, { country: 'DE' }), ['Rock One', 'Rock Unknown']);
  // An order it does not know: the most played first.
  assert.deepEqual(await names({ key: 'url', dir: 'asc' }), ['Café 2000', 'Rock One', 'Rock Unknown']);
});

test('the list is kept as a copy, used at once, and fetched again behind it once a day old', async () => {
  let kept = null;
  const copy = { read: () => kept && JSON.parse(kept), write: (data) => { kept = JSON.stringify(data); } };
  {
    await radio.createDirectory({ fetch: fakeDirectory(STATIONS), copy }).search({});
    assert.ok(kept);
    const calls = [];
    const fresh = radio.createDirectory({ fetch: fakeDirectory([], calls), copy });
    assert.equal((await fresh.search({})).total, 3);
    assert.equal(calls.length, 0, 'a fresh copy needs no directory');
    // A day old: still answered from it, a new list fetched behind it.
    const old = radio.createDirectory({ fetch: fakeDirectory(STATIONS.slice(0, 1), calls), copy, maxAgeMs: -1 });
    assert.equal((await old.search({})).total, 3);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls.length > 0);
    assert.equal((await old.search({})).total, 1);
    // Nothing kept and the directory away: the error says so.
    const away = radio.createDirectory({ fetch: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(away.search({}), /radio-browser.info/);
    // A copy that cannot be read is as none.
    const broken = radio.createDirectory({ fetch: fakeDirectory(STATIONS), copy: { read: () => { throw new Error('bad'); }, write: () => {} } });
    assert.equal((await broken.search({})).total, 3);
  }
});

test('the Quality setting is one of the steps, or all', () => {
  assert.equal(clean({}).radioQuality, 0);
  assert.equal(clean({ radioQuality: '256' }).radioQuality, 256);
  assert.equal(clean({ radioQuality: -1 }).radioQuality, -1);
  assert.equal(clean({ radioQuality: 100 }).radioQuality, 0);
});

test('settings keep each profile\'s favourite stations, cleaned', () => {
  const s = clean({
    radioFavs: {
      'srv/p1': [{ id: 'a', name: 'A', url: 'http://a.example/live' }, { id: 'a', name: 'A again', url: 'http://a.example/live' }, { name: 'no url' }],
      private: 'nonsense',
    },
    radioCountry: 'de',
    radioGenre: '  rock  ',
  });
  assert.deepEqual(Object.keys(s.radioFavs), ['srv/p1']);
  assert.equal(s.radioFavs['srv/p1'].length, 1);
  assert.equal(s.radioCountry, '');
  assert.equal(s.radioGenre, 'rock');
  assert.equal(s.showRadio, true);
  assert.equal(clean({ showRadio: false }).showRadio, false);
});
