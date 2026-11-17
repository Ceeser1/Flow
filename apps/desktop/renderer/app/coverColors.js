'use strict';

// The colours of a cover (5.1.5), for the clouds' "From cover" scheme
// (ambient.js). Pure, so the tests can pin it; the window loads it as a plain
// script and gets `CoverColors` as a global.
//
// The cover's pixels (a small copy of it) are sorted by hue into HUES
// buckets, each pixel counting by how colourful it is (saturation, less near
// black and white). The strongest buckets, at least MIN_APART degrees apart,
// are its colours, each as the average of its pixels (its hue as an angle's
// average). A cover with hardly any colour (black and white, grey) gives one
// grey. Nearly black and nearly white pixels count for nothing.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoverColors = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const HUES = 24;
  const MIN_APART = 35;
  // Colour weight under this share of the pixels: the cover counts as grey.
  const GREY_SHARE = 0.04;

  /** r, g, b 0..255 as [hue 0..360, saturation 0..1, lightness 0..1]. */
  function hsl(r, g, b) {
    const R = r / 255;
    const G = g / 255;
    const B = b / 255;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    return [(h * 60 + 360) % 360, Math.min(1, s), l];
  }

  /**
   * Up to `count` colours of a picture's RGBA pixels (`data`, 4 bytes a
   * pixel), strongest first, as [hue 0..360, saturation 0..100, lightness
   * 0..100]. [] for no pixels to go by.
   */
  function palette(data, count = 4) {
    const buckets = Array.from({ length: HUES }, () => ({
      w: 0, x: 0, y: 0, s: 0, l: 0,
    }));
    let pixels = 0;
    let colour = 0;
    let greyL = 0;
    let greyN = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const [h, s, l] = hsl(data[i], data[i + 1], data[i + 2]);
      if (l < 0.07 || l > 0.96) continue;
      pixels += 1;
      // Colourful, and not washed out towards black or white.
      const w = s * (1 - Math.abs(2 * l - 1) ** 2);
      if (w < 0.12) {
        greyL += l;
        greyN += 1;
        continue;
      }
      colour += w;
      const b = buckets[Math.floor(h / (360 / HUES)) % HUES];
      const rad = (h * Math.PI) / 180;
      b.w += w;
      b.x += Math.cos(rad) * w;
      b.y += Math.sin(rad) * w;
      b.s += s * w;
      b.l += l * w;
    }
    if (!pixels) return [];
    if (colour < pixels * GREY_SHARE) {
      const l = greyN ? greyL / greyN : 0.5;
      return [[0, 0, Math.round(Math.min(80, Math.max(30, l * 100)))]];
    }
    const found = [];
    for (const b of buckets.filter((x) => x.w > 0).sort((a, c) => c.w - a.w)) {
      if (found.length >= count) break;
      // A bucket much weaker than the strongest is a speck, not a colour of the cover.
      if (found.length && b.w < found[0].w * 0.06) break;
      const h = ((Math.atan2(b.y, b.x) * 180) / Math.PI + 360) % 360;
      const near = found.some((f) => {
        const d = Math.abs(f.h - h);
        return Math.min(d, 360 - d) < MIN_APART;
      });
      if (near) continue;
      found.push({ h, s: b.s / b.w, l: b.l / b.w, w: b.w });
    }
    return found.map((f) => [Math.round(f.h), Math.round(f.s * 100), Math.round(f.l * 100)]);
  }

  /**
   * A cover's colour as a cloud wears it: as colourful and as light as the
   * clouds are (a dark or pale cover still gives clouds that show), a grey
   * one grey. `light`: the cloud's own lightness (percent).
   */
  function forCloud([h, s, l], light = 46) {
    if (s < 8) return [0, 0, Math.min(70, Math.max(35, l))];
    return [h, Math.min(92, Math.max(45, s * 1.15)), Math.min(56, Math.max(34, (l + light) / 2))];
  }

  return { palette, forCloud, hsl };
}));
