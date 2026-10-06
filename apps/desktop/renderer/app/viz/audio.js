'use strict';

// What the music is doing right now, worked out once a frame for the
// visualizers in this folder (each its own file, added to the Music
// Visualizer with Visualizer.add). They all read the same sound the
// equalizer does (equalizer.js), before the volume, so they show the song
// rather than the volume knob.
//
//   playing    a song is playing (paused or stopped: the levels sink to 0)
//   samples    the newest sound, mono, -1..1; the last sample is the newest
//   left/right the same per channel, for those that ask (needStereo)
//   bands      BANDS levels 0..1 from 30 Hz to 16 kHz on a log axis, from a
//              short analysis (about 46 ms), the high ones tilted up a little
//              since music is quieter up there
//   smooth     the same, rising fast and falling over about a third of a second
//   bass, mid, treble  0..1, the smooth bands averaged up to 150 Hz, to 2 kHz,
//              and above; level: all of them
//   kick       0..1, the bass rising above its own recent average (Kick,
//              landscape.js), up fast and back over 300 ms
//   beat       the kick against the strongest of the last 3 s, so a calm part's
//              kicks are as clear as a drop's
//   intensity  0 (calm) .. 1 (the song's loudest parts), Intensity
//   onset      true on the frame a beat lands (the low end jumping well above
//              how much it has jumped lately), onsetPower how hard, 0..1
//   hit        the same for the whole range: snares, claps, crashes
//   time       seconds of music played since the visualizer opened (stands
//              still while paused): for things that move with the music

const VizAudio = {
  BANDS: 96,
  MIN_HZ: 30,
  MAX_HZ: 16000,
  FLOOR_DB: -64,
  CEIL_DB: -10,
  TILT_DB: 14,
  ATTACK_MS: 25,
  RELEASE_MS: 320,
  BASS_HZ: 150,
  TREBLE_HZ: 2000,
  // Onsets: the frame's jump (spectral flux) against its own recent mean and
  // spread; at least GAP_MS apart.
  ONSET_K: 1.6,
  ONSET_MIN: 0.02,
  ONSET_GAP_MS: 140,
  ONSET_MEAN_MS: 900,

  playing: false,
  samples: new Float32Array(0),
  left: null,
  right: null,
  bands: new Float32Array(0),
  smooth: new Float32Array(0),
  bass: 0,
  mid: 0,
  treble: 0,
  level: 0,
  kick: 0,
  beat: 0,
  intensity: 0,
  onset: false,
  onsetPower: 0,
  hit: false,
  hitPower: 0,
  time: 0,

  _spec: null,
  _prev: null,
  _kick: null,
  _intensity: null,
  _beatPeak: 0,
  _low: null,
  _all: null,
  _stereo: null,

  /** Ready for a visualizer opening; stereo when it wants both channels. */
  reset({ stereo = false } = {}) {
    const n = this.BANDS;
    this._spec = Equalizer.active
      ? new Spectrum.Analyser({ sampleRate: Equalizer.ctx.sampleRate, bars: n, minHz: this.MIN_HZ, maxHz: this.MAX_HZ, windowSeconds: 0.046, hop: 128 })
      : null;
    this.bands = new Float32Array(n);
    this.smooth = new Float32Array(n);
    this._prev = new Float32Array(n);
    this._kick = new Kick();
    this._intensity = new Intensity();
    this._beatPeak = 0;
    this._low = { mean: 0, dev: 0, last: -1e9 };
    this._all = { mean: 0, dev: 0, last: -1e9 };
    this._lowEnd = 0;
    this._midEnd = 0;
    if (this._spec) {
      while (this._lowEnd < n && this._spec.barHz(this._lowEnd) <= this.BASS_HZ) this._lowEnd += 1;
      this._midEnd = this._lowEnd;
      while (this._midEnd < n && this._spec.barHz(this._midEnd) <= this.TREBLE_HZ) this._midEnd += 1;
    }
    Object.assign(this, { bass: 0, mid: 0, treble: 0, level: 0, kick: 0, beat: 0, intensity: 0, onset: false, onsetPower: 0, hit: false, hitPower: 0, time: 0 });
    this._stereo = stereo && Equalizer.active ? Equalizer.stereo() : null;
    this.left = this._stereo ? new Float32Array(this._stereo.left.fftSize) : null;
    this.right = this._stereo ? new Float32Array(this._stereo.right.fftSize) : null;
  },

  /** Frequency at the middle of band i. */
  bandHz(i) {
    return this._spec ? this._spec.barHz(i) : this.MIN_HZ * (this.MAX_HZ / this.MIN_HZ) ** ((i + 0.5) / this.BANDS);
  },

  /** samples: the analyser's newest (Visualizer reads them); dt in seconds, now in ms. */
  update(samples, dt, now) {
    this.samples = samples;
    const playing = Player.isPlaying && !!this._spec;
    this.playing = playing;
    const n = this.BANDS;
    const ms = dt * 1000;
    const rise = 1 - Math.exp(-ms / this.ATTACK_MS);
    const fall = Math.exp(-ms / this.RELEASE_MS);
    const bands = this.bands;
    const smooth = this.smooth;
    const prev = this._prev;
    prev.set(bands);
    if (playing) {
      this.time += dt;
      const db = this._spec.analyse(samples);
      for (let i = 0; i < n; i += 1) bands[i] = Spectrum.unit(db[i] + (this.TILT_DB * i) / (n - 1), this.FLOOR_DB, this.CEIL_DB);
    } else {
      for (let i = 0; i < n; i += 1) bands[i] *= fall;
    }
    let bass = 0;
    let mid = 0;
    let treble = 0;
    let lowFlux = 0;
    let allFlux = 0;
    for (let i = 0; i < n; i += 1) {
      const v = bands[i];
      smooth[i] = v >= smooth[i] ? smooth[i] + (v - smooth[i]) * rise : v + (smooth[i] - v) * fall;
      if (i < this._lowEnd) bass += smooth[i];
      else if (i < this._midEnd) mid += smooth[i];
      else treble += smooth[i];
      const d = v - prev[i];
      if (d > 0) {
        if (i < this._lowEnd) lowFlux += d;
        allFlux += d;
      }
    }
    this.bass = this._lowEnd ? bass / this._lowEnd : 0;
    this.mid = this._midEnd > this._lowEnd ? mid / (this._midEnd - this._lowEnd) : 0;
    this.treble = n > this._midEnd ? treble / (n - this._midEnd) : 0;
    this.level = (bass + mid + treble) / n;

    this.kick = this._kick.follow(playing ? Equalizer.bass || 0 : 0, ms);
    this._beatPeak = Math.max(this.kick, this._beatPeak * Math.exp(-ms / 3000));
    this.beat = this.kick / Math.max(0.3, this._beatPeak);
    this.intensity = this._intensity.follow(playing ? Equalizer.levels : null, ms);

    // Per frame the jump depends on how long the frame was: per second.
    const o = this._detect(this._low, this._lowEnd ? lowFlux / this._lowEnd / dt : 0, ms, now, playing);
    this.onset = o > 0;
    this.onsetPower = o;
    const hit = this._detect(this._all, (allFlux / n) / dt, ms, now, playing);
    this.hit = hit > 0;
    this.hitPower = hit;

    if (this._stereo && playing) {
      this._stereo.left.getFloatTimeDomainData(this.left);
      this._stereo.right.getFloatTimeDomainData(this.right);
    } else if (this.left) {
      this.left.fill(0);
      this.right.fill(0);
    }
  },

  /** An onset for this flux (per second), or 0: how far above the usual it went, 0..1. */
  _detect(s, flux, ms, now, playing) {
    if (!playing) {
      s.mean *= 0.9;
      s.dev *= 0.9;
      return 0;
    }
    const k = 1 - Math.exp(-ms / this.ONSET_MEAN_MS);
    const over = flux - (s.mean + this.ONSET_K * s.dev);
    s.mean += (flux - s.mean) * k;
    s.dev += (Math.abs(flux - s.mean) - s.dev) * k;
    if (over <= 0 || flux < this.ONSET_MIN / 0.016 || now - s.last < this.ONSET_GAP_MS) return 0;
    s.last = now;
    return Math.min(1, 0.25 + over / Math.max(1e-6, s.mean + 3 * s.dev));
  },

  /** The newest `count` mono samples as a view (no copy). */
  wave(count) {
    const s = this.samples;
    const c = Math.min(count, s.length);
    return s.subarray(s.length - c);
  },
};
