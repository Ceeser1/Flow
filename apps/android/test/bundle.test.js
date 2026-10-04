'use strict';

// The shared client as the WebView gets it (inside www/flow-android.js): it
// builds for the browser, and runs where there is no require, process or Buffer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { bundle } = require('../scripts/bundle');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-bundle-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function load() {
  const code = fs.readFileSync(bundle(path.join(scratch, 'flow-core.js'), { entry: 'core.js', globalName: 'FlowCore' }), 'utf8');
  // What a page has: no require, process or Buffer.
  const page = vm.createContext({
    crypto: require('crypto').webcrypto, URL, setTimeout, clearTimeout, setInterval, clearInterval, console,
  });
  vm.runInContext(`${code}\nthis.FlowCore = FlowCore;`, page);
  return page.FlowCore;
}

test('the shared client runs in a page', () => {
  const FlowCore = load();
  const saved = {};
  const settings = FlowCore.createSettings({ read: () => saved.settings || null, write: (v) => { saved.settings = v; } });
  assert.match(settings.clientId(), /^[\w-]{16}$/);
  const library = FlowCore.createLocalLibrary({ read: () => null, write: (d) => { saved.library = d; } });
  library.quietly = async (fn) => fn();

  const remote = FlowCore.createRemote({
    settings,
    library,
    covers: {},
    jsonFiles: { read: () => null, write: () => {} },
    files: {},
    paths: {},
    exporter: {},
    http: {},
    secrets: { encrypt: (t) => t, decrypt: (t) => t },
    device: { name: () => 'Pixel' },
    discovery: { find: async () => [], addressOf: () => '' },
    network: { isMetered: async () => false },
  });
  assert.equal(remote.active(), false);
  assert.equal(remote.status().state, 'off');
  assert.equal(remote.status().clientId, settings.get('clientId'));

  const actions = FlowCore.createActions({ remote, library, files: { exists: () => false, rm: () => {} } });
  const p = actions.createPlaylist('Evening');
  assert.equal(saved.library.playlists[0].id, p.id);
  assert.equal(FlowCore.fileMeta.metaFromFile('/x/Moby - Porcelain.opus').artist, 'Moby');
});

test('window.flow for the phone builds for the browser', () => {
  const code = fs.readFileSync(bundle(path.join(scratch, 'flow-android.js')), 'utf8');
  assert.match(code, /window\.flow = start\(\)/);
  assert.doesNotMatch(code, /require\("(fs|path|os|crypto|http|https|dgram|child_process)"\)/);
});
