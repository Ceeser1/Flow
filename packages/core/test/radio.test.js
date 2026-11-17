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

test('the directory leaves out HLS stations and keeps the first host that answers', async () => {
  const calls = [];
  const stations = [
    { stationuuid: '11111111-aaaa', name: 'One', url: 'http://one.example/live', url_resolved: 'http://one.example/live', countrycode: 'de', tags: 'rock,pop', codec: 'MP3', bitrate: 128, hls: 0 },
    { stationuuid: '22222222-bbbb', name: 'Two', url: 'http://two.example/a.m3u8', hls: 1 },
  ];
  const get = async (url) => {
    calls.push(url);
    if (url.startsWith('https://all.')) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => stations };
  };
  const d = radio.createDirectory({ fetch: get });
  const r = await d.search({ country: 'DE', genre: 'rock' });
  assert.equal(r.stations.length, 1);
  assert.equal(r.stations[0].name, 'One');
  assert.equal(r.stations[0].countryCode, 'DE');
  assert.match(calls[1], /^https:\/\/de1\..*countrycode=DE.*tag=rock/);
  await d.search({});
  assert.match(calls[2], /^https:\/\/de1\./);
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
