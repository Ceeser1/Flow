'use strict';

// Albums and genres: Apple's search results matched to a song, the filler
// that looks up a library's songs, and how the library keeps what it finds.

const test = require('node:test');
const assert = require('node:assert/strict');
const info = require('../src/songInfo');
const m = require('../src/libraryModel');
const { applyCommand } = require('../src/commands');
const tags = require('../src/tags');
const { metaFromFile } = require('../src/fileMeta');

const result = (trackName, artistName, collectionName, primaryGenreName, seconds) => ({
  wrapperType: 'track', kind: 'song', trackName, artistName, collectionName, primaryGenreName, trackTimeMillis: seconds * 1000,
});

// Apple's answers for "Plastik Bass Marc Korn Ready or Not" and "Daft Punk Get Lucky", 2026-10-22.
const READY = [
  result('Ready Or Not (Extended Mix)', 'Plastik Bass, Marc Korn & Semitoo', 'Ready Or Not - Single', 'Dance', 214),
  result('Ready Or Not', 'Plastik Bass, Marc Korn & Semitoo', 'Ready Or Not - Single', 'Dance', 156),
];
const LUCKY = [
  result('Get Lucky (feat. Pharrell Williams & Nile Rodgers) [Daft Punk Remix]', 'Daft Punk', 'Get Lucky - Single', 'Pop', 382),
  result('Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Daft Punk, Pharrell Williams & Nile Rodgers', 'Random Access Memories (10th Anniversary Edition)', 'Pop', 369),
  result('Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Daft Punk, Pharrell Williams & Nile Rodgers', 'Get Lucky - Single', 'Pop', 369),
  result('Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Daft Punk, Pharrell Williams & Nile Rodgers', 'Random Access Memories', 'Pop', 369),
];
// Some of Apple's answers for "Linkin Park Numb": a live take as long as the studio one.
const NUMB = [
  result('Numb (Live)', 'LINKIN PARK', 'Live In Texas (Audio Version)', 'Hard Rock', 187),
  result('Numb', 'LINKIN PARK', 'Live In Texas', 'Hard Rock', 187),
  result('Numb', 'LINKIN PARK', 'Meteora (Deluxe Edition)', 'Hard Rock', 188),
  result('Numb', 'LINKIN PARK', 'Meteora', 'Hard Rock', 188),
];

test('Apple\'s result for a song: the same title and an artist in common, the same version first', () => {
  const song = { artist: 'Plastik Bass, Marc Korn, Semitoo', title: 'Ready or Not', mix: '', duration: 156 };
  // A single's album is its name, without " - Single".
  assert.deepEqual(info.pickResult(song, READY), { album: 'Ready Or Not', genre: 'Dance' });
  assert.deepEqual(info.pickResult({ ...song, mix: 'Extended Mix', duration: 214 }, READY).album, 'Ready Or Not');
  // Brackets aside, "Get Lucky (feat. ...)" is the song; the remix is not the version without a Mix;
  // the album beats the single and the anniversary edition.
  assert.deepEqual(info.pickResult({ artist: 'Daft Punk', title: 'Get Lucky', duration: 369 }, LUCKY),
    { album: 'Random Access Memories', genre: 'Pop' });
  // A live take is another version, however close its length; the album as it came out first.
  assert.equal(info.pickResult({ artist: 'Linkin Park', title: 'Numb', duration: 187 }, NUMB).album, 'Meteora');
  assert.equal(info.pickResult({ artist: 'Linkin Park', title: 'Numb', mix: 'Live', duration: 187 }, NUMB).album, 'Live In Texas (Audio Version)');
  // Another artist, another title, or a length far off: nothing fits.
  assert.equal(info.pickResult({ artist: 'Moby', title: 'Ready or Not' }, READY), null);
  assert.equal(info.pickResult({ artist: 'Marc Korn', title: 'Easy to Love' }, READY), null);
  assert.equal(info.pickResult({ artist: 'Marc Korn', title: 'Ready or Not', duration: 400 }, READY), null);
  assert.equal(info.cleanAlbum('Nightfall - EP'), 'Nightfall');
  assert.equal(info.cleanAlbum('Singles Club'), 'Singles Club');
});

test('a lookup asks Apple by artist and title and fails when Apple cannot be reached', async () => {
  let asked = '';
  const fetch = async (url) => {
    asked = url;
    return { ok: true, json: async () => ({ results: READY }) };
  };
  const got = await info.lookupInfo({ artist: 'Marc Korn', title: 'Ready or Not', duration: 156 }, { fetch });
  assert.deepEqual(got, { album: 'Ready Or Not', genre: 'Dance' });
  assert.match(asked, /^https:\/\/itunes\.apple\.com\/search\?.*entity=song.*term=Marc%20Korn%20Ready%20or%20Not$/);
  assert.deepEqual(await info.lookupInfo({ artist: 'X', title: 'Nothing' }, { fetch }), { album: '', genre: '' });
  await assert.rejects(info.lookupInfo({ title: 'X' }, { fetch: async () => ({ ok: false, status: 503 }) }), /503/);
});

test('the filler looks up each song once, keeps what a song has, and tries one Apple missed again later', async () => {
  const d = m.emptyLibrary();
  m.addSong(d, { id: 'a', file: 'a.mp3', title: 'Ready or Not', artist: 'Marc Korn' });
  m.addSong(d, { id: 'b', file: 'b.mp3', title: 'Unknown Song', artist: 'Nobody' });
  m.addSong(d, { id: 'c', file: 'c.mp3', title: 'Tagged', artist: 'Someone', album: 'From The File', genre: 'Techno' });
  m.addSong(d, { id: 'd', file: 'd.mp3', title: 'Offline', artist: 'Someone' });
  const asked = [];
  const filler = info.createInfoFiller({
    nextSong: (tried) => d.songs.find((s) => !s.infoLooked && !tried.has(s.id)) || null,
    save: (found) => {
      for (const f of found) m.setInfo(d, f.id, f);
    },
    lookup: async (s) => {
      asked.push(s.id);
      if (s.id === 'd') throw new Error('offline');
      return s.id === 'a' ? { album: 'Ready Or Not', genre: 'Dance' } : { album: '', genre: '' };
    },
    pauseMs: 0,
  });
  await filler.run();
  assert.deepEqual(asked, ['a', 'b', 'd']);
  const get = (id) => m.songById(d, id);
  assert.deepEqual([get('a').album, get('a').genre, get('a').infoLooked], ['Ready Or Not', 'Dance', true]);
  // Nothing found: the title is the album.
  assert.deepEqual([get('b').album, get('b').genre, get('b').infoLooked], ['Unknown Song', '', true]);
  assert.deepEqual([get('c').album, get('c').genre, get('c').infoLooked], ['From The File', 'Techno', true]);
  assert.equal(get('d').infoLooked, false);
});

test('the library: an album set by hand or looked for, empty means the title', () => {
  const d = m.emptyLibrary();
  m.addSong(d, { id: 's1', file: 'a.mp3', title: 'Around the World', artist: 'Daft Punk', infoLooked: true });
  assert.equal(m.songById(d, 's1').album, 'Around the World');
  m.addSong(d, { id: 's2', file: 'b.mp3', title: 'Scanned', artist: 'X' });
  assert.equal(m.songById(d, 's2').album, '');
  assert.equal(m.songById(d, 's2').infoLooked, false);
  m.updateSong(d, 's2', { album: '  Homework  ', genre: 'House' });
  assert.deepEqual([m.songById(d, 's2').album, m.songById(d, 's2').genre, m.songById(d, 's2').infoLooked], ['Homework', 'House', true]);
  m.updateSong(d, 's2', { album: '' });
  assert.equal(m.songById(d, 's2').album, 'Scanned');
  // What a lookup finds never replaces a name set by hand.
  m.setInfo(d, 's2', { album: 'Other', genre: 'Pop' });
  assert.deepEqual([m.songById(d, 's2').album, m.songById(d, 's2').genre], ['Scanned', 'House']);
  // Sub-Genre/Info: set by hand, kept over a lookup's, cleaned like the others.
  m.updateSong(d, 's2', { subGenre: '  from   Bravo Hits 2012 ' });
  m.setInfo(d, 's2', { subGenre: 'Other' });
  assert.equal(m.songById(d, 's2').subGenre, 'from Bravo Hits 2012');
  m.setInfo(d, 's1', { subGenre: 'Melodic' });
  assert.equal(m.songById(d, 's1').subGenre, 'Melodic');
  const again = m.sanitize(JSON.parse(JSON.stringify(d)));
  assert.deepEqual([again.songs[1].album, again.songs[1].genre, again.songs[1].infoLooked], ['Scanned', 'House', true]);
  assert.equal(again.songs[1].subGenre, 'from Bravo Hits 2012');
  assert.equal(m.sanitize({ songs: [{ id: 'x', file: 'x' }] }).songs[0].subGenre, '');
  assert.deepEqual([m.sanitize({ songs: [{ id: 'x', file: 'x' }] }).songs[0].album, m.sanitize({ songs: [{ id: 'x', file: 'x' }] }).songs[0].infoLooked], ['', false]);
});

test('Edit Song\'s command sets album and genre; one from an app without them keeps the song\'s', () => {
  const d = m.emptyLibrary();
  m.addSong(d, { id: 's1', file: '/music/a.mp3', title: 'Da Funk', artist: 'Daft Punk', album: 'Homework', genre: 'House', infoLooked: true });
  applyCommand(d, { type: 'editSong', songId: 's1', artist: 'Daft Punk', title: 'Da Funk', mix: '', album: 'Musique Vol. 1', genre: 'Electronic' });
  assert.deepEqual([m.songById(d, 's1').album, m.songById(d, 's1').genre], ['Musique Vol. 1', 'Electronic']);
  applyCommand(d, { type: 'editSong', songId: 's1', artist: 'Daft Punk', title: 'Da Funk (Live)', mix: '' });
  assert.deepEqual([m.songById(d, 's1').album, m.songById(d, 's1').genre], ['Musique Vol. 1', 'Electronic']);
  applyCommand(d, { type: 'editSong', songId: 's1', artist: 'Daft Punk', title: 'Da Funk', mix: '', album: '', genre: '' });
  assert.deepEqual([m.songById(d, 's1').album, m.songById(d, 's1').genre], ['Da Funk', '']);
  applyCommand(d, { type: 'editSong', songId: 's1', artist: 'Daft Punk', title: 'Da Funk', mix: '', subGenre: 'French House' });
  assert.equal(m.songById(d, 's1').subGenre, 'French House');
  // Not sent (an app from before sub-genres): kept.
  applyCommand(d, { type: 'editSong', songId: 's1', artist: 'Daft Punk', title: 'Da Funk', mix: '', album: '', genre: '' });
  assert.equal(m.songById(d, 's1').subGenre, 'French House');
});

test('album and genre go into a saved file\'s tags and come out of a file\'s', () => {
  const args = tags.tagArgs({ title: 'T', artist: 'A', album: 'Discovery', genre: 'House' }, 'mp3');
  assert.ok(args.includes('album=Discovery') && args.includes('genre=House'));
  assert.ok(!tags.tagArgs({ title: 'T', artist: 'A', album: 'Discovery' }, 'wav').includes('album=Discovery'));
  // Flow's album wins; without one the file keeps its own.
  assert.equal(tags.mergedTags({ album: 'Old', genre: 'Rock' }, { title: 'T', album: 'New' }).album, 'New');
  assert.equal(tags.mergedTags({ album: 'Old', genre: 'Rock' }, { title: 'T' }).genre, 'Rock');
  const meta = metaFromFile('C:/Music/A - B.mp3', { title: 'B', artist: 'A', album: ' Discovery ', genre: 'House' });
  assert.deepEqual([meta.album, meta.genre], ['Discovery', 'House']);
  assert.deepEqual([metaFromFile('C:/Music/A - B.mp3', {}).album, metaFromFile('C:/Music/A - B.mp3', {}).genre], ['', '']);
  // Sub-Genre/Info is the grouping tag.
  assert.ok(tags.tagArgs({ title: 'T', artist: 'A', subGenre: 'Melodic' }, 'opus').includes('grouping=Melodic'));
  assert.equal(tags.mergedTags({ grouping: 'Old' }, { title: 'T', subGenre: 'Raw' }).grouping, 'Raw');
  assert.equal(tags.mergedTags({ grouping: 'Old' }, { title: 'T' }).grouping, 'Old');
  assert.equal(metaFromFile('C:/Music/A - B.mp3', { title: 'B', grouping: ' Melodic ' }).subGenre, 'Melodic');
});

test('a downloaded song\'s album and genre: the list\'s, else its page\'s, else Apple\'s', async () => {
  const { createLister } = require('../src/listing');
  const asked = [];
  const lister = createLister({
    media: {},
    library: () => m.emptyLibrary(),
    lookupInfo: async (s) => {
      asked.push(s.title);
      return { album: 'From Apple', genre: 'Dance' };
    },
  });
  // A Spotify album's song: its album; the genre from Apple.
  const probed = { duration: 200, guess: { album: 'From The Page', genre: '' } };
  assert.deepEqual(await lister.withInfo({ artist: 'A', title: 'One', mix: '', album: 'From Spotify' }, probed),
    { artist: 'A', title: 'One', mix: '', album: 'From Spotify', genre: 'Dance', subGenre: '' });
  // Both on the page (SoundCloud's genre, YouTube Music's album): Apple is not asked.
  assert.deepEqual(await lister.withInfo({ artist: 'A', title: 'Two', mix: '' }, { duration: 1, guess: { album: 'Page', genre: 'Rock' } }),
    { artist: 'A', title: 'Two', mix: '', album: 'Page', genre: 'Rock', subGenre: '' });
  assert.deepEqual(asked, ['One']);
  // A sub-genre given (the box above the frames) stays; one from the page fills an empty one.
  assert.equal((await lister.withInfo({ title: 'Four', subGenre: 'Melodic' }, { guess: { subGenre: 'Raw' } })).subGenre, 'Melodic');
  assert.equal((await lister.withInfo({ title: 'Five' }, { guess: { subGenre: 'Raw' } })).subGenre, 'Raw');
  // Without a lookup, or with Apple out of reach: what there is.
  const off = createLister({ media: {}, library: () => m.emptyLibrary(), lookupInfo: async () => { throw new Error('offline'); } });
  assert.equal((await off.withInfo({ title: 'Three' }, { guess: {} })).album, '');
});
