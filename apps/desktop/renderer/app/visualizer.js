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
//             that hang a moment and then drop. A click switches to the
//             oscilloscope and back.
//   Waveform  the equalizer behind the pages (equalizer.js), mirrored about
//             the middle of the screen, in the colour scheme chosen for it.
//   Flow      the window's own background, clouds and equalizer as set in
//             Settings, across the whole screen: the menu and the page are
//             hidden (the body's class viz-flow), and the equalizer stands on
//             the bottom edge of the screen, so it only goes up.
//   Synthwave the wireframe landscape (landscape.js) flown over at full
//             screen, under a purple sky and a sun, from a ship's nose. A
//             cogwheel at the top left opens, to the right, onto its own
//             settings: the wireframe's colour, the floor's bumps, and the
//             camera bobbing, the camera tilting and the car tilting on them.
//   Random    one of the others, a different one than last time if it can.
//
// Both read the player's sound where the equalizer does, before the volume.
// Bars runs its own short analysis (about 46 ms) so they jump the way
// Winamp's did; Waveform the equalizer's longer one, so it breathes like it.

const VISUALIZERS = [
  {
    id: 'random',
    name: 'Random',
    ready: true,
    desc: 'A different visualizer each time',
    glyph: '<img class="viz-tile__icon" src="../images/shuffle.png" alt="" />',
  },
  { id: 'bars', name: 'Bars', ready: true, desc: 'Spectrum bars with falling peaks, in the manner of Winamp', glyph: Icons.speaker },
  { id: 'waveform', name: 'Waveform', ready: true, desc: 'The equalizer, glowing out from the middle of the screen', glyph: Icons.pulse },
  {
    id: 'flow',
    name: 'Flow (Settings)',
    ready: true,
    desc: 'The clouds and equalizer as set above, across the whole screen',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.3 4.4 4.4 0 0 0 7 18z"/></svg>',
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    ready: true,
    desc: 'A flight through neon mountains made of the music; the kicks speed it up and make it glow',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="4"/><path d="M2 20l6-8 3 4 2-2 4 6"/>'
      + '<path d="M15 16l2-3 5 7"/></svg>',
  },
  {
    id: 'lightning',
    name: 'Lightning',
    ready: false,
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
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
  kind: null,          // 'bars', 'waveform' or 'synthwave', the one showing
  mode: 'bars',        // Bars: 'bars' or 'scope'
  samples: null,
  raf: null,
  last: 0,
  _lastRandom: null,
  _wasFull: false,
  _closedAt: 0,
  _idle: null,
  _resize: null,

  // Bars
  BARS: 40,
  FLOOR_DB: -64,
  CEIL_DB: -10,
  TILT_DB: 14,         // added across the range, low to high: music is quieter up high
  FALL_PER_S: 1.6,     // how fast a bar drops, in full heights per second
  PEAK_HOLD_MS: 350,
  PEAK_GRAVITY: 2.2,   // full heights per second², once the hold is over
  TOP: 0.9,            // a full bar reaches this share of the screen

  // Waveform: the equalizer's look, a little bigger. Distances in css pixels.
  WAVE_PITCH: 6,
  WAVE_BAR: 3.5,
  WAVE_FLOOR_DB: -58,
  WAVE_CEIL_DB: -8,
  WAVE_REACH: 0.32,    // a full bar reaches this share of the screen, each way
  WAVE_SHINE: 1.8,     // the shine reaches this much further
  WAVE_SHINE_BLUR: 40,
  WAVE_SHINE_ALPHA: 0.6,
  WAVE_CORE_BLUR: 3,
  WAVE_ATTACK_MS: 30,
  WAVE_RELEASE_MS: 360,
  RAINBOW_MS: 15000,

  // Synthwave. Distances in grid cells.
  SYN_SPEED: 7,        // cells per second while a song plays
  SYN_IDLE: 0.25,      // and this much of it while paused
  SYN_KICK_SPEED: 1.4, // a full kick adds this much of SYN_SPEED
  SYN_ROWS: 52,        // how far ahead it is drawn
  SYN_COLS: 64,        // each side of the middle
  SYN_FLOOR: 3.5,      // half the valley floor's width
  SYN_CAM_H: 1.1,      // the eye above the floor
  SYN_HORIZON: 0.5,    // of the screen's height
  SYN_FOCAL: 0.5,      // the lens: a cell one ahead is this share of the width
  SYN_BUMPS: 0.14,     // the floor's bumps at the most intense music, in cells
  SYN_BUMPS_KICK: 0.8, // a full kick lifts them by this much more, a calm beat less
  SYN_BEAT_MS: 3000,   // the kicks the bumps heave on, against the strongest of about this long
  SYN_BEAT_FLOOR: 0.3, // or at least this, so faint kicks in a calm part stay faint
  SYN_RIDE_MS: 70,     // how fast the car follows the bumps under it
  SYN_LIFT: 0.536,     // how much of a bump lifts the eye
  SYN_PITCH: 0.235,    // how much the nose tips up as the ground rises ahead
  SYN_ROLL: 0.35,      // radians the car leans per cell one side stands higher
  SYN_ROLL_MS: 110,    // and how fast, a little slower than the bumps, a wobble
  SYN_ROLL_MAX: 0.04,  // and at most (radians), what the margins below cover
  SYN_ROLL_EYE: 0.75,  // how much of the lean the world tilts (the eye following it)
  SYN_ROLL_NOSE: 1.125, // and the nose the other way, more, so the car is seen to rock
  // The wireframe colours offered under the picker; the first is the default.
  SYN_PRESETS: ['#9f38fa', '#00e5ff', '#ff2bd6', '#39ff14', '#ffb000', '#ff3030', '#ffffff'],

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
    const kind = id === 'random' ? this._pickRandom() : id;
    if (!VISUALIZERS.some((v) => v.id === kind && v.ready)) return;
    this.kind = kind;
    this.mode = 'bars';

    const flow = kind === 'flow';
    // Flow draws nothing of its own: the layer is see-through, over the
    // window's background, and only there for the X and the pointer.
    this.canvas = flow ? null : h('canvas.viz-full__canvas');
    const close = iconButton('viz-full__close', Icons.x, Store.can('keyboard') ? 'Close (Esc)' : 'Close', () => this.close());
    this.el = h('div.viz-full' + (flow ? '.viz-full--flow' : ''), this.canvas, close);
    if (!Equalizer.active && !flow) {
      this.el.appendChild(h('p.viz-full__note', 'The visualizer needs Web Audio, which could not be started on this computer.'));
    }
    if (kind === 'synthwave') this.el.appendChild(this._synPanel());
    if (kind === 'bars') {
      this.canvas.title = 'Click to switch between spectrum and oscilloscope';
      this.canvas.addEventListener('click', () => {
        this.mode = this.mode === 'bars' ? 'scope' : 'bars';
      });
    }
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
    document.body.classList.toggle('viz-flow', flow);
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

    if (flow) {
      // Measured again now the menu, the page and the player bar are out of
      // the way (and again as the window grows to full screen).
      Equalizer._layout();
      Equalizer.wake();
      return;
    }
    if (!Equalizer.active) return;
    this.samples = new Float32Array(Equalizer.analyser.fftSize);
    if (kind === 'bars') this._startBars();
    else if (kind === 'waveform') this._startWave();
    else if (kind === 'synthwave') this._startSynthwave();
    this._resize = new ResizeObserver(() => this._size());
    this._resize.observe(this.canvas);
    this._size();
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this._frame(t));
  },

  close() {
    if (!this.el) return;
    cancelAnimationFrame(this.raf);
    this.raf = null;
    clearTimeout(this._idle);
    if (this._resize) this._resize.disconnect();
    this._resize = null;
    document.removeEventListener('fullscreenchange', this._onFullscreen);
    document.removeEventListener('pointermove', this._onPointer);
    document.removeEventListener('pointerdown', this._onPointer);
    if (this._synOutside) document.removeEventListener('pointerdown', this._synOutside, true);
    this._synOutside = null;
    this._synDraft = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.body.classList.remove('viz-open', 'viz-awake', 'viz-flow');
    this._drawButton(false);
    // The player bar is back in its place: the equalizer measures from it.
    Equalizer._layout();
    this.el.remove();
    this.el = null;
    this.canvas = null;
    this.scratch = null;
    this.glow = null;
    this.terrain = null;
    this._closedAt = performance.now();
  },

  _pickRandom() {
    const ids = VISUALIZERS.filter((v) => v.ready && v.id !== 'random').map((v) => v.id);
    const fresh = ids.filter((v) => v !== this._lastRandom);
    const pool = fresh.length ? fresh : ids;
    this._lastRandom = pool[Math.floor(Math.random() * pool.length)];
    return this._lastRandom;
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
    // Waveform is blurred twice a frame: at css pixels, which is sharp enough
    // for light and much cheaper on a large screen.
    const r = this.kind === 'bars' ? window.devicePixelRatio || 1 : 1;
    const w = Math.max(1, Math.round(c.clientWidth * r));
    const hgt = Math.max(1, Math.round(c.clientHeight * r));
    for (const x of [c, this.scratch, this.glow]) {
      if (!x) continue;
      if (x.width !== w) x.width = w;
      if (x.height !== hgt) x.height = hgt;
    }
    if (this.kind === 'waveform') this._layoutWave();
  },

  _frame(now) {
    if (!this.canvas) return;
    const dt = Math.min(0.1, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    Equalizer.analyser.getFloatTimeDomainData(this.samples);
    if (this.kind === 'synthwave') this._drawSynthwave(dt, now);
    else if (this.kind === 'waveform') this._drawWave(dt);
    else if (this.mode === 'bars') this._drawBars(dt, now);
    else this._drawScope();
    this.raf = requestAnimationFrame((t) => this._frame(t));
  },

  // ---- Bars ----

  _startBars() {
    this.spec = new Spectrum.Analyser({
      sampleRate: Equalizer.ctx.sampleRate, bars: this.BARS, minHz: 40, maxHz: 16000, windowSeconds: 0.046, hop: 128,
    });
    this.levels = new Float32Array(this.BARS);
    this.peaks = new Float32Array(this.BARS);
    this.peakHold = new Float32Array(this.BARS);
    this.peakSpeed = new Float32Array(this.BARS);
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

  _drawBars(dt, now) {
    const c = this.canvas;
    const ctx = c.getContext('2d');
    const w = c.width;
    const hgt = c.height;
    this._background(ctx, w, hgt);
    const db = Player.isPlaying ? this.spec.analyse(this.samples) : null;
    const n = this.BARS;
    const pitch = w / n;
    const barW = Math.max(1, pitch * 0.78);
    const full = hgt * this.TOP;
    const grad = ctx.createLinearGradient(0, hgt, 0, hgt - full);
    grad.addColorStop(0, '#1fb81f');
    grad.addColorStop(0.45, '#9ee21e');
    grad.addColorStop(0.65, '#ffe01a');
    grad.addColorStop(0.82, '#ff8c1a');
    grad.addColorStop(1, '#ff2a1a');
    const cap = Math.max(2, Math.round(hgt / 90));

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
      const top = hgt - level * full;
      ctx.fillStyle = grad;
      ctx.fillRect(x, top, barW, hgt - top);
      ctx.fillStyle = '#d8d8e0';
      ctx.fillRect(x, Math.min(hgt - cap, hgt - this.peaks[i] * full - cap), barW, cap);
    }
  },

  _drawScope() {
    const c = this.canvas;
    const ctx = c.getContext('2d');
    const w = c.width;
    const hgt = c.height;
    this._background(ctx, w, hgt);
    const s = this.samples;
    // The newest ~40 ms, starting where the wave rises through zero, so it
    // stands still instead of running.
    const span = Math.min(2048, s.length);
    let start = s.length - span * 2;
    for (let i = start; i < s.length - span; i += 1) {
      if (s[i - 1] <= 0 && s[i] > 0) {
        start = i;
        break;
      }
    }
    const r = window.devicePixelRatio || 1;
    ctx.strokeStyle = '#7cf06a';
    ctx.lineWidth = Math.max(2, r * 2.5);
    ctx.shadowColor = 'rgba(124, 240, 106, 0.6)';
    ctx.shadowBlur = 12 * r;
    ctx.beginPath();
    for (let i = 0; i < span; i += 1) {
      const x = (i / (span - 1)) * w;
      const v = Player.isPlaying ? Math.max(-1, Math.min(1, s[start + i] * 1.6)) : 0;
      const y = hgt / 2 - v * (hgt / 2) * 0.8;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  },

  // ---- Waveform ----
  //
  // Drawn like the equalizer: sharp bars onto a scratch canvas, faded towards
  // their tips, then that onto the screen twice, once blurred wide and
  // stretched out from the middle for the shine and once only softened.

  _startWave() {
    this.scratch = document.createElement('canvas');
    this.glow = document.createElement('canvas');
    this.spec = null;
    this.levels = new Float32Array(0);
    this.shift = 0;
  },

  /** As many bars as fit across, the analysis to match. */
  _layoutWave() {
    const bars = Math.max(16, Math.floor(this.canvas.width / this.WAVE_PITCH));
    if (this.spec && this.spec.bars === bars) return;
    this.spec = new Spectrum.Analyser({ sampleRate: Equalizer.ctx.sampleRate, bars });
    this.levels = new Float32Array(bars);
  },

  _drawWave(dt) {
    const c = this.canvas;
    const out = c.getContext('2d');
    const w = c.width;
    const hgt = c.height;
    const levels = this.levels;
    const n = levels.length;
    const ms = dt * 1000;
    const fall = Math.exp(-ms / this.WAVE_RELEASE_MS);
    const rise = 1 - Math.exp(-ms / this.WAVE_ATTACK_MS);
    this.shift = (this.shift + ms / this.RAINBOW_MS) % 1;

    if (Player.isPlaying && this.spec) {
      const db = this.spec.analyse(this.samples);
      const unit = (i) => Spectrum.unit(db[Math.max(0, Math.min(n - 1, i))], this.WAVE_FLOOR_DB, this.WAVE_CEIL_DB);
      for (let i = 0; i < n; i += 1) {
        // Each bar leans a little on its neighbours, as on the equalizer.
        const target = 0.25 * unit(i - 1) + 0.5 * unit(i) + 0.25 * unit(i + 1);
        levels[i] = target >= levels[i]
          ? levels[i] + (target - levels[i]) * rise
          : target + (levels[i] - target) * fall;
      }
    } else {
      for (let i = 0; i < n; i += 1) levels[i] *= fall;
    }

    out.globalAlpha = 1;
    out.fillStyle = '#000';
    out.fillRect(0, 0, w, hgt);

    // 1. Sharp bars in the equalizer's colour scheme, mirrored about the
    // middle; a thin line where it is quiet. Black would not show on black.
    const cy = hgt / 2;
    const reach = hgt * this.WAVE_REACH;
    const sc = this.scratch.getContext('2d');
    sc.globalCompositeOperation = 'source-over';
    sc.clearRect(0, 0, w, hgt);
    const scheme = Store.settings.eqColors || 'rainbow';
    const solid = scheme === 'black' ? Palette.solid.white : Palette.solid[scheme] || null;
    if (solid) sc.fillStyle = solid;
    const offset = (w - n * this.WAVE_PITCH) / 2 + (this.WAVE_PITCH - this.WAVE_BAR) / 2;
    for (let i = 0; i < n; i += 1) {
      const v = levels[i];
      const half = Math.max(1, v * reach);
      if (!solid) sc.fillStyle = scheme === 'rainbow' ? Palette.rainbow(i / n - this.shift) : Palette.by(scheme, v);
      sc.fillRect(offset + i * this.WAVE_PITCH, cy - half, this.WAVE_BAR, half * 2);
    }

    // 2. Faded towards the tips, so it reads as light rather than as blocks.
    sc.globalCompositeOperation = 'destination-in';
    const fade = sc.createLinearGradient(0, cy - reach, 0, cy + reach);
    fade.addColorStop(0, 'rgba(0,0,0,0.3)');
    fade.addColorStop(0.5, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0.3)');
    sc.fillStyle = fade;
    sc.fillRect(0, 0, w, hgt);
    sc.globalCompositeOperation = 'source-over';

    // 3. The shine, stretched out from the middle both ways.
    const gl = this.glow.getContext('2d');
    gl.clearRect(0, 0, w, hgt);
    gl.filter = `blur(${this.WAVE_SHINE_BLUR}px)`;
    gl.drawImage(this.scratch, 0, cy - cy * this.WAVE_SHINE, w, hgt * this.WAVE_SHINE);
    gl.filter = 'none';
    out.globalAlpha = this.WAVE_SHINE_ALPHA;
    out.drawImage(this.glow, 0, 0);

    // 4. The bars, only softened.
    out.globalAlpha = 1;
    out.filter = `blur(${this.WAVE_CORE_BLUR}px)`;
    out.drawImage(this.scratch, 0, 0);
    out.filter = 'none';
  },

  // ---- Synthwave ----
  //
  // The wireframe landscape (landscape.js) at full screen, its mountains
  // filled dark, under a purple sky with stars and a sun sitting in the
  // valley's gap, seen from a ship whose nose shows at the bottom. The kicks
  // push it on faster and make the grid and the sun glow.

  _startSynthwave() {
    this.terrain = new Terrain({
      rows: this.SYN_ROWS, cols: this.SYN_COLS, floor: this.SYN_FLOOR, camH: this.SYN_CAM_H, seed: Math.floor(Math.random() * 1e9),
    });
    this.synKick = new Kick();
    this.synIntensity = new Intensity();
    this.synBeatPeak = 0;
    this.synSpeed = this.SYN_SPEED;
    this.synLift = 0;
    this.synPitch = 0;
    this.synRoll = 0;
    this.synEye = this._synEyeOf(Store.settings);
    this.synNose = this._synNoseOf(Store.settings);
    // Stars: where they are (shares of the screen), how big, and their twinkle.
    this.stars = [];
    for (let i = 0; i < 160; i += 1) {
      this.stars.push({ x: Math.random(), y: Math.random() ** 1.6, r: 0.5 + Math.random() * 1.3, p: Math.random() * 6.3, s: 0.5 + Math.random() * 2 });
    }
  },

  _drawSynthwave(dt, now) {
    const c = this.canvas;
    const ctx = c.getContext('2d');
    const w = c.width;
    const hgt = c.height;
    const playing = Player.isPlaying;
    const bass = playing ? Equalizer.bass || 0 : 0;
    const kick = this.synKick.follow(bass, dt * 1000);
    const target = this.SYN_SPEED * (playing ? 1 + this.SYN_KICK_SPEED * kick + 0.4 * bass : this.SYN_IDLE);
    this.synSpeed += (target - this.synSpeed) * (1 - Math.exp(-dt / 0.6));
    this.terrain.advance(this.synSpeed * dt, playing ? Equalizer.levels : null);
    // The floor in front of the car is as rough as the music is intense right
    // now, and heaves on the kicks: measured against the song's own recent
    // kicks, since a long electronic kick over a held bass rises much less
    // above it than a rock drum does, and its drops stayed nearly flat.
    const intensity = this.synIntensity.follow(playing ? Equalizer.levels : null, dt * 1000);
    this.synBeatPeak = Math.max(kick, this.synBeatPeak * Math.exp(-dt * 1000 / this.SYN_BEAT_MS));
    const beat = kick / Math.max(this.SYN_BEAT_FLOOR, this.synBeatPeak);
    const set = Store.settings;
    this.terrain.bumps = set.synBumps
      ? this.SYN_BUMPS * intensity * (1 - this.SYN_BUMPS_KICK / 2 + this.SYN_BUMPS_KICK * beat)
      : 0;

    // The car rides the floor's bumps: between its back (under the eye) and
    // its front the ground lifts it and tips its nose, and the view shakes
    // with it. The horizon moving is the nose tipping: up as the ground rises
    // ahead, so the horizon drops. Camera bobbing off (or no bumps), it
    // settles back level.
    const bob = set.synBumps && set.synBobbing ? set.synBobbingAmount / 100 : 0;
    const back = bob ? this.terrain.groundAt(0.8) * bob : 0;
    const front = bob ? this.terrain.groundAt(1.8) * bob : 0;
    const ride = 1 - Math.exp(-dt * 1000 / this.SYN_RIDE_MS);
    this.synLift += (this.SYN_LIFT * (back + front) / 2 - this.synLift) * ride;
    this.synPitch += ((front - back) - this.synPitch) * ride;
    const horizon = this.SYN_HORIZON + (this.synPitch * this.SYN_PITCH * w * this.SYN_FOCAL) / hgt;
    const hy = hgt * horizon;
    // And it leans to the side whose wheels sit lower. The eye follows part
    // of the lean (SYN_ROLL_EYE), so the world tilts by that much, and the
    // nose the other way (SYN_ROLL_NOSE): the car is seen rocking under you.
    // Either can be switched off or set stronger or weaker (Camera tilt, Car
    // tilt, 0-200%), each eased there.
    const left = this.terrain.groundAt(1.3, -2, -1);
    const right = this.terrain.groundAt(1.3, 1, 2);
    const lean = Math.max(-this.SYN_ROLL_MAX, Math.min(this.SYN_ROLL_MAX, (right - left) * this.SYN_ROLL));
    const roll = 1 - Math.exp(-dt * 1000 / this.SYN_ROLL_MS);
    this.synRoll += (lean - this.synRoll) * roll;
    this.synEye += (this._synEyeOf(set) - this.synEye) * roll;
    this.synNose += (this._synNoseOf(set) - this.synNose) * roll;

    // Under it all the floor's colour, for the corners the tilt uncovers.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'hsl(236, 75%, 6%)';
    ctx.fillRect(0, 0, w, hgt);
    ctx.save();
    ctx.translate(w / 2, hgt);
    ctx.rotate(this.synRoll * this.synEye);
    ctx.translate(-w / 2, -hgt);
    const pad = w * 0.1; // reaching past the edges, tilted

    // The sky, deep purple to magenta at the horizon.
    const sky = ctx.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, '#12002a');
    sky.addColorStop(0.5, '#4a0a5e');
    sky.addColorStop(1, '#b0157a');
    ctx.fillStyle = sky;
    ctx.fillRect(-pad, -pad, w + 2 * pad, hgt);

    ctx.fillStyle = '#fff';
    for (const s of this.stars) {
      const y = s.y * hy * 0.85;
      ctx.globalAlpha = (0.55 + 0.45 * Math.sin(now / 1000 * s.s + s.p)) * (1 - y / hy);
      ctx.beginPath();
      ctx.arc(s.x * w, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // The sun, pink at the top to orange at the bottom, sitting on the
    // horizon; its haze swells on the kicks.
    const r = hgt * 0.22;
    const sy = hy - r * 0.62;
    const haze = ctx.createRadialGradient(w / 2, sy, r * 0.8, w / 2, sy, r * (2.2 + 0.6 * kick));
    haze.addColorStop(0, `rgba(255, 60, 140, ${0.45 + 0.35 * kick})`);
    haze.addColorStop(1, 'rgba(255, 60, 140, 0)');
    ctx.fillStyle = haze;
    ctx.fillRect(-pad, -pad, w + 2 * pad, hy + pad);
    const sun = ctx.createLinearGradient(0, sy - r, 0, sy + r);
    sun.addColorStop(0, '#ff1f6e');
    sun.addColorStop(0.55, '#ff3d8b');
    sun.addColorStop(1, '#ffb347');
    ctx.fillStyle = sun;
    ctx.beginPath();
    ctx.arc(w / 2, sy, r, 0, Math.PI * 2);
    ctx.fill();

    // The terrain a little wider than the screen, the lens the same, so
    // tilted it still reaches the sides: the sine of the most it tilts (the
    // camera at 200%) times the height. Fixed, so its buffer keeps its size.
    const side = Math.ceil(hgt * (Math.sin(this.SYN_ROLL_MAX * this.SYN_ROLL_EYE * 2) + 0.01));
    ctx.translate(-side, 0);
    this.terrain.render(ctx, w + 2 * side, hgt, {
      horizon,
      lift: this.synLift,
      fill: (d) => `hsl(236, 75%, ${(6 + 10 * d).toFixed(1)}%)`,
      glow: 0.8,
      kick,
      focal: (this.SYN_FOCAL * w) / (w + 2 * side),
      line: this._synLine(this._synDraft || set.synColor),
    });
    ctx.translate(side, 0);

    // Where the valley meets the sky, a band of light.
    const band = ctx.createLinearGradient(0, hy - hgt * 0.04, 0, hy + hgt * 0.03);
    band.addColorStop(0, 'rgba(255, 90, 170, 0)');
    band.addColorStop(0.6, `rgba(255, 110, 190, ${0.25 + 0.25 * kick})`);
    band.addColorStop(1, 'rgba(255, 90, 170, 0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = band;
    ctx.fillRect(-pad, hy - hgt * 0.04, w + 2 * pad, hgt * 0.07);
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    ctx.save();
    ctx.translate(w / 2, hgt);
    ctx.rotate(-this.synRoll * this.synNose);
    ctx.translate(-w / 2, -hgt);
    this._drawShip(ctx, w, hgt);
    ctx.restore();
  },

  /** How much of the lean the world tilts, by Camera tilt and its amount. */
  _synEyeOf(set) {
    return set.synCameraTilt ? (this.SYN_ROLL_EYE * set.synCameraTiltAmount) / 100 : 0;
  },

  /** And the nose, by Car tilt and its amount. */
  _synNoseOf(set) {
    return set.synCarTilt ? (this.SYN_ROLL_NOSE * set.synCarTiltAmount) / 100 : 0;
  },

  /**
   * '#rrggbb' as { h, s, l } for the terrain's lines, the last one kept. The
   * default violet turns blue into the distance; a chosen colour stays itself.
   */
  _synLine(hex) {
    if (this._synLineFor === hex) return this._synLineHsl;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const c = max - min;
    const s = c ? c / (1 - Math.abs(2 * l - 1)) : 0;
    this._synLineFor = hex;
    this._synLineHsl = { h: hueOf(r, g, b), s: s * 100, l: l * 100, drift: hex === this.SYN_PRESETS[0] ? 52 : 0 };
    return this._synLineHsl;
  },

  /**
   * Synthwave's cogwheel at the top left. A click opens it to the right,
   * along the top, onto its settings (no dialog); the cogwheel again, or a
   * click anywhere else, closes it. The camera and the car ride the bumps,
   * so their boxes are greyed out while the bumps are off; each has a slider
   * for how strong, 0-200%. Saved as they change.
   */
  _synPanel() {
    const panel = h('div.viz-cfg');
    let picker = null;
    const setOpen = (on) => {
      panel.classList.toggle('viz-cfg--open', on);
      cog.setAttribute('aria-expanded', String(on));
      if (!on) picker.close();
    };
    const cog = iconButton('viz-cfg__cog', Icons.cog, 'Synthwave settings', () => setOpen(!panel.classList.contains('viz-cfg--open')));
    cog.setAttribute('aria-expanded', 'false');

    const swatch = h('button.viz-cfg__swatch', { type: 'button', title: 'Choose the wireframe colour' });
    const paint = (hex) => {
      swatch.style.background = hex;
    };
    paint(Store.settings.synColor);
    picker = this._synPicker(panel, swatch, paint);
    swatch.addEventListener('click', () => picker.toggle());

    const boxes = {};
    const check = (key, label) => {
      const box = h('input', { type: 'checkbox', checked: !!Store.settings[key] });
      box.addEventListener('change', () => {
        Store.saveSettings({ [key]: box.checked });
        refresh();
      });
      boxes[key] = box;
      return h('label.check.viz-cfg__check', box, h('span', label));
    };
    // Its box, and under it the slider with its value; dragging shows at
    // once, letting go saves.
    const sliders = {};
    const option = (key, label) => {
      const amount = key + 'Amount';
      const input = h('input.volume-slider.viz-cfg__slider', { type: 'range', min: 0, max: 200, step: 5, value: Store.settings[amount] });
      const value = h('span.viz-cfg__value');
      const draw = () => {
        value.textContent = `${input.value}%`;
        input.style.setProperty('--fill', `${Number(input.value) / 2}%`);
      };
      input.addEventListener('input', () => {
        draw();
        Store.previewSettings({ [amount]: Number(input.value) });
      });
      input.addEventListener('change', () => Store.saveSettings({ [amount]: Number(input.value) }));
      draw();
      sliders[key] = input;
      return h('div.viz-cfg__opt', check(key, label), h('div.viz-cfg__amount', input, value));
    };
    const ride = h('div.viz-cfg__ride',
      option('synBobbing', 'Camera bobbing'),
      option('synCameraTilt', 'Camera tilt'),
      option('synCarTilt', 'Car tilt'));
    const refresh = () => {
      const on = !!Store.settings.synBumps;
      ride.classList.toggle('viz-cfg__ride--off', !on);
      for (const key of ['synBobbing', 'synCameraTilt', 'synCarTilt']) {
        boxes[key].disabled = !on;
        sliders[key].disabled = !on || !Store.settings[key];
        sliders[key].parentNode.classList.toggle('viz-cfg__amount--off', !Store.settings[key]);
      }
    };

    panel.append(cog, h('div.viz-cfg__body',
      h('div.viz-cfg__item', h('span', 'Wireframe color:'), swatch),
      h('div.viz-cfg__item.viz-cfg__bumps', check('synBumps', 'Ground bumps'), ride)));
    refresh();

    this._synOutside = (e) => {
      if (panel.classList.contains('viz-cfg--open') && !panel.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', this._synOutside, true);
    return panel;
  },

  /**
   * The colour picker under the swatch: a square of saturation (across) and
   * brightness (up), a hue bar, and the presets. Dragging shows the colour on
   * the wireframe at once; it is saved on letting go.
   */
  _synPicker(panel, swatch, paint) {
    const sv = h('div.viz-pick__sv', h('div.viz-pick__dot'));
    const hueBar = h('div.viz-pick__hue', h('div.viz-pick__knob'));
    const presets = h('div.viz-pick__presets');
    const el = h('div.viz-pick', sv, hueBar, presets);
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
    // While dragging only drawn (_synDraft); saved when let go.
    const set = (hex, save) => {
      paint(hex);
      this._synDraft = save ? null : hex;
      if (save && hex !== Store.settings.synColor) Store.saveSettings({ synColor: hex });
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
    for (const hex of this.SYN_PRESETS) {
      const title = hex === this.SYN_PRESETS[0] ? 'Default' : hex;
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
      presets.appendChild(btn);
    }

    const picker = {
      close: () => el.remove(),
      toggle: () => {
        if (el.isConnected) return picker.close();
        hsv = fromHex(Store.settings.synColor);
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

  /** The ship's nose at the bottom of the screen. */
  _drawShip(ctx, w, hgt) {
    const cx = w / 2;
    const top = hgt * 0.86;
    const half = Math.min(w * 0.16, hgt * 0.3);
    // Down past the screen's edge, so leaning it uncovers nothing.
    const bottom = hgt * 1.05;
    const hull = ctx.createLinearGradient(0, top, 0, hgt);
    hull.addColorStop(0, '#f4f6ff');
    hull.addColorStop(0.35, '#c9d0e6');
    hull.addColorStop(1, '#6f7894');
    ctx.fillStyle = hull;
    ctx.beginPath();
    ctx.moveTo(cx - half, top + hgt * 0.02);
    ctx.quadraticCurveTo(cx, top - hgt * 0.012, cx + half, top + hgt * 0.02);
    ctx.lineTo(cx + half * 1.3, bottom);
    ctx.lineTo(cx - half * 1.3, bottom);
    ctx.closePath();
    ctx.fill();

    // The canopy, light blue, on the ridge.
    const canopy = ctx.createLinearGradient(0, top - hgt * 0.02, 0, top + hgt * 0.03);
    canopy.addColorStop(0, '#bff0ff');
    canopy.addColorStop(1, '#3fa9f5');
    ctx.fillStyle = canopy;
    ctx.beginPath();
    ctx.moveTo(cx - half * 0.16, top + hgt * 0.025);
    ctx.lineTo(cx - half * 0.1, top - hgt * 0.012);
    ctx.lineTo(cx + half * 0.1, top - hgt * 0.012);
    ctx.lineTo(cx + half * 0.16, top + hgt * 0.025);
    ctx.closePath();
    ctx.fill();
  },
};
