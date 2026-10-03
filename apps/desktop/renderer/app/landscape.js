'use strict';

// The wireframe landscape: a neon grid of mountains flown over, first person,
// along a valley. Behind the pages it lies between the clouds and the
// equalizer (Settings' "Wireframe Landscape"); the Synthwave visualizer
// (visualizer.js) flies the same terrain under a sky, a sun and a ship's nose.
//
// The terrain is made of the music. It is a grid of rows, one cell apart, each
// a line of heights across; flying on, the nearest row drops away behind and
// a new one is made at the horizon from the spectrum as it is right then
// (the equalizer's levels, equalizer.js). Across a row the valley floor stays
// flat, and from its edges outwards each point stands for a frequency, bass
// next to the valley, higher further out: the louder it is, the higher the
// mountain there. What lies ahead is the song's last few seconds, and a quiet
// part comes towards you as low hills.
//
// Perspective is one division: a point Z cells ahead is drawn at 1/Z of its
// size. Rows are drawn from the horizon forwards, and each strip between two
// rows first wipes out what it covers (behind the pages, so the clouds show
// through) or is filled dark (the visualizer), so nearer mountains hide the
// ones behind. The glow is the whole picture blurred once at half size, not a
// shadow on every line, which would be far too slow at full screen.

class Kick {
  // The bass rising above its own average of the last AVERAGE_MS.
  constructor({ averageMs = 600, threshold = 0.05, gain = 3, attackMs = 30, releaseMs = 300 } = {}) {
    Object.assign(this, { averageMs, threshold, gain, attackMs, releaseMs });
    this.average = 0;
    this.value = 0;
    this.hearing = false;
  }

  /** bass 0..1, dt in ms. Returns the kick, 0..1. */
  follow(bass, dt) {
    if (bass > 0 && !this.hearing) this.average = bass;
    this.hearing = bass > 0;
    this.average += (bass - this.average) * (1 - Math.exp(-dt / this.averageMs));
    const hit = Math.min(1, Math.max(0, bass - this.average - this.threshold) * this.gain);
    this.value = hit > this.value
      ? this.value + (hit - this.value) * (1 - Math.exp(-dt / this.attackMs))
      : hit + (this.value - hit) * Math.exp(-dt / this.releaseMs);
    return this.value;
  }
}

class Terrain {
  /**
   * rows: how far ahead it reaches. cols: points each side of the middle.
   * floor: half the valley floor's width. camH: the eye above the floor.
   * Distances in cells.
   */
  constructor({ rows = 48, cols = 64, floor = 3.5, camH = 1.1, seed = 1 } = {}) {
    Object.assign(this, { rows, cols, floor, camH, seed: seed % 2147483646 + 1 });
    this.width = cols * 2 + 1;
    // A slow random field each point keeps from row to row, so ridges run on
    // into the distance instead of every row being new noise.
    this.field = new Float32Array(this.width);
    for (let j = 0; j < this.width; j += 1) this.field[j] = this._rand();
    // ring[0] the nearest row, ring[rows] the one at the horizon.
    this.ring = [];
    for (let k = 0; k <= rows; k += 1) this.ring.push(this._row(null, new Float32Array(this.width)));
    this.frac = 0; // 0..1, how far the rows have come since the last one dropped
    this.buf = document.createElement('canvas');
    this.glowBuf = document.createElement('canvas');
    this.px = new Float32Array(this.width * 4); // far x, far y, near x, near y
  }

  _rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /** 0..1, the music at t (0 the bass, 1 the top), averaged over a few bars. */
  static levelAt(levels, t) {
    const n = levels ? levels.length : 0;
    if (!n) return 0;
    const centre = t * (n - 1);
    const half = Math.max(1, Math.round(n / 48));
    const lo = Math.max(0, Math.round(centre) - half);
    const hi = Math.min(n - 1, Math.round(centre) + half);
    let sum = 0;
    for (let i = lo; i <= hi; i += 1) sum += levels[i];
    return sum / (hi - lo + 1);
  }

  /** A new row for the horizon, from the levels (null: silence), into `row`. */
  _row(levels, row) {
    const SPAN = 24; // cells from the valley's edge to the top of the range
    for (let j = 0; j < this.width; j += 1) {
      this.field[j] = 0.7 * this.field[j] + 0.3 * this._rand();
      const d = Math.abs(j - this.cols) - this.floor;
      if (d <= 0) {
        row[j] = 0;
        continue;
      }
      const rise = Math.min(1, d / 5);
      const slope = rise * rise * (3 - 2 * rise);
      const base = 0.9 + d * 0.32;
      const music = Math.min(1, 1.5 * Terrain.levelAt(levels, Math.min(1, d / SPAN)));
      // A rough edge on every point, and now and then a spire.
      const rough = 0.75 + 0.5 * this._rand();
      const spire = this._rand() < 0.04 ? 1.5 : 1;
      row[j] = slope * base * (0.3 + 0.5 * this.field[j] + 1.1 * music) * rough * spire;
    }
    return row;
  }

  /** Flies `cells` on; the rows that come up at the horizon take `levels`. */
  advance(cells, levels) {
    this.frac += Math.max(0, cells);
    // A long stall (a hidden window) would make many rows of the same sound.
    if (this.frac > this.rows) this.frac = this.frac % 1 + this.rows;
    while (this.frac >= 1) {
      this.frac -= 1;
      const old = this.ring.shift();
      this.ring.push(this._row(levels, old));
    }
  }

  /** How far ahead ring[k] is. */
  depth(k) {
    return k + 1 - this.frac;
  }

  /**
   * Draws onto `out` (w x h). horizon: its height as a share of h. fill: a
   * colour for the mountains' sides (by depth, 0 near to 1 far), or null to
   * leave them see-through. glow: how strong the blurred copy is added. kick:
   * 0..1, brightens the lines.
   */
  render(out, w, h, { horizon = 0.45, fill = null, glow = 0.7, kick = 0, focal = 0.55, alpha = 1 } = {}) {
    const buf = this.buf;
    if (buf.width !== w) buf.width = w;
    if (buf.height !== h) buf.height = h;
    const t = buf.getContext('2d');
    t.globalCompositeOperation = 'source-over';
    t.globalAlpha = 1;
    t.clearRect(0, 0, w, h);
    const f = w * focal;
    const cx = w / 2;
    const hy = h * horizon;
    const { cols, camH, ring, px } = this;
    const end = this.rows + 1;

    for (let k = this.rows - 1; k >= 0; k -= 1) {
      const zf = this.depth(k + 1);
      const zn = this.depth(k);
      if (zn < 0.3) continue;
      const far = ring[k + 1];
      const near = ring[k];
      const reach = Math.min(cols, Math.ceil((zf * cx) / f) + 1);
      const lo = cols - reach;
      const hi = cols + reach;
      for (let j = lo; j <= hi; j += 1) {
        const x = j - cols;
        px[j * 4] = cx + (x / zf) * f;
        px[j * 4 + 1] = hy + ((camH - far[j]) / zf) * f;
        px[j * 4 + 2] = cx + (x / zn) * f;
        px[j * 4 + 3] = hy + ((camH - near[j]) / zn) * f;
      }
      const d = zf / end; // 0 near, 1 at the horizon

      // The strip covers whatever lies behind it.
      t.beginPath();
      t.moveTo(px[lo * 4], px[lo * 4 + 1]);
      for (let j = lo + 1; j <= hi; j += 1) t.lineTo(px[j * 4], px[j * 4 + 1]);
      for (let j = hi; j >= lo; j -= 1) t.lineTo(px[j * 4 + 2], px[j * 4 + 3]);
      t.closePath();
      if (fill) {
        t.globalCompositeOperation = 'source-over';
        t.fillStyle = fill(d);
      } else {
        t.globalCompositeOperation = 'destination-out';
        t.fillStyle = '#000';
      }
      t.fill();

      // Its far row and the lines running towards you. Violet near, blue
      // further on, fading into the distance so new rows come in softly.
      t.globalCompositeOperation = 'source-over';
      const fog = Math.min(1, ((1 - d) / 0.35)) * (0.55 + 0.45 * (1 - d));
      t.globalAlpha = Math.min(1, alpha * fog);
      const hue = 272 - 52 * Math.sqrt(d);
      const light = Math.min(85, 56 + 8 * (1 - d) + 22 * kick);
      t.strokeStyle = `hsl(${hue.toFixed(0)}, 95%, ${light.toFixed(0)}%)`;
      t.lineWidth = 0.8 + 1.6 * (1 - d) * (1 - d);
      t.beginPath();
      t.moveTo(px[lo * 4], px[lo * 4 + 1]);
      for (let j = lo + 1; j <= hi; j += 1) t.lineTo(px[j * 4], px[j * 4 + 1]);
      for (let j = lo; j <= hi; j += 1) {
        t.moveTo(px[j * 4], px[j * 4 + 1]);
        t.lineTo(px[j * 4 + 2], px[j * 4 + 3]);
      }
      t.stroke();
      t.globalAlpha = 1;
    }

    if (glow > 0) {
      const g = this.glowBuf;
      const gw = Math.max(1, Math.round(w / 2));
      const gh = Math.max(1, Math.round(h / 2));
      if (g.width !== gw) g.width = gw;
      if (g.height !== gh) g.height = gh;
      const gc = g.getContext('2d');
      gc.clearRect(0, 0, gw, gh);
      gc.filter = 'blur(5px)';
      gc.drawImage(buf, 0, 0, gw, gh);
      gc.filter = 'none';
      out.globalCompositeOperation = 'lighter';
      out.globalAlpha = Math.min(1, glow * (1 + 0.8 * kick));
      out.drawImage(g, 0, 0, w, h);
    }
    out.globalCompositeOperation = 'source-over';
    out.globalAlpha = 1;
    out.drawImage(buf, 0, 0);
  }
}

// ---- Behind the pages ----

const Landscape = {
  canvas: null,
  terrain: null,
  kick: null,
  raf: null,
  lastFrame: 0,
  speed: 0,         // cells per second right now
  dirty: true,      // something changed while it stood still
  frozen: false,    // Windows' "Show animations" off: it stands still

  SPEED: 3,         // cells per second while a song plays
  KICK_SPEED: 1.2,  // a full kick adds this much of SPEED
  EASE_MS: 900,     // speeding up and slowing down
  HORIZON: 0.42,    // of the pages' height, above the player bar
  GLOW: 0.6,

  init() {
    this.canvas = $('landscapeCanvas');
    if (!this.canvas) return;
    this.terrain = new Terrain({ rows: 44, cols: 60, seed: 11 });
    this.kick = new Kick();
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.frozen = motion.matches;
    motion.addEventListener('change', () => {
      this.frozen = motion.matches;
    });
    this._layout();
    this._applyVisibility();
    new ResizeObserver(() => this._layout()).observe(document.querySelector('.content'));
    Store.onSettings((patch) => {
      if ('landscapeVisibility' in patch) this._applyVisibility();
      if ('landscapeOn' in patch) this.dirty = true;
    });
    this.raf = requestAnimationFrame((t) => this._frame(t));
  },

  _applyVisibility() {
    this.canvas.style.opacity = String((Store.settings.landscapeVisibility || 50) / 100);
  },

  _layout() {
    const content = document.querySelector('.content');
    const w = Math.max(1, content.clientWidth);
    const h = Math.max(1, content.clientHeight);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.dirty = true;
  },

  /** Under a full-screen visualizer nobody would see it, unless that is the Flow one. */
  _hidden() {
    return Store.settings.landscapeOn === false || (Visualizer.shown && Visualizer.kind !== 'flow');
  },

  _frame(now) {
    this.raf = requestAnimationFrame((t) => this._frame(t));
    const dt = Math.min(100, Math.max(0, now - (this.lastFrame || now)));
    this.lastFrame = now;
    if (this._hidden()) {
      if (this.dirty) this._clear();
      this.dirty = false;
      return;
    }
    const bass = Equalizer.bass || 0;
    const kick = this.kick.follow(bass, dt);
    const playing = Equalizer.active && Equalizer._sounding();
    const target = playing && !this.frozen ? this.SPEED * (1 + this.KICK_SPEED * kick + 0.3 * bass) : 0;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / this.EASE_MS));
    if (this.speed < 0.02 && target === 0) this.speed = 0;
    // Standing still with nothing new to show: no frame at all.
    if (this.speed === 0 && kick < 0.002 && !this.dirty) return;
    this.terrain.advance((this.speed * dt) / 1000, playing ? Equalizer.levels : null);
    this._draw(kick);
    this.dirty = false;
  },

  _clear() {
    const out = this.canvas.getContext('2d');
    out.clearRect(0, 0, this.canvas.width, this.canvas.height);
  },

  _draw(kick) {
    this._clear();
    const c = this.canvas;
    const player = $('player');
    // The horizon sits in the pages, above the player bar; with the Flow
    // visualizer the bar floats over the screen's bottom edge.
    const flow = document.body.classList.contains('viz-flow');
    const bottom = flow || !player ? c.height : player.offsetTop;
    this.terrain.render(c.getContext('2d'), c.width, c.height, {
      horizon: (bottom * this.HORIZON) / c.height,
      glow: this.GLOW,
      kick,
    });
  },
};
