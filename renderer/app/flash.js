'use strict';

// Screen Flash: on a punch of the bass the window glows white from its edges
// inwards, at once, and fades back.
//
// Only the bass felt more than heard counts: the bars from 20 to 80 Hz,
// averaged (equalizer.js). A punch is a sudden jump of that level above the
// dip it came up from, not a fixed height: even with every song at the same
// loudness one carries twice the sub-bass of another, so a fixed line is
// either always crossed or never, while a punch jumps in any song. The level
// is smoothed over SMOOTH_MS first, which irons out the ripple of a distorted
// kick (more loses real punches too). The dip follows the level down at once
// and up only slowly (FLOOR_MS), so a punch is measured from just before it.
//
// How big a jump has to be: a share of the biggest jumps of the last
// PEAK_MEMORY_MS (and at least MIN_RISE at all). Within one passage the
// punches are the biggest jumps and the kick's own ripple is smaller. After a
// flash the jump has to fall back to half of that before the next one.
//
// Settings:
//   Triggers (1-100%)    how small a jump still counts (SHARE: the first share
//                        of the biggest at 1%, the second at 100%) and how
//                        soon a flash may follow the last: never sooner than
//                        INTERVAL_MS / Triggers% (50 ms at 100%, 100 ms at
//                        50%, 5 s at 1%).
//   Flash range (1-100%) how strong it starts at the edges (Range% white) and
//                        how far in it reaches before it is gone (Range% of
//                        the window's width, from every edge alike).
//
// The glow's shape depends only on the range and the window size, so it is
// drawn once into a canvas over the whole window, and a flash only changes
// that canvas's opacity (cheap: no redraw).

const ScreenFlash = {
  canvas: null,
  smooth: 0,        // the bass level, smoothed
  floor: 0,         // the dip it came up from
  peakRise: 0,      // the biggest jumps lately, slowly forgotten
  level: 0,         // 0..1, the flash showing now
  clock: 0,         // ms of analysis so far
  lastFlash: -Infinity,
  armed: true,
  _shown: -1,

  SMOOTH_MS: 30,
  FLOOR_MS: 120,
  PEAK_MEMORY_MS: 2000,
  SHARE: [0.95, 0.45],
  MIN_RISE: 0.03,
  INTERVAL_MS: 5000,
  FADE_MS: 150,     // after the instant rise, 1/e of it is left after this long
  SCALE: 0.5,       // the glow is drawn at half size and stretched; it is all soft

  init() {
    this.canvas = $('flashCanvas');
    this._shape();
    window.addEventListener('resize', () => this._shape());
    Store.onSettings((patch) => {
      if ('flashRange' in patch) this._shape();
      if ('flashOn' in patch && !Store.settings.flashOn) this.reset();
    });
  },

  /** One analysed frame: `bass` 0..1 (the 20 to 80 Hz level), `dt` ms since the last. */
  follow(bass, dt) {
    this.clock += dt;
    this.smooth += (bass - this.smooth) * (1 - Math.exp(-dt / this.SMOOTH_MS));
    const b = this.smooth;
    this.floor = b < this.floor ? b : this.floor + (b - this.floor) * (1 - Math.exp(-dt / this.FLOOR_MS));
    const rise = b - this.floor;
    const t = (Store.settings.flashTriggers || 33) / 100;
    const share = this.SHARE[0] + (this.SHARE[1] - this.SHARE[0]) * t;
    // Measured against the jumps before this one, so a new biggest one counts.
    const biggest = Math.max(rise, this.peakRise);
    const minRise = Math.max(this.MIN_RISE, share * this.peakRise);
    this.peakRise = Math.max(rise, this.peakRise * Math.exp(-dt / this.PEAK_MEMORY_MS));
    this.level *= Math.exp(-dt / this.FADE_MS);
    if (rise < minRise * 0.5) this.armed = true;
    if (this.armed && rise >= minRise && this.clock - this.lastFlash >= this.INTERVAL_MS / (t * 100)) {
      this.armed = false;
      this.lastFlash = this.clock;
      // Harder punches flash brighter: the biggest lately at the full glow.
      this.level = Math.max(this.level, 0.5 + 0.5 * Math.min(1, rise / biggest));
    }
    if (this.level < 0.003) this.level = 0;
    this._show();
  },

  /** Nothing playing any more: no flash left over. */
  reset() {
    this.level = 0;
    this.smooth = 0;
    this.floor = 0;
    this.peakRise = 0;
    this.armed = true;
    this._show();
  },

  _show() {
    if (!this.canvas) return;
    const v = Store.settings.flashOn ? Math.round(this.level * 1000) / 1000 : 0;
    if (v === this._shown) return;
    this._shown = v;
    this.canvas.style.opacity = String(v);
  },

  /**
   * Draws the glow for the current range and window size: from each edge,
   * Range% white fading as (1 - distance / reach)^2 to nothing at the reach,
   * the edges mixed as light adds up, so the corners are the brightest.
   */
  _shape() {
    const c = this.canvas;
    if (!c) return;
    const w = Math.max(1, Math.round(window.innerWidth * this.SCALE));
    const h = Math.max(1, Math.round(window.innerHeight * this.SCALE));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const r = (Store.settings.flashRange || 10) / 100;
    const reach = Math.max(1, r * w);
    const falloff = (n) => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const near = Math.min(i + 0.5, n - i - 0.5);
        a[i] = near >= reach ? 0 : r * (1 - near / reach) ** 2;
      }
      return a;
    };
    const fx = falloff(w);
    const fy = falloff(h);
    const out = c.getContext('2d');
    const img = out.createImageData(w, h);
    const px = img.data;
    for (let y = 0; y < h; y += 1) {
      const dark = 1 - fy[y];
      let o = y * w * 4;
      for (let x = 0; x < w; x += 1, o += 4) {
        px[o] = 255;
        px[o + 1] = 255;
        px[o + 2] = 255;
        px[o + 3] = Math.round(255 * (1 - dark * (1 - fx[x])));
      }
    }
    out.putImageData(img, 0, 0);
  },
};
