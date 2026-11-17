'use strict';

// The taskbar's thumbnail buttons (5.1.4, Windows): Previous, Play / Pause
// and Next under Flow's preview when the pointer rests on its taskbar button,
// as other players have them. A click is the same action a global hotkey
// sends (keys:global, keys.js). Play shows while nothing plays (it starts the
// list shown, as the player bar's Play does), Pause while something does;
// what plays comes from what Flow's window tells the Mini Player.
//
// Windows forgets the buttons when the window is hidden (the tray), so they
// are set again whenever it shows. The icons are drawn here, white on
// nothing, at 16, 24 and 32 pixels (100, 150 and 200 % display scaling).

const { nativeImage } = require('electron');

// Each icon as shapes on a 16 x 16 grid: polygons ([x, y] corners). Straight
// edges on whole pixels, so the bars are sharp at 16 and 32 pixels.
const SHAPES = {
  play: [[[4, 2], [14, 8], [4, 14]]],
  pause: [[[3, 2], [6, 2], [6, 14], [3, 14]], [[10, 2], [13, 2], [13, 14], [10, 14]]],
  prev: [[[2, 2], [4, 2], [4, 14], [2, 14]], [[14, 2], [14, 14], [5, 8]]],
  next: [[[12, 2], [14, 2], [14, 14], [12, 14]], [[2, 2], [11, 8], [2, 14]]],
};

/** Whether a point is inside a polygon (even-odd). */
function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * An icon's pixels: `size` x `size`, white with its edges smoothed (4 x 4
 * samples a pixel), premultiplied BGRA as nativeImage takes a bitmap.
 */
function pixels(name, size) {
  const shapes = SHAPES[name];
  const out = Buffer.alloc(size * size * 4);
  const scale = 16 / size;
  const S = 4;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const x = (px + (sx + 0.5) / S) * scale;
          const y = (py + (sy + 0.5) / S) * scale;
          if (shapes.some((poly) => inside(poly, x, y))) hits += 1;
        }
      }
      const a = Math.round((255 * hits) / (S * S));
      const o = (py * size + px) * 4;
      out[o] = a;
      out[o + 1] = a;
      out[o + 2] = a;
      out[o + 3] = a;
    }
  }
  return out;
}

/** The icon at the three sizes Windows may want. */
function icon(name) {
  const img = nativeImage.createFromBitmap(pixels(name, 16), { width: 16, height: 16, scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 1.5, width: 24, height: 24, buffer: pixels(name, 24) });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: pixels(name, 32) });
  return img;
}

/**
 * `window()`: Flow's window (or null). `onAction(action)`: 'prev',
 * 'playPause' or 'next' clicked. `texts()`: { prev, play, pause, next }, the
 * tooltips in the language chosen.
 */
function createThumbar({ window, onAction, texts }) {
  const on = process.platform === 'win32';
  let icons = null;
  let playing = false;
  // What is set now ('' none yet): set again only when it changes, or the window shows.
  let shown = '';

  function apply(force = false) {
    if (!on) return false;
    const w = window();
    if (!w || w.isDestroyed()) return false;
    const key = playing ? 'pause' : 'play';
    if (!force && key === shown) return true;
    if (!icons) icons = { play: icon('play'), pause: icon('pause'), prev: icon('prev'), next: icon('next') };
    const t = texts();
    let ok = false;
    try {
      ok = w.setThumbarButtons([
        { tooltip: t.prev, icon: icons.prev, click: () => onAction('prev') },
        { tooltip: playing ? t.pause : t.play, icon: playing ? icons.pause : icons.play, click: () => onAction('playPause') },
        { tooltip: t.next, icon: icons.next, click: () => onAction('next') },
      ]);
    } catch {
      ok = false;
    }
    // Not shown yet (or hidden): tried again when it shows.
    shown = ok ? key : '';
    return ok;
  }

  return {
    /** What Flow's window plays now ({ playing }). */
    state(next) {
      playing = !!(next && next.playing);
      apply();
    },
    /** The window has shown (first, or out of the tray): Windows wants the buttons again. */
    shown: () => apply(true),
    /** The language changed. */
    refresh: () => apply(true),
  };
}

module.exports = { createThumbar, pixels, SHAPES };
