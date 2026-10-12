'use strict';

// Words typed into Add Songs instead of a link: telling them from a link,
// ranking what a search found, and the lister's search over a stand-in yt-dlp.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSearch, parseQuery, rankSearch, musicHits } = require('../src/songSearch');
const { createLister, groupToken } = require('../src/listing');

test('words are a search, links are links', () => {
  for (const words of ['Linkin Park - Numb', 'numb linkin park', 'Numb', 'Bohemian Rhapsody', 'AC/DC - Thunderstruck', 'Mr. Brightside', 'will.i.am - Scream & Shout']) {
    assert.equal(isSearch(words), true, words);
  }
  for (const link of ['https://www.youtube.com/watch?v=kXYiU_JCYtU', 'youtu.be/kXYiU_JCYtU', 'soundcloud.com/artist/song',
    'www.youtube.com/playlist?list=PL123', 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', 'open.spotify.com/album/abc', '93.184.216.34/song.mp3',
    'Look at this: https://youtu.be/kXYiU_JCYtU']) {
    assert.equal(isSearch(link), false, link);
  }
  assert.equal(isSearch('   '), false);
});

test('"Artist - Title" is split at the dash, anything else is a title', () => {
  assert.deepEqual(parseQuery('  Linkin Park  -  Numb '), { query: 'Linkin Park - Numb', artist: 'Linkin Park', title: 'Numb' });
  assert.deepEqual(parseQuery('Daft Punk – Around the World'), { query: 'Daft Punk – Around the World', artist: 'Daft Punk', title: 'Around the World' });
  assert.deepEqual(parseQuery('numb linkin park'), { query: 'numb linkin park', artist: '', title: 'numb linkin park' });
  // A dash inside a word is no separator.
  assert.equal(parseQuery('Jay-Z Encore').artist, '');
  assert.equal(parseQuery('x'.repeat(300)).query.length, 200);
});

const NUMB = parseQuery('Linkin Park - Numb');

test('the artist\'s own upload of the song comes first, other versions and compilations last', () => {
  const ranked = rankSearch(NUMB, [
    { id: 'live', title: 'Numb (Live) - Linkin Park', channel: 'Linkin Park', duration: 193, order: 0 },
    { id: 'hits', title: 'Linkin Park Greatest Hits Full Album', channel: 'Some Mixes', duration: 3600, order: 1 },
    { id: 'lyrics', title: 'Linkin Park - Numb (Lyrics)', channel: '7clouds Rock', duration: 188, order: 2 },
    { id: 'video', title: 'Numb (Official Music Video) - Linkin Park', channel: 'Linkin Park', duration: 188, order: 3 },
    { id: 'album', title: 'Numb', channel: 'Linkin Park - Topic', duration: 187, order: 0, fromMusic: true },
    { id: 'gone', title: '[Deleted video]', channel: '', duration: 0, order: 4 },
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ['album', 'video', 'lyrics', 'live', 'hits']);
  assert.equal(ranked[0].quality, 'good');
  assert.deepEqual(ranked.find((r) => r.id === 'live').versions, ['live']);
  assert.notEqual(ranked.find((r) => r.id === 'live').quality, 'good');
  assert.notEqual(ranked.find((r) => r.id === 'hits').quality, 'good');
});

test('a version that was typed is no other version; a channel writing the artist as one word is the artist', () => {
  const live = parseQuery('Linkin Park - Numb live');
  const [first] = rankSearch(live, [
    { id: 'studio', title: 'Numb', channel: 'Linkin Park - Topic', duration: 187, order: 0 },
    { id: 'live', title: 'Numb (Live in Texas)', channel: 'Linkin Park', duration: 197, order: 1 },
  ]);
  assert.equal(first.id, 'live');
  assert.deepEqual(first.versions, []);
  const [hu] = rankSearch(parseQuery('Hollywood Undead - Hear Me Now'),
    [{ id: '1', title: 'Hear Me Now', channel: 'HollywoodUndead', duration: 214 }]);
  assert.equal(hu.quality, 'good');
});

test('a length far from what most uploads last counts against an upload', () => {
  const ranked = rankSearch(parseQuery('numb linkin park'), [
    { id: 'intro', title: 'Linkin Park - Numb', channel: 'Someone', duration: 260, order: 0 },
    { id: 'a', title: 'Linkin Park - Numb', channel: 'Someone else', duration: 187, order: 1 },
    { id: 'b', title: 'Linkin Park - Numb', channel: 'A third', duration: 188, order: 2 },
  ]);
  assert.equal(ranked[ranked.length - 1].id, 'intro');
  assert.equal(ranked[ranked.length - 1].quality, 'shaky');
});

test('YouTube Music\'s results that can be the song: its title, or typed words only, and no other version', () => {
  const hits = musicHits(parseQuery('numb linkin park'), [
    { id: '1', title: 'Numb' }, { id: '2', title: 'Numb (Piano Cover)' }, { id: '3', title: 'In the End' }, { id: '4', title: 'Numb / Encore' },
  ]);
  assert.deepEqual(hits.map((h) => h.id), ['1']);
});

/**
 * A lister over a stand-in yt-dlp: youtube and music are the two searches'
 * entries (or an Error), reads the videos read one by one.
 */
function lister({ youtube = [], music = [], reads = {}, songs = [] }) {
  const asked = [];
  const answer = (v) => (v instanceof Error ? Promise.reject(v) : Promise.resolve({ entries: v }));
  const media = {
    async readJson(args) {
      const what = args[args.length - 1];
      if (/music\.youtube\.com/.test(what)) {
        asked.push('youtube music');
        return answer(music);
      }
      if (/^ytsearch/.test(what)) {
        asked.push('youtube');
        return answer(youtube);
      }
      asked.push(`read ${what}`);
      const info = reads[what];
      if (!info) throw new Error('Could not read this link.');
      return info;
    },
  };
  return { asked, lister: createLister({ media, library: () => ({ songs, playlists: [] }) }) };
}

test('a search: YouTube Music\'s song read for its artist, YouTube\'s uploads, the library\'s marked', async () => {
  const { lister: l, asked } = lister({
    music: [{ id: 'm1', title: 'Numb' }, { id: 'm2', title: 'Faint' }],
    youtube: [
      { id: 'v1', title: 'Numb (Official Music Video) - Linkin Park', channel: 'Linkin Park', duration: 188 },
      { id: 'stream', title: 'Linkin Park radio 24/7', channel: 'Radio', duration: null },
      { id: 'm1', title: 'Numb', channel: 'Linkin Park - Topic', duration: 187 },
    ],
    reads: { 'https://www.youtube.com/watch?v=m1': { id: 'm1', title: 'Numb', channel: 'Linkin Park', album: 'Meteora', duration: 187 } },
    songs: [{ id: 's1', artist: 'Linkin Park', title: 'Numb', mix: '', sourceKey: 'youtube:v1' }],
  });
  const r = await l.search('Linkin Park - Numb', groupToken());
  assert.equal(r.artist, 'Linkin Park');
  assert.deepEqual(r.results.map((x) => x.id), ['m1', 'v1'], 'once each; no stream');
  const [album, video] = r.results;
  assert.equal(album.album, 'Meteora');
  assert.equal(album.url, 'https://www.youtube.com/watch?v=m1');
  assert.equal(album.key, 'youtube:m1');
  assert.equal(album.site, 'YouTube');
  assert.equal(album.existing, null);
  assert.equal(video.existing.id, 's1');
  assert.ok(!('fromMusic' in album) && !('order' in album));
  assert.deepEqual(asked.sort(), ['read https://www.youtube.com/watch?v=m1', 'youtube', 'youtube music']);
});

test('one search failing is no failure; both is', async () => {
  const { lister: l } = lister({ music: new Error('YouTube Music did not answer'), youtube: [{ id: 'v1', title: 'Numb', channel: 'Linkin Park', duration: 188 }] });
  assert.deepEqual((await l.search('Numb', groupToken())).results.map((x) => x.id), ['v1']);
  const { lister: down } = lister({ music: new Error('offline'), youtube: new Error('Unable to download API page') });
  await assert.rejects(down.search('Numb', groupToken()), /Unable to download API page/);
  await assert.rejects(down.search('   ', groupToken()), /Type the name of a song/);
});

test('a cancelled search says so', async () => {
  const { lister: l } = lister({ youtube: [] });
  const group = groupToken();
  group.cancel();
  await assert.rejects(l.search('Numb', group), (err) => err.cancelled === true);
});

test('"Search for more" further down YouTube: page 2 is its results 11 to 20; nothing past the last page', async () => {
  const asked = [];
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: `v${i + 1}`, title: `Linkin Park - Numb ${i + 1}`, channel: 'Someone', duration: 188 }));
  const media = {
    async readJson(args) {
      asked.push(args[args.length - 1]);
      return { entries };
    },
  };
  const l = createLister({ media, library: () => ({ songs: [], playlists: [] }) });
  const r = await l.search('Linkin Park - Numb', groupToken(), { page: 2 });
  assert.equal(r.page, 2);
  assert.deepEqual(asked, ['ytsearch20:Linkin Park - Numb']);
  assert.deepEqual(r.results.map((x) => x.id).sort(), entries.slice(10).map((e) => e.id).sort());
  asked.length = 0;
  assert.deepEqual((await l.search('Linkin Park - Numb', groupToken(), { page: 11 })).results, []);
  assert.deepEqual(asked, []);
});
