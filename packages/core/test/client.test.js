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
  const { files, outside } = graph(path.join(SRC, 'client', 'remote.js'));
  assert.deepEqual(outside, []);
  assert.ok(files.includes(path.join('client', 'common.js')));
  assert.ok(builtinModules.includes('fs'));
});

test('random ids are hex of the length asked for', () => {
  const { randomHex } = require('../src/client/common');
  assert.match(randomHex(8), /^[0-9a-f]{16}$/);
  assert.notEqual(randomHex(8), randomHex(8));
});
