'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jsQR = require('jsqr');
const qr = require('../src/qr');

/** The code drawn as an RGBA picture (4 px a module, quiet zone around), read back by jsQR. */
function read(code) {
  const scale = 4;
  const quiet = 4;
  const w = (code.size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < code.size; y += 1) {
    for (let x = 0; x < code.size; x += 1) {
      if (!code.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const i = (((y + quiet) * scale + dy) * w + (x + quiet) * scale + dx) * 4;
          px[i] = 0;
          px[i + 1] = 0;
          px[i + 2] = 0;
        }
      }
    }
  }
  const found = jsQR(px, w, w);
  return found ? found.data : null;
}

test('QR codes of every length up to a long link read back as they were', () => {
  const versions = new Set();
  for (const n of [1, 5, 14, 20, 26, 42, 60, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412]) {
    const text = 'flow://connect?' + 'abcdefghij0123456789'.repeat(30).slice(0, n);
    const code = qr.encode(text);
    versions.add(code.version);
    assert.equal(code.size, code.version * 4 + 17);
    assert.equal(read(code), text, `${n} characters, version ${code.version}`);
  }
  assert.ok(versions.size >= 12, `versions ${[...versions].join(', ')}`);
  // UTF-8 too: a server named with umlauts.
  const named = 'flow://connect?name=K%C3%BCche&x=Küche';
  assert.equal(read(qr.encode(named)), named);
  assert.match(qr.toTerminal(qr.encode('hi')), /█/);
});
