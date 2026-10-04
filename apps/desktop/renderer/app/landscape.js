'use strict';

// The wireframe landscape: a neon grid of mountains flown over, first person,
// along a valley, for the Synthwave visualizer (visualizer.js), which flies it
// under a sky, a sun and a ship's nose.
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
// rows first is filled dark (or, without a fill, wipes out what it covers),
// so nearer mountains hide the ones behind. The glow is the whole picture
// blurred once at half size, not a shadow on every line, which would be far
// too slow at full screen.

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

class Intensity {
  // How intense the music is right now, 0 (calm) to 1, measured against the
  // song's own loud parts, not a fixed loudness: songs are mastered so
  // differently that a rock song sits as loud all through as a hardstyle drop
  // at its peak. The mean level over the last AVERAGE_MS is compared with the
  // loudest it has been lately, a peak that sinks back over PEAK_MS; from
  // FROM of that peak on it counts, fully at TO. Starting at START, a quiet
  // intro counts as calm.
  constructor({ averageMs = 1000, peakMs = 60000, from = 0.75, to = 0.95, start = 0.5, silence = 0.12 } = {}) {
    Object.assign(this, { averageMs, peakMs, from, to, silence });
    this.loud = 0;
    this.peak = start;
  }

  /** levels: the equalizer's (null: silence), dt in ms. Returns 0..1. */
  follow(levels, dt) {
    let mean = 0;
    if (levels && levels.length) {
      for (let i = 0; i < levels.length; i += 1) mean += levels[i];
      mean /= levels.length;
    }
    this.loud += (mean - this.loud) * (1 - Math.exp(-dt / this.averageMs));
    this.peak = Math.max(this.loud, this.peak + (this.loud - this.peak) * (1 - Math.exp(-dt / this.peakMs)));
    if (this.loud < this.silence) return 0;
    const x = Math.min(1, Math.max(0, (this.loud / this.peak - this.from) / (this.to - this.from)));
    return x * x * (3 - 2 * x);
  }
}

// Cells drawn as one path (see render).
const PIECE = 2;
// The floor's bumps stand at full height up to BUMPS_NEAR cells ahead and
// fade out by BUMPS_FAR: the music now is right in front of the car.
const BUMPS_NEAR = 5;
const BUMPS_FAR = 14;

/** 0..1, how much of the bumps' height shows z cells ahead. */
function bumpsAt(z) {
  const x = Math.min(1, Math.max(0, (BUMPS_FAR - z) / (BUMPS_FAR - BUMPS_NEAR)));
  return x * x * (3 - 2 * x);
}

/**
 * Where the piece starting at column j ends: pieces always break at the same
 * columns, so they do not regroup as the rows come on and the strips reach
 * further or less far out.
 */
function pieceEnd(j) {
  return j - (j % PIECE) + PIECE;
}

/** A triangle into the path, always clockwise on screen, so none cancel. */
function triangle(t, ax, ay, bx, by, cx, cy) {
  t.moveTo(ax, ay);
  if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) >= 0) {
    t.lineTo(bx, by);
    t.lineTo(cx, cy);
  } else {
    t.lineTo(cx, cy);
    t.lineTo(bx, by);
  }
  t.closePath();
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
    // ring[0] the nearest row, ring[rows] the one at the horizon. Beside
    // each, its bumps: 0..1 per point, the floor's shape when it is rough.
    this.ring = [];
    this.bumpRing = [];
    for (let k = 0; k <= rows; k += 1) {
      this.bumpRing.push(new Float32Array(this.width));
      this.ring.push(this._row(null, new Float32Array(this.width), this.bumpRing[k]));
    }
    // How high the bumps stand right now, in cells: set from the music each
    // frame, so the floor rises and falls with it as it is, not as it was
    // when the row came up at the horizon.
    this.bumps = 0;
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

  /**
   * A new row for the horizon, from the levels (null: silence), into `row`,
   * and its bumps into `bumps`.
   */
  _row(levels, row, bumps) {
    const SPAN = 24; // cells from the valley's edge to the top of the range
    for (let j = 0; j < this.width; j += 1) {
      this.field[j] = 0.7 * this.field[j] + 0.3 * this._rand();
      const d = Math.abs(j - this.cols) - this.floor;
      // Mostly small bumps and now and then a bigger one, on the floor and
      // dying away up the mountains' feet.
      const r = this._rand();
      if (d <= 0) {
        row[j] = 0;
        bumps[j] = r * r;
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
      bumps[j] = r * r * (1 - slope);
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
      const oldBumps = this.bumpRing.shift();
      this.ring.push(this._row(levels, old, oldBumps));
      this.bumpRing.push(oldBumps);
    }
  }

  /** How far ahead ring[k] is. */
  depth(k) {
    return k + 1 - this.frac;
  }

  /** The height of ring[k] at column j, its bumps as high as they stand now. */
  heightAt(k, j) {
    return this.ring[k][j] + this.bumps * bumpsAt(this.depth(k)) * this.bumpRing[k][j];
  }

  /**
   * The ground's height z cells ahead, in cells, across columns `from` to
   * `to` from the middle (-1 to 1: the car's width).
   */
  groundAt(z, from = -1, to = 1) {
    const k = Math.min(this.rows - 1, Math.max(0, z - 1 + this.frac));
    const k0 = Math.floor(k);
    const t = k - k0;
    let sum = 0;
    for (let j = this.cols + from; j <= this.cols + to; j += 1) {
      sum += this.heightAt(k0, j) * (1 - t) + this.heightAt(k0 + 1, j) * t;
    }
    return sum / (to - from + 1);
  }

  /**
   * Draws onto `out` (w x h). horizon: its height as a share of h. fill: a
   * colour for the mountains' sides (by depth, 0 near to 1 far), or null to
   * leave them see-through. glow: how strong the blurred copy is added. kick:
   * 0..1, brightens the lines. lift: the eye raised above camH (riding over
   * bumps), in cells. line: the lines' colour near you as { h, s, l } (hsl),
   * its hue turning by `drift` degrees towards the horizon.
   */
  render(out, w, h, {
    horizon = 0.45, fill = null, glow = 0.7, kick = 0, focal = 0.55, alpha = 1, lift = 0, line = { h: 272, s: 95, l: 60, drift: 52 },
  } = {}) {
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
    const { cols, ring, bumpRing, px } = this;
    const camH = this.camH + lift;
    const end = this.rows + 1;

    for (let k = this.rows - 1; k >= 0; k -= 1) {
      const zf = this.depth(k + 1);
      const zn = this.depth(k);
      if (zn < 0.3) continue;
      const far = ring[k + 1];
      const near = ring[k];
      const farBumps = bumpRing[k + 1];
      const nearBumps = bumpRing[k];
      const bf = this.bumps * bumpsAt(zf);
      const bn = this.bumps * bumpsAt(zn);
      const reach = Math.min(cols, Math.ceil((zf * cx) / f) + 1);
      const lo = cols - reach;
      const hi = cols + reach;
      for (let j = lo; j <= hi; j += 1) {
        const x = j - cols;
        px[j * 4] = cx + (x / zf) * f;
        px[j * 4 + 1] = hy + ((camH - far[j] - bf * farBumps[j]) / zf) * f;
        px[j * 4 + 2] = cx + (x / zn) * f;
        px[j * 4 + 3] = hy + ((camH - near[j] - bn * nearBumps[j]) / zn) * f;
      }
      const d = zf / end; // 0 near, 1 at the horizon

      // The strip covers whatever lies behind it, a few cells (PIECE) per
      // path: Chromium draws a long, jagged path on the CPU, as a mask the
      // size of its bounds, and a short one on the GPU; whole strips across
      // the screen ran at under 20 fps even on a fast PC. Each cell is two
      // triangles, all traced the same way round: a cell whose near edge
      // rises above its far one would otherwise run the other way and cancel
      // its neighbour out (nonzero winding), leaving a hole that flickered as
      // the rows came on and the cells were grouped differently. The seams
      // are under the lines running towards you.
      if (fill) {
        t.globalCompositeOperation = 'source-over';
        t.fillStyle = fill(d);
      } else {
        t.globalCompositeOperation = 'destination-out';
        t.fillStyle = '#000';
      }
      for (let p = lo, q; p < hi; p = q) {
        q = Math.min(hi, pieceEnd(p));
        t.beginPath();
        for (let j = p; j < q; j += 1) {
          const o = j * 4;
          // far j, far j+1, near j+1 and far j, near j+1, near j
          triangle(t, px[o], px[o + 1], px[o + 4], px[o + 5], px[o + 6], px[o + 7]);
          triangle(t, px[o], px[o + 1], px[o + 6], px[o + 7], px[o + 2], px[o + 3]);
        }
        t.fill();
      }

      // Its far row and the lines running towards you. The line colour (by
      // default violet near, blue further on), fading into the distance so
      // new rows come in softly.
      t.globalCompositeOperation = 'source-over';
      const fog = Math.min(1, ((1 - d) / 0.35)) * (0.55 + 0.45 * (1 - d));
      t.globalAlpha = Math.min(1, alpha * fog);
      const hue = line.h - (line.drift || 0) * Math.sqrt(d);
      const light = Math.max(0, Math.min(Math.max(85, line.l), line.l - 4 + 8 * (1 - d) + 22 * kick));
      t.strokeStyle = `hsl(${hue.toFixed(0)}, ${line.s.toFixed(0)}%, ${light.toFixed(0)}%)`;
      t.lineWidth = 0.8 + 1.6 * (1 - d) * (1 - d);
      for (let p = lo, q; p < hi; p = q) {
        q = Math.min(hi, pieceEnd(p));
        t.beginPath();
        t.moveTo(px[p * 4], px[p * 4 + 1]);
        for (let j = p + 1; j <= q; j += 1) t.lineTo(px[j * 4], px[j * 4 + 1]);
        // Each line towards you once: the next piece draws the one at q.
        const last = q === hi ? q : q - 1;
        for (let j = p; j <= last; j += 1) {
          t.moveTo(px[j * 4], px[j * 4 + 1]);
          t.lineTo(px[j * 4 + 2], px[j * 4 + 3]);
        }
        t.stroke();
      }
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
