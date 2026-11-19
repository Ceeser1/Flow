'use strict';

// The clouds' From cover (5.1.5): a cover's colours.

const test = require('node:test');
const assert = require('node:assert/strict');
const CoverColors = require('../renderer/app/coverColors');

/** A picture of `n` pixels: each [r, g, b] as many times as it says. */
function picture(parts) {
  const out = [];
  for (const [rgb, times] of parts) for (let i = 0; i < times; i += 1) out.push(rgb[0], rgb[1], rgb[2], 255);
  return Uint8ClampedArray.from(out);
}

const hueNear = (h, want, by = 12) => Math.min(Math.abs(h - want), 360 - Math.abs(h - want)) <= by;

test('a cover\'s colours, strongest first, far enough apart', () => {
  const p = CoverColors.palette(picture([[[220, 30, 30], 300], [[30, 60, 220], 150], [[230, 40, 40], 50], [[20, 20, 20], 76]]));
  assert.ok(p.length === 2, JSON.stringify(p));
  assert.ok(hueNear(p[0][0], 0), 'red first');
  assert.ok(hueNear(p[1][0], 228), 'then blue');
  assert.ok(p[0][1] > 60);
});

test('black, white and grey count as grey; a speck of colour is not a colour', () => {
  const grey = CoverColors.palette(picture([[[120, 120, 120], 400], [[0, 0, 0], 100], [[255, 255, 255], 76]]));
  assert.equal(grey.length, 1);
  assert.equal(grey[0][1], 0);
  const speck = CoverColors.palette(picture([[[200, 150, 40], 500], [[40, 200, 60], 4]]));
  assert.equal(speck.length, 1, JSON.stringify(speck));
  assert.deepEqual(CoverColors.palette(new Uint8ClampedArray(0)), []);
  // See-through pixels: nothing.
  assert.deepEqual(CoverColors.palette(Uint8ClampedArray.from([255, 0, 0, 0])), []);
});

test('a hue around red is averaged as an angle, not as a number', () => {
  // 355 and 5 degrees: red, not cyan (180).
  const p = CoverColors.palette(picture([[[230, 20, 40], 200], [[230, 40, 20], 200]]));
  assert.ok(hueNear(p[0][0], 0, 8), p[0][0]);
});

test('forCloud: as colourful and light as clouds, grey stays grey', () => {
  const dark = CoverColors.forCloud([240, 30, 10], 46);
  assert.equal(dark[0], 240);
  assert.ok(dark[1] >= 45 && dark[2] >= 34, JSON.stringify(dark));
  const pale = CoverColors.forCloud([60, 100, 95], 46);
  assert.ok(pale[2] <= 56);
  const grey = CoverColors.forCloud([0, 0, 50], 46);
  assert.equal(grey[1], 0);
});
