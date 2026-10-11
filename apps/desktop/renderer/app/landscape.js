'use strict';

// The wireframe landscape: a neon grid of mountains flown over, first person,
// along a valley, for the Synthwave visualizer (viz/synthwave.js, which
// draws it in WebGL under a sky, a sun and a ship's nose).
//
// The terrain is made of the music. It is a grid of rows, one cell apart, each
// a line of heights across; flying on, the nearest row drops away behind and
// a new one is made at the horizon from the spectrum as it is right then
// (the equalizer's levels, equalizer.js). Across a row the valley floor stays
// flat, and from its edges outwards each point stands for a frequency, bass
// next to the valley, higher further out: the louder it is, the higher the
// mountain there. What lies ahead is the song's last few seconds, and a quiet
// part comes towards you as low hills.

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

// The floor's bumps stand at full height up to BUMPS_NEAR cells ahead and
// fade out by BUMPS_FAR: the music now is right in front of the car.
const BUMPS_NEAR = 5;
const BUMPS_FAR = 14;

/** 0..1, how much of the bumps' height shows z cells ahead. */
function bumpsAt(z) {
  const x = Math.min(1, Math.max(0, (BUMPS_FAR - z) / (BUMPS_FAR - BUMPS_NEAR)));
  return x * x * (3 - 2 * x);
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
   * Every point's height as it stands now, its bumps as high as they stand,
   * into out: row after row (ring[0] first), `width` to a row.
   */
  heights(out) {
    for (let k = 0; k <= this.rows; k += 1) {
      const row = this.ring[k];
      const bumps = this.bumpRing[k];
      const b = this.bumps * bumpsAt(this.depth(k));
      const o = k * this.width;
      for (let j = 0; j < this.width; j += 1) out[o + j] = row[j] + b * bumps[j];
    }
    return out;
  }
}
