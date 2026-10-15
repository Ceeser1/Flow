'use strict';

// The equalizer's analysis: raw samples in, one level per bar out, 20 Hz to
// 4 kHz on a log axis. Pure, so test/spectrum.test.js can pin it; the window
// loads it as a plain script and gets `Spectrum` as a global.
//
// One short window for the whole range, about 85 ms, so every band reacts
// within 100 ms. A window that short cannot tell two bass notes 5 Hz apart (to
// resolve a difference of d Hz takes about 1/d seconds of sound), but it can
// say very precisely where a single note is. Each FFT bin's true frequency is
// read off how far its phase turned between two frames a few milliseconds
// apart ("frequency reassignment"), and its energy is placed there instead of
// at the bin's centre. The bass usually plays one note at a time, which is the
// case this is exact for, so a bass line shows as a narrow peak at the right
// place rather than as a block of bars a third of an octave wide.
//
// Where bars are wider than bins (above roughly 600 Hz) there is nothing to
// sharpen, and each bar is the average of the bins it covers.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Spectrum = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const TWO_PI = Math.PI * 2;

  /** Smallest power of two holding the window for this sample rate. */
  function windowSize(sampleRate, seconds) {
    return 2 ** Math.round(Math.log2(sampleRate * seconds));
  }

  /**
   * Math.hypot(x, y) to the bit, worked out the way V8's builtin does it
   * (scaled by the larger, then Kahan's sum, which for two terms is the plain
   * one). The builtin allocates on every call, thousands a frame here.
   */
  function hypot(x, y) {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    if (ax === Infinity || ay === Infinity) return Infinity;
    if (x !== x || y !== y) return NaN;
    const max = ay > ax ? ay : ax;
    if (max === 0) return 0;
    const nx = ax / max;
    const ny = ay / max;
    return Math.sqrt(nx * nx + ny * ny) * max;
  }

  /**
   * What analysers of one window size and hop share: the FFT, the window,
   * and the two frames' spectra, with which samples (and stamp) they are of.
   * Analysers asked about the same samples with the same stamp (one frame's
   * VizAudio, Bars and Spectrogram) work them out once.
   */
  const banks = new Map();
  function bankFor(n) {
    let bank = banks.get(n);
    if (!bank) {
      const window = new Float64Array(n);
      for (let i = 0; i < n; i += 1) window[i] = 0.5 * (1 - Math.cos((TWO_PI * i) / n));
      bank = {
        fft: new FFT(n),
        window,
        reA: new Float64Array(n),
        imA: new Float64Array(n),
        reB: new Float64Array(n),
        imB: new Float64Array(n),
        samples: null,
        hop: 0,
        stamp: undefined,
      };
      banks.set(n, bank);
    }
    return bank;
  }

  class FFT {
    constructor(n) {
      this.n = n;
      this.rev = new Uint32Array(n);
      const bits = Math.log2(n);
      for (let i = 0; i < n; i += 1) {
        let r = 0;
        for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
        this.rev[i] = r;
      }
      this.cos = new Float64Array(n / 2);
      this.sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i += 1) {
        this.cos[i] = Math.cos((TWO_PI * i) / n);
        this.sin[i] = -Math.sin((TWO_PI * i) / n);
      }
    }

    /** In place, re/im of length n. */
    transform(re, im) {
      const { n, rev } = this;
      for (let i = 0; i < n; i += 1) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0; k < half; k += 1) {
            const wr = this.cos[k * step];
            const wi = this.sin[k * step];
            const a = start + k;
            const b = a + half;
            const xr = re[b] * wr - im[b] * wi;
            const xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr;
            im[b] = im[a] - xi;
            re[a] += xr;
            im[a] += xi;
          }
        }
      }
    }
  }

  class Analyser {
    /**
     * bars: how many bars span minHz..maxHz. windowSeconds: the analysis
     * window, which is also roughly how long a new sound takes to show in
     * full. hop: samples between the two frames the phase is compared across.
     * spread: how wide a reassigned bin's energy is laid, in bins. Smaller is
     * sharper but lets noisy bins scatter.
     */
    constructor({ sampleRate, bars, minHz = 20, maxHz = 4000, windowSeconds = 0.085, hop = 256, spread = 0.3 }) {
      this.sampleRate = sampleRate;
      this.bars = bars;
      this.minHz = minHz;
      this.maxHz = maxHz;
      this.n = windowSize(sampleRate, windowSeconds);
      this.hop = hop;
      this.spread = spread;
      this.inputLength = this.n + hop;
      this.binHz = sampleRate / this.n;
      this.logSpan = Math.log(maxHz / minHz);
      // Each bar spans the same fraction of its own frequency.
      this.barRatio = Math.exp(this.logSpan / bars) - 1;

      this.bank = bankFor(this.n);
      this.fft = this.bank.fft;
      this.window = this.bank.window;
      this.power = new Float64Array(bars);
      this.out = new Float32Array(bars);
      this.kLast = Math.min(this.n / 2 - 1, Math.ceil((maxHz * 1.1) / this.binHz));
      // A Hann window's peak for a sine of amplitude 1 is n/4.
      this.scale = 4 / this.n;
    }

    /** Where a frequency sits on the bar axis, 0 at minHz and `bars` at maxHz. */
    position(hz) {
      return (Math.log(hz / this.minHz) / this.logSpan) * this.bars;
    }

    /** The frequency at the centre of bar i. */
    barHz(i) {
      return this.minHz * Math.exp(((i + 0.5) / this.bars) * this.logSpan);
    }

    /**
     * Levels in dB for the newest `inputLength` samples of `samples` (full
     * scale 0 dB: a full-scale sine reads about 0). stamp: when given, says
     * these samples are unchanged since another analyser of the same window
     * and hop was given them with the same stamp, whose spectra are reused.
     */
    analyse(samples, stamp) {
      const { n, hop, bank } = this;
      const { reA, imA, reB, imB } = bank;
      if (stamp === undefined || bank.samples !== samples || bank.hop !== hop || bank.stamp !== stamp) {
        const end = samples.length;
        const startB = end - n;
        const startA = startB - hop;
        // Both frames in one transform, A as the real part and B as the
        // imaginary (both are real), then told apart: A[k] = (Z[k] +
        // conj(Z[n-k])) / 2, B[k] = (Z[k] - conj(Z[n-k])) / 2i. Only bins
        // under n/2 are ever read (all analysers of this size, kLast at most
        // n/2 - 1), so A goes back in place.
        for (let i = 0; i < n; i += 1) {
          const w = this.window[i];
          reA[i] = (startA + i >= 0 ? samples[startA + i] : 0) * w;
          imA[i] = samples[startB + i] * w;
        }
        this.fft.transform(reA, imA);
        for (let k = 1; k < n / 2; k += 1) {
          const zr = reA[k];
          const zi = imA[k];
          const nr = reA[n - k];
          const ni = imA[n - k];
          reA[k] = (zr + nr) * 0.5;
          imA[k] = (zi - ni) * 0.5;
          reB[k] = (zi + ni) * 0.5;
          imB[k] = (nr - zr) * 0.5;
        }
        bank.samples = samples;
        bank.hop = hop;
        bank.stamp = stamp;
      }

      const power = this.power;
      power.fill(0);
      const bars = this.bars;
      const expectedStep = (TWO_PI * hop) / n;
      const toBins = n / (TWO_PI * hop);

      for (let k = 1; k <= this.kLast; k += 1) {
        const amp = hypot(reB[k], imB[k]) * this.scale;
        const p = amp * amp;
        if (p < 1e-12) continue;

        // How far the phase turned beyond what the bin's own centre would
        // turn in `hop` samples says how far off-centre the sound really is.
        let dphi = Math.atan2(imB[k], reB[k]) - Math.atan2(imA[k], reA[k]) - expectedStep * k;
        dphi -= TWO_PI * Math.round(dphi / TWO_PI);
        let offset = dphi * toBins;
        let spreadBins = this.spread;
        // Further out than the main lobe reaches means the bin is not really
        // one sound: leave it where it is and lay it wider.
        if (!(Math.abs(offset) <= 2.5)) {
          offset = 0;
          spreadBins = 1;
        }
        const hz = (k + offset) * this.binHz;
        if (hz < this.minHz * 0.9 || hz > this.maxHz * 1.1) continue;

        const barWidthHz = hz * this.barRatio;
        const pos = this.position(hz) - 0.5;
        const sigma = Math.max(0.7, (spreadBins * this.binHz) / barWidthHz);
        // Where bins are narrower than bars, a bar is the average of its bins
        // rather than their sum, so the top of the range does not climb just
        // because more bins fall into each bar.
        const density = Math.max(1, barWidthHz / this.binHz);
        const weight = p / density;
        const reach = Math.ceil(sigma * 3);
        const lo = Math.max(0, Math.floor(pos) - reach);
        const hi = Math.min(bars - 1, Math.ceil(pos) + reach);
        const inv = 1 / (2 * sigma * sigma);
        for (let b = lo; b <= hi; b += 1) {
          const d = b - pos;
          power[b] += weight * Math.exp(-d * d * inv);
        }
      }

      const out = this.out;
      for (let b = 0; b < bars; b += 1) out[b] = 10 * Math.log10(power[b] + 1e-12);
      return out;
    }
  }

  /** 0..1 for a level in dB between floor and ceiling. */
  function unit(db, floor, ceiling) {
    const t = (db - floor) / (ceiling - floor);
    return t <= 0 ? 0 : (t >= 1 ? 1 : t);
  }

  // hypot also for the visualizers' lines (viz/gl.js), a few thousand a frame.
  return { Analyser, FFT, windowSize, unit, hypot };
}));
