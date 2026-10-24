'use strict';

// The sound equalizer (Settings > Equalizer; not the bars behind the pages,
// equalizer.js). Its bands are points on a curve from 20 Hz to 20 kHz, evenly
// spread on a log scale (8 to 48 of them, 16 by default), each -12 to +12 dB;
// between two points the curve eases out of the one and into the next (flat
// at each point). Standard, Bass Boost, Subtle and Intimate are curves by
// frequency, so they fit any number of bands; Custom is the user's own points
// (soundEqCustom), kept while the others are tried.
//
// The sound follows the curve itself, not only its points: one filter made
// from the whole curve (a minimum-phase impulse response, so nothing is held
// back) in a ConvolverNode, put between the player's mix and the limiter
// (equalizer.js). A new curve goes to the second convolver and is faded over
// to, as a jump would click; a flat curve is passed by, untouched.
//
// The numbers (freqs, at, resample, impulse) need no browser: tested in Node.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoundEq = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const LOW_HZ = 20;
  const HIGH_HZ = 20000;
  const MAX_DB = 12;
  const MIN_BANDS = 8;
  const MAX_BANDS = 48;
  const DEFAULT_BANDS = 16;

  // [Hz, dB] points, eased between as the bands are; nothing given is 0 dB.
  const PRESETS = {
    standard: { name: 'Standard', points: [] },
    // The low end lifted: already up at 20 Hz, the peak at 80 Hz, back to 0 by 250 Hz.
    bass: { name: 'Bass Boost', points: [[20, 4], [80, 6], [250, 0]] },
    // The bass held down a little, a light lift at the top.
    subtle: { name: 'Subtle', points: [[20, -2], [80, -1.5], [250, -0.5], [1000, -0.5], [3000, 0.5], [8000, 1.5], [20000, 2]] },
    // A wave: the low end down, the middle (500 Hz) up, the highs a little down.
    intimate: { name: 'Intimate', points: [[20, -6], [500, 6], [20000, -3]] },
  };
  const CHOICES = [...Object.keys(PRESETS), 'custom'];

  /** The bands' frequencies: `n` from 20 Hz to 20 kHz, evenly on a log scale. */
  function freqs(n) {
    return Array.from({ length: n }, (_, i) => LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / (n - 1)));
  }

  /**
   * The curve through [Hz, dB] points (by frequency) at `hz`: eased in and out
   * between two (smoothstep on the log scale), the end ones' beyond them.
   */
  function at(points, hz) {
    if (!points.length) return 0;
    if (hz <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i += 1) {
      const [f1, d1] = points[i];
      if (hz > f1) continue;
      const [f0, d0] = points[i - 1];
      const t = Math.log(hz / f0) / Math.log(f1 / f0);
      return d0 + (d1 - d0) * t * t * (3 - 2 * t);
    }
    return points[points.length - 1][1];
  }

  /** Band gains (dB) as [Hz, dB] points. */
  function pointsOf(gains) {
    const fs = freqs(gains.length);
    return gains.map((g, i) => [fs[i], g]);
  }

  const round = (db) => Math.round(Math.max(-MAX_DB, Math.min(MAX_DB, db)) * 10) / 10;

  /** `gains` spread over `n` bands: each new point where the curve was. */
  function resample(gains, n) {
    if (gains.length === n) return gains.slice();
    const pts = pointsOf(gains);
    return freqs(n).map((f) => round(at(pts, f)));
  }

  /** A preset's gains on `n` bands. */
  function presetGains(id, n) {
    const p = PRESETS[id] || PRESETS.standard;
    return freqs(n).map((f) => round(at(p.points, f)));
  }

  /** The gains shown and heard for these settings. */
  function gainsOf(s) {
    const n = Math.max(MIN_BANDS, Math.min(MAX_BANDS, Math.round(Number(s.soundEqBands)) || DEFAULT_BANDS));
    if (s.soundEqPreset !== 'custom') return presetGains(s.soundEqPreset, n);
    const own = Array.isArray(s.soundEqCustom) ? s.soundEqCustom : [];
    return own.length >= 2 ? resample(own, n) : new Array(n).fill(0);
  }

  // ---- the filter ----

  /** In-place FFT of (re, im), whose length is a power of two; `inverse` scales by 1/n. */
  function fft(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    const sign = inverse ? 1 : -1;
    for (let k = 0; k < n / 2; k += 1) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = sign * Math.sin((2 * Math.PI * k) / n);
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k += 1) {
          const a = start + k;
          const b = a + half;
          const wr = cos[k * step];
          const wi = sin[k * step];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i += 1) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }

  /** How many samples the filter has at this rate (a fifth of a second or more, for 20 Hz). */
  function taps(rate) {
    return 2 ** Math.ceil(Math.log2(rate * 0.2));
  }

  /**
   * The curve through the band gains as a minimum-phase impulse response at
   * `rate` (its magnitude the curve, made causal by folding the cepstrum).
   * Below 20 Hz and above 20 kHz the end bands' gain.
   */
  function impulse(gains, rate) {
    const len = taps(rate);
    const n = len * 4;
    const pts = pointsOf(gains);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let k = 0; k <= n / 2; k += 1) {
      const hz = Math.min(HIGH_HZ, Math.max(LOW_HZ, (k * rate) / n));
      re[k] = (at(pts, hz) * Math.LN10) / 20;
      if (k > 0 && k < n / 2) re[n - k] = re[k];
    }
    fft(re, im, true);
    for (let i = 1; i < n / 2; i += 1) {
      re[i] *= 2;
      im[i] *= 2;
    }
    for (let i = n / 2 + 1; i < n; i += 1) {
      re[i] = 0;
      im[i] = 0;
    }
    im[0] = 0;
    im[n / 2] = 0;
    fft(re, im);
    for (let k = 0; k < n; k += 1) {
      const mag = Math.exp(re[k]);
      const ph = im[k];
      re[k] = mag * Math.cos(ph);
      im[k] = mag * Math.sin(ph);
    }
    fft(re, im, true);
    const out = new Float32Array(len);
    const tail = len / 4;
    for (let i = 0; i < len; i += 1) {
      const fadeAt = i - (len - tail);
      out[i] = re[i] * (fadeAt > 0 ? 0.5 + 0.5 * Math.cos((Math.PI * fadeAt) / tail) : 1);
    }
    return out;
  }

  // ---- in the player ----

  const SoundEq = {
    LOW_HZ, HIGH_HZ, MAX_DB, MIN_BANDS, MAX_BANDS, DEFAULT_BANDS, PRESETS, CHOICES,
    freqs, at, pointsOf, resample, presetGains, gainsOf, impulse, fft,
    FADE_S: 0.015,       // the fade between one curve and the next (time constant)
    BUILD_MS: 60,        // while a point is dragged, a new filter at most this often

    ctx: null,
    dry: null,
    wet: [],             // two { conv, gain }: the one heard and the one faded from
    live: -1,            // which is heard (-1: none, the sound passes untouched)
    boosting: false,     // some band above 0 dB: the limiter catches the peaks
    _last: 0,
    _timer: 0,
    _key: '',

    /**
     * Between `source` and what follows it in the player's route; the node to
     * connect on from. Only where the app has the equalizer (Store.can('soundEq')).
     */
    attach(ctx, source) {
      this.ctx = ctx;
      const input = ctx.createGain();
      const output = ctx.createGain();
      source.connect(input);
      this.dry = ctx.createGain();
      input.connect(this.dry);
      this.dry.connect(output);
      this.wet = [0, 1].map(() => {
        const conv = ctx.createConvolver();
        conv.normalize = false;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        input.connect(conv);
        conv.connect(gain);
        gain.connect(output);
        return { conv, gain };
      });
      Store.onSettings((patch) => {
        if (['soundEqBands', 'soundEqPreset', 'soundEqCustom'].some((k) => k in patch)) this.update();
      });
      this.update();
      return output;
    },

    /** The curve changed: a new filter now, or soon while it keeps changing. */
    update() {
      if (!this.ctx || this._timer) return;
      const wait = this._last + this.BUILD_MS - performance.now();
      if (wait > 0) {
        this._timer = setTimeout(() => {
          this._timer = 0;
          this.update();
        }, wait);
        return;
      }
      this._last = performance.now();
      this._apply(gainsOf(Store.settings));
    },

    _apply(gains) {
      const key = gains.join(',');
      if (key === this._key) return;
      this._key = key;
      const boosting = gains.some((g) => g > 0);
      if (boosting !== this.boosting) {
        this.boosting = boosting;
        Equalizer.setLimiter();
      }
      const flat = gains.every((g) => g === 0);
      let next = -1;
      if (!flat) {
        next = this.live === 0 ? 1 : 0;
        const ir = impulse(gains, this.ctx.sampleRate);
        const buffer = this.ctx.createBuffer(1, ir.length, this.ctx.sampleRate);
        buffer.copyToChannel(ir, 0);
        this.wet[next].conv.buffer = buffer;
      }
      this.live = next;
      const now = this.ctx.currentTime;
      this.dry.gain.setTargetAtTime(next === -1 ? 1 : 0, now, this.FADE_S);
      this.wet.forEach((w, i) => w.gain.gain.setTargetAtTime(i === next ? 1 : 0, now, this.FADE_S));
      // The one faded from let go once silent, so it costs nothing.
      setTimeout(() => {
        this.wet.forEach((w, i) => {
          if (i !== this.live && w.conv.buffer) w.conv.buffer = null;
        });
      }, this.FADE_S * 1000 * 12);
    },
  };

  return SoundEq;
}));
