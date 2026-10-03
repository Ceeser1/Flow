'use strict';

// The clouds behind the content: a few large, shapeless clouds of deep colour,
// each a wide core with a far, faint shine around it, that drift about slowly
// and never stop. Each one also comes and goes on its own slow cycle, so at
// any time some of the background is plain and some is tinted, and it is
// never the same twice. While a song plays they breathe with it: a kick or a
// bass note that stands out from the last half second swells and brightens
// them a little.
//
// A cloud is a loose scatter of puffs, each drifting and swelling on its own.
// A puff is a round glow that falls off like a bell curve, a dense middle
// running out into a wide, faint shine, drawn with many colour steps so the
// fall-off has no corners. Where puffs overlap the cloud is denser, which is
// what gives it its uneven, changing shape. (Not the canvas blur filter: at
// these widths Chromium blurs in shrunk-down stages, which leaves streaks.)
//
// The visible canvas is solid: it is painted with the page background first
// and the clouds are mixed into that. A see-through canvas holding such faint
// colour keeps too few steps of it (colour and see-through are each rounded
// to 256 steps, and at a few percent the two roundings disagree), which shows
// as rings that fade out and start again. Solid, only the colour is rounded,
// in steps too small to see.
//
// At full size: Chromium speckles colour fades by a step to hide banding,
// invisible pixel by pixel, but a canvas drawn smaller and stretched turns the
// speckles into a grid. The equalizer's canvas lies on top of this one.
//
// Settings: in Rainbow each cloud takes a random colour every time it comes
// back; a solid scheme gives them all that one. The amount at 50% is the
// first half of CLOUDS (the look as designed), 100% all of them, 0% none.

const Ambient = {
  canvas: null,
  background: '#1e1e22',
  raf: null,
  lastDraw: 0,
  lastFrame: 0,
  time: 0,          // seconds of drift so far
  bassAverage: 0,
  pulse: 0,         // 0..1, the swell of the last bass hit
  frozen: false,    // Windows' "Show animations" off: the clouds stand still

  IDLE_FPS: 24,     // without a song they only drift, which needs no more
  // One puff: its strength in the middle, and how far the shine reaches, in
  // puff radii. Where several overlap the cloud gets stronger.
  PUFF_ALPHA: 0.1,   // at Settings' 50% intensity; 100% doubles it
  SHINE_SHARE: 0.35, // the shine's strength against the core's
  SHINE_WIDTH: 2.2,  // the shine's width against the core's
  REACH: 3.4,        // where the puff has faded to nothing
  STOPS: 24,
  // The pulse: bass above its own average of the last AVERAGE_MS by more than
  // THRESHOLD, rising over ATTACK_MS and falling back over RELEASE_MS.
  AVERAGE_MS: 500,
  THRESHOLD: 0.06,
  GAIN: 2.3,
  ATTACK_MS: 40,
  RELEASE_MS: 280,
  PULSE_ALPHA: 0.8, // a full pulse makes a cloud this much brighter
  PULSE_GROW: 0.08, // and this much larger (both at Settings' 25% reaction)
  PUFFS: 9,         // per cloud

  // Each cloud: saturation and lightness of its colour (the hue is Rainbow's
  // pick), size (share of the larger side), the slow paths it drifts along
  // (centre, reach and period in seconds, for x and for y), and how long one
  // round of coming and going takes. It is away for about a third of that.
  CLOUDS: [
    { sat: 90, light: 46, size: 0.24, x: [0.2, 0.2, 97], y: [0.3, 0.2, 131], hueSwing: 14, cycle: 71 },
    { sat: 85, light: 48, size: 0.22, x: [0.78, 0.16, 113], y: [0.25, 0.18, 89], hueSwing: 18, cycle: 97 },
    { sat: 90, light: 38, size: 0.22, x: [0.6, 0.28, 149], y: [0.7, 0.2, 103], hueSwing: 12, cycle: 83 },
    { sat: 85, light: 46, size: 0.2, x: [0.3, 0.24, 167], y: [0.75, 0.18, 119], hueSwing: 16, cycle: 109 },
    { sat: 80, light: 50, size: 0.22, x: [0.5, 0.32, 83], y: [0.45, 0.26, 157], hueSwing: 20, cycle: 61 },
    { sat: 85, light: 44, size: 0.18, x: [0.85, 0.1, 139], y: [0.6, 0.26, 127], hueSwing: 14, cycle: 131 },
    // Above 50%.
    { sat: 85, light: 44, size: 0.2, x: [0.4, 0.3, 107], y: [0.2, 0.15, 137], hueSwing: 14, cycle: 79 },
    { sat: 88, light: 42, size: 0.21, x: [0.7, 0.22, 127], y: [0.45, 0.3, 101], hueSwing: 16, cycle: 103 },
    { sat: 80, light: 48, size: 0.19, x: [0.15, 0.12, 151], y: [0.6, 0.3, 109], hueSwing: 12, cycle: 89 },
    { sat: 85, light: 45, size: 0.23, x: [0.55, 0.35, 173], y: [0.85, 0.12, 113], hueSwing: 18, cycle: 127 },
    { sat: 90, light: 40, size: 0.18, x: [0.9, 0.08, 93], y: [0.15, 0.12, 143], hueSwing: 14, cycle: 67 },
    { sat: 82, light: 47, size: 0.2, x: [0.35, 0.28, 131], y: [0.5, 0.35, 163], hueSwing: 16, cycle: 113 },
  ],

  // The solid schemes: [hue, saturation, lightness], as the equalizer's.
  SOLID: {
    white: [0, 0, 78],
    red: [0, 85, 46],
    green: [130, 70, 40],
    yellow: [52, 95, 48],
    blue: [215, 90, 50],
    purple: [275, 75, 52],
    black: [0, 0, 0],
  },

  init() {
    this.canvas = $('ambientCanvas');
    if (!this.canvas) return;
    this.background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || this.background;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.frozen = motion.matches;
    motion.addEventListener('change', () => {
      this.frozen = motion.matches;
    });
    this._makeFalloff();
    this._makePuffs();
    // Each start somewhere else along the paths.
    this.time = Math.random() * 600;
    this._layout();
    new ResizeObserver(() => this._layout()).observe(document.querySelector('.content'));
    this.raf = requestAnimationFrame((t) => this._frame(t));
    Store.onSettings((patch) => {
      if (['cloudsOn', 'cloudsIntensity', 'cloudsColors', 'cloudsAmount'].some((k) => k in patch)) this._draw();
    });
  },

  /**
   * Each cloud's puffs: scattered wide around its middle (the same every
   * start), each wandering and swelling on its own periods, so the cloud has
   * no shape to speak of and a different one every minute.
   */
  _makePuffs() {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (const cl of this.CLOUDS) {
      // Some lie, some stand.
      const stretch = 0.6 + rand() * 1.1;
      cl.puffs = [];
      for (let k = 0; k < this.PUFFS; k += 1) {
        const angle = rand() * Math.PI * 2;
        const dist = Math.sqrt(rand()) * 1.3;
        cl.puffs.push({
          dx: Math.cos(angle) * dist * stretch,
          dy: Math.sin(angle) * dist / stretch,
          r: 0.25 + rand() * 0.45,
          wander: 0.25 + rand() * 0.35,
          period: 31 + rand() * 50,
          phase: rand() * Math.PI * 2,
        });
      }
    }
  },

  /**
   * A puff's strength from its middle (0) to its edge (1), sampled at STOPS
   * points: a bell curve for the core plus a wider, fainter one for the shine,
   * lowered so it ends at exactly nothing.
   */
  _makeFalloff() {
    const at = (u) => Math.exp(-u * u) + this.SHINE_SHARE * Math.exp(-(u * u) / (this.SHINE_WIDTH * this.SHINE_WIDTH));
    const end = at(this.REACH);
    const top = at(0) - end;
    this.falloff = [];
    for (let k = 0; k <= this.STOPS; k += 1) {
      const d = k / this.STOPS;
      this.falloff.push([d, Math.max(0, (at(d * this.REACH) - end) / top)]);
    }
  },

  _layout() {
    const content = document.querySelector('.content');
    const w = Math.max(1, content.clientWidth);
    const h = Math.max(1, content.clientHeight);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this._draw();
  },

  _frame(now) {
    this.raf = requestAnimationFrame((t) => this._frame(t));
    const dt = Math.min(100, Math.max(0, now - (this.lastFrame || now)));
    this.lastFrame = now;
    // Turned off in Settings: the plain background, drawn once by _draw.
    if (Store.settings.cloudsOn === false) return;
    this._follow(dt);
    // With nothing playing and no pulse left to fade, fewer frames will do.
    const lively = Equalizer.bass > 0 || this.pulse > 0.002;
    if (!lively && now - this.lastDraw < 1000 / this.IDLE_FPS) return;
    if (!this.frozen) this.time += (now - (this.lastDraw || now)) / 1000;
    this.lastDraw = now;
    this._draw();
  },

  /** The bass pulse, from the equalizer's bass level. */
  _follow(dt) {
    const bass = Equalizer.bass || 0;
    // A song starting is not a hit: the average starts where the bass is.
    if (bass > 0 && !this._hearing) this.bassAverage = bass;
    this._hearing = bass > 0;
    this.bassAverage += (bass - this.bassAverage) * (1 - Math.exp(-dt / this.AVERAGE_MS));
    const hit = Math.min(1, Math.max(0, bass - this.bassAverage - this.THRESHOLD) * this.GAIN);
    this.pulse = hit > this.pulse
      ? this.pulse + (hit - this.pulse) * (1 - Math.exp(-dt / this.ATTACK_MS))
      : hit + (this.pulse - hit) * Math.exp(-dt / this.RELEASE_MS);
  },

  _draw() {
    const c = this.canvas;
    if (!c) return;
    const out = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    out.fillStyle = this.background;
    out.fillRect(0, 0, w, h);
    const s = Store.settings;
    if (s.cloudsOn === false) return;

    const t = this.time;
    const tau = 2 * Math.PI;
    const side = Math.max(w, h);
    // Settings: intensity at 50% and bass reaction at 25% are the look as
    // designed; 100% reaction is four times that.
    const react = s.cloudsBass === false ? 0 : (s.cloudsBassAmount || 50) / 25;
    const swell = 1 + this.PULSE_GROW * this.pulse * react;
    const brighter = 1 + this.PULSE_ALPHA * this.pulse * react;
    const intensity = (s.cloudsIntensity || 50) / 50;
    const at = ([centre, reach, period], phase) => centre + reach * Math.sin((tau * t) / period + phase);
    const solid = this.SOLID[s.cloudsColors] || null;
    const amount = Number.isFinite(s.cloudsAmount) ? s.cloudsAmount : 50;
    const count = Math.round((this.CLOUDS.length * amount) / 100);

    this.CLOUDS.forEach((cl, i) => {
      if (i >= count) return;
      // Away while the wave is well below zero, easing in and out around it.
      const wave = Math.min(1, Math.max(0, 0.5 + 0.8 * Math.sin((tau * t) / cl.cycle + i * 2.1)));
      const here = wave * wave * (3 - 2 * wave);
      if (here < 0.005) {
        cl.away = true;
        return;
      }
      // Rainbow: a new colour each time it comes back.
      if (cl.away || cl.hue == null) {
        cl.hue = Math.random() * 360;
        cl.away = false;
      }
      const x = at(cl.x, i * 1.7) * w;
      const y = at(cl.y, i * 2.3 + 1) * h;
      // Growing as it comes, shrinking as it goes.
      const r = cl.size * side * swell * (0.7 + 0.3 * here);
      const colour = solid
        ? `hsla(${solid[0]}, ${solid[1]}%, ${solid[2]}%, `
        : `hsla(${(cl.hue + cl.hueSwing * Math.sin((tau * t) / 211 + i)).toFixed(1)}, ${cl.sat}%, ${cl.light}%, `;
      const strength = Math.min(1, this.PUFF_ALPHA * intensity * here * brighter);

      for (const p of cl.puffs) {
        const a = (tau * t) / p.period + p.phase;
        const px = x + (p.dx + p.wander * Math.sin(a)) * r;
        const py = y + (p.dy + p.wander * 0.6 * Math.cos(a * 0.83)) * r;
        const reach = p.r * r * (1 + 0.3 * Math.sin(a * 1.37 + 1)) * this.REACH;
        const grad = out.createRadialGradient(px, py, 0, px, py, reach);
        for (const [d, v] of this.falloff) grad.addColorStop(d, colour + (strength * v).toFixed(4) + ')');
        out.fillStyle = grad;
        out.fillRect(px - reach, py - reach, reach * 2, reach * 2);
      }
    });
  },
};
