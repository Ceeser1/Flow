'use strict';

// Which notes are sounding: one level per semitone over six octaves, the
// twelve pitch classes summed over the octaves (chroma), and the key the
// music has been in lately. Pure, so test/notes.test.js can pin it; the
// window loads it as a plain script and gets `Notes` as a global (VizAudio
// works it out for the visualizers that ask).
//
// The analysis is Spectrum's (frequency reassignment), one bar per semitone,
// over a long window (about 170 ms) so neighbouring notes in the bass fall
// apart. Each semitone's level is how far it stands out above the spectrum
// around it, so a note shows and a wash of noise does not. Its overtones land
// on the octave, the fifth and the third above: the chroma leans towards the
// chord the note belongs to, which is what the colours want.
//
// The key: the chroma averaged over the last several seconds, compared with
// the profile of each of the 24 major and minor keys (Krumhansl and
// Kessler's probe-tone ratings); the best match is the key, how far it
// stands out from the next its clarity.

(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./spectrum') : root.Spectrum);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Notes = api;
}(typeof self !== 'undefined' ? self : this, (Spectrum) => {
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  /** Frequency of a MIDI note (69 = A4 = 440 Hz). */
  function hz(midi) {
    return 440 * 2 ** ((midi - 69) / 12);
  }

  /** Pearson correlation of a with b rotated by `shift` (b[(i - shift) mod 12] against a[i]). */
  function correlate(a, b, shift) {
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < 12; i += 1) {
      ma += a[i];
      mb += b[i];
    }
    ma /= 12;
    mb /= 12;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < 12; i += 1) {
      const x = a[i] - ma;
      const y = b[(i - shift + 12) % 12] - mb;
      sab += x * y;
      saa += x * x;
      sbb += y * y;
    }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
  }

  class Notes {
    /**
     * low: the lowest note (MIDI, 36 = C2), count: how many semitones up from
     * it. keySeconds: how long the key's chroma average looks back.
     */
    constructor({ sampleRate, low = 36, count = 72, windowSeconds = 0.17, hop = 256, keySeconds = 8 } = {}) {
      this.low = low;
      this.count = count;
      this.spec = new Spectrum.Analyser({
        sampleRate, bars: count, minHz: hz(low - 0.5), maxHz: hz(low + count - 0.5), windowSeconds, hop, spread: 0.3,
      });
      this.inputLength = this.spec.inputLength;
      this.keySeconds = keySeconds;
      this.level = new Float32Array(count);   // 0..1 per semitone, low first
      this.chroma = new Float32Array(12);     // 0..1 per pitch class, C first, the loudest 1
      this.average = new Float32Array(12);    // the chroma over the last keySeconds
      this._pow = new Float32Array(count);
      this._near = new Float32Array(12);
      this.reset();
    }

    reset() {
      this.level.fill(0);
      this.chroma.fill(0);
      this.average.fill(0);
      this.tonal = 0;       // 0..1: how much of the sound is clear notes
      this.strongest = -1;  // the loudest semitone's MIDI note, -1 for none
      this.key = -1;        // the key's tonic, 0..11 (C..B), -1 until there is one
      this.minor = false;
      this.clarity = 0;     // 0..1: how clearly that key wins
    }

    /** MIDI note of semitone i. */
    midi(i) {
      return this.low + i;
    }

    /** "C#4" for a MIDI note. */
    static name(midi) {
      return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
    }

    /** "A minor" for a key. */
    static keyName(tonic, minor) {
      return tonic < 0 ? '' : `${NAMES[tonic]} ${minor ? 'minor' : 'major'}`;
    }

    /** The newest samples (at least inputLength), dt seconds since the last call. Silence: null. */
    analyse(samples, dt) {
      const n = this.count;
      const level = this.level;
      if (!samples) {
        for (let i = 0; i < n; i += 1) level[i] *= 0.85;
        for (let p = 0; p < 12; p += 1) this.chroma[p] *= 0.85;
        this.tonal *= 0.85;
        return;
      }
      const db = this.spec.analyse(samples);
      // How far each semitone stands out above its surroundings (the median
      // of the six either side in dB, so the other notes of a chord do not
      // raise it), and how loud it is.
      let loudest = -Infinity;
      for (let i = 0; i < n; i += 1) loudest = Math.max(loudest, db[i]);
      let strongest = -1;
      let top = 0;
      let peaks = 0;
      let all = 0;
      const near = this._near;
      for (let i = 0; i < n; i += 1) {
        let c = 0;
        for (let j = Math.max(0, i - 6); j <= Math.min(n - 1, i + 6); j += 1) if (j !== i) near[c++] = db[j];
        const around = near.subarray(0, c).sort();
        const above = db[i] - around[c >> 1];
        // Only a peak counts: louder than both neighbours.
        const peak = (i === 0 || db[i] >= db[i - 1]) && (i === n - 1 || db[i] >= db[i + 1]);
        const loud = Math.max(0, Math.min(1, (db[i] - Math.max(-70, loudest - 36)) / 30));
        const v = peak ? Math.max(0, Math.min(1, (above - 3) / 12)) * loud : 0;
        level[i] = v;
        this._pow[i] = v * v;
        all += loud;
        peaks += v;
        if (v > top) {
          top = v;
          strongest = i;
        }
      }
      this.strongest = strongest >= 0 ? this.midi(strongest) : -1;
      this.tonal = all > 0 ? Math.min(1, peaks / Math.max(1, all * 0.25)) : 0;

      const chroma = this.chroma;
      chroma.fill(0);
      for (let i = 0; i < n; i += 1) chroma[(this.low + i) % 12] += this._pow[i];
      let max = 0;
      for (let p = 0; p < 12; p += 1) max = Math.max(max, chroma[p]);
      if (max > 0) for (let p = 0; p < 12; p += 1) chroma[p] = Math.sqrt(chroma[p] / max);

      // The key, from the chroma of the last keySeconds (only while there are notes).
      const k = (1 - Math.exp(-dt / this.keySeconds)) * Math.min(1, this.tonal * 2);
      for (let p = 0; p < 12; p += 1) this.average[p] += (chroma[p] - this.average[p]) * k;
      let best = -2;
      let second = -2;
      let key = -1;
      let minor = false;
      for (let t = 0; t < 12; t += 1) {
        for (const m of [false, true]) {
          const r = correlate(this.average, m ? MINOR : MAJOR, t);
          if (r > best) {
            second = best;
            best = r;
            key = t;
            minor = m;
          } else if (r > second) second = r;
        }
      }
      const clarity = Math.max(0, Math.min(1, (best - second) * 6 + (best - 0.4)));
      // Hold on to the key unless another is clearly ahead.
      if (key !== this.key || minor !== this.minor) {
        const cur = this.key >= 0 ? correlate(this.average, this.minor ? MINOR : MAJOR, this.key) : -2;
        if (this.key < 0 || best > cur + 0.05) {
          this.key = key;
          this.minor = minor;
        }
      }
      this.clarity += (clarity - this.clarity) * Math.min(1, dt * 2);
    }
  }

  Notes.NAMES = NAMES;
  Notes.hz = hz;
  return Notes;
}));
