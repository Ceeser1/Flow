'use strict';

// Show Cover as background (renderer/app/ambient.js): the picture baked once
// per cover. A plain frame round the artwork is found and left out, the cover
// goes on mirrored past its edge and blurs more and more from a little inside
// the edge outwards, so the surround has the colours of the cover's outer
// band and never its last row of pixels pulled outwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app', 'ambient.js'), 'utf8');

// Ambient in a page of its own (only what works on pixels is used here).
const context = vm.createContext({});
vm.runInContext(`${SOURCE}\nthis.Ambient = Ambient;`, context);
const { Ambient } = context;

/** A cover's pixels (S x S, RGBA), each from colour(x, y) => [r, g, b]. */
function cover(S, colour) {
  const src = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const [r, g, b] = colour(x, y);
      src.set([r, g, b, 255], (y * S + x) * 4);
    }
  }
  return src;
}

/** Artwork with no plain rows: stripes and a drift of colour. */
const art = (x, y) => [40 + ((x * 7 + y * 3) % 90), 20 + ((x + y * 5) % 60), 60 + ((x * 3 + y) % 120)];

/** `colour` for a frame `wide` round what `inner` gives. */
const framed = (S, wide, colour, inner = art) => (x, y) => (
  x < wide || y < wide || x >= S - wide || y >= S - wide ? colour : inner(x, y));

/** The picture's colour at a point of the baked pixels (P wide). */
const at = (pixels, P, x, y) => Array.from(pixels.slice((y * P + x) * 4, (y * P + x) * 4 + 4));

test('a plain frame round the artwork is found, with the row it ends in', () => {
  const S = 100;
  const cut = Ambient._frameOf(cover(S, framed(S, 5, [252, 252, 252])), S);
  assert.deepEqual(Array.from(cut), [6, 6, 6, 6]);
  // A frame of another colour, not the same width on every side, a little uneven (as a packed picture is).
  const uneven = cover(S, (x, y) => {
    const frame = x < 3 || y < 4 || x >= S - 3 || y >= S - 5;
    return frame ? [20 + ((x + y) % 5), 24, 16 + (x % 4)] : [200, 180 - (y % 30), 90];
  });
  assert.deepEqual(Array.from(Ambient._frameOf(uneven, S)), [4, 5, 4, 6]);
});

test('artwork without a frame is left whole', () => {
  const S = 100;
  assert.equal(Ambient._frameOf(cover(S, art), S), null);
  // A plain background the artwork comes into bit by bit (a disc on white): not a frame.
  const disc = cover(S, (x, y) => (Math.hypot(x - 50, y - 50) < 47 ? [30, 60, 160] : [255, 255, 255]));
  assert.equal(Ambient._frameOf(disc, S), null);
  // One plain colour all over.
  assert.equal(Ambient._frameOf(cover(S, () => [12, 12, 12]), S), null);
  // A border wider than a frame may be (COVER_FRAME of the width).
  const wide = Math.floor(S * Ambient.COVER_FRAME) + 3;
  assert.equal(Ambient._frameOf(cover(S, framed(S, wide, [0, 0, 0])), S), null);
  // Bars at two sides only.
  const bars = cover(S, (x, y) => (y < 5 || y >= S - 5 ? [0, 0, 0] : art(x, y)));
  assert.equal(Ambient._frameOf(bars, S), null);
  // Two colours: white at the top and bottom, black at the sides.
  const two = cover(S, (x, y) => (x < 5 || x >= S - 5 ? [0, 0, 0] : y < 5 || y >= S - 5 ? [255, 255, 255] : art(x, y)));
  assert.equal(Ambient._frameOf(two, S), null);
});

test('the baked picture: the cover whole in the middle, solid everywhere', () => {
  const S = 100;
  const M = 10;
  const P = S + 2 * M;
  const src = cover(S, art);
  const pixels = Ambient._surround(src, S, M);
  assert.equal(pixels.length, P * P * 4);
  for (let i = 3; i < pixels.length; i += 4) assert.equal(pixels[i], 255);
  // Further in than the blur begins nothing has changed.
  const inset = Math.ceil(S * Ambient.COVER_BLUR_IN) + 3;
  for (let y = inset; y < S - inset; y += 1) {
    for (let x = inset; x < S - inset; x += 1) {
      assert.deepEqual(at(pixels, P, x + M, y + M).slice(0, 3), Array.from(src.slice((y * S + x) * 4, (y * S + x) * 4 + 3)), `pixel ${x}, ${y}`);
    }
  }
});

test('the surround has the colours of the cover\'s outer band on that side', () => {
  const S = 120;
  const M = 12;
  const P = S + 2 * M;
  // Red on the left, blue on the right, green along the top.
  const pixels = Ambient._surround(cover(S, (x, y) => (y < 12 ? [0, 200, 0] : x < 60 ? [200, 0, 0] : [0, 0, 200])), S, M);
  const left = at(pixels, P, 4, M + 70);
  const right = at(pixels, P, P - 5, M + 70);
  const top = at(pixels, P, M + 60, 4);
  assert.ok(left[0] > 150 && left[1] < 40 && left[2] < 40, `left ${left}`);
  assert.ok(right[2] > 150 && right[0] < 40 && right[1] < 40, `right ${right}`);
  assert.ok(top[1] > 150 && top[0] < 40 && top[2] < 40, `top ${top}`);
});

test('a bright last row of pixels is not pulled outwards', () => {
  const S = 120;
  const M = 12;
  const P = S + 2 * M;
  // Dark artwork whose outermost row is white (as a picture's edge can be).
  const pixels = Ambient._surround(cover(S, (x, y) => (x === 0 || y === 0 || x === S - 1 || y === S - 1 ? [255, 255, 255] : [20, 10, 12])), S, M);
  for (const [x, y] of [[2, P >> 1], [P - 3, P >> 1], [P >> 1, 2], [P >> 1, P - 3], [6, P >> 1], [P >> 1, 6]]) {
    const c = at(pixels, P, x, y);
    assert.ok(c[0] < 90, `at ${x}, ${y}: ${c}`);
  }
  // Pulled outwards it would be white all the way: the row itself is only a soft, dim rim now.
  const rim = at(pixels, P, M, P >> 1);
  assert.ok(rim[0] < 140, `rim ${rim}`);
});

test('the blur begins inside the cover and grows towards the far end of the surround', () => {
  const S = 200;
  const M = 20;
  const P = S + 2 * M;
  // A fine check pattern: how much of it is left tells how strong the blur is there.
  const pixels = Ambient._surround(cover(S, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0])), S, M);
  const contrast = (x) => {
    let low = 255;
    let high = 0;
    for (let y = (P >> 1) - 6; y < (P >> 1) + 6; y += 1) {
      const v = pixels[(y * P + x) * 4];
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
    return high - low;
  };
  const inset = Math.round(S * Ambient.COVER_BLUR_IN);
  const deep = contrast(M + inset + 4);
  const half = contrast(M + (inset >> 1));
  const edge = contrast(M);
  const out = contrast(M >> 1);
  assert.equal(deep, 255);
  assert.ok(half < deep && half > edge, `half way ${half}, at the edge ${edge}`);
  assert.ok(edge < 40, `at the edge ${edge}`);
  assert.ok(out <= edge, `outside ${out}, at the edge ${edge}`);
});

test('made in parts, the same picture comes out', () => {
  const S = 64;
  const M = 6;
  const src = cover(S, art);
  const whole = Ambient._surround(src, S, M);
  const parts = Ambient._surroundParts(src, S, M);
  let n = 0;
  let part = parts.next();
  while (!part.done) {
    n += 1;
    part = parts.next();
  }
  assert.ok(n >= 10, `parts ${n}`);
  assert.deepEqual(Array.from(part.value), Array.from(whole));
});

test('the cover has no edge: whole in its core, about half at its edge, gone well outside, the same on every side', () => {
  const size = 200;
  const mid = size / 2;
  const fadeIn = size * Ambient.COVER_FADE_IN;
  const fadeOut = size * Ambient.COVER_FADE;
  // Whole in the middle and up to where the thinning begins.
  assert.equal(Ambient._solid(mid, mid, size), 1);
  assert.equal(Ambient._solid(fadeIn + 1, mid, size), 1);
  // Thinner and thinner outwards, never a step: no two points a pixel apart differ much.
  let last = 1;
  let step = 0;
  for (let x = fadeIn; x >= -fadeOut; x -= 1) {
    const v = Ambient._solid(x, mid, size);
    assert.ok(v <= last, `at ${x}: ${v} after ${last}`);
    step = Math.max(step, last - v);
    last = v;
  }
  assert.ok(step * (fadeIn + fadeOut) < 2.2, `the biggest step ${step}`);
  // About half at the edge itself, nothing at the far end and beyond.
  const edge = Ambient._solid(0, mid, size);
  assert.ok(edge > 0.4 && edge < 0.6, `at the edge ${edge}`);
  assert.ok(Ambient._solid(-fadeOut, mid, size) < 1e-9);
  assert.equal(Ambient._solid(-fadeOut - 20, mid, size), 0);
  // It begins and ends without a kink.
  assert.ok(1 - Ambient._solid(fadeIn - 2, mid, size) < 0.005);
  assert.ok(Ambient._solid(-fadeOut + 2, mid, size) < 0.005);
  // The same from each side, and thinner still out past a corner.
  for (const [x, y] of [[size, mid], [mid, 0], [mid, size]]) assert.ok(Math.abs(Ambient._solid(x, y, size) - edge) < 1e-9);
  assert.ok(Ambient._solid(0, 0, size) < edge);
  // The baked surround reaches as far as the cover is to be seen.
  assert.ok(Ambient.COVER_BLUR_OUT <= Ambient.COVER_FADE);
});

test('how far outside the cover\'s rounded square a point lies', () => {
  const size = 100;
  const round = size * Ambient.COVER_ROUND;
  assert.equal(Ambient._edge(0, 50, size), 0);
  assert.equal(Ambient._edge(50, 50, size), -50);
  assert.equal(Ambient._edge(-7, 50, size), 7);
  assert.equal(Ambient._edge(50, 104, size), 4);
  // The square's own corner lies outside the rounded one.
  assert.ok(Math.abs(Ambient._edge(0, 0, size) - (Math.SQRT2 - 1) * round) < 1e-9);
});
