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
    id: 'lightning',
    name: 'Lightning',
    ready: false,
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  },
];

const Visualizer = {
  el: null,            // the full-screen layer while open
  canvas: null,
  kind: null,          // 'bars' or 'waveform', the one showing
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
    const close = iconButton('viz-full__close', Icons.x, 'Close (Esc)', () => this.close());
    this.el = h('div.viz-full' + (flow ? '.viz-full--flow' : ''), this.canvas, close);
    if (!Equalizer.active && !flow) {
      this.el.appendChild(h('p.viz-full__note', 'The visualizer needs Web Audio, which could not be started on this computer.'));
    }
    if (kind === 'bars') {
      this.canvas.title = 'Click to switch between spectrum and oscilloscope';
      this.canvas.addEventListener('click', () => {
        this.mode = this.mode === 'bars' ? 'scope' : 'bars';
      });
    }
    // Anywhere, the player bar included, since that is over the layer.
    this._onPointer = () => this._wake();
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
    else this._startWave();
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
    if (this.kind === 'waveform') this._drawWave(dt);
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
};
