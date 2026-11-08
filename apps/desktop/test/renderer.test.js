'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('url');
const Util = require('../renderer/app/util');
const PlayQueue = require('../renderer/app/queue');

test('clock and date formats', () => {
  assert.equal(Util.fmtClock(65), '1:05');
  assert.equal(Util.fmtClock(3723), '1:02:03');
  assert.equal(Util.fmtDate(new Date(2026, 8, 5, 7, 3).getTime()), '05.09.26 07:03');
  assert.equal(Util.fmtPrecise(83.4567), '00:01:23.457');
  assert.equal(Util.parsePrecise('1:30.5'), 90.5);
  assert.throws(() => Util.parsePrecise('abc'));
});

test('a server address typed without http(s):// gets https:// where the shared client connects over https', () => {
  const { completeAddress } = require('@flow/core/address');
  for (const a of ['ceeser.de', 'ceeser.de/flow', ' flow-test.duckdns.org ', 'music.example.com:443', 'Music.Example.com/flow/',
    '192.168.0.61:7878', '192.168.0.61', '999.1.1.1', '[fd7a::1]:7878', 'fe80::1', 'localhost', 'raspberrypi', 'pi.local', 'pi.lan',
    'pi.home.arpa', 'pi.tail1234.ts.net', 'flow.example.com:7878', 'flow.example.com:80', 'http://ceeser.de', 'https://ceeser.de', '']) {
    assert.equal(Util.serverAddress(a), completeAddress(a), a);
  }
  assert.equal(Util.serverAddress('ceeser.de/flow'), 'https://ceeser.de/flow');
  assert.equal(Util.serverAddress('192.168.0.61:7878'), '192.168.0.61:7878');
});

test('file URLs match Node\'s own', () => {
  for (const p of ['C:\\Users\\A B\\Music\\FlowPlayer\\x #1 (Remix) 100%.mp3',
    'D:\\Müsik\\Björk - Jóga.opus', 'C:\\a\\it\'s [live]!.flac']) {
    assert.equal(Util.fileUrl(p), pathToFileURL(p, { windows: true }).href);
  }
});

test('file URLs for Linux paths', () => {
  // Hard-coded: Node's pathToFileURL follows the OS the test runs on.
  assert.equal(Util.fileUrl('/home/a b/Music/FlowPlayer/x #1 (Remix) 100%.mp3'),
    'file:///home/a%20b/Music/FlowPlayer/x%20%231%20(Remix)%20100%25.mp3');
  assert.equal(Util.fileUrl('/mnt/Müsik/Björk - Jóga.opus'), 'file:///mnt/M%C3%BCsik/Bj%C3%B6rk%20-%20J%C3%B3ga.opus');
  // \ is part of a Linux file name, not a folder.
  assert.equal(Util.fileUrl('/home/a/AC\\DC - Thunder.mp3'), 'file:///home/a/AC%5CDC%20-%20Thunder.mp3');
  assert.equal(Util.fileUrl('/home/a/Covers/local/abc.jpg'), 'file:///home/a/Covers/local/abc.jpg');
});

test('sort cycles asc, desc, off', () => {
  let s = Util.cycleSort(null, 'title');
  assert.deepEqual(s, { key: 'title', dir: 'asc' });
  s = Util.cycleSort(s, 'title');
  assert.equal(s.dir, 'desc');
  s = Util.cycleSort(s, 'title');
  assert.equal(s.key, null);
  assert.deepEqual(Util.cycleSort({ key: 'title', dir: 'desc' }, 'artist'), { key: 'artist', dir: 'asc' });
});

test('sortRows keeps empties last both ways and sorts numbers', () => {
  const rows = [{ m: 'b' }, { m: '' }, { m: 'A' }, { m: 'c' }];
  const get = (r, k) => r[k];
  assert.deepEqual(Util.sortRows(rows, { key: 'm', dir: 'asc' }, get).map((r) => r.m), ['A', 'b', 'c', '']);
  assert.deepEqual(Util.sortRows(rows, { key: 'm', dir: 'desc' }, get).map((r) => r.m), ['c', 'b', 'A', '']);
  assert.deepEqual(Util.sortRows(rows, { key: null }, get), rows);
  const nums = [{ d: 10 }, { d: 9 }, { d: 100 }];
  assert.deepEqual(Util.sortRows(nums, { key: 'd', dir: 'asc' }, get).map((r) => r.d), [9, 10, 100]);
});

test('search matching ignores case and accents, all words must match', () => {
  assert.ok(Util.matches('bjork jo', 'Jóga', 'Björk'));
  assert.ok(!Util.matches('bjork remix', 'Jóga', 'Björk'));
  assert.ok(Util.matches('', 'x'));
});

test('long lists: sort keys sort without case or accents and numbers by value, stable, empties last', () => {
  const titles = ['song 10', 'Song 2', 'Ärger', 'apfel', 'song 02b', 'Zebra', ''];
  const rows = titles.map((t, i) => ({ t, i }));
  const asc = Util.sortByKeys(rows, { key: 't', dir: 'asc' }, (r) => Util.sortKey(r.t)).map((r) => r.t);
  assert.deepEqual(asc, ['apfel', 'Ärger', 'Song 2', 'song 02b', 'song 10', 'Zebra', '']);
  const desc = Util.sortByKeys(rows, { key: 't', dir: 'desc' }, (r) => Util.sortKey(r.t)).map((r) => r.t);
  assert.deepEqual(desc, ['Zebra', 'song 10', 'song 02b', 'Song 2', 'Ärger', 'apfel', '']);
  // Ties keep their order both ways; no sort gives the rows themselves.
  const ties = [{ k: 'a', n: 1 }, { k: 'A', n: 2 }, { k: 'b', n: 3 }];
  assert.deepEqual(Util.sortByKeys(ties, { key: 'k', dir: 'desc' }, (r) => Util.sortKey(r.k)).map((r) => r.n), [3, 1, 2]);
  assert.equal(Util.sortByKeys(ties, { key: null }, () => ''), ties);
  // Descending made from ascending in one pass is the same as sorting descending.
  const many = Array.from({ length: 300 }, (_, i) => ({ t: ['b', 'A', '', 'a', 'c 2', 'c 10', 'é'][i % 7], i }));
  const key = (r) => Util.sortKey(r.t);
  const ascMany = Util.sortByKeys(many, { key: 't', dir: 'asc' }, key);
  assert.deepEqual(Util.reverseSorted(ascMany, 't', key), Util.sortByKeys(many, { key: 't', dir: 'desc' }, key));
  // Numbers as they are.
  assert.deepEqual(Util.sortByKeys([{ d: 30 }, { d: 5 }, { d: 200 }], { key: 'd', dir: 'asc' }, (r) => r.d).map((r) => r.d), [5, 30, 200]);
});

test('long lists: a song\'s search text is made once and found by all words, case and accents aside', () => {
  const song = { title: 'Über Nacht', artist: 'Dame', mix: '', album: 'Notiz an mich', genre: 'Hip-Hop', subGenre: '' };
  assert.equal(Util.songHay(song), Util.songHay(song));
  assert.equal(Util.hasWords(Util.songHay(song), Util.queryWords('uber dame')), true);
  assert.equal(Util.hasWords(Util.songHay(song), Util.queryWords('  NOTIZ  hip ')), true);
  assert.equal(Util.hasWords(Util.songHay(song), Util.queryWords('dame techno')), false);
  assert.deepEqual(Util.queryWords('   '), []);
  assert.equal(Util.songSortKey(song, 'title'), Util.sortKey('Über Nacht'));
  // A list's own search: titles only.
  assert.equal(Util.hasWords(Util.titleHay(song), Util.queryWords('uber')), true);
  assert.equal(Util.hasWords(Util.titleHay(song), Util.queryWords('dame')), false);
});

test('an artist, album ... picked on the Search page: the songs that have it, case and accents aside', () => {
  const songs = [
    { artist: 'Broiler, Tessa Odden', album: 'Après' },
    { artist: 'Broiler', album: 'apres ' },
    { artist: 'Broilers', album: 'Other' },
  ];
  const pick = (key, value) => songs.filter(Util.fieldMatcher(key, value)).map((s) => songs.indexOf(s));
  assert.deepEqual(pick('artist', 'broiler'), [0, 1]);
  assert.deepEqual(pick('artist', 'Tessa Odden'), [0]);
  assert.deepEqual(pick('artist', 'Broiler, Tessa Odden'), [0]);
  assert.deepEqual(pick('album', 'Après'), [0, 1]);
  assert.deepEqual(pick('genre', 'Pop'), []);
});

test('song line', () => {
  assert.equal(Util.songLine({ title: 'T', artist: 'A', mix: 'M' }), 'T - A - (M)');
  assert.equal(Util.songLine({ title: 'T', artist: '', mix: '' }), 'T');
});

function seeded() {
  let seed = 1;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

const numbered = (n) => Array.from({ length: n }, (_, i) => `s${i + 1}`);

test('queue without shuffle follows the list and wraps', () => {
  const q = new PlayQueue();
  const ids = ['a', 'b', 'c'];
  assert.equal(q.start('p', ids), 'a');
  assert.deepEqual(q.auto, ['b', 'c', 'a']);
  assert.equal(q.next(ids), 'b');
  assert.equal(q.next(ids), 'c');
  assert.equal(q.next(ids), 'a');
  assert.equal(q.prev(ids), 'c');
  assert.equal(q.next(ids), 'a', 'the song gone back from is next again');
});

test('queue holds 20 songs of a long list and adds no. 21 once no. 1 is done', () => {
  const q = new PlayQueue();
  const ids = numbered(50);
  q.start('p', ids);
  assert.deepEqual(q.auto, ids.slice(1, 21));
  q.next(ids);
  assert.equal(q.currentId, 's2');
  assert.deepEqual(q.auto, ids.slice(2, 22));
});

test('a song of the list picked by hand plays now and leaves the queue be', () => {
  const q = new PlayQueue();
  const ids = numbered(50);
  q.start('p', ids);
  q.jump('s10', ids);
  assert.equal(q.currentId, 's10');
  assert.equal(q.auto[0], 's2');
  assert.ok(!q.auto.includes('s10'), 'not queued twice');
  assert.equal(q.auto.length, 20);
  assert.equal(q.next(ids), 's2');
});

test('starting another list builds a new queue, songs added by hand stay first', () => {
  const q = new PlayQueue();
  q.start('p', ['a', 'b', 'c']);
  q.add('x');
  q.add('y');
  assert.equal(q.start('other', ['m', 'n', 'o']), 'm');
  assert.deepEqual(q.auto, ['n', 'o', 'm']);
  assert.equal(q.next(['m', 'n', 'o']), 'x');
  assert.equal(q.next(['m', 'n', 'o']), 'y');
  assert.equal(q.next(['m', 'n', 'o']), 'n');
});

test('queue with shuffle draws every song once before any comes again, prev walks history', () => {
  const q = new PlayQueue(seeded());
  q.setShuffle(true);
  const ids = numbered(30);
  const played = [q.start('p', ids)];
  // The first 20 are queued at once; the rest follow as songs are played.
  assert.equal(new Set([played[0], ...q.auto]).size, 21);
  for (let i = 0; i < 29; i += 1) played.push(q.next(ids));
  assert.deepEqual(played.slice().sort(), ids.slice().sort(), 'a whole round without repeats');
  assert.equal(q.prev(ids), played[28]);
  assert.equal(q.prev(ids), played[27]);
  assert.equal(q.next(ids), played[28]);
});

test('shuffle with one song repeats it', () => {
  const q = new PlayQueue();
  q.setShuffle(true);
  assert.equal(q.start('p', ['a']), 'a');
  assert.equal(q.next(['a']), 'a');
});

test('dragging songs round the queue leaves what the list adds next alone', () => {
  const q = new PlayQueue();
  const ids = numbered(50);
  q.start('p', ids);
  q.move('auto', 19, 0); // s21 to the top
  assert.deepEqual(q.auto.slice(0, 3), ['s21', 's2', 's3']);
  assert.equal(q.next(ids), 's21');
  assert.equal(q.auto[q.auto.length - 1], 's22', 'the list goes on after s21, nothing twice');
  assert.equal(new Set(q.auto).size, q.auto.length);
  q.add('x');
  q.add('y');
  q.move('manual', 1, 0);
  assert.deepEqual(q.manual, ['y', 'x']);
});

test('removing, pruning and a search that hides songs', () => {
  const q = new PlayQueue();
  const ids = numbered(5);
  q.start('p', ids);
  q.add('s4');
  q.removeAt('manual', 0, ids);
  assert.deepEqual(q.manual, []);
  q.removeAt('auto', 0, ids);
  assert.equal(q.auto[0], 's3');
  q.prune((id) => id !== 's3');
  assert.equal(q.auto[0], 's4');
  // Only s1 (playing) and s5 are shown now: the others leave the queue, and
  // the list starts over after s5.
  q.fill(['s1', 's5']);
  assert.deepEqual(q.auto, ['s5', 's1']);
});

test('a queue taken over from a snapshot goes on exactly as the original would', () => {
  const a = new PlayQueue(seeded());
  const ids = numbered(30);
  a.setShuffle(true);
  a.start('p', ids);
  a.next(ids);
  a.add('s7');
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const b = new PlayQueue(seeded());
  b.restore(snap);
  assert.deepEqual(b.snapshot(), a.snapshot());
  // Without shuffle the two go the same way from here.
  a.setShuffle(false, ids);
  b.setShuffle(false, ids);
  for (let i = 0; i < 5; i += 1) assert.equal(b.next(ids), a.next(ids));
  assert.equal(b.prev(ids), a.prev(ids));
  // Nonsense is an empty queue, not a broken one.
  const c = new PlayQueue();
  c.restore({ manual: 'x', auto: [1, 's1'], used: null });
  assert.deepEqual(c.manual, []);
  assert.deepEqual(c.auto, ['s1']);
  assert.equal(c.contextId, null);
});

test('the window\'s copy of libraryPatch.js is core\'s (npm run strings writes it)', () => {
  const fs = require('fs');
  const { SHARED, sharedSource } = require('../scripts/build-strings');
  const path = require('path');
  for (const [name, from] of SHARED) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app', name), 'utf8'), sharedSource(name, fs.readFileSync(from, 'utf8')), name);
  }
});

test('the library reaches the window whole once, then as its changes, and the window\'s copy ends the same', () => {
  const WindowPatch = require('../renderer/app/libraryPatch');
  const { createViewChannel } = require('@flow/core/client/viewChannel');
  const sent = [];
  const ch = createViewChannel((msg) => sent.push(JSON.parse(JSON.stringify(msg))));
  const song = (id, extra = {}) => ({ id, title: `T${id}`, artist: 'A', stats: { plays: 0 }, tagged: '', ...extra });
  const lib = { songs: [song('a'), song('b'), song('c')], playlists: [{ id: 'p', name: 'P', entries: [{ songId: 'a', addedAt: 1 }] }], follows: [] };
  let seq = ch.start(lib);
  let mine = JSON.parse(JSON.stringify(lib));
  const take = (msg) => {
    if (!msg.patch) {
      mine = msg.library;
      seq = msg.seq;
      return true;
    }
    if (msg.base !== seq) return false;
    mine = WindowPatch.apply(mine, msg.patch);
    seq = msg.seq;
    return true;
  };
  lib.songs[1].title = 'renamed';
  ch.update(lib);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].patch.map((s) => s[1]), ['songs']);
  assert.deepEqual(sent[0].patch[0][2].put.map((s) => s.id), ['b']);
  const kept = mine.songs[0];
  assert.ok(take(sent[0]));
  assert.equal(mine.songs[0], kept, 'a song that stays is the same object');
  // A song's file tagged shows nowhere: nothing sent.
  lib.songs[0].tagged = 'abc';
  ch.update(lib);
  assert.equal(sent.length, 1);
  lib.songs.push(song('d'));
  lib.playlists[0].entries.push({ songId: 'd', addedAt: 2 });
  ch.update(lib);
  assert.ok(take(sent[1]));
  const { tagged: _a, ...want } = lib.songs[0];
  assert.deepEqual(mine.songs.map((s) => s.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual({ ...mine.songs[0], tagged: undefined }, { ...want, tagged: undefined });
  assert.deepEqual(mine.playlists, lib.playlists);
  // One missed: the next does not fit, the window asks it whole.
  lib.songs.shift();
  ch.update(lib);
  lib.follows = ['x'];
  ch.update(lib);
  assert.equal(take(sent[3]), false);
  ch.whole(lib);
  assert.ok(take(sent[4]));
  assert.deepEqual(mine, JSON.parse(JSON.stringify(lib)));
});
