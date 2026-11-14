'use strict';

// Add Songs' downloads kept over a restart (4.5.3, src/keptDownloads.js): the
// window's state written and read back, the songs gone from the cache marked,
// and the cache emptied at the start but for the songs still kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-kept-'));
process.env.FLOW_HOME = path.join(scratch, 'home');
process.env.FLOW_MUSIC = path.join(scratch, 'music');

const paths = require('../src/paths');
const kept = require('../src/keptDownloads');
const downloader = require('../src/downloader');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('kept downloads: written as the window sends them, read back with the songs gone from the cache marked', () => {
  const cache = paths.cacheDir();
  const a = path.join(cache, 'a.m4a');
  const b = path.join(cache, 'b.m4a');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(`${a}.cover.jpg`, 'jpg');
  const original = path.join(scratch, 'pick', 'c.flac');
  const state = {
    version: 1,
    queue: [{ url: 'https://example.com/list', kind: 'list' }],
    batches: [
      { state: 'trimming', included: [{ index: 0, state: 'ready', media: { path: a } }, { index: 1, state: 'ready', media: { path: b } }] },
      { state: 'downloading', local: true, included: [{ index: 0, path: original, state: null }] },
    ],
  };
  kept.save(JSON.stringify(state));
  const back = kept.load();
  assert.deepEqual(back.state.queue, state.queue);
  assert.deepEqual(back.state.batches[0].included.map((it) => !!it.missing), [false, true], 'b is gone from the cache');
  assert.deepEqual(back.originals, [original], 'a local file not prepared yet may be moved later');
  // The cache at the start: what the kept batches hold stays (their covers too), the rest goes.
  const stray = path.join(cache, 'abandoned.webm');
  fs.writeFileSync(stray, 'x');
  downloader.clearCache(kept.cacheFiles());
  assert.ok(fs.existsSync(a));
  assert.ok(fs.existsSync(`${a}.cover.jpg`));
  assert.ok(!fs.existsSync(stray));
  // Nothing waiting any more: the file goes, and the next start empties the cache.
  kept.save(JSON.stringify({ version: 1, queue: [], batches: [] }));
  assert.ok(!fs.existsSync(kept.file()));
  assert.equal(kept.load(), null);
  downloader.clearCache(kept.cacheFiles());
  assert.ok(!fs.existsSync(a));
});

test('kept downloads: a broken file reads as nothing kept, and nothing written over it from a bad send', () => {
  fs.mkdirSync(path.dirname(kept.file()), { recursive: true });
  fs.writeFileSync(kept.file(), '{ not json');
  assert.equal(kept.load(), null);
  assert.equal(kept.cacheFiles().size, 0);
  kept.save('{ not json either');
  assert.equal(fs.readFileSync(kept.file(), 'utf8'), '{ not json');
});
