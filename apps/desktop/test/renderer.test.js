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

test('file URLs match Node\'s own', () => {
  for (const p of ['C:\\Users\\A B\\Music\\FlowPlayer\\x #1 (Remix) 100%.mp3',
    'D:\\Müsik\\Björk - Jóga.opus', 'C:\\a\\it\'s [live]!.flac']) {
    assert.equal(Util.fileUrl(p), pathToFileURL(p).href);
  }
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
