'use strict';

// The Mini Player's equalizer (its cogwheel's Show Equalizer): the app's own
// equalizer, with the looks set in Flow's Settings (colours, height, shine,
// visibility), standing on the widget's bottom edge behind the rows.
//
// The picture is drawn by the app's equalizer.js, loaded here for that alone
// (Equalizer's canvas, geom, levels, _look, _webgl and _draw, and Palette);
// what it reads of the app is stood in for below (the settings, and that no
// visualizer is open). A full bar is as high here against the widget as it is
// in the app against the pages: a third of the height at Settings' 50%.
//
// To come out as strong as in the app, the picture is the app's made small,
// not cut out of it. There the bars also run below the line they stand on
// (behind the player bar), and their softening and their shine gather light
// from both halves: so here the canvas goes on below the widget's bottom
// edge, out of sight. And the app softens by a set number of pixels, made for
// its tall bars: here that is brought into the measure of these bars, or the
// shine is spread several times as thin.
//
// There is no sound in this window. With each frame the bars' levels are
// asked of Flow's window (window.mini.wantLevels, at most 60 times a second),
// which answers them from what it plays; the bars follow them here, quick up
// and slow down as in the app. Nothing is asked while nothing plays, while the
// tick is off, or while the widget is out of sight (it gets no frames then).

// What equalizer.js reads of the app.
const Store = {
  settings: {
    eqOn: true, eqColors: 'rainbow', eqHeight: 50, eqShine: true, eqShineSpread: 50, eqVisibility: 50,
  },
  away: false,
};
const Visualizer = { shown: false };

const MiniEq = {
  on: false,          // the tick
  playing: false,     // Flow's window plays
  made: false,        // the canvas's drawing is there (from the first time the tick is on)
  raf: null,
  last: 0,
  askedAt: 0,
  target: null,       // the levels last answered, 0..255 each
  targetAt: 0,

  ASK_MS: 16,         // between two asks
  STALE_MS: 400,      // an answer older than this counts as silence
  // The app's picture this one is the small copy of: a full bar's height there (a window as Flow
  // first opens), and how far its canvas goes on below the line, in bar heights (its player bar).
  APP_REACH: 250,
  BELOW: 0.48,
  CORE_LEAST: 2,      // the bars' softening at least (px): under that the single bars show as stripes
  core: 0,            // the app's own two blurs (px), as equalizer.js has them
  shine: 0,

  /** The tick: the equalizer there (true) or gone. */
  show(on) {
    this.on = !!on;
    if (this.on && !this.made) this._make();
    if (!this.made) return;
    Equalizer.canvas.hidden = !this.on;
    if (this.on) {
      this._layout();
      this._wake();
      return;
    }
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.target = null;
    Equalizer.levels.fill(0);
  },

  /** The looks from Flow's Settings ({ eqColors, eqHeight, eqShine, eqShineSpread, eqVisibility }), as it starts and when they change. */
  look(look) {
    Object.assign(Store.settings, look || {}, { eqOn: true });
    if (this.made && this.on) this._layout();
  },

  /** Whether Flow's window plays: the bars follow it, or fall and rest. */
  sounding(playing) {
    this.playing = !!playing;
    if (this.playing) this._wake();
  },

  /** The levels asked for, from Flow's window. */
  take(levels) {
    if (!Array.isArray(levels)) return;
    this.target = levels;
    this.targetAt = performance.now();
  },

  _make() {
    const E = Equalizer;
    this.made = true;
    E.canvas = document.getElementById('eq');
    // WebGL where it can be had (it may put a fresh canvas in this one's place), else the canvas's own drawing.
    E.gl = E._webgl();
    E.scratch = document.createElement('canvas');
    E.glow = document.createElement('canvas');
    this.core = E.CORE_BLUR;
    this.shine = E.SHINE_BLUR;
    new ResizeObserver(() => {
      if (this.on) this._layout();
    }).observe(document.getElementById('mini'));
  },

  /**
   * The canvas on the widget's bottom edge: as wide as the widget, as high as
   * the bars and their shine reach above the line they stand on (the widget's
   * bottom edge) and going on below it out of sight, a bar every few pixels
   * as in the app, its blurs in these bars' measure.
   */
  _layout() {
    const E = Equalizer;
    const root = document.getElementById('mini');
    const width = Math.max(1, root.clientWidth);
    const full = Math.max(1, root.clientHeight);
    const look = E._look();
    const reach = full * look.reach;
    const above = Math.max(1, Math.round(Math.min(full, reach * Math.max(1, look.shine) * 1.05)));
    const below = Math.round(reach * this.BELOW);
    const height = above + below;
    E.geom = {
      width, height, top: full - above, center: above, reach, shine: look.shine,
    };
    const k = reach / this.APP_REACH;
    E.CORE_BLUR = Math.min(this.core, Math.max(this.CORE_LEAST, this.core * k));
    E.SHINE_BLUR = Math.min(this.shine, this.shine * k);
    E.canvas.style.width = `${width}px`;
    E.canvas.style.height = `${height}px`;
    E.canvas.style.bottom = `${-below}px`;
    E.canvas.style.opacity = String((Store.settings.eqVisibility || 50) / 100);
    const w = Math.max(1, Math.round(width * E.SCALE));
    const h = Math.max(1, Math.round(height * E.SCALE));
    for (const c of [E.canvas, E.scratch, E.glow]) {
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
    }
    const bars = Math.max(16, Math.floor(width / E.PITCH));
    if (E.levels.length !== bars) {
      // What was showing, stretched to the new count, so resizing does not blink.
      const old = E.levels;
      E.levels = new Float32Array(bars);
      for (let i = 0; i < bars && old.length; i += 1) E.levels[i] = old[Math.min(old.length - 1, Math.floor((i / bars) * old.length))];
    }
    if (this.raf === null) E._draw();
  },

  /** Starts the frames; they stop by themselves once nothing plays and the bars have settled. */
  _wake() {
    if (!this.on || !this.made || this.raf !== null) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this._frame(t));
  },

  _frame(now) {
    this.raf = null;
    const E = Equalizer;
    const dt = Math.min(100, Math.max(1, now - this.last));
    this.last = now;
    const live = this.on && this.playing;
    if (live && now - this.askedAt >= this.ASK_MS) {
      this.askedAt = now;
      window.mini.wantLevels(E.levels.length);
    }
    const levels = E.levels;
    const n = levels.length;
    const fresh = performance.now() - this.targetAt < this.STALE_MS;
    const t = live && fresh && this.target && this.target.length === n ? this.target : null;
    const fall = Math.exp(-dt / E.RELEASE_MS);
    const rise = 1 - Math.exp(-dt / E.ATTACK_MS);
    E.rainbowShift = (E.rainbowShift + dt / E.RAINBOW_MS) % 1;
    let peak = 0;
    for (let i = 0; i < n; i += 1) {
      let v = levels[i] * fall;
      if (t) {
        // Each bar leans a little on its neighbours, as in the app.
        const want = (0.25 * t[Math.max(0, i - 1)] + 0.5 * t[i] + 0.25 * t[Math.min(n - 1, i + 1)]) / 255;
        v = want >= levels[i] ? levels[i] + (want - levels[i]) * rise : want + (levels[i] - want) * fall;
      }
      levels[i] = v;
      if (v > peak) peak = v;
    }
    E._draw();
    if (live || peak > 0.004) {
      this.raf = requestAnimationFrame((ts) => this._frame(ts));
    } else {
      levels.fill(0);
      E._draw();
    }
  },
};
