'use strict';

// The taskbar buttons' icons (5.1.4): drawn white, smoothed at the edges, at every size.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pixels, SHAPES } = require('../src/thumbar');

const alpha = (buf, size, x, y) => buf[(y * size + x) * 4 + 3];

test('each icon is drawn at 16, 24 and 32 pixels: solid inside, nothing in the corners, soft edges', () => {
  for (const name of Object.keys(SHAPES)) {
    for (const size of [16, 24, 32]) {
      const buf = pixels(name, size);
      assert.equal(buf.length, size * size * 4);
      assert.equal(alpha(buf, size, 0, 0), 0, `${name} ${size}: corner`);
      assert.equal(alpha(buf, size, size - 1, size - 1), 0);
      let solid = 0;
      let soft = 0;
      for (let i = 3; i < buf.length; i += 4) {
        if (buf[i] === 255) solid += 1;
        else if (buf[i] > 0) soft += 1;
        // Premultiplied white: every channel as its alpha.
        assert.equal(buf[i - 1], buf[i]);
      }
      assert.ok(solid > size * size * 0.12, `${name} ${size}: ${solid} solid`);
      // Slanted sides are smoothed (the pause bars may sit on whole pixels).
      if (name !== 'pause') assert.ok(soft > 0, `${name} ${size}: smoothed`);
    }
  }
});

test('play points right, its middle filled; pause has a gap between its bars', () => {
  const play = pixels('play', 32);
  assert.equal(alpha(play, 32, 14, 16), 255);
  assert.equal(alpha(play, 32, 29, 4), 0);
  const pause = pixels('pause', 32);
  assert.equal(alpha(pause, 32, 16, 16), 0, 'the gap');
  assert.equal(alpha(pause, 32, 10, 16), 255);
  assert.equal(alpha(pause, 32, 22, 16), 255);
});
