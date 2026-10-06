'use strict';

// The music's tempo and where in the beat it is, from how the sound jumps
// frame by frame. Pure, so test/tempo.test.js can pin it; the window loads it
// as a plain script and gets `Tempo` as a global (VizAudio feeds it).
//
// Each frame brings its onset strength: how much louder the spectrum got
// since the frame before, summed over the bands (spectral flux). That is laid
// into an envelope at a steady RATE whatever the screen's rate, and every
// EVAL_MS the last few seconds of it are compared with themselves shifted
// (autocorrelation): the shift at which the jumps line up best is the beat.
// A shift whose multiples line up too counts more, so the beat wins over the
// half beat (as much as the beat itself: a dotted beat, 3/2 of the true
// one, has nothing half-way); tempos far from about 150 BPM count a little
// less, so the quarter note wins over the half and the double (the usual
// octave doubt; fast songs are more often heard at half than slow ones at
// double).
// The scores are smoothed over the evaluations, so one odd bar does not
// flip it, and a tempo found is kept until another scores clearly higher.
//
// Measured offline on the first 4 minutes of 56 songs of known tempo (rock,
// metal, dance, hardstyle, drum and bass) at 144 fps: the right tempo 90%
// of the time after the first 10 s, half or double it 6%, wrong 4% (rock
// heard at 2/3 of its tempo, mostly); mostly found within 4-8 s. Whether a
// fast song is meant at half its tempo or in full the sound alone cannot
// say (the half and quarter beats line up as well in a 95 BPM rock song),
// so VizAudio's speeds count a slow tempo double. The beats tick within a
// few milliseconds of a click track's.
//
// The phase is a clock running at that tempo, pulled toward where the
// envelope says the beats fall (the offset whose comb of beats back in time
// sums highest). It is pulled by running faster or slower, never backwards,
// so every beat ticks exactly once.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Tempo = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const STAY = 0.15;
  // Sureness: the correlation a beat on, from CORR_MIN (0) over CORR_SPAN (1).
  const CORR_MIN = 0.05;
  const CORR_SPAN = 0.3;

  class Tempo {
    /**
     * rate: envelope samples a second. seconds: how much of it is looked at.
     * minBpm/maxBpm: the tempos considered. centerBpm/octaves: the tempo
     * preferred and how fast the preference falls off (a log-normal weight).
     */
    constructor({ rate = 100, seconds = 10, minBpm = 60, maxBpm = 190, centerBpm = 150, octaves = 0.9, evalMs = 200, leadMs = 10, half = 1, keep = 1.2 } = {}) {
      this.half = half;
      this.keep = keep;
      this.rate = rate;
      this.size = Math.round(rate * seconds);
      this.minLag = Math.floor((rate * 60) / maxBpm);
      this.maxLag = Math.ceil((rate * 60) / minBpm);
      this.centerBpm = centerBpm;
      this.octaves = octaves;
      this.evalMs = evalMs;
      // Beats tick this much early: the analysis sees an attack a little
      // after it is heard and the frame shows a little after that.
      this.lead = leadMs / 1000;
      this.ring = new Float32Array(this.size);
      this.x = new Float32Array(this.size);
      this.ac = new Float32Array(this.maxLag * 4 + 2);
      this.score = new Float32Array(this.maxLag + 2);
      this.smooth = new Float32Array(this.maxLag + 2);
      this.prior = new Float32Array(this.maxLag + 2);
      for (let L = this.minLag; L <= this.maxLag; L += 1) {
        const o = Math.log2((rate * 60) / L / centerBpm) / octaves;
        this.prior[L] = Math.exp(-0.5 * o * o);
      }
      this.reset();
    }

    reset() {
      this.ring.fill(0);
      this.smooth.fill(0);
      this.at = 0;           // next slot to write
      this.filled = 0;       // slots written so far (up to size)
      this.clock = 0;        // seconds into the current slot
      this.acc = 0;          // flux gathered for the current slot
      this.sinceEval = 0;
      this.bpm = 0;          // the tempo, 0 until there is one
      this.period = 0;       // seconds a beat
      this.confidence = 0;   // 0..1: how clearly the music has a beat
      this.phase = 0;        // 0..1 through the beat, 0 on it
      this.beats = 0;        // beats ticked so far
      this.tick = false;     // true on the frame a beat lands
      this.err = 0;          // phase still to make up
    }

    /** One frame: its onset strength (>= 0) and how long it was (seconds). */
    push(flux, dt) {
      // Spread evenly over the time the frame covers, so the envelope looks
      // the same whether frames come 60 or 144 times a second.
      const slot = 1 / this.rate;
      if (!(dt > 0)) {
        // No time passed (the clock did not move): kept for the slot under way.
        this.acc += flux;
        this.tick = false;
        return;
      }
      const density = flux / dt;
      let left = dt;
      while (this.clock + left >= slot) {
        const part = slot - this.clock;
        this.acc += density * part;
        left -= part;
        this.clock = 0;
        this.ring[this.at] = this.acc;
        this.acc = 0;
        this.at = (this.at + 1) % this.size;
        if (this.filled < this.size) this.filled += 1;
      }
      this.acc += density * left;
      this.clock += left;
      this.sinceEval += dt * 1000;
      if (this.sinceEval >= this.evalMs) {
        this.sinceEval = 0;
        this._evaluate();
      }
      this._advance(dt);
    }

    /** Held still (paused): nothing is gathered, the clock does not run. */
    hold() {
      this.tick = false;
    }

    /** The envelope oldest first, its local mean taken away, the rest kept (only the jumps). */
    _envelope() {
      const n = this.filled;
      const x = this.x;
      const start = (this.at - n + this.size) % this.size;
      for (let i = 0; i < n; i += 1) x[i] = this.ring[(start + i) % this.size];
      // Moving average over about a quarter second, then half-wave rectified.
      const half = Math.round(this.rate * 0.12);
      let sum = 0;
      let lo = 0;
      let hi = -1;
      const out = this._env || (this._env = new Float32Array(this.size));
      for (let i = 0; i < n; i += 1) {
        while (hi < Math.min(n - 1, i + half)) sum += x[++hi];
        while (lo < i - half) sum -= x[lo++];
        const m = sum / (hi - lo + 1);
        out[i] = Math.max(0, x[i] - m);
      }
      return out;
    }

    _evaluate() {
      const n = this.filled;
      if (n < this.rate * 3) return;
      const e = this._envelope();
      let energy = 0;
      let mu = 0;
      for (let i = 0; i < n; i += 1) {
        energy += e[i] * e[i];
        mu += e[i];
      }
      if (energy <= 1e-9) {
        this.confidence *= 0.8;
        return;
      }
      energy /= n;
      mu /= n;
      // What any lag matches just from the envelope never being below 0.
      const floor = (mu * mu) / energy;
      // Autocorrelation per lag, as a share of the energy (1 = a perfect match).
      const maxAc = Math.min(this.ac.length - 1, n - Math.round(this.rate * 1.5));
      for (let L = 0; L <= maxAc; L += 1) {
        let s = 0;
        for (let i = L; i < n; i += 1) s += e[i] * e[i - L];
        this.ac[L] = s / (n - L) / energy;
      }
      const ac = (lag) => {
        if (lag > maxAc) return 0;
        const i = Math.floor(lag);
        const f = lag - i;
        return this.ac[i] * (1 - f) + this.ac[Math.min(maxAc, i + 1)] * f;
      };
      // A lag scores its own match and its multiples' (up to four beats),
      // each the best of itself and its neighbours (the beat wobbles).
      const peak = (lag) => Math.max(ac(lag - 1), ac(lag), ac(lag + 1));
      let mean = 0;
      let count = 0;
      for (let L = this.minLag; L <= this.maxLag; L += 1) {
        let s = peak(L);
        let w = 1;
        for (let k = 2; k <= 4; k += 1) {
          if (k * L > maxAc) break;
          s += peak(k * L) * 0.6;
          w += 0.6;
        }
        // The half beat matching too says the meter is duple: a dotted beat
        // (3/2 of the true one) has nothing half-way.
        s += peak(L / 2) * this.half;
        w += this.half;
        this.score[L] = (s / w) * this.prior[L];
        mean += this.score[L];
        count += 1;
      }
      mean /= count;
      const k = this.filled < this.size ? 0.35 : 0.2;
      let best = this.minLag;
      for (let L = this.minLag; L <= this.maxLag; L += 1) {
        this.smooth[L] += (this.score[L] - this.smooth[L]) * k;
        if (this.smooth[L] > this.smooth[best]) best = L;
      }
      // Keep the tempo there is unless another is clearly better.
      if (this.period) {
        const cur = Math.round(this.period * this.rate);
        if (cur >= this.minLag && cur <= this.maxLag && this.smooth[best] < this.smooth[cur] * this.keep) best = cur;
      }
      // Between whole slots: the top of a parabola through the best and its neighbours.
      const a = this.smooth[Math.max(this.minLag, best - 1)];
      const b = this.smooth[best];
      const c = this.smooth[Math.min(this.maxLag, best + 1)];
      const d = a - 2 * b + c;
      const rough = best + (d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0);
      // Then finer: the lag whose many multiples (as far back as the
      // envelope reaches) line up best; a few hundredths of a slot matter
      // when they add up over sixteen beats.
      let lag = rough;
      let top = -Infinity;
      for (let t = rough - 1; t <= rough + 1; t += 0.02) {
        let s = 0;
        for (let m = 1; m * t <= maxAc; m += 1) s += ac(m * t);
        if (s > top) {
          top = s;
          lag = t;
        }
      }
      // How clearly: how well the envelope matches itself a beat on, as a
      // correlation (that floor taken away: noise scores about 0).
      const corr = (peak(best) - floor) / Math.max(1e-6, 1 - floor);
      this.confidence += (Math.max(0, Math.min(1, (corr - CORR_MIN) / CORR_SPAN)) - this.confidence) * 0.3;
      const period = lag / this.rate;
      this.period = this.period ? this.period + (period - this.period) * 0.5 : period;
      this.bpm = 60 / this.period;
      this._findPhase(e, n, lag);
    }

    _smoothMean() {
      let s = 0;
      for (let L = this.minLag; L <= this.maxLag; L += 1) s += this.smooth[L];
      return s / (this.maxLag - this.minLag + 1);
    }

    /** Where the beats fall: the offset back from now whose comb of beats sums highest. */
    _findPhase(e, n, lag) {
      const span = Math.ceil(lag);
      let bestO = 0;
      let bestS = -1;
      const scores = this._phaseScores || (this._phaseScores = new Float32Array(this.maxLag + 2));
      // Where the clock says the last beat was, in slots back from now: an
      // offset near it counts a little more, so the beat does not flip
      // between two that match as well (every other beat, at half tempo).
      const expected = this.period ? (((this.phase - this.lead / this.period) % 1) + 1) % 1 * lag - this.clock * this.rate : null;
      for (let o = 0; o < span; o += 1) {
        let s = 0;
        let w = 1;
        for (let k = 0; k < 16; k += 1) {
          const t = n - 1 - o - k * lag;
          if (t < 2) break;
          // A little either side counts too (a triangle two slots wide each
          // way): an attack is a few slots wide and often split across two.
          const c = Math.round(t);
          let v = 0;
          for (let d = -2; d <= 2; d += 1) {
            const j = c + d;
            if (j >= 0 && j < n) v += e[j] * (1 - Math.abs(j - t) / 3);
          }
          s += v * w;
          w *= 0.88;
        }
        if (expected !== null) s *= 1 + STAY * Math.cos((2 * Math.PI * (o - expected)) / lag);
        scores[o] = s;
        if (s > bestS) {
          bestS = s;
          bestO = o;
        }
      }
      if (bestS <= 0) return;
      // Between slots: the top of a parabola through the best and its neighbours.
      const a = scores[(bestO - 1 + span) % span];
      const c = scores[(bestO + 1) % span];
      const d = a - 2 * bestS + c;
      const at = bestO + (d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0);
      // The beat fell that many slots ago (plus what is gathered in this
      // slot), and the clock runs a little ahead (lead).
      const since = (at + this.clock * this.rate) / lag;
      const target = (since + this.lead / this.period) % 1;
      let err = target - this.phase;
      err -= Math.round(err);
      this.err = err;
    }

    _advance(dt) {
      this.tick = false;
      if (!this.period) return;
      const step = dt / this.period;
      // Make up the error by running up to half again as fast, or half as fast.
      const adjust = Math.max(-0.5 * step, Math.min(0.5 * step, this.err * Math.min(1, dt * 6)));
      this.err -= adjust;
      this.phase += step + adjust;
      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase);
        this.beats += 1;
        this.tick = true;
      }
    }
  }

  return Tempo;
}));
