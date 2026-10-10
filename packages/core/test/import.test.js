'use strict';

// Playlist import: Spotify, Amazon Music and Deezer links and page data,
// picking the YouTube upload that matches such a song, and the playlist it
// goes into.

const test = require('node:test');
const assert = require('node:assert/strict');
const spotify = require('../src/spotify');
const m = require('../src/libraryModel');

test('a list link keeps its list: a Mix is a video plus its list', () => {
  const { normalizeListUrl, normalizeUrl } = require('../src/text');
  assert.equal(normalizeListUrl('https://www.youtube.com/watch?v=IIX9epv9Vjc&list=RDIIX9epv9Vjc&start_radio=1'),
    'https://www.youtube.com/watch?v=IIX9epv9Vjc&list=RDIIX9epv9Vjc');
  assert.equal(normalizeListUrl('https://youtu.be/IIX9epv9Vjc?list=PL123'),
    'https://www.youtube.com/watch?v=IIX9epv9Vjc&list=PL123');
  assert.equal(normalizeListUrl('youtube.com/playlist?list=PLabc'), 'https://www.youtube.com/playlist?list=PLabc');
  // Without a list it is the same as for one song.
  assert.equal(normalizeListUrl('https://www.youtube.com/watch?v=IIX9epv9Vjc'), normalizeUrl('https://www.youtube.com/watch?v=IIX9epv9Vjc'));
  // The one-song cleanup drops the list, which is why lists need their own.
  assert.equal(normalizeUrl('https://www.youtube.com/watch?v=IIX9epv9Vjc&list=RDIIX9epv9Vjc'),
    'https://www.youtube.com/watch?v=IIX9epv9Vjc');
});

test('Spotify links: playlists and albums, with or without extras', () => {
  assert.deepEqual(spotify.parseSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'),
    { type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  assert.deepEqual(spotify.parseSpotifyUrl('open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy'),
    { type: 'album', id: '4aawyAB9vmqN3uQ7FjRGTy' });
  assert.deepEqual(spotify.parseSpotifyUrl('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'),
    { type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  assert.equal(spotify.parseSpotifyUrl('https://www.youtube.com/playlist?list=PL123'), null);
  assert.equal(spotify.isSpotifyTrackUrl('https://open.spotify.com/track/70cHKK8bHAfJrOGVnfRG9J'), true);
});

test('the embed page gives the name and each song', () => {
  const data = {
    props: { pageProps: { state: { data: { entity: {
      type: 'playlist',
      name: 'Today’s Top Hits',
      trackList: [
        { title: 'Nicole Kidman', subtitle: 'ADÉLA', duration: 181270, isPlayable: true },
        { title: 'BbY WOW', subtitle: 'KAROL G,Judeline, rusowsky', duration: 225834, isPlayable: false },
      ],
    } } } } },
  };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
  const page = spotify.parseEmbedPage(html);
  assert.equal(page.name, 'Today’s Top Hits');
  assert.deepEqual(page.tracks[0], { title: 'Nicole Kidman', artists: 'ADÉLA', duration: 181.27, playable: true });
  assert.equal(page.tracks[1].artists, 'KAROL G, Judeline, rusowsky');
  assert.equal(page.tracks[1].playable, false);
  assert.throws(() => spotify.parseEmbedPage('<html>nothing</html>'), /changed/);
});

test('the search uses the first artist and the plain title', () => {
  assert.equal(spotify.searchQuery({ artists: 'KAROL G, Judeline', title: 'BbY WOW (feat. Someone)' }), 'KAROL G - BbY WOW');
  assert.equal(spotify.searchQuery({ artists: 'Queen', title: 'Bohemian Rhapsody - Remastered 2011' }), 'Queen - Bohemian Rhapsody');
});

// The real results for "ADÉLA - Nicole Kidman" (Spotify: 3:01).
const ADELA = [
  { id: 'a', title: 'ADÉLA - Nicole Kidman', channel: 'ADÉLA', duration: 222 },
  { id: 'b', title: 'ADÉLA - Nicole Kidman (Lyrics)', channel: '7clouds', duration: 182 },
  { id: 'c', title: 'Nicole Kidman', channel: 'ADÉLA', duration: 182 },
  { id: 'd', title: 'ADÉLA - Nicole Kidman (Lyrics)', channel: 'Lost Panda', duration: 181 },
  { id: 'e', title: 'ADÉLA - Nicole Kidman (Lyrics)', channel: 'Creative Chaos', duration: 183 },
];

test('the artist\'s own upload of the right length wins over the video and lyrics copies', () => {
  const pick = spotify.pickMatch({ title: 'Nicole Kidman', artists: 'ADÉLA', duration: 181.27 }, ADELA);
  assert.equal(pick.cand.id, 'c');
  assert.equal(pick.quality, 'good');
});

test('a Topic channel upload is preferred', () => {
  const pick = spotify.pickMatch({ title: 'Song', artists: 'Band', duration: 200 }, [
    { id: 'x', title: 'Band - Song (Official Video)', channel: 'BandVEVO', duration: 214 },
    { id: 'y', title: 'Song', channel: 'Band - Topic', duration: 201 },
  ]);
  assert.equal(pick.cand.id, 'y');
});

test('a remix on Spotify may match a remix upload', () => {
  const pick = spotify.pickMatch({ title: 'Song - Club Remix', artists: 'Band', duration: 300 }, [
    { id: 'o', title: 'Band - Song', channel: 'Band', duration: 200 },
    { id: 'r', title: 'Band - Song (Club Remix)', channel: 'Band', duration: 301 },
  ]);
  assert.equal(pick.cand.id, 'r');
});

test('nothing close in length is not a match', () => {
  const pick = spotify.pickMatch({ title: 'Song', artists: 'Band', duration: 200 }, [
    { id: 'z', title: 'Band - Song (1 Hour)', channel: 'Loops', duration: 3600 },
  ]);
  assert.equal(pick.quality, 'none');
  assert.equal(spotify.pickMatch({ title: 'Song', artists: 'Band', duration: 200 }, []).quality, 'none');
});

test('a match 10 s off is shown, but marked to check', () => {
  const pick = spotify.pickMatch({ title: 'Song', artists: 'Band', duration: 200 }, [
    { id: 'v', title: 'Band - Song', channel: 'Band', duration: 211 },
  ]);
  assert.equal(pick.quality, 'shaky');
});

test('a channel is the artist\'s only under the artist\'s own name', () => {
  assert.equal(spotify.channelIsArtist('Bad Bunny', 'Bad Bunny'), true);
  assert.equal(spotify.channelIsArtist('Bad Bunny', 'Bad Bunny - Topic'), true);
  assert.equal(spotify.channelIsArtist('Rick Astley', 'RickAstleyVEVO'), true);
  assert.equal(spotify.channelIsArtist('Bad Bunny', 'Bad Bunny jr'), false);
  assert.equal(spotify.channelIsArtist('Shakira', 'Shakira and 2 more'), false);
});

// Two of the real misses from Today's Top Hits, before the stricter scoring.
test('a fake artist channel and a TV performance lose to a plain upload', () => {
  const bunny = spotify.pickMatch({ title: 'DtMF', artists: 'Bad Bunny', duration: 237 }, [
    { id: 'fake', title: 'Bad bunny  dtmf  video official', channel: 'Bad Bunny jr', duration: 225 },
    { id: 'real', title: 'DtMF', channel: 'Bad Bunny - Topic', duration: 237 },
  ]);
  assert.equal(bunny.cand.id, 'real');
  const dean = spotify.pickMatch({ title: 'Man I Need', artists: 'Olivia Dean', duration: 184 }, [
    { id: 'tv', title: 'Olivia Dean - Man I Need | Jools\' Annual Hootenanny 2025', channel: 'BBC Music and Olivia Dean', duration: 193 },
    { id: 'lyr', title: 'Olivia Dean - Man I Need', channel: 'Olivia Dean', duration: 185 },
  ]);
  assert.equal(dean.cand.id, 'lyr');
});

// The real YouTube Music results for "Shakira - Dai Dai".
test('from YouTube Music the first result that is this song, not another version', () => {
  const entries = [
    { id: '1', title: 'Dai Dai (Spanish Version)' },
    { id: '2', title: 'Dai Dai' },
    { id: '3', title: 'Dai Dai (SPINALL Remix)' },
  ];
  assert.equal(spotify.pickMusicResult({ title: 'Dai Dai', artists: 'Shakira' }, entries).id, '2');
  assert.equal(spotify.pickMusicResult({ title: 'Dai Dai - SPINALL Remix', artists: 'Shakira' }, entries).id, '3');
  assert.equal(spotify.pickMusicResult({ title: 'Waka Waka', artists: 'Shakira' }, entries), null);
  assert.match(spotify.musicSearchUrl({ title: 'Dai Dai', artists: 'Shakira, Burna Boy' }),
    /^https:\/\/music\.youtube\.com\/search\?q=Shakira%20-%20Dai%20Dai#songs$/);
});

test('an imported playlist takes a free name and remembers its source', () => {
  const data = m.emptyLibrary();
  m.createPlaylist(data, 'Chill', 'p1');
  assert.equal(m.freePlaylistName(data, 'Party'), 'Party');
  assert.equal(m.freePlaylistName(data, 'chill'), 'chill (2)');
  m.createPlaylist(data, 'Chill (2)', 'p2');
  assert.equal(m.freePlaylistName(data, 'Chill'), 'Chill (3)');
  assert.equal(m.freePlaylistName(data, 'All Songs'), 'All Songs (2)');
  m.setPlaylistSource(data, 'p1', { url: 'https://open.spotify.com/playlist/x', kind: 'spotify' });
  m.setPlaylistSource(data, 'p1', { url: 'https://other', kind: 'youtube' });
  assert.deepEqual(m.playlistById(data, 'p1').source, { url: 'https://open.spotify.com/playlist/x', kind: 'spotify' });
  const again = m.sanitize(JSON.parse(JSON.stringify(data)));
  assert.equal(again.playlists[0].source.kind, 'spotify');
  assert.equal(again.playlists[1].source, null);
});

test('Amazon Music links: playlists, albums, songs, every store', () => {
  const { parseAmazonMusicUrl, pageUrl } = require('../src/amazonMusic');
  assert.deepEqual(parseAmazonMusicUrl('https://music.amazon.de/playlists/B0HJJ7HKT6?ref=dm_sh_x'),
    { type: 'playlist', id: 'B0HJJ7HKT6', tld: 'de', trackId: '', query: '' });
  // A song shared from an album: that song.
  assert.deepEqual(parseAmazonMusicUrl('music.amazon.co.uk/albums/B0CXY9HZV6?trackAsin=B0CXY89JD7'),
    { type: 'album', id: 'B0CXY9HZV6', tld: 'co.uk', trackId: 'B0CXY89JD7', query: '' });
  // The player inside amazon.de is read from music.amazon.de.
  const player = parseAmazonMusicUrl('https://www.amazon.de/music/player/playlists/B00ZR6ZKLQ');
  assert.equal(pageUrl(player), 'https://music.amazon.de/playlists/B00ZR6ZKLQ');
  const own = parseAmazonMusicUrl('https://music.amazon.com/user-playlists/abc123def456?shareId=xyz');
  assert.equal(pageUrl(own), 'https://music.amazon.com/user-playlists/abc123def456?shareId=xyz');
  assert.equal(parseAmazonMusicUrl('https://music.amazon.de/tracks/B0HKXZGTCP').type, 'track');
  assert.equal(parseAmazonMusicUrl('https://music.amazon.de/artists/B01BM755V8/shakira'), null);
  assert.equal(parseAmazonMusicUrl('https://www.amazon.de/dp/B0CXY9HZV6'), null);
});

test('Amazon Music\'s page gives the name and each song', () => {
  const { parseAmazonPage } = require('../src/amazonMusic');
  const row = (title, artist, duration, n) => `<music-image-row data-key="${title}${n}" index="${n + 1}" `
    + `primary-text="${title}" primary-href="/albums/B0X?trackAsin=B0T${n}" secondary-text-1="${artist}" `
    + `secondary-text-2="Album" duration="${duration}" class="hydrated">`;
  const html = '<music-detail-header class="x"></music-detail-header>'
    + '<music-detail-header image-src="a.jpg" label="Playlist" headline="Summer &amp; Sun" tertiary-text="3 SONGS  •  11 MINUTEN">'
    + row('Hips Don&#39;t Lie', 'Shakira feat. Wyclef Jean', '03:40', 0)
    + row('Houdini [Explicit]', 'Dua Lipa', '03:06', 1)
    + '<music-image-row loading="" class="disabled-hover hydrated" s-id="7">'
    + row('La Bicicleta', 'Carlos Vives &amp; Shakira', '1:03:49', 2);
  const page = parseAmazonPage(html);
  assert.equal(page.name, 'Summer & Sun');
  assert.equal(page.total, 3);
  assert.deepEqual(page.tracks.map((t) => [t.title, t.artists, t.duration, t.id]), [
    ['Hips Don\'t Lie', 'Shakira, Wyclef Jean', 220, 'B0T0'],
    ['Houdini', 'Dua Lipa', 186, 'B0T1'],
    ['La Bicicleta', 'Carlos Vives & Shakira', 3829, 'B0T2'],
  ]);
  // An album's rows leave the artist to the top of the page.
  const album = parseAmazonPage('<music-detail-header label="Album" headline="Radical Optimism" primary-text="Dua Lipa" tertiary-text="11 SONGS">'
    + '<music-text-row data-key="x0" primary-text="Houdini" primary-href="/tracks/B0CXY89JD7" secondary-text-2="" duration="03:06">');
  assert.deepEqual(album.tracks, [{ title: 'Houdini', artists: 'Dua Lipa', duration: 186, playable: true, id: 'B0CXY89JD7' }]);
  // The home page, where a link from another country's store leads.
  assert.throws(() => parseAmazonPage('<html><music-app></music-app></html>'), /shows nothing/);
  assert.throws(() => parseAmazonPage('<music-detail-header headline="X" tertiary-text="5 SONGS">'), /changed/);
});

test('Deezer links and songs', () => {
  const { parseDeezerUrl, trackOf } = require('../src/deezer');
  assert.deepEqual(parseDeezerUrl('https://www.deezer.com/en/playlist/4524622884'), { type: 'playlist', id: '4524622884' });
  assert.deepEqual(parseDeezerUrl('deezer.com/album/302127?utm_source=x'), { type: 'album', id: '302127' });
  assert.deepEqual(parseDeezerUrl('https://www.deezer.com/de/track/3135556'), { type: 'track', id: '3135556' });
  assert.deepEqual(parseDeezerUrl('https://link.deezer.com/s/31abcDEF'), { short: 'https://link.deezer.com/s/31abcDEF' });
  assert.equal(parseDeezerUrl('https://www.deezer.com/en/artist/27'), null);
  assert.deepEqual(trackOf({ title: 'Dai Dai', artist: { name: 'Shakira' }, duration: 223, readable: true }),
    { title: 'Dai Dai', artists: 'Shakira', duration: 223, playable: true });
  // A song of its own lists everyone on it; an album's song may lean on the album's artist.
  assert.equal(trackOf({ title: 'X', contributors: [{ name: 'Carlos Vives' }, { name: 'Shakira' }] }).artists, 'Carlos Vives, Shakira');
  assert.equal(trackOf({ title: 'X', readable: false }, 'Daft Punk').artists, 'Daft Punk');
  // Not playable on Deezer is no reason to leave it out: it comes from YouTube.
  assert.equal(trackOf({ title: 'X', readable: false }).playable, true);
});

test('lists found on YouTube by name: Spotify, Deezer, Amazon Music', () => {
  const { isNameOnlyList } = require('../src/text');
  assert.equal(isNameOnlyList('https://open.spotify.com/playlist/x'), true);
  assert.equal(isNameOnlyList('spotify:album:abc'), true);
  assert.equal(isNameOnlyList('https://www.deezer.com/playlist/4524622884'), true);
  assert.equal(isNameOnlyList('https://music.amazon.de/playlists/B0HJJ7HKT6'), true);
  assert.equal(isNameOnlyList('https://www.amazon.de/music/player/albums/B0CXY9HZV6'), true);
  assert.equal(isNameOnlyList('https://www.amazon.de/dp/B0CXY9HZV6'), false);
  assert.equal(isNameOnlyList('https://www.youtube.com/playlist?list=PL1'), false);
  assert.equal(isNameOnlyList(''), false);
});
