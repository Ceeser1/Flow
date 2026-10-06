'use strict';

// The equalizer behind the content: the main player's sound, 20 Hz to 4 kHz,
// mirrored about the top edge of the player bar. It reaches a third of the way
// up the pages, and the half below the line runs behind the player bar and off
// the bottom of the window.
//
// It also owns the player's route to the speakers, since the analysis has to
// sit on it. The player has two elements (the second plays the next song
// during a song transition), each with its own two gains:
//
//   element -> loudness -> fade --+
//   element -> loudness -> fade --+-> mix -> [limiter] -> analyser -> volume -> out
//
// "loudness" evens out loud and quiet songs (Equalize volume), "fade" is the
// song transition, and the limiter catches the peaks of a song turned up. The
// analyser comes before the volume, so the picture shows the song rather than
// the volume knob. If Web Audio is not to be had, the elements play as before
// and there is no equalizer, transition or evening out.
//
// It is background, not a feature: soft bars with a little glow, slow to fall.
// Drawn at full size (at half size the thin bars came out stepped once they
// were no longer heavily blurred): sharp bars onto a scratch canvas,
// faded towards their tips, then that twice onto the visible one, once very
// blurred and stretched far upwards for the shine, and once blurred for the
// bars themselves. Last, the whole picture is faded out towards the top of the
// canvas, so the shine ends in full transparency instead of at an edge.

const Equalizer = {
  ctx: null,
  analyser: null,
  gain: null,
  spec: null,
  samples: null,
  levels: new Float32Array(0),
  canvas: null,
  scratch: null,
  elements: [],
  channels: null,      // element -> { norm, fade } gains
  mix: null,
  limiter: null,
  raf: null,
  lastFrame: 0,
  geom: null,
  bass: 0,             // 0..1, the kick band right now, unsmoothed (ambient.js)
  feel: 0,             // 0..1, the bars up to FEEL_HZ right now, averaged (flash.js)
  feelBars: 0,         // how many bars that is
  rainbowShift: 0,     // 0..1, how far Rainbow has drifted; held while nothing plays
  bassWeights: null,   // per bar, how much it counts towards `bass` (BASS_*)

  // Look. Distances are in css pixels.
  SCALE: 1,            // canvas resolution against css pixels
  PITCH: 4,            // one bar every 4 px
  BAR: 2.5,            // of which the bar is this wide
  // Measured on music: half of all bars sit below about -50 dB, one in ten
  // above -30, one in a hundred above -15. This range leaves the quiet bands
  // low and gives the loud ones the height.
  FLOOR_DB: -58,       // the level a bar starts at
  CEIL_DB: -8,         // and reaches full height at
  // Height and shine follow Settings (50% each by default): at 50% the bars
  // reach a third of the pages' height and the shine 1.7 times as far.
  REACH: 1 / 3,        // full height at 50%, as a share of the pages' height
  SHINE: 1.7,          // how much further the shine reaches at 50%
  // The bars are drawn solid and the shine at SHINE_ALPHA of them; Settings'
  // Visibility is then the whole canvas's opacity, so 100% is fully opaque.
  // Above 50% the shine also starts brighter at the bars (up to SHINE_BOOST
  // times) and fades out faster away from them, as (1 - distance) to the
  // power of up to SHINE_FALLOFF; below 50% it starts dimmer.
  CORE_BLUR: 4,
  CORE_ALPHA: 1,
  SHINE_BLUR: 36,
  SHINE_ALPHA: 0.59,
  SHINE_BOOST: 1.4,
  SHINE_FALLOFF: 2,
  // Bars rise over about 60 ms (the analysis itself adds as much again, so a
  // sound still shows within 100 ms) and fall back over about half a second,
  // which turns the flicker of single frames into a slow breathing.
  ATTACK_MS: 30,
  RELEASE_MS: 480,
  // The bass level the clouds' pulse and Screen Flash react to: the bars
  // weighted by how close they are to BASS_PEAK_HZ, where a kick drum punches,
  // falling in a straight line to nothing at BASS_LOW_HZ (sub rumble and the
  // long tails of kicks) and at BASS_HIGH_HZ (bass lines, snare, voices).
  BASS_LOW_HZ: 20,
  BASS_PEAK_HZ: 70,
  BASS_HIGH_HZ: 120,
  // Screen Flash only looks at the bass felt more than heard: up to FEEL_HZ.
  FEEL_HZ: 80,
  RAINBOW_MS: 15000,   // Rainbow drifts one screen width to the right in this long

  /** Wires the player's elements through Web Audio. False when that failed. */
  attach(elements) {
    this.elements = elements;
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      this.spec = new Spectrum.Analyser({ sampleRate: ctx.sampleRate, bars: 1 });
      // The analyser only keeps the newest fftSize samples; two frames need
      // the window plus the hop between them. At least 16384: the
      // visualizers' notes (notes.js) look at a longer window.
      analyser.fftSize = Math.min(32768, Math.max(16384, 2 ** Math.ceil(Math.log2(this.spec.inputLength))));
      const mix = ctx.createGain();
      // Only there to catch peaks: fast, hard, and just under full scale.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -2;
      limiter.knee.value = 1;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      const gain = ctx.createGain();
      // The output delay (output.js): the sound itself held back, to the
      // sample, before the analyser so the bars stay with what is heard.
      const delay = ctx.createDelay(1);
      delay.delayTime.value = Output.delay() / 1000;
      delay.connect(analyser);
      this.channels = new Map();
      for (const el of elements) {
        const norm = ctx.createGain();
        const fade = ctx.createGain();
        ctx.createMediaElementSource(el).connect(norm);
        norm.connect(fade);
        fade.connect(mix);
        this.channels.set(el, { norm, fade });
      }
      analyser.connect(gain);
      gain.connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
      this.mix = mix;
      this.limiter = limiter;
      this.delay = delay;
      this.gain = gain;
      this.samples = new Float32Array(analyser.fftSize);
      this.setLimiter(Store.settings.normalize);
    } catch (err) {
      console.warn('No equalizer:', err);
      this.ctx = null;
      this.channels = null;
      return false;
    }

    this.canvas = $('eqCanvas');
    this.scratch = document.createElement('canvas');
    this.glow = document.createElement('canvas'); // the shine, before it joins the bars
    this._layout();
    this._applyVisibility();
    new ResizeObserver(() => this._layout()).observe(document.querySelector('.content'));
    Store.onSettings((patch) => {
      if (['eqOn', 'eqHeight', 'eqShine', 'eqShineSpread', 'eqColors'].some((k) => k in patch)) this._layout();
      if ('eqVisibility' in patch) this._applyVisibility();
      if ('normalize' in patch) this.setLimiter(Store.settings.normalize);
    });

    for (const el of elements) {
      el.addEventListener('play', () => this.wake());
      el.addEventListener('playing', () => this.wake());
    }
    return true;
  },

  get active() {
    return !!this.ctx;
  },

  /** The gains of one of the player's elements, or null without Web Audio. */
  channel(el) {
    return this.channels ? this.channels.get(el) || null : null;
  },

  /**
   * An analyser for each channel, beside the one for both, for the
   * visualizers that show left against right; made the first time one asks.
   */
  stereo() {
    if (!this.ctx) return null;
    if (!this._stereo) {
      const split = this.ctx.createChannelSplitter(2);
      const left = this.ctx.createAnalyser();
      const right = this.ctx.createAnalyser();
      left.fftSize = 4096;
      right.fftSize = 4096;
      this.delay.connect(split);
      split.connect(left, 0);
      split.connect(right, 1);
      this._stereo = { left, right };
    }
    return this._stereo;
  },

  /** The limiter goes in with "Equalize volume", which may turn songs up. */
  setLimiter(on) {
    if (!this.ctx) return;
    this.mix.disconnect();
    this.limiter.disconnect();
    if (on) {
      this.mix.connect(this.limiter);
      this.limiter.connect(this.delay);
    } else {
      this.mix.connect(this.delay);
    }
  },

  /** Holds the sound back `ms` (output.js), gliding there: a jump would click. */
  setDelay(ms) {
    if (!this.delay) return;
    const v = Math.max(0, Math.min(1000, Number(ms) || 0)) / 1000;
    if (Math.abs(this.delay.delayTime.value - v) < 0.00005) return;
    this.delay.delayTime.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  },

  setVolume(v) {
    if (!this.gain) return;
    // A short glide rather than a jump, which would click.
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  },

  /** Starts drawing; it stops by itself once paused and settled. */
  wake() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.raf === null) {
      this.lastFrame = performance.now();
      this.raf = requestAnimationFrame((t) => this._frame(t));
    }
  },

  _sounding() {
    return this.elements.some((a) => !a.paused && !a.ended && !!a.getAttribute('src'));
  },

  /** Full height (share of the pages' height) and shine reach, from Settings. */
  _look() {
    const s = Store.settings;
    return {
      reach: this.REACH * (s.eqHeight || 50) / 50,
      shine: s.eqShine === false ? 0 : 1 + (this.SHINE - 1) * (s.eqShineSpread || 50) / 50,
    };
  },

  _applyVisibility() {
    this.canvas.style.opacity = String((Store.settings.eqVisibility || 50) / 100);
  },

  // ---- geometry ----

  _layout() {
    const content = document.querySelector('.content');
    const player = $('player');
    if (!content || !player || !this.canvas) return;
    const width = content.clientWidth;
    // The top edge of the player bar; as the Flow visualizer (visualizer.js),
    // the bottom of the screen.
    const lineY = document.body.classList.contains('viz-flow') ? content.clientHeight : player.offsetTop;
    const look = this._look();
    const reach = lineY * look.reach;
    const top = Math.max(0, lineY - reach * Math.max(1, look.shine) * 1.05);
    const height = content.clientHeight - top;
    this.geom = { width, height, top, center: lineY - top, reach, shine: look.shine };
    this.canvas.style.top = top + 'px';
    this.canvas.style.height = height + 'px';
    const w = Math.max(1, Math.round(width * this.SCALE));
    const h = Math.max(1, Math.round(height * this.SCALE));
    for (const c of [this.canvas, this.scratch, this.glow]) {
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
    }

    const bars = Math.max(16, Math.floor(width / this.PITCH));
    if (this.ctx && (!this.spec || this.spec.bars !== bars)) {
      this.spec = new Spectrum.Analyser({ sampleRate: this.ctx.sampleRate, bars });
      this.feelBars = 0;
      while (this.feelBars < bars && this.spec.barHz(this.feelBars) <= this.FEEL_HZ) this.feelBars += 1;
      this.bassWeights = new Float32Array(bars);
      for (let i = 0; i < bars; i += 1) {
        const hz = this.spec.barHz(i);
        const w = hz <= this.BASS_PEAK_HZ
          ? (hz - this.BASS_LOW_HZ) / (this.BASS_PEAK_HZ - this.BASS_LOW_HZ)
          : (this.BASS_HIGH_HZ - hz) / (this.BASS_HIGH_HZ - this.BASS_PEAK_HZ);
        this.bassWeights[i] = Math.max(0, w);
      }
      const old = this.levels;
      this.levels = new Float32Array(bars);
      // Keep what was showing, stretched to the new count, so a resize does not blink.
      for (let i = 0; i < bars && old.length; i += 1) {
        this.levels[i] = old[Math.min(old.length - 1, Math.floor((i / bars) * old.length))];
      }
    }
    if (this.raf === null) this._draw();
  },

  // ---- frames ----

  _frame(now) {
    this.raf = null;
    const dt = Math.min(100, Math.max(1, now - this.lastFrame));
    this.lastFrame = now;
    const levels = this.levels;
    const sounding = this._sounding();
    const fall = Math.exp(-dt / this.RELEASE_MS);
    const rise = 1 - Math.exp(-dt / this.ATTACK_MS);
    this.rainbowShift = (this.rainbowShift + dt / this.RAINBOW_MS) % 1;

    if (sounding && this.spec) {
      this.analyser.getFloatTimeDomainData(this.samples);
      const db = this.spec.analyse(this.samples);
      let bass = 0;
      let weight = 0;
      for (let i = 0; i < levels.length; i += 1) {
        const w = this.bassWeights[i];
        if (!w) continue;
        bass += w * Spectrum.unit(db[i], this.FLOOR_DB, this.CEIL_DB);
        weight += w;
      }
      let feel = 0;
      for (let i = 0; i < this.feelBars; i += 1) feel += Spectrum.unit(db[i], this.FLOOR_DB, this.CEIL_DB);
      this.bass = weight ? bass / weight : 0;
      this.feel = this.feelBars ? feel / this.feelBars : 0;
      ScreenFlash.follow(this.feel, dt);
      for (let i = 0; i < levels.length; i += 1) {
        // Each bar leans a little on its neighbours, so single bars do not
        // jump out on their own.
        const l = Spectrum.unit(db[Math.max(0, i - 1)], this.FLOOR_DB, this.CEIL_DB);
        const c = Spectrum.unit(db[i], this.FLOOR_DB, this.CEIL_DB);
        const r = Spectrum.unit(db[Math.min(levels.length - 1, i + 1)], this.FLOOR_DB, this.CEIL_DB);
        const target = 0.25 * l + 0.5 * c + 0.25 * r;
        levels[i] = target >= levels[i]
          ? levels[i] + (target - levels[i]) * rise
          : target + (levels[i] - target) * fall;
      }
    } else {
      this.bass = 0;
      this.feel = 0;
      ScreenFlash.follow(0, dt);
      for (let i = 0; i < levels.length; i += 1) levels[i] *= fall;
    }

    this._draw();

    let peak = 0;
    for (let i = 0; i < levels.length; i += 1) if (levels[i] > peak) peak = levels[i];
    if (sounding || peak > 0.004) {
      this.raf = requestAnimationFrame((t) => this._frame(t));
    } else {
      levels.fill(0);
      ScreenFlash.reset();
      this._draw();
    }
  },

  _draw() {
    const g = this.geom;
    if (!g || !this.canvas) return;
    const s = this.SCALE;
    const out = this.canvas.getContext('2d');
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Turned off: nothing drawn, but the analysis goes on for the clouds.
    // Under the full-screen visualizer nobody would see it, unless that is
    // the Flow one, which is this.
    if (Store.settings.eqOn === false || (Visualizer.shown && Visualizer.kind !== 'flow')) return;
    const levels = this.levels;
    let any = false;
    for (let i = 0; i < levels.length; i += 1) {
      if (levels[i] > 0.004) {
        any = true;
        break;
      }
    }
    if (!any) return;

    // 1. Sharp bars, coloured by the chosen scheme: by their own height
    // (Spectrum, and Greyscale: the taller the whiter), by where they stand
    // (Rainbow), or all one colour.
    const sc = this.scratch.getContext('2d');
    sc.setTransform(s, 0, 0, s, 0, 0);
    sc.globalCompositeOperation = 'source-over';
    sc.clearRect(0, 0, g.width, g.height);
    const offset = (g.width - levels.length * this.PITCH) / 2;
    const scheme = Store.settings.eqColors || 'rainbow';
    const solid = Palette.solid[scheme] || null;
    if (solid) sc.fillStyle = solid;
    for (let i = 0; i < levels.length; i += 1) {
      const v = levels[i];
      if (v <= 0.004) continue;
      const h = v * g.reach;
      if (!solid) sc.fillStyle = scheme === 'rainbow' ? Palette.rainbow(i / levels.length - this.rainbowShift) : Palette.by(scheme, v);
      sc.fillRect(offset + i * this.PITCH, g.center - h, this.BAR, h * 2);
    }

    // 2. Faded towards the tips, so it reads as light rather than as blocks.
    sc.globalCompositeOperation = 'destination-in';
    const fade = sc.createLinearGradient(0, g.center - g.reach, 0, g.center + g.reach);
    fade.addColorStop(0, 'rgba(0,0,0,0.25)');
    fade.addColorStop(0.5, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0.5)');
    sc.fillStyle = fade;
    sc.fillRect(0, 0, g.width, g.height);
    sc.globalCompositeOperation = 'source-over';

    // 3. The shine: blurred wide and stretched upwards from the line, as far
    // as Settings' spread says. Its blur grows with it, and Visibility sets
    // how bright it starts and how fast it fades (the constants above).
    const w = this.canvas.width;
    const hgt = this.canvas.height;
    const cy = g.center * s;
    if (g.shine > 0) {
      const spread = (g.shine - 1) / (this.SHINE - 1);
      const vis = (Store.settings.eqVisibility || 50) / 100;
      const above = Math.max(0, vis - 0.5) * 2; // 0 up to 50%, 1 at 100%
      const gl = this.glow.getContext('2d');
      gl.setTransform(1, 0, 0, 1, 0, 0);
      gl.globalCompositeOperation = 'source-over';
      gl.clearRect(0, 0, w, hgt);
      gl.filter = `blur(${(this.SHINE_BLUR * (0.4 + 0.6 * spread) * s).toFixed(1)}px)`;
      gl.drawImage(this.scratch, 0, cy - cy * g.shine, w, hgt * g.shine);
      gl.filter = 'none';
      if (above > 0) {
        const power = this.SHINE_FALLOFF * above;
        const mask = gl.createLinearGradient(0, 0, 0, hgt);
        for (let i = 0; i <= 12; i += 1) {
          const y = (cy * i) / 12; // from the top down to the line
          mask.addColorStop(y / hgt, `rgba(0,0,0,${((i / 12) ** power).toFixed(3)})`);
        }
        for (let i = 1; i <= 4; i += 1) {
          const y = cy + ((hgt - cy) * i) / 4; // and on down below it
          mask.addColorStop(Math.min(1, y / hgt), `rgba(0,0,0,${((1 - i / 4) ** power).toFixed(3)})`);
        }
        gl.globalCompositeOperation = 'destination-in';
        gl.fillStyle = mask;
        gl.fillRect(0, 0, w, hgt);
        gl.globalCompositeOperation = 'source-over';
      }
      const boost = vis >= 0.5 ? 1 + (this.SHINE_BOOST - 1) * above : 0.6 + 0.8 * vis;
      out.globalAlpha = Math.min(1, this.SHINE_ALPHA * boost);
      out.drawImage(this.glow, 0, 0);
    }
    // 4. The bars, only softened.
    out.filter = `blur(${this.CORE_BLUR * s}px)`;
    out.globalAlpha = this.CORE_ALPHA;
    out.drawImage(this.scratch, 0, 0);
    out.filter = 'none';
    out.globalAlpha = 1;
    // 5. Everything fades to nothing towards the top of the canvas.
    out.globalCompositeOperation = 'destination-in';
    const top = out.createLinearGradient(0, 0, 0, cy);
    top.addColorStop(0, 'rgba(0,0,0,0)');
    top.addColorStop(0.45, 'rgba(0,0,0,0.35)');
    top.addColorStop(1, 'rgba(0,0,0,1)');
    out.fillStyle = top;
    // The whole canvas: destination-in clears whatever the fill leaves out.
    out.fillRect(0, 0, w, hgt);
    out.globalCompositeOperation = 'source-over';
  },
};

// Blue -> green -> yellow -> orange -> red -> dark red, by height: round the
// colour wheel from 220° down to red at RED, then only darker. (It used to end
// in purple, which the clouds behind swallowed.)
const Palette = {
  steps: 128,
  cache: null,
  RED: 0.85,
  at(v) {
    if (!this.cache) {
      this.cache = [];
      for (let i = 0; i < this.steps; i += 1) {
        const t = i / (this.steps - 1);
        const sweep = Math.min(1, t / this.RED);
        const hue = 220 * (1 - sweep);
        const dark = Math.max(0, (t - this.RED) / (1 - this.RED));
        const light = 52 + 10 * Math.sin(Math.PI * sweep) - 18 * dark;
        this.cache.push(`hsl(${hue.toFixed(1)}, 90%, ${light.toFixed(1)}%)`);
      }
    }
    const i = Math.max(0, Math.min(this.steps - 1, Math.round(v * (this.steps - 1))));
    return this.cache[i];
  },

  // Greyscale: dark grey when low, up to white at full height.
  greyCache: null,
  grey(v) {
    if (!this.greyCache) {
      this.greyCache = [];
      for (let i = 0; i < this.steps; i += 1) this.greyCache.push(`hsl(0, 0%, ${(22 + 74 * (i / (this.steps - 1))).toFixed(1)}%)`);
    }
    const i = Math.max(0, Math.min(this.steps - 1, Math.round(v * (this.steps - 1))));
    return this.greyCache[i];
  },

  /** A bar of height `v` in a scheme coloured by height. */
  by(scheme, v) {
    return scheme === 'greyscale' ? this.grey(v) : this.at(v);
  },

  // Rainbow: by where the bar stands, once round the whole colour wheel from
  // blue on the left through violet, red, orange, yellow and green back to
  // blue on the right. Both ends being blue, `x` wraps round, so the equalizer
  // can drift it sideways without a seam. A step a degree, so it drifts
  // smoothly.
  rainbowCache: null,
  rainbow(x) {
    if (!this.rainbowCache) {
      this.rainbowCache = [];
      for (let i = 0; i < 360; i += 1) this.rainbowCache.push(`hsl(${(220 + i) % 360}, 90%, 56%)`);
    }
    const i = Math.round((x - Math.floor(x)) * 360) % 360;
    return this.rainbowCache[i];
  },

  // The one-colour schemes.
  solid: {
    white: 'hsl(0, 0%, 92%)',
    red: 'hsl(0, 85%, 52%)',
    green: 'hsl(130, 70%, 48%)',
    yellow: 'hsl(52, 95%, 55%)',
    blue: 'hsl(215, 90%, 58%)',
    purple: 'hsl(275, 75%, 62%)',
    black: 'hsl(0, 0%, 0%)',
  },
};
