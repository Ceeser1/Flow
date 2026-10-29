'use strict';

// The Music Visualizer: the player bar's button (and Settings' "Preview
// selected") opens the one chosen in Settings in full screen, on the screen
// Flow is on. A big X shows at the top right while the mouse moves and for 3
// seconds after; it, the visualizer button again, or Escape closes it.
//
// The player bar stays over it along the bottom, without its background: the
// whole window goes full screen (not only the visualizer's layer), and while
// it is open the body has the class viz-open, which lifts the bar, the popups
// opened from it (ui.js) and the toasts above the layer.
//
//   Bars      in the manner of Winamp's: 40 bars from 40 Hz to 16 kHz, green
//             at the floor through yellow to red at the top, with peak caps
//             that hang a moment and then drop. Its cogwheel: how many bars
//             (16-128), their colours (fire, ice, lime, a rainbow), solid or
//             in LED steps, the caps, a mirror floor. (The oscilloscope it
//             had is Scope's, viz/scope.js; Waveform, the equalizer
//             glowing, is viz/waveform.js.)
//   Random    each category (VIZ_CATEGORIES) has one ('random-<category>'),
//             one of that category's, a different one than last time if it
//             can; with vizRandomEach (Settings) another one with each song.
//
// In Settings the visualizers stand in categories (VIZ_CATEGORIES), each
// folding away with a click on its heading (vizCollapsed); Up and Down go
// through them in that order.
//
// All read the player's sound where the equalizer does, before the volume.
// Bars runs its own short analysis (about 46 ms) so they jump the way
// Winamp's did.

// The sign on each category's Random tile in Settings.
const VIZ_RANDOM_GLYPH = '<img class="viz-tile__icon" src="../images/shuffle.png" alt="" />';

const VISUALIZERS = [
  { id: 'bars', name: 'Bars', ready: true, desc: 'Spectrum bars with falling peaks, in the manner of Winamp', glyph: Icons.speaker, image: '../images/viz-bars.jpg' },
];

// The categories in Settings, each's visualizers in their order there (and
// for Up and Down), each with its own Random first.
const VIZ_CATEGORIES = [
  {
    id: 'equalizers',
    name: 'Equalizers',
    desc: 'The sound itself: bars, waves, rings and dots',
    ids: ['bars', 'waveform', 'scope', 'spectrogram', 'ridges', 'skyline', 'halo', 'orb', 'reactor', 'hifi', 'vinyl', 'strings', 'radar', 'seismo'],
  },
  {
    id: 'worlds',
    name: 'Worlds',
    desc: 'Places to look at',
    ids: ['synthwave', 'galaxy', 'aurora', 'lightning', 'inferno', 'fireworks', 'disco', 'stainedglass', 'blackhole', 'deepsea', 'pond', 'lighthouse', 'train', 'fountain'],
  },
  {
    id: 'trippy',
    name: 'Trippy',
    desc: 'Patterns, colour and motion',
    ids: ['kaleidoscope', 'prism', 'lava', 'demo', 'rain', 'chladni', 'coral', 'attractor', 'julia', 'plasmaglobe', 'tunnel', 'warp', 'mandelbulb', 'moire'],
  },
  {
    id: 'other',
    name: 'Other',
    desc: 'The odd ones',
    ids: ['pianoroll', 'arcade', 'shatter', 'mosaic'],
  },
];

/** The hue (0..360) of r, g, b in 0..1. */
function hueOf(r, g, b) {
  const max = Math.max(r, g, b);
  const c = max - Math.min(r, g, b);
  if (!c) return 0;
  let hue;
  if (max === r) hue = ((g - b) / c) % 6;
  else if (max === g) hue = (b - r) / c + 2;
  else hue = (r - g) / c + 4;
  return (hue * 60 + 360) % 360;
}

const Visualizer = {
  el: null,            // the full-screen layer while open
  canvas: null,
  kind: null,          // the id of the one showing
  scenes: {},          // id -> the visualizers in viz/ (add)
  scene: null,         // the one of those showing, as made by its create
  samples: null,
  raf: null,
  last: 0,
  _lastRandom: null,
  _wasFull: false,
  _closedAt: 0,
  _idle: null,
  _resize: null,
  _ahead: null,        // a Random's next one, picked (and warmed) ahead: { random, kind }
  _unwarm: null,       // stops the warming going on (warm)

  // Bars (how many: Settings' brCount)
  FLOOR_DB: -64,
  CEIL_DB: -10,
  TILT_DB: 14,         // added across the range, low to high: music is quieter up high
  FALL_PER_S: 1.6,     // how fast a bar drops, in full heights per second
  PEAK_HOLD_MS: 350,
  PEAK_GRAVITY: 2.2,   // full heights per second², once the hold is over
  TOP: 0.9,            // a full bar reaches this share of the screen

  // An own colour's presets (the swatch after a visualizer's colours): the first the default.
  OWN_PRESETS: ['#3484f4', '#ebebeb', '#ed1d1d', '#25d041', '#f9dc1f', '#aa55e7'],

  AWAKE_MS: 3000,      // the X stays this long after the mouse stops

  get shown() {
    return !!this.el;
  },

  /** Escape just closed it: that press is not for anything else. */
  justClosed() {
    return performance.now() - this._closedAt < 400;
  },

  open(id = Store.settings.visualizer) {
    if (this.el) return;
    const pool = this._pool(id);
    const kind = pool ? this._nextOf(id) : id;
    if (!VISUALIZERS.some((v) => v.id === kind && v.ready)) return;
    // Opened as a Random it may move on to another of its own with each
    // song (vizRandomEach): which Random, or null.
    this._random = pool ? id : null;
    this._songAt = Player.currentId;

    const close = iconButton('viz-full__close', Icons.x, Store.can('keyboard') ? 'Close (Esc)' : 'Close', () => this.close());
    this.el = h('div.viz-full', close);
    // Anywhere, the player bar included, since that is over the layer; but
    // on the Queue (a drawer over it) they get out of the way instead.
    this._onPointer = (e) => {
      if (e.target instanceof Element && e.target.closest('.modal--drawer')) this._sleep();
      else this._wake();
    };
    document.addEventListener('pointermove', this._onPointer);
    document.addEventListener('pointerdown', this._onPointer);
    // Space should not press the button it was opened with again.
    if (document.activeElement) document.activeElement.blur();
    document.body.appendChild(this.el);
    document.body.classList.add('viz-open');
    this._drawButton(true);
    this._wake();

    const root = document.documentElement;
    this._onFullscreen = () => {
      if (document.fullscreenElement === root) this._wasFull = true;
      else if (this._wasFull) this.close();
    };
    document.addEventListener('fullscreenchange', this._onFullscreen);
    this._wasFull = false;
    // Refused (it should not be): it still covers the window.
    root.requestFullscreen().catch(() => {});
    this._watchSongs();
    this._mount(kind);
  },

  /**
   * The visualizer `kind` into the open layer: its canvas, its cogwheel, and
   * its drawing started. Everything of it lives in one box (this.stage), so
   * it can be swapped for another without leaving full screen.
   */
  _mount(kind) {
    this.kind = kind;
    this.canvas = h('canvas.viz-full__canvas');
    this.stage = h('div.viz-full__stage', this.canvas);
    this.el.insertBefore(this.stage, this.el.firstChild);
    if (!Equalizer.active) {
      this.stage.appendChild(h('p.viz-full__note', 'The visualizer needs Web Audio, which could not be started on this computer.'));
    }
    if (kind === 'bars') this.stage.appendChild(this._barsPanel());
    const def = this.scenes[kind];
    if (def && def.options) this.stage.appendChild(this._cfgPanel(`${def.name} settings`, def.options));
    if (def && def.click) this.canvas.addEventListener('click', () => this.scene && def.click(this.scene));
    if (def && def.hint) this.canvas.title = def.hint;
    if (!Equalizer.active) return;
    this.samples = new Float32Array(Equalizer.analyser.fftSize);
    VizAudio.reset({ stereo: !!(def && def.stereo) });
    if (def) {
      try {
        this.scene = def.create(this.canvas);
      } catch (err) {
        console.warn('Visualizer:', err);
        this.stage.appendChild(h('p.viz-full__note', `${def.name} could not be started on this computer (${def.gl ? 'it needs WebGL 2' : String(err.message || err)}).`));
        return;
      }
    }
    if (kind === 'bars') this._startBars();
    this._resize = new ResizeObserver(() => this._size());
    this._resize.observe(this.canvas);
    this._size();
    this.last = performance.now();
    this._due = 0;
    this.raf = requestAnimationFrame((t) => this._frame(t));
    // Moving on with each song: the next one ready by then.
    if (this._random && Store.settings.vizRandomEach) this.warm(this._random);
  },

  /** The visualizer showing taken out of the layer, the layer left open. */
  _unmount() {
    cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this._resize) this._resize.disconnect();
    this._resize = null;
    if (this._cfgOutside) document.removeEventListener('pointerdown', this._cfgOutside, true);
    this._cfgOutside = null;
    this._draft = null;
    if (this.scene) {
      try {
        if (this.scene.destroy) this.scene.destroy();
      } catch (err) {
        console.warn('Visualizer:', err);
      }
      this.scene = null;
    }
    if (this.stage) this.stage.remove();
    this.stage = null;
    this.canvas = null;
  },

  /** All of them in Settings' order: the categories', then any in none of them. */
  ordered() {
    const ready = VISUALIZERS.filter((v) => v.ready).map((v) => v.id);
    const listed = VIZ_CATEGORIES.flatMap((c) => c.ids).filter((id) => ready.includes(id));
    return [...listed, ...ready.filter((id) => !listed.includes(id))];
  },

  /** A Random's choices: a category's for 'random-<category>' (all of them for 'random'); null for any other id. */
  _pool(id) {
    if (id === 'random') return this.ordered();
    const cat = typeof id === 'string' && id.startsWith('random-') && VIZ_CATEGORIES.find((c) => `random-${c.id}` === id);
    return cat ? this.ordered().filter((v) => cat.ids.includes(v)) : null;
  },

  /** The one before (-1) or after (1) in Settings' order, staying in full screen (Up and Down). */
  step(dir) {
    if (!this.el) return;
    const ids = this.ordered();
    const at = ids.indexOf(this.kind);
    this._unmount();
    this._mount(ids[(at + dir + ids.length) % ids.length]);
    this._wake();
  },

  /** On to another one, at random (not the one showing; of its Random's own if opened as one), staying in full screen. */
  next() {
    if (!this.el) return;
    this._unmount();
    this._mount(this._nextOf(this._random || 'random'));
  },

  /** A Random's next one: the one picked (and warmed) ahead for it, else one picked now. */
  _nextOf(id) {
    const ahead = this._ahead;
    this._ahead = null;
    if (ahead && ahead.random === id && ahead.kind !== this.kind) return ahead.kind;
    return this._pickRandom(this._pool(id));
  },

  /**
   * Gets the visualizer `id` ready to open without a wait: its shaders
   * compiled ahead (VizGL.warm), which the first time (before the browser
   * has them cached) can take seconds. A Random picks its next one now and
   * warms that. Whatever was being warmed before is dropped. Called at
   * startup, on choosing one in Settings, and while a Random that moves on
   * with each song shows (for the next).
   */
  warm(id = Store.settings.visualizer) {
    if (this._unwarm) this._unwarm();
    this._unwarm = null;
    let kind = id;
    const pool = this._pool(id);
    if (pool) {
      kind = this._pickRandom(pool);
      this._ahead = { random: id, kind };
    }
    const def = this.scenes[kind];
    if (!def || !def.gl || kind === this.kind) return;
    this._unwarm = VizGL.warm((canvas) => def.create(canvas));
  },

  /** Opened as Random with "a new one with each song": the song changing moves it on. */
  _watchSongs() {
    if (this._watching) return;
    this._watching = true;
    Player.onChange(() => {
      if (!this.el || Player.currentId === this._songAt) return;
      this._songAt = Player.currentId;
      if (this._random && Store.settings.vizRandomEach && Player.currentId) this.next();
    });
  },

  close() {
    if (!this.el) return;
    this._unmount();
    clearTimeout(this._idle);
    document.removeEventListener('fullscreenchange', this._onFullscreen);
    document.removeEventListener('pointermove', this._onPointer);
    document.removeEventListener('pointerdown', this._onPointer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.body.classList.remove('viz-open', 'viz-awake');
    this._drawButton(false);
    // The player bar is back in its place: the equalizer measures from it.
    Equalizer._layout();
    this.el.remove();
    this.el = null;
    this._closedAt = performance.now();
  },

  /**
   * A visualizer from viz/: { id, name, desc, glyph, create(canvas) -> scene,
   * options?, click?(scene), hint?, stereo?, gl?, resolution?, sharp? }. The
   * scene: size(w, h) (canvas pixels), frame(audio, dt, now) with audio
   * VizAudio, destroy?(). resolution: canvas pixels per css pixel (1), sharp:
   * the screen's own.
   */
  add(def) {
    this.scenes[def.id] = def;
    // Its picture in Settings: images/viz-<id>.jpg, a moment of it playing.
    const image = def.image === undefined ? `../images/viz-${def.id}.jpg` : def.image;
    VISUALIZERS.push({ id: def.id, name: def.name, ready: true, desc: def.desc, glyph: def.glyph, image });
  },

  /** One of `ids` at random, not the last one picked nor the one showing if it can. */
  _pickRandom(ids) {
    const fresh = ids.filter((v) => v !== this._lastRandom && v !== this.kind);
    const pool = fresh.length ? fresh : ids;
    this._lastRandom = pool[Math.floor(Math.random() * pool.length)];
    return this._lastRandom;
  },

  /**
   * The screen's refresh rate (Hz), measured over a few dozen of its frames
   * and rounded to a usual one when close: cb(hz) once known (at once after
   * the first time).
   */
  refreshRate(cb) {
    if (this._hz) {
      cb(this._hz);
      return;
    }
    const gaps = [];
    let last = 0;
    const tick = (t) => {
      if (last) gaps.push(t - last);
      last = t;
      if (gaps.length < 40) {
        requestAnimationFrame(tick);
        return;
      }
      gaps.sort((a, b) => a - b);
      const hz = 1000 / gaps[gaps.length >> 1];
      const usual = [24, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 175, 180, 200, 240, 280, 300, 360, 480, 500];
      const near = usual.find((u) => Math.abs(u - hz) / u < 0.03);
      this._hz = near || Math.round(hz);
      cb(this._hz);
    };
    requestAnimationFrame(tick);
  },

  /** The player bar's button shows on while it is open, like Shuffle and Repeat. */
  _drawButton(on) {
    const btn = $('btnVisualizer');
    btn.classList.toggle('sq-btn--on', on);
    btn.setAttribute('aria-pressed', String(on));
  },

  /** The player bar's button: opens it, or closes it when open. */
  toggle() {
    if (this.el) this.close();
    else this.open();
  },

  /**
   * The X, the player bar and the pointer show (the body's class viz-awake);
   * all fade out once the mouse has been still a while.
   */
  _wake() {
    if (!this.el) return;
    document.body.classList.add('viz-awake');
    clearTimeout(this._idle);
    this._idle = setTimeout(() => document.body.classList.remove('viz-awake'), this.AWAKE_MS);
  },

  /** The X, the cogwheel and the player bar gone at once (the pointer stays, over the Queue). */
  _sleep() {
    clearTimeout(this._idle);
    document.body.classList.remove('viz-awake');
  },

  _size() {
    const c = this.canvas;
    if (!c) return;
    // Bars and the sharp ones at the screen's own pixels; the rest at css
    // pixels (or their own resolution), sharp enough for light and much
    // cheaper on a large screen.
    const def = this.scenes[this.kind];
    const r = this.kind === 'bars' || (def && def.sharp) ? window.devicePixelRatio || 1 : (def && def.resolution) || 1;
    const w = Math.max(1, Math.round(c.clientWidth * r));
    const hgt = Math.max(1, Math.round(c.clientHeight * r));
    if (c.width !== w) c.width = w;
    if (c.height !== hgt) c.height = hgt;
    if (this.scene && this.scene.size) this.scene.size(w, hgt);
  },

  _frame(now) {
    if (!this.canvas) return;
    // Limit framerate (vizFps, when on and not V-Sync): a frame only when one
    // is due, the screen's refreshes between left alone (2 ms early is on time).
    const fps = Store.settings.vizFpsOn && !Store.settings.vizVsync ? Store.settings.vizFps : 0;
    if (fps > 0) {
      const step = 1000 / fps;
      if (now + 2 < this._due) {
        this.raf = requestAnimationFrame((t) => this._frame(t));
        return;
      }
      // Fallen behind (a stall, or just started): from now on.
      this._due = now - this._due > step ? now + step : this._due + step;
    }
    const dt = Math.min(0.1, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    Equalizer.analyser.getFloatTimeDomainData(this.samples);
    VizAudio.update(this.samples, dt, now);
    if (this.scene) {
      this.scene.frame(VizAudio, dt, now);
    } else this._drawBars(dt, now);
    this.raf = requestAnimationFrame((t) => this._frame(t));
  },

  // ---- Bars ----

  _startBars() {
    this._barsFor(Store.settings.brCount);
  },

  /** The analysis and the bars' state for `count` bars. */
  _barsFor(count) {
    this.barCount = count;
    this.spec = new Spectrum.Analyser({
      sampleRate: Equalizer.ctx.sampleRate, bars: count, minHz: 40, maxHz: 16000, windowSeconds: 0.046, hop: 128,
    });
    this.levels = new Float32Array(count);
    this.peaks = new Float32Array(count);
    this.peakHold = new Float32Array(count);
    this.peakSpeed = new Float32Array(count);
  },

  /** Bars' cogwheel. */
  _barsPanel() {
    return this._cfgPanel('Bars settings', [
      { type: 'slider', key: 'brCount', label: 'Bars', min: 16, max: 128, step: 4, unit: '' },
      {
        type: 'choice',
        key: 'brColors',
        label: 'Colors',
        choices: [['fire', 'Fire'], ['ice', 'Ice'], ['lime', 'Lime'], ['rainbow', 'Rainbow']],
        color: { value: 'custom', key: 'brColor', presets: this.OWN_PRESETS },
      },
      { type: 'choice', key: 'brStyle', label: 'Style', choices: [['solid', 'Solid'], ['led', 'LED']] },
      { type: 'check', key: 'brPeaks', label: 'Peaks' },
      { type: 'check', key: 'brMirror', label: 'Mirror floor' },
    ]);
  },

  _background(ctx, w, hgt) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, hgt);
    // Winamp's faint dotted grid.
    ctx.fillStyle = 'rgba(80, 80, 90, 0.35)';
    const step = Math.round(hgt / 8);
    const dot = Math.max(1, Math.round(hgt / 500));
    for (let y = step; y < hgt; y += step) {
      for (let x = 0; x < w; x += dot * 6) ctx.fillRect(x, y, dot * 2, dot);
    }
  },

  /** The bars' colours from the floor (0) to the top (1), as a gradient's stops. */
  _barStops(scheme) {
    switch (scheme) {
      // Its own colour: dark at the floor, lighter at the top.
      case 'custom': {
        const c = VizGL.rgb(this.setting('brColor'));
        const css = (k, white) => `rgb(${c.map((v) => Math.round(255 * (v * k + white))).join(', ')})`;
        return [[0, css(0.25, 0)], [0.6, css(1, 0)], [1, css(0.45, 0.55)]];
      }
      case 'fire': return [[0, '#3a0000'], [0.35, '#c0160b'], [0.65, '#ff7a00'], [0.85, '#ffd23a'], [1, '#fff6c8']];
      case 'ice': return [[0, '#06123a'], [0.4, '#1650d8'], [0.7, '#2fb6ff'], [0.9, '#a8f0ff'], [1, '#ffffff']];
      // Lime: Winamp's.
      default: return [[0, '#1fb81f'], [0.45, '#9ee21e'], [0.65, '#ffe01a'], [0.82, '#ff8c1a'], [1, '#ff2a1a']];
    }
  },

  _drawBars(dt, now) {
    const set = Store.settings;
    if (set.brCount !== this.barCount) this._barsFor(set.brCount);
    const c = this.canvas;
    const ctx = c.getContext('2d');
    const w = c.width;
    const hgt = c.height;
    this._background(ctx, w, hgt);
    const db = Player.isPlaying ? this.spec.analyse(this.samples, VizAudio.frames) : null;
    const n = this.barCount;
    const mirror = !!set.brMirror;
    // With the mirror the floor stands higher, and the bars are seen again below it.
    const floor = mirror ? Math.round(hgt * 0.74) : hgt;
    const pitch = w / n;
    const barW = Math.max(1, pitch * (n > 80 ? 0.7 : 0.78));
    const full = floor * this.TOP;
    const scheme = set.brColors;
    let grad = null;
    if (scheme !== 'rainbow') {
      grad = ctx.createLinearGradient(0, floor, 0, floor - full);
      for (const [at, colour] of this._barStops(scheme)) grad.addColorStop(at, colour);
    }
    const led = set.brStyle === 'led';
    const cap = Math.max(2, Math.round(hgt / 90));
    // LED: each bar in steps, the unlit ones faintly there.
    const cell = Math.max(4, Math.round(full / 32));
    const gap = Math.max(1, Math.round(cell * 0.28));
    const shift = (now / 15000) % 1;

    for (let i = 0; i < n; i += 1) {
      const target = db ? Spectrum.unit(db[i] + (this.TILT_DB * i) / (n - 1), this.FLOOR_DB, this.CEIL_DB) : 0;
      // Up at once, down at a steady rate.
      this.levels[i] = Math.max(target, this.levels[i] - this.FALL_PER_S * dt);
      const level = this.levels[i];
      if (level >= this.peaks[i]) {
        this.peaks[i] = level;
        this.peakHold[i] = now + this.PEAK_HOLD_MS;
        this.peakSpeed[i] = 0;
      } else if (now > this.peakHold[i]) {
        this.peakSpeed[i] += this.PEAK_GRAVITY * dt;
        this.peaks[i] = Math.max(level, this.peaks[i] - this.peakSpeed[i] * dt);
      }
      const x = i * pitch + (pitch - barW) / 2;
      ctx.fillStyle = scheme === 'rainbow' ? Palette.rainbow(i / n - shift) : grad;
      if (led) {
        // Whole cells only, and the dark ones above them.
        const lit = Math.floor((level * full) / cell);
        ctx.globalAlpha = 0.09;
        for (let k = lit; (k + 1) * cell <= full; k += 1) ctx.fillRect(x, floor - (k + 1) * cell + gap, barW, cell - gap);
        ctx.globalAlpha = 1;
        for (let k = 0; k < lit; k += 1) ctx.fillRect(x, floor - (k + 1) * cell + gap, barW, cell - gap);
      } else {
        const top = floor - level * full;
        ctx.fillRect(x, top, barW, floor - top);
      }
      if (set.brPeaks) {
        ctx.fillStyle = '#d8d8e0';
        if (led) {
          const k = Math.max(0, Math.ceil((this.peaks[i] * full) / cell) - 1);
          ctx.fillRect(x, floor - (k + 1) * cell + gap, barW, cell - gap);
        } else {
          ctx.fillRect(x, Math.min(floor - cap, floor - this.peaks[i] * full - cap), barW, cap);
        }
      }
    }

    if (mirror) {
      // The floor: what stands above it, upside down and fading into the dark.
      const below = hgt - floor;
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.translate(0, floor * 2);
      ctx.scale(1, -1);
      ctx.drawImage(c, 0, floor - below, w, below, 0, floor - below, w, below);
      ctx.restore();
      const fade = ctx.createLinearGradient(0, floor, 0, hgt);
      fade.addColorStop(0, 'rgba(0, 0, 0, 0.1)');
      fade.addColorStop(1, 'rgba(0, 0, 0, 1)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, floor, w, below);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(0, floor, w, Math.max(1, Math.round(hgt / 900)));
    }
  },

  /**
   * A visualizer's own settings value: while a colour is being dragged in
   * the picker, that colour (shown at once, saved on letting go).
   */
  setting(key) {
    return this._draft && key in this._draft ? this._draft[key] : Store.settings[key];
  },

  /**
   * The cogwheel at the top left, for a visualizer with settings. A click
   * opens it to the right, along the top, onto them (no dialog); the
   * cogwheel again, or a click anywhere else, closes it. Saved as they change.
   *
   * items, each one of:
   *   { type: 'color', key, label, presets }   a swatch opening a picker
   *   { type: 'check', key, label, amount?, group? }
   *       a box; amount: { key, min, max, step } a slider under it, greyed
   *       while it is off; group: items beside it, greyed while it is off
   *       (both: the box and its slider, the group beside them)
   *   { type: 'slider', key, label, min, max, step, unit? }
   *   { type: 'choice', key, label, choices: [[value, label], ...] }  (label '': the pills alone)
   *       color: { value, key, presets }: after the pills a swatch, choosing
   *       `value` (lit while it is chosen) and opening a picker for `key`
   *       pick: { value, key, name, square?, max, video? }: the pill `value`
   *       opens the file dialog for a picture (_pickPicture; video: or an MP4
   *       or WebM video), chosen with it once one is picked; its path in `key`
   *       group: items beside it, framed as a box's group
   * Any of them with when: (settings) => bool, greyed out while it is false.
   */
  _cfgPanel(title, items) {
    const panel = h('div.viz-cfg');
    const pickers = [];
    const refreshers = [];
    const refresh = () => refreshers.forEach((fn) => fn());
    const setOpen = (on) => {
      // Changed meanwhile (a click on Kaleidoscope moves its look on): shown as it is now.
      if (on) refresh();
      panel.classList.toggle('viz-cfg--open', on);
      cog.setAttribute('aria-expanded', String(on));
      if (!on) pickers.forEach((p) => p.close());
    };
    const cog = iconButton('viz-cfg__cog', Icons.cog, title, () => setOpen(!panel.classList.contains('viz-cfg--open')));
    cog.setAttribute('aria-expanded', 'false');

    // A slider and its value; dragging shows at once, letting go saves.
    // format (number => text) shows the value otherwise than as itself and its unit.
    const slider = ({ key, min = 0, max = 200, step = 5, unit = '%', format }, cls = '') => {
      const input = h('input.volume-slider.viz-cfg__slider' + cls, { type: 'range', min, max, step, value: Store.settings[key] });
      const value = h('span.viz-cfg__value');
      const draw = () => {
        value.textContent = format ? format(Number(input.value)) : `${input.value}${unit}`;
        input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
      };
      input.addEventListener('input', () => {
        draw();
        Store.previewSettings({ [key]: Number(input.value) });
      });
      input.addEventListener('change', () => Store.saveSettings({ [key]: Number(input.value) }));
      draw();
      return { input, el: h('div.viz-cfg__amount', input, value) };
    };

    // enabled: whether what it hangs on (a box around it) is on; an item's
    // own `when` (settings => bool) greys it out too.
    const build = (item, around) => {
      const enabled = item.when ? () => around() && item.when(Store.settings) : around;
      if (item.type === 'color') {
        const swatch = h('button.viz-cfg__swatch', { type: 'button', title: `Choose the ${item.label.toLowerCase()}` });
        const paint = (hex) => {
          swatch.style.background = hex;
        };
        paint(Store.settings[item.key]);
        const picker = this._picker(panel, swatch, paint, item.key, item.presets);
        pickers.push(picker);
        swatch.addEventListener('click', () => picker.toggle());
        return h('div.viz-cfg__item', h('span', `${item.label}:`), swatch);
      }
      if (item.type === 'check') {
        const box = h('input', { type: 'checkbox', checked: !!Store.settings[item.key] });
        box.addEventListener('change', () => {
          Store.saveSettings({ [item.key]: box.checked });
          refresh();
        });
        const label = h('label.check.viz-cfg__check', box, h('span', item.label));
        const on = () => enabled() && !!Store.settings[item.key];
        refreshers.push(() => {
          box.disabled = !enabled();
        });
        let head = label;
        if (item.amount) {
          const s = slider(item.amount);
          refreshers.push(() => {
            s.input.disabled = !on();
            s.el.classList.toggle('viz-cfg__amount--off', !Store.settings[item.key]);
          });
          head = h('div.viz-cfg__opt', label, s.el);
          if (!item.group) return head;
        }
        if (item.group) {
          const group = h('div.viz-cfg__ride', item.group.map((g) => build(g, on)));
          refreshers.push(() => group.classList.toggle('viz-cfg__ride--off', !on()));
          return h('div.viz-cfg__item.viz-cfg__bumps', head, group);
        }
        const el = h('div.viz-cfg__item', label);
        refreshers.push(() => el.classList.toggle('viz-cfg__opt--off', !enabled()));
        return el;
      }
      if (item.type === 'slider') {
        const s = slider(item);
        refreshers.push(() => {
          s.input.disabled = !enabled();
        });
        const el = h('div.viz-cfg__opt', h('span.viz-cfg__label', item.label), s.el);
        refreshers.push(() => el.classList.toggle('viz-cfg__opt--off', !enabled()));
        return el;
      }
      if (item.type === 'choice') {
        const pills = h('div.viz-cfg__pills', { role: 'group', 'aria-label': item.label });
        for (const [value, text] of item.choices) {
          const pick = item.pick && item.pick.value === value ? item.pick : null;
          pills.appendChild(h('button.viz-cfg__pill', {
            type: 'button',
            title: pick ? (pick.video ? 'Choose a picture or a video' : 'Choose a picture') : null,
            dataset: { value },
            onclick: async () => {
              pickers.forEach((p) => p.close());
              if (pick) {
                const file = await this._pickPicture(pick);
                if (!file) return;
                Store.saveSettings({ [item.key]: value, [pick.key]: file });
              } else {
                Store.saveSettings({ [item.key]: value });
              }
              refresh();
            },
          }, text));
        }
        if (item.color) {
          // Its own colour: the swatch picks it (and opens the picker).
          const { value, key, presets } = item.color;
          const swatch = h('button.viz-cfg__pill.viz-cfg__pill--swatch', { type: 'button', title: 'Choose a color', 'aria-label': 'Own color', dataset: { value } });
          const paint = (hex) => swatch.style.setProperty('--swatch', hex);
          paint(Store.settings[key]);
          const picker = this._picker(panel, swatch, paint, key, presets);
          pickers.push(picker);
          swatch.addEventListener('click', () => {
            if (Store.settings[item.key] !== value) {
              Store.saveSettings({ [item.key]: value });
              refresh();
            }
            picker.toggle();
          });
          refreshers.push(() => paint(this.setting(key)));
          pills.appendChild(swatch);
        }
        refreshers.push(() => {
          for (const b of pills.children) {
            const on = b.dataset.value === String(Store.settings[item.key]);
            b.classList.toggle('viz-cfg__pill--on', on);
            b.setAttribute('aria-pressed', String(on));
            b.disabled = !enabled();
          }
        });
        const opt = h('div.viz-cfg__opt', item.label ? h('span.viz-cfg__label', item.label) : null, pills);
        if (!item.group) return opt;
        return h('div.viz-cfg__item.viz-cfg__bumps', opt, h('div.viz-cfg__ride', item.group.map((g) => build(g, enabled))));
      }
      return null;
    };

    const body = h('div.viz-cfg__body', items.map((item) => build(item, () => true)));
    // Wider than the window: the wheel scrolls it sideways.
    body.addEventListener('wheel', (e) => {
      if (body.scrollWidth <= body.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      body.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    panel.append(cog, body);
    refresh();

    this._cfgOutside = (e) => {
      if (panel.classList.contains('viz-cfg--open') && !panel.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', this._cfgOutside, true);
    return panel;
  },

  /**
   * A picture for a visualizer: the file dialog (Explorer, the phone's
   * picker), the picture read, cut to its middle square (square) and made at
   * most `max` pixels across, and kept by Flow as a JPEG, or as a PNG when
   * some of it is see-through (window.flow.saveVizPicture, under `name`).
   * With `video`, an MP4 or WebM video too, kept as it is (_keepVideo).
   * Its path, or null when none was picked.
   */
  async _pickPicture({ name, square = false, max, video = false }) {
    const file = await new Promise((resolve) => {
      const accept = video ? 'image/*,video/mp4,video/webm,.mp4,.m4v,.webm' : 'image/*';
      const input = h('input', { type: 'file', accept, hidden: true });
      const done = (f) => {
        input.remove();
        resolve(f);
      };
      input.addEventListener('change', () => done(input.files[0] || null));
      input.addEventListener('cancel', () => done(null));
      document.body.appendChild(input);
      input.click();
    });
    if (!file) return null;
    if (video && (/^video\//.test(file.type) || /\.(mp4|m4v|webm)$/i.test(file.name))) return this._keepVideo(file, name);
    try {
      const img = await createImageBitmap(file);
      const sw = square ? Math.min(img.width, img.height) : img.width;
      const sh = square ? sw : img.height;
      const k = Math.min(1, max / Math.max(sw, sh));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw * k));
      c.height = Math.max(1, Math.round(sh * k));
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, c.width, c.height);
      img.close();
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let clear = false;
      for (let i = 3; i < px.length && !clear; i += 4) clear = px[i] < 255;
      const blob = await new Promise((resolve) => (clear ? c.toBlob(resolve, 'image/png') : c.toBlob(resolve, 'image/jpeg', 0.92)));
      if (!blob) throw new Error('unreadable');
      return await window.flow.saveVizPicture(name, new Uint8Array(await blob.arrayBuffer()));
    } catch {
      toast(`"${file.name}" could not be opened as a picture.`, 'error');
      return null;
    }
  },

  /**
   * A video picked for a visualizer's background: tried first (one this
   * device cannot play is not kept, and the one kept before stays), then
   * kept by Flow as it is. Up to 300 MB on a computer, 60 MB on a phone and
   * in the browser. Its path, or null.
   */
  async _keepVideo(file, name) {
    const most = ['android', 'ios', 'web'].includes(Store.platform) ? 60 : 300;
    if (file.size > most * 1e6) {
      toast(`"${file.name}" is too big for a background: at most ${most} MB.`, 'error');
      return null;
    }
    const url = URL.createObjectURL(file);
    const plays = await new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true;
      const done = (ok) => {
        clearTimeout(late);
        v.removeAttribute('src');
        v.load();
        resolve(ok);
      };
      const late = setTimeout(() => done(false), 10000);
      v.addEventListener('loadeddata', () => done(v.videoWidth > 0), { once: true });
      v.addEventListener('error', () => done(false), { once: true });
      v.src = url;
    });
    URL.revokeObjectURL(url);
    if (!plays) {
      toast(`"${file.name}" could not be played as a video.`, 'error');
      return null;
    }
    try {
      return await window.flow.saveVizPicture(name, new Uint8Array(await file.arrayBuffer()));
    } catch {
      toast(`"${file.name}" could not be kept.`, 'error');
      return null;
    }
  },

  /**
   * The colour picker under a swatch: a square of saturation (across) and
   * brightness (up), a hue bar, and the presets (the first is the default).
   * Dragging shows the colour at once (setting); it is saved on letting go.
   */
  _picker(panel, swatch, paint, key, presets) {
    const sv = h('div.viz-pick__sv', h('div.viz-pick__dot'));
    const hueBar = h('div.viz-pick__hue', h('div.viz-pick__knob'));
    const row = h('div.viz-pick__presets');
    const el = h('div.viz-pick', sv, hueBar, row);
    let hsv = { h: 0, s: 0, v: 0 };

    const toHex = ({ h: hue, s, v }) => {
      const f = (n) => {
        const k = (n + hue / 60) % 6;
        return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
      };
      return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('');
    };
    const fromHex = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b);
      const c = max - Math.min(r, g, b);
      return { h: hueOf(r, g, b), s: max ? c / max : 0, v: max };
    };
    const show = () => {
      sv.style.backgroundColor = `hsl(${hsv.h}, 100%, 50%)`;
      sv.firstChild.style.left = `${hsv.s * 100}%`;
      sv.firstChild.style.top = `${(1 - hsv.v) * 100}%`;
      hueBar.firstChild.style.left = `${(hsv.h / 360) * 100}%`;
    };
    // While dragging only drawn (the draft); saved when let go.
    const set = (hex, save) => {
      paint(hex);
      this._draft = this._draft || {};
      if (save) delete this._draft[key];
      else this._draft[key] = hex;
      if (save && hex !== Store.settings[key]) Store.saveSettings({ [key]: hex });
    };
    const drag = (area, move) => {
      area.addEventListener('pointerdown', (e) => {
        area.setPointerCapture(e.pointerId);
        const at = (ev) => {
          const r = area.getBoundingClientRect();
          move(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
          show();
          set(toHex(hsv), false);
        };
        const up = () => {
          area.removeEventListener('pointermove', at);
          area.removeEventListener('pointerup', up);
          area.removeEventListener('pointercancel', up);
          set(toHex(hsv), true);
        };
        at(e);
        area.addEventListener('pointermove', at);
        area.addEventListener('pointerup', up);
        area.addEventListener('pointercancel', up);
      });
    };
    drag(sv, (x, y) => {
      hsv.s = x;
      hsv.v = 1 - y;
    });
    drag(hueBar, (x) => {
      hsv.h = Math.min(359.9, x * 360);
    });
    for (const hex of presets) {
      const title = hex === presets[0] ? 'Default' : hex;
      const btn = h('button.viz-pick__preset', {
        type: 'button',
        title,
        'aria-label': title,
        onclick: () => {
          hsv = fromHex(hex);
          show();
          set(hex, true);
        },
      });
      btn.style.background = hex;
      row.appendChild(btn);
    }

    const picker = {
      close: () => el.remove(),
      toggle: () => {
        if (el.isConnected) return picker.close();
        hsv = fromHex(Store.settings[key]);
        show();
        // Under the swatch: the panel's body clips, so it hangs from the panel.
        const p = panel.getBoundingClientRect();
        const s = swatch.getBoundingClientRect();
        el.style.left = `${s.left + s.width / 2 - p.left}px`;
        panel.appendChild(el);
        return null;
      },
    };
    return picker;
  },
};
