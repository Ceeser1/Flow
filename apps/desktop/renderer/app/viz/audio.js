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
//   dynamic    smooth against each band's own average of the last few
//              seconds: a loud master's wall of sound still moves, a band
//              holding steady sits at about half, what jumps out stands out
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
//
// The tempo (tempo.js), from the same jumps the onsets come from:
//   bpm        beats a minute, 0 until there is one
//   sure       0..1, how clearly the music has a beat (a drumless intro: ~0)
//   phase      0..1 through the beat, 0 on it
//   tick       true on the frame a beat lands (only while sure enough)
//   beats      beats so far (a bar is four): for things that change every few
//   pulse      1 on the beat, falling away before the next (0 while unsure)
//   pace       about 1 at 120 BPM, more for faster songs (1 while unsure),
//              eased: what motion should be scaled by
//   lock       0..1, how far to go by the tempo rather than the kicks (sure
//              blended in over a little range, 0 while paused)
//   throb      0..1, the kick while there is no clear beat, the beat's pulse
//              once there is (by lock): for what moves to the rhythm
//   surge(), motion()  speed factors that move with the beat, see there
//
// The notes (notes.js), worked out only for those that ask: notes() gives
// the levels per semitone, the chroma, the key; noteHue() a colour for the
// chord sounding.

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
  dynamic: new Float32Array(0),
  _mean: new Float32Array(0),
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
  bpm: 0,
  sure: 0,
  phase: 0,
  tick: false,
  beats: 0,
  pulse: 0,
  pace: 1,
  lock: 0,
  throb: 0,
  frames: 0,           // counts the frames, for what is worked out once a frame

  _spec: null,
  _prev: null,
  _kick: null,
  _intensity: null,
  _beatPeak: 0,
  _low: null,
  _all: null,
  _stereo: null,
  _tempo: null,
  _song: undefined,    // the song the tempo and the notes are of
  _fedAt: -1e9,        // when the tempo was last fed (ms)
  _clock: null,        // the audio clock then (seconds)
  _notes: null,
  _notesAt: -1,
  _dt: 0.016,
  // The tempo counts from SURE on; pace eases over PACE_MS.
  SURE: 0.35,
  PACE_MS: 2000,

  /** Ready for a visualizer opening; stereo when it wants both channels. */
  reset({ stereo = false } = {}) {
    const n = this.BANDS;
    this._spec = Equalizer.active
      ? new Spectrum.Analyser({ sampleRate: Equalizer.ctx.sampleRate, bars: n, minHz: this.MIN_HZ, maxHz: this.MAX_HZ, windowSeconds: 0.046, hop: 128 })
      : null;
    this.bands = new Float32Array(n);
    this.smooth = new Float32Array(n);
    this.dynamic = new Float32Array(n);
    this._mean = new Float32Array(n);
    this._heard = false;
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
    // The tempo carries on when one visualizer gives way to another on the
    // same song (the arrow keys, Random), and starts again otherwise.
    this._clock = null;
    if (!this._tempo || this._song !== Player.currentId || performance.now() - this._fedAt > 1000) {
      this._tempo = this._tempo || new Tempo();
      this._tempo.reset();
      if (this._notes) this._notes.reset();
      this._song = Player.currentId;
      Object.assign(this, { bpm: 0, sure: 0, phase: 0, tick: false, beats: 0, pulse: 0, pace: 1, lock: 0, throb: 0 });
    }
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
    this.frames += 1;
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
    // Each band against its own recent average, while something plays.
    // The first frames heard start the averages where they are.
    if (playing && !this._heard) {
      this._heard = true;
      this._mean.set(bands);
    }
    const km = playing ? 1 - Math.exp(-ms / 3000) : 0;
    for (let i = 0; i < n; i += 1) {
      const m = (this._mean[i] += (smooth[i] - this._mean[i]) * km);
      const d = 0.3 + (smooth[i] - m) * 2.2 + m * 0.35;
      this.dynamic[i] = smooth[i] < 0.02 ? smooth[i] : Math.min(1, Math.max(0, Math.min(d, smooth[i] * 1.6)));
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
    this._dt = dt;
    this._follow(allFlux / n, dt, ms, playing);

    if (this._stereo && playing) {
      this._stereo.left.getFloatTimeDomainData(this.left);
      this._stereo.right.getFloatTimeDomainData(this.right);
    } else if (this.left) {
      this.left.fill(0);
      this.right.fill(0);
    }
  },

  /** The tempo fed this frame's jump (a new song starts it again). */
  _follow(flux, dt, ms, playing) {
    const t = this._tempo;
    if (this._song !== Player.currentId) {
      this._song = Player.currentId;
      t.reset();
      if (this._notes) this._notes.reset();
    }
    // Timed by the audio clock, not the frame's (capped) time: a frame held
    // up while a visualizer starts would otherwise shift all the beats before
    // it against those after. A frame that got no new sound gets no time,
    // the next one all of it.
    const clock = Equalizer.ctx ? Equalizer.ctx.currentTime : null;
    let span = clock !== null && this._clock !== null ? clock - this._clock : dt;
    this._clock = clock;
    if (!(span >= 0) || span > 1) span = dt;
    if (playing) t.push(flux, span);
    else t.hold();
    this._fedAt = performance.now();
    this.bpm = t.bpm;
    this.sure = t.confidence;
    this.phase = t.phase;
    this.beats = t.beats;
    const sure = this.sure >= this.SURE && playing;
    this.tick = t.tick && sure;
    this.pulse = sure ? Math.exp(-5 * this.phase) : this.pulse * Math.exp(-ms / 150);
    const pace = sure ? Math.max(0.5, Math.min(1.6, this.bpm / 120)) : (playing ? this.pace : 1);
    this.pace += (pace - this.pace) * (1 - Math.exp(-ms / this.PACE_MS));
    this.lock = playing ? Math.max(0, Math.min(1, (this.sure - this.SURE + 0.1) / 0.25)) : 0;
    this.throb = this.kick + (this.pulse - this.kick) * this.lock;
  },

  /**
   * The tempo's speed factor: `pace` on average over each beat, but rushing
   * right after the beat and easing off before the next (surge 0: steady,
   * 1: nearly stopping between beats).
   */
  surge(surge = 0.5) {
    // k e^(-k phase) / (1 - e^-k) averages 1 over the beat.
    const K = 3;
    const shape = (K * Math.exp(-K * this.phase)) / (1 - Math.exp(-K));
    return this.pace * (1 - surge + surge * shape);
  },

  /**
   * A speed factor for things that fly or turn with the music: surge() while
   * the beat is clear; with no clear beat 1 and the kick's push (kickPush of
   * it for a full kick), blended between the two by lock.
   */
  motion(surge = 0.5, kickPush = 1.5) {
    const kick = 1 + kickPush * this.kick;
    return kick + (this.surge(surge) - kick) * this.lock;
  },

  /** The notes this frame (notes.js): level per semitone, chroma, key. Worked out on the first call a frame. */
  notes() {
    if (!this._notes) this._notes = new Notes({ sampleRate: Equalizer.ctx ? Equalizer.ctx.sampleRate : 48000 });
    if (this._notesAt !== this.frames) {
      this._notesAt = this.frames;
      const ok = this.playing && this.samples.length >= this._notes.inputLength;
      this._notes.analyse(ok ? this.samples : null, this._dt);
    }
    return this._notes;
  },

  /**
   * A colour for the harmony sounding: the chroma's pitch classes laid round
   * the circle of fifths (so related chords get related hues: C red, G
   * orange, D yellow ...) and averaged. { hue 0..1, strength 0..1 }: how
   * clearly one harmony stands out.
   */
  noteHue() {
    const c = this.notes().chroma;
    let x = 0;
    let y = 0;
    let sum = 0;
    for (let p = 0; p < 12; p += 1) {
      const a = (((p * 7) % 12) / 12) * Math.PI * 2;
      const v = c[p] * c[p];
      x += Math.cos(a) * v;
      y += Math.sin(a) * v;
      sum += v;
    }
    if (sum <= 0) return { hue: 0, strength: 0 };
    const hue = ((Math.atan2(y, x) / (Math.PI * 2)) + 1) % 1;
    return { hue, strength: Math.min(1, Math.hypot(x, y) / sum * 1.5) * this._notes.tonal };
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

  /**
   * The waveform as `n` points (newest last), -1..1: the low end only (a
   * loud song's full waveform is a wall of noise), evened out so a quiet
   * song swings as wide as a loud one. Worked out once a frame per n.
   */
  lowWave(n) {
    let w = this._low_waves && this._low_waves.get(n);
    if (!w) {
      w = { out: new Float32Array(n), gain: 0.05, at: -1 };
      this._low_waves = this._low_waves || new Map();
      this._low_waves.set(n, w);
    }
    if (w.at === this.frames) return w.out;
    w.at = this.frames;
    const src = this.wave(4096);
    const per = src.length / n;
    // Twice through a one-pole low pass, about 300 Hz.
    let y1 = 0;
    let y2 = 0;
    let peak = 0;
    const k = 0.04;
    let j = 0;
    for (let i = 0; i < n; i += 1) {
      const end = Math.floor((i + 1) * per);
      for (; j < end; j += 1) {
        y1 += (src[j] - y1) * k;
        y2 += (y1 - y2) * k;
      }
      w.out[i] = y2;
      peak = Math.max(peak, Math.abs(y2));
    }
    w.gain = Math.max(peak, w.gain * 0.97, 0.02);
    for (let i = 0; i < n; i += 1) w.out[i] /= w.gain;
    return w.out;
  },

  /** The newest `count` mono samples as a view (no copy). */
  wave(count) {
    const s = this.samples;
    const c = Math.min(count, s.length);
    return s.subarray(s.length - c);
  },
};
