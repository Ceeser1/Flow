'use strict';

// The shared client (src/client) also runs in the Android app's WebView: it
// and everything it loads must do without Node's own modules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const SRC = path.join(__dirname, '..', 'src');

/** Every file `entry` loads, and every require of something not in src. */
function graph(entry) {
  const seen = new Set();
  const outside = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
      const name = m[1];
      if (!name.startsWith('.')) {
        outside.push(`${path.relative(SRC, file)}: ${name}`);
        continue;
      }
      visit(require.resolve(path.join(path.dirname(file), name)));
    }
  };
  visit(entry);
  return { files: [...seen].map((f) => path.relative(SRC, f)), outside };
}

test('the shared client loads no Node module, nor anything outside @flow/core', () => {
  for (const entry of ['client/remote.js', 'client/localLibrary.js', 'fileMeta.js']) {
    const { files, outside } = graph(path.join(SRC, entry));
    assert.deepEqual(outside, [], entry);
    assert.ok(files.length >= 1);
  }
  assert.ok(graph(path.join(SRC, 'client', 'remote.js')).files.includes(path.join('client', 'common.js')));
  // The check itself sees Node's modules.
  assert.ok(graph(path.join(SRC, 'jsonFile.js')).outside.some((x) => x.endsWith(': fs')));
  assert.ok(builtinModules.includes('fs'));
});

test('the Local Files library: changes saved and told, a throw saves nothing', () => {
  const { createLocalLibrary } = require('../src/client/localLibrary');
  const saved = [];
  const lib = createLocalLibrary({ read: () => null, write: (d) => saved.push(JSON.parse(JSON.stringify(d))) });
  const told = [];
  lib.onChange((d) => told.push(d.playlists.length));
  const model = require('../src/libraryModel');
  const p = lib.mutate((d) => model.createPlaylist(d, 'Evening', lib.newId()));
  assert.match(p.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(told, [1]);
  assert.equal(saved.length, 1);
  assert.throws(() => lib.mutate(() => {
    throw new Error('no');
  }));
  assert.equal(saved.length, 1);
});

test('a file name without folder and extension, on any system', () => {
  const { fileStem, metaFromFile } = require('../src/fileMeta');
  assert.equal(fileStem('C:\\Music\\Air - Playground Love.mp3'), 'Air - Playground Love');
  assert.equal(fileStem('/storage/emulated/0/Music/Moby - Porcelain.opus'), 'Moby - Porcelain');
  assert.equal(fileStem('a.b.flac'), 'a.b');
  assert.equal(fileStem('.hidden'), '.hidden');
  const meta = metaFromFile('/x/Moby - Porcelain.opus');
  assert.equal(meta.artist, 'Moby');
  assert.equal(meta.title, 'Porcelain');
});

test('random ids are hex of the length asked for', () => {
  const { randomHex } = require('../src/client/common');
  assert.match(randomHex(8), /^[0-9a-f]{16}$/);
  assert.notEqual(randomHex(8), randomHex(8));
});
