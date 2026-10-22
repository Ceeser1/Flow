'use strict';

// Albums and genres: Apple's and Discogs' search results matched to a song,
// the filler that looks up a library's songs, and how the library keeps what
// it finds.

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
  const got = await info.lookupApple({ artist: 'Marc Korn', title: 'Ready or Not', duration: 156 }, { fetch });
  assert.deepEqual(got, { album: 'Ready Or Not', genre: 'Dance' });
  assert.match(asked, /^https:\/\/itunes\.apple\.com\/search\?.*entity=song.*term=Marc%20Korn%20Ready%20or%20Not$/);
  assert.deepEqual(await info.lookupApple({ artist: 'X', title: 'Nothing' }, { fetch }), { album: '', genre: '' });
  await assert.rejects(info.lookupApple({ title: 'X' }, { fetch: async () => ({ ok: false, status: 503 }) }), /503/);
});

const disc = (title, format, genre, style, id) => ({
  type: 'master', title, format, genre, style, resource_url: `https://api.discogs.com/masters/${id}`,
});
// Discogs' masters holding "Numb" by Linkin Park, 2026-10-22 (some of them).
const NUMB_DISCOGS = [
  disc('Linkin Park - From The "Live In Texas" Album', ['CDr', 'Promo'], ['Rock'], ['Alternative Rock', 'Nu Metal'], 587114),
  disc('Linkin Park - Numb', ['CD', 'Single'], ['Rock'], ['Alternative Rock', 'Nu Metal'], 74535),
  disc('Linkin Park - Papercuts', ['File', 'AAC', 'Compilation'], ['Rock'], ['Alternative Rock', 'Nu Metal'], 1),
  disc('Linkin Park - Road To Revolution: Live At Milton Keynes', ['CD', 'Album', 'DVD'], ['Rock'], ['Alternative Rock', 'Nu Metal'], 2),
  disc('Linkin Park - Meteora', ['CD', 'Album', 'Enhanced'], ['Rock'], ['Nu Metal'], 3),
  disc('Various - Rock Hits 2003', ['CD', 'Compilation'], ['Rock'], ['Pop Rock'], 4),
];

test('Discogs\' result for a song: an artist in common, the album as it came out over singles, live takes and compilations', () => {
  assert.equal(info.pickDiscogs({ artist: 'Linkin Park', title: 'Numb' }, NUMB_DISCOGS).title, 'Linkin Park - Meteora');
  assert.equal(info.pickDiscogs({ artist: 'Linkin Park', title: 'Numb' }, NUMB_DISCOGS.slice(0, 3)).title, 'Linkin Park - Numb');
  // Discogs' "Broiler (2)": the second artist of that name, still Broiler.
  assert.ok(info.scoreDiscogs({ artist: 'Broiler, Tessa Odden' }, disc('Broiler (2) - The Beginning', ['Album'], [], [], 5)) > 0);
  assert.equal(info.pickDiscogs({ artist: 'Moby', title: 'Numb' }, NUMB_DISCOGS), null);
  // A sampler of many is never the song's.
  assert.equal(info.pickDiscogs({ artist: 'Linkin Park', title: 'Numb' }, NUMB_DISCOGS.slice(5)), null);
});

test('a Discogs lookup: masters first, else releases; the first style is the Info; the album only from a tracklist holding the song', async () => {
  const asked = [];
  const answers = {
    master: { results: [] },
    release: { results: [disc('Headhunterz - Dragonborn', ['File', 'MP3', 'Single'], ['Electronic'], ['Hardstyle', 'Euphoric Hardstyle'], 865172)] },
    'masters/865172': { title: 'Dragonborn', tracklist: [{ title: 'Dragonborn', duration: '5:35' }] },
  };
  const fetch = async (url, init) => {
    asked.push(url);
    assert.match(init.headers['User-Agent'], /^Flow /);
    const key = url.includes('/database/search') ? new URL(url).searchParams.get('type') : url.replace('https://api.discogs.com/', '');
    return { ok: true, json: async () => answers[key] };
  };
  const song = { artist: 'Headhunterz', title: 'Dragonborn' };
  assert.deepEqual(await info.lookupDiscogs(song, { fetch, gapMs: 0 }), { album: 'Dragonborn', genre: 'Electronic', subGenre: 'Hardstyle' });
  assert.equal(asked.length, 3);
  assert.match(asked[0], /\/database\/search\?type=master&.*track=Dragonborn&artist=Headhunterz$/);
  // An album known: the tracklist is not asked for.
  asked.length = 0;
  assert.deepEqual(await info.lookupDiscogs({ ...song, album: 'Mine' }, { fetch, gapMs: 0 }), { album: '', genre: 'Electronic', subGenre: 'Hardstyle' });
  assert.equal(asked.length, 2);
  // A tracklist without the song: no album, the rest still.
  answers['masters/865172'].tracklist = [{ title: 'Other Song' }];
  assert.equal((await info.lookupDiscogs(song, { fetch, gapMs: 0 })).album, '');
  // The first artist of several is asked for.
  asked.length = 0;
  await info.lookupDiscogs({ artist: 'Headhunterz, Krewella', title: 'United Kids of the World', album: 'X' }, { fetch, gapMs: 0 });
  assert.match(asked[0], /&artist=Headhunterz$/);
  await assert.rejects(info.lookupDiscogs(song, { fetch: async () => ({ ok: false, status: 429 }), gapMs: 0 }), /429/);
});

test('a song\'s lookup: Apple for album and genre, Discogs for what is still empty, failures only thrown when nothing came or strict', async () => {
  const calls = [];
  const apple = async (s) => {
    calls.push(`apple ${s.title}`);
    return { album: 'Meteora', genre: '' };
  };
  const discogs = async (s) => {
    calls.push(`discogs ${s.album}`);
    return { album: 'Other', genre: 'Rock', subGenre: 'Nu Metal' };
  };
  assert.deepEqual(await info.lookupInfo({ artist: 'Linkin Park', title: 'Numb' }, { apple, discogs }),
    { album: 'Meteora', genre: 'Rock', subGenre: 'Nu Metal' });
  // Discogs is told the album Apple found, so it does not look for one.
  assert.deepEqual(calls, ['apple Numb', 'discogs Meteora']);
  // Album and genre known: Discogs alone, for the Info; all known: nobody.
  calls.length = 0;
  assert.equal((await info.lookupInfo({ title: 'Numb', album: 'A', genre: 'G' }, { apple, discogs })).subGenre, 'Nu Metal');
  await info.lookupInfo({ title: 'Numb', album: 'A', genre: 'G', subGenre: 'Mine' }, { apple, discogs });
  assert.deepEqual(calls, ['discogs A']);
  const down = async () => {
    throw new Error('down');
  };
  // One down: what the other found, unless strict (the filler tries again later).
  assert.equal((await info.lookupInfo({ title: 'Numb' }, { apple: down, discogs })).genre, 'Rock');
  assert.equal((await info.lookupInfo({ title: 'Numb' }, { apple, discogs: down })).album, 'Meteora');
  await assert.rejects(info.lookupInfo({ title: 'Numb' }, { apple, discogs: down, strict: true }), /down/);
  await assert.rejects(info.lookupInfo({ title: 'Numb' }, { apple: down, discogs: down }), /down/);
});

test('the filler looks up each song once, keeps what a song has, and tries one Apple missed again later', async () => {
  const d = m.emptyLibrary();
  m.addSong(d, { id: 'a', file: 'a.mp3', title: 'Ready or Not', artist: 'Marc Korn' });
  m.addSong(d, { id: 'b', file: 'b.mp3', title: 'Unknown Song', artist: 'Nobody' });
  m.addSong(d, { id: 'c', file: 'c.mp3', title: 'Tagged', artist: 'Someone', album: 'From The File', genre: 'Techno' });
  m.addSong(d, { id: 'd', file: 'd.mp3', title: 'Offline', artist: 'Someone' });
  m.addSong(d, { id: 'e', file: 'e.mp3', title: 'Known', artist: 'Someone', album: 'A', genre: 'G', subGenre: 'I' });
  const asked = [];
  const options = [];
  const filler = info.createInfoFiller({
    nextSong: (tried) => d.songs.find((s) => !s.infoLooked && !tried.has(s.id)) || null,
    save: (found) => {
      for (const f of found) m.setInfo(d, f.id, f);
    },
    lookup: async (s, opts) => {
      asked.push(s.id);
      options.push(opts);
      if (s.id === 'd') throw new Error('offline');
      if (s.id === 'c') return { album: 'Other', genre: 'Other', subGenre: 'Hard Techno' };
      return s.id === 'a' ? { album: 'Ready Or Not', genre: 'Dance' } : { album: '', genre: '' };
    },
    pauseMs: 0,
  });
  await filler.run();
  // c has album and genre from its file, but no Info; e has all three.
  assert.deepEqual(asked, ['a', 'b', 'c', 'd']);
  assert.ok(options.every((o) => o.strict === true));
  const get = (id) => m.songById(d, id);
  assert.deepEqual([get('a').album, get('a').genre, get('a').infoLooked], ['Ready Or Not', 'Dance', true]);
  // Nothing found: the title is the album.
  assert.deepEqual([get('b').album, get('b').genre, get('b').infoLooked], ['Unknown Song', '', true]);
  assert.deepEqual([get('c').album, get('c').genre, get('c').subGenre, get('c').infoLooked], ['From The File', 'Techno', 'Hard Techno', true]);
  assert.equal(get('d').infoLooked, false);
  assert.equal(get('e').infoLooked, true);
});

test('a library looked up before Discogs: its songs missing anything are looked up once more', () => {
  const d = m.sanitize({
    songs: [
      { id: 'a', file: 'a', title: 'A', album: 'A', genre: 'Pop', infoLooked: true },
      { id: 'b', file: 'b', title: 'B', album: 'B', genre: 'Pop', subGenre: 'Dance-pop', infoLooked: true },
      { id: 'c', file: 'c', title: 'C' },
    ],
  });
  assert.equal(d.infoRound, 0);
  assert.equal(m.startInfoRound(d), true);
  assert.deepEqual(d.songs.map((s) => s.infoLooked), [false, true, false]);
  assert.equal(m.sanitize(JSON.parse(JSON.stringify(d))).infoRound, 2);
  // Once only, and a new library is looked up the new way from the start.
  d.songs[1].infoLooked = true;
  assert.equal(m.startInfoRound(d), false);
  assert.equal(m.startInfoRound(m.emptyLibrary()), false);
  assert.equal(m.startInfoRound(m.sanitize(null)), false);
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

test('a downloaded song\'s album and genre: the list\'s, else its page\'s, else the lookup\'s', async () => {
  const { createLister } = require('../src/listing');
  const asked = [];
  const lister = createLister({
    media: {},
    library: () => m.emptyLibrary(),
    lookupInfo: async (s) => {
      asked.push(s.title);
      return { album: 'From Apple', genre: 'Dance', subGenre: 'Euro House' };
    },
  });
  // A Spotify album's song: its album; the genre from Apple.
  const probed = { duration: 200, guess: { album: 'From The Page', genre: '' } };
  assert.deepEqual(await lister.withInfo({ artist: 'A', title: 'One', mix: '', album: 'From Spotify' }, probed),
    { artist: 'A', title: 'One', mix: '', album: 'From Spotify', genre: 'Dance', subGenre: 'Euro House' });
  // Both on the page (SoundCloud's genre, YouTube Music's album): asked for the Info only, the page's stay.
  assert.deepEqual(await lister.withInfo({ artist: 'A', title: 'Two', mix: '' }, { duration: 1, guess: { album: 'Page', genre: 'Rock' } }),
    { artist: 'A', title: 'Two', mix: '', album: 'Page', genre: 'Rock', subGenre: 'Euro House' });
  // All three known: nobody is asked.
  await lister.withInfo({ artist: 'A', title: 'Six', album: 'X', genre: 'Y', subGenre: 'Z' }, { guess: {} });
  assert.deepEqual(asked, ['One', 'Two']);
  // A sub-genre given (the box above the frames) stays; one from the page fills an empty one.
  assert.equal((await lister.withInfo({ title: 'Four', subGenre: 'Melodic' }, { guess: { subGenre: 'Raw' } })).subGenre, 'Melodic');
  assert.equal((await lister.withInfo({ title: 'Five' }, { guess: { subGenre: 'Raw' } })).subGenre, 'Raw');
  // Without a lookup, or with Apple out of reach: what there is.
  const off = createLister({ media: {}, library: () => m.emptyLibrary(), lookupInfo: async () => { throw new Error('offline'); } });
  assert.equal((await off.withInfo({ title: 'Three' }, { guess: {} })).album, '');
});
