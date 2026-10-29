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
  for (const entry of ['client/remote.js', 'client/localLibrary.js', 'client/settings.js', 'client/actions.js', 'client/privateStats.js', 'client/trackedProfiles.js', 'fileMeta.js']) {
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

test("a file's title tag is cleaned like a name, unless Flow wrote it", () => {
  const { metaFromFile } = require('../src/fileMeta');
  const names = (tags) => {
    const m = metaFromFile('/x/whatever.mp3', tags);
    return [m.artist, m.title, m.mix];
  };
  assert.deepEqual(names({ title: 'Numb [asdf]', artist: 'Linkin Park' }), ['Linkin Park', 'Numb', '']);
  assert.deepEqual(names({ title: 'Strobe (Original Mix) [Free Download]', artist: 'deadmau5' }), ['deadmau5', 'Strobe', 'Original Mix']);
  assert.deepEqual(names({ title: 'Song (feat. Singer) [Official Video]', artist: 'Artist' }), ['Artist feat. Singer', 'Song', '']);
  // A mix tag and a mix in the title both kept, the same one once.
  assert.deepEqual(names({ title: 'Song (Live)', artist: 'A', mix: 'Extended' }), ['A', 'Song', 'Extended, Live']);
  assert.deepEqual(names({ title: 'Song (Remix)', artist: 'A', mix: 'remix' }), ['A', 'Song', 'remix']);
  // Flow's own file (its flowid): its names as Flow wrote them.
  assert.deepEqual(names({ title: 'Song (Live) [2010]', artist: 'A', flowid: 'lib1:song1' }), ['A', 'Song (Live) [2010]', '']);
  // No title tag: from the file name, as before.
  assert.deepEqual(metaFromFile('/x/Muse - Uprising [abc].mp3').title, 'Uprising');
});

test('random ids are hex of the length asked for', () => {
  const { randomHex } = require('../src/client/common');
  assert.match(randomHex(8), /^[0-9a-f]{16}$/);
  assert.notEqual(randomHex(8), randomHex(8));
});

test('base64url as Node writes it, at every length', () => {
  const { base64Url, randomBase64Url } = require('../src/client/common');
  for (let len = 0; len < 40; len += 1) {
    const bytes = require('crypto').randomBytes(len);
    assert.equal(base64Url(bytes), bytes.toString('base64url'));
  }
  assert.match(randomBase64Url(12), /^[\w-]{16}$/);
});

test('settings: cleaned, saved whole, and one id made once', () => {
  const { createSettings, DEFAULTS } = require('../src/client/settings');
  const saved = [];
  const s = createSettings({ read: () => ({ volume: 3, crossfadeSeconds: 'x' }), write: (v) => saved.push(v) });
  assert.equal(s.get('volume'), 1);
  assert.equal(s.get('crossfadeSeconds'), DEFAULTS.crossfadeSeconds);
  const id = s.clientId();
  assert.match(id, /^[\w-]{16}$/);
  assert.equal(s.clientId(), id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].clientId, id);
  const broken = createSettings({ read: () => null, write: () => { throw new Error('read-only'); } });
  assert.equal(broken.set({ volume: 0.5 }).volume, 0.5);
});

test('settings: what the phone\'s update check saved is dropped', () => {
  const { clean } = require('../src/client/settings');
  const s = clean({ updateFound: { version: '3.0.1', url: 'https://example.com/Flow.apk' }, updateNoPrompt: true, batteryHelpShown: true });
  assert.equal('updateFound' in s, false);
  assert.equal('updateNoPrompt' in s, false);
  assert.equal(s.batteryHelpShown, true);
});

test('settings: the phones get the clouds off once, then as the user leaves them', () => {
  const { createSettings, cloudsOffOnce } = require('../src/client/settings');
  let file = null;
  const make = () => createSettings({ read: () => cloudsOffOnce(file), write: (v) => { file = JSON.parse(JSON.stringify(v)); } });
  // A new install, and one from before with the clouds saved on.
  assert.equal(make().get('cloudsOn'), false);
  file = { cloudsOn: true, volume: 0.4 };
  const old = make();
  assert.equal(old.get('cloudsOn'), false);
  assert.equal(old.get('volume'), 0.4);
  // Turned on by the user: they stay on.
  old.set({ cloudsOn: true });
  assert.equal(make().get('cloudsOn'), true);
});
