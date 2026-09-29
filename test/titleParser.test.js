'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guessFromInfo, parseTitle, cleanUploader } = require('../src/titleParser');

const cases = [
  ['Rick Astley - Never Gonna Give You Up (Official Music Video)',
    { artist: 'Rick Astley', title: 'Never Gonna Give You Up', mix: '' }],
  ['Daft Punk - One More Time [Official Video]',
    { artist: 'Daft Punk', title: 'One More Time', mix: '' }],
  ['Avicii - Levels (Skrillex Remix)',
    { artist: 'Avicii', title: 'Levels', mix: 'Skrillex Remix' }],
  ['Artist - Song (Extended Mix) [HD]',
    { artist: 'Artist', title: 'Song', mix: 'Extended Mix' }],
  ['Artist - Song - Extended Mix',
    { artist: 'Artist', title: 'Song', mix: 'Extended Mix' }],
  ['Artist – Song (Official Audio)',
    { artist: 'Artist', title: 'Song', mix: '' }],
  ['Artist - "Song Name" (Lyrics)',
    { artist: 'Artist', title: 'Song Name', mix: '' }],
  ['Artist - Song (feat. Singer) [Official Lyric Video]',
    { artist: 'Artist feat. Singer', title: 'Song', mix: '' }],
  ['Artist ft. Singer - Song',
    { artist: 'Artist feat. Singer', title: 'Song', mix: '' }],
  ['Artist - Song ft. Singer (Radio Edit)',
    { artist: 'Artist feat. Singer', title: 'Song', mix: 'Radio Edit' }],
  ['Artist - Song | Official Video',
    { artist: 'Artist', title: 'Song', mix: '' }],
  ['Artist - Song (Acoustic Version) (Live at Wembley)',
    { artist: 'Artist', title: 'Song', mix: 'Acoustic Version, Live at Wembley' }],
  ['Artist - Song [NCS Release]',
    { artist: 'Artist', title: 'Song', mix: '' }],
  ['Artist - Song (Official HD Music Video)',
    { artist: 'Artist', title: 'Song', mix: '' }],
  ['BLACKPINK - ‘Shut Down’ M/V',
    { artist: 'BLACKPINK', title: 'Shut Down', mix: '' }],
  ["NewJeans (뉴진스) 'Ditto' Official MV",
    { artist: 'NewJeans', title: 'Ditto', mix: '' }],
  ['Levels by Avicii (Lyrics)',
    { artist: 'Avicii', title: 'Levels', mix: '' }],
  ['Rick Astley - Never Gonna Give You Up (Official Music Video) [4K Remaster]',
    { artist: 'Rick Astley', title: 'Never Gonna Give You Up', mix: '' }],
  ['Artist - Song (2015 Remaster)',
    { artist: 'Artist', title: 'Song', mix: '2015 Remaster' }],
  ['Artist - Song (1 Hour Version)',
    { artist: 'Artist', title: 'Song', mix: '' }],
  ['Artist - Song (prod. by Somebody)',
    { artist: 'Artist', title: 'Song', mix: '' }],
  ['Artist - Song Official Video',
    { artist: 'Artist', title: 'Song', mix: '' }],
  ["Queen - Rock 'n' Roll Suicide",
    { artist: 'Queen', title: "Rock 'n' Roll Suicide", mix: '' }],
  ['Song | Artist',
    { artist: 'Artist', title: 'Song', mix: '' }],
  ["Artist 'Song' Remix",
    { artist: 'Artist', title: 'Song', mix: 'Remix' }],
];

for (const [raw, want] of cases) {
  test(`parseTitle: ${raw}`, () => {
    assert.deepEqual(parseTitle(raw), want);
  });
}

test('a soundtrack is filed under the film, the studio channel is skipped', () => {
  const title = '“Golden” Official Lyric Video | KPop Demon Hunters | Sony Animation';
  assert.deepEqual(parseTitle(title, 'Sony Pictures Animation', { uploader: 'Sony Pictures Animation' }),
    { artist: 'KPop Demon Hunters', title: 'Golden', mix: '' });
});

test('"Stand by Me" is not a song called Stand by an artist called Me', () => {
  assert.deepEqual(parseTitle('Stand by Me', 'Ben E. King'),
    { artist: 'Ben E. King', title: 'Stand by Me', mix: '' });
});

test('Title - Artist is turned round when the right side is a known artist', () => {
  const raw = 'Interstellar Main Theme - Hans Zimmer (1 Hour)';
  assert.deepEqual(parseTitle(raw, '', { knownArtists: ['Hans Zimmer'] }),
    { artist: 'Hans Zimmer', title: 'Interstellar Main Theme', mix: '' });
  assert.deepEqual(parseTitle(raw, 'Hans Zimmer', { uploader: 'Hans Zimmer' }),
    { artist: 'Hans Zimmer', title: 'Interstellar Main Theme', mix: '' });
  // Without either hint it stays as written.
  assert.equal(parseTitle(raw).artist, 'Interstellar Main Theme');
});

test('the name part of a filename is read back unchanged', () => {
  assert.deepEqual(parseTitle('Avicii - Levels (Skrillex Remix)'),
    { artist: 'Avicii', title: 'Levels', mix: 'Skrillex Remix' });
});

test('no separator falls back to the uploader as artist', () => {
  assert.deepEqual(parseTitle('Just A Song (Official Video)', 'Uploader'),
    { artist: 'Uploader', title: 'Just A Song', mix: '' });
});

test('no separator and no uploader leaves the artist empty', () => {
  assert.deepEqual(parseTitle('Just A Song'), { artist: '', title: 'Just A Song', mix: '' });
});

test('a title of only clutter is kept rather than emptied', () => {
  assert.equal(parseTitle('(Official Video)').title, '(Official Video)');
});

test('yt-dlp track and artist fields win over the title', () => {
  const g = guessFromInfo({
    title: 'Some Channel Upload - whatever [4K]',
    track: 'Real Song (VIP Mix)',
    artist: 'Real Artist',
    uploader: 'Some Channel',
  });
  assert.deepEqual(g, { artist: 'Real Artist', title: 'Real Song', mix: 'VIP Mix', artistFromChannel: false });
});

test('YouTube\'s own "Title · Artist" description line is read', () => {
  const g = guessFromInfo({
    title: 'Golden',
    uploader: 'HUNTR/X - Topic',
    description: 'Provided to YouTube by Republic Records\n\nGolden · HUNTR/X · EJAE\n\nKPop Demon Hunters',
  });
  assert.deepEqual(g, { artist: 'HUNTR/X, EJAE', title: 'Golden', mix: '', artistFromChannel: false });
});

test('several artists are joined', () => {
  const g = guessFromInfo({ track: 'Song', artists: ['A', 'B'] });
  assert.equal(g.artist, 'A, B');
});

test('SoundCloud style: uploader is the artist when the title has none', () => {
  const g = guessFromInfo({ title: 'Deep Night (Bootleg)', uploader: 'djsomeone' });
  assert.deepEqual(g, { artist: 'djsomeone', title: 'Deep Night', mix: 'Bootleg', artistFromChannel: true });
});

test('an artist found in the title is not marked as the channel\'s', () => {
  const g = guessFromInfo({ title: 'Artist - Song', uploader: 'Some Channel' });
  assert.equal(g.artistFromChannel, false);
});

test('uploader clean-up', () => {
  assert.equal(cleanUploader('Rick Astley - Topic'), 'Rick Astley');
  assert.equal(cleanUploader('RickAstleyVEVO'), 'RickAstley');
  assert.equal(cleanUploader('Band Official'), 'Band');
});
