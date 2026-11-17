'use strict';

// The menu's roots (style.css .roots, assets/roots-far.svg and roots-near.svg),
// at two depths, shown in the menu and reaching out behind the content.
//
// A fake 3D: each depth drifts slowly and without ever stopping, as if hanging
// in water (round a small loop: the speed stays the same, there is no turning
// point where they stand), turns a little about the menu's top, and follows the
// mouse a little the other way (parallax): the near roots more than the far
// ones, so moving the mouse makes them shift against each other. Both breathe
// very slowly in brightness, by turns.
//
// Only the pictures' layers move (transform and opacity, set here), so nothing
// is drawn again: the GPU only lays the layers elsewhere. FPS changes a second
// while they only drift (half a pixel a second: no more are needed, a step is
// far below a pixel), FOLLOW_FPS while they follow the mouse (eased, so slow
// enough for that too). Measured on a quiet window (clouds off): drifting at 20
// a second it cost 0.2 % CPU and 0.85 % GPU, following the mouse every frame 0.3 %
// and 1.5 %; hence these. No frames at all while Flow is in the tray, under the
// full-screen visualizer, or on the phone layout while its menu is closed;
// standing still (the mouse not followed either) with Windows' "Show
// animations" off.

const MenuRoots = {
  layers: [], // { el, depth }
  raf: null,
  last: 0,
  // Seconds drifted so far (only while it moves, so it goes on where it stood).
  time: 0,
  still: false,
  // The mouse against the window's middle (-1 to 1), and how far the roots follow it now.
  mouse: { x: 0, y: 0 },
  follow: { x: 0, y: 0 },
  FPS: 8,
  FOLLOW_FPS: 15,
  // Each depth: how much of the movement it makes, and where in its rhythms it is.
  DEPTHS: { far: { amount: 0.45, phase: 0.37 }, near: { amount: 1, phase: 0 } },
  // The loop's size (px; a little wider than tall) and how long a round takes (s):
  // about half a pixel a second near. A slow wobble of the loop's size on top, so
  // its path does not look drawn with a compass; the turn about the menu's top
  // middle (degrees); how strongly it pulses (the opacity between 1 - PULSE and 1).
  // The periods share no beat, so the movement does not repeat soon.
  LOOP_X: 4.5,
  LOOP_Y: 3.5,
  WOBBLE: 0.3,
  TURN: 0.35,
  PULSE: 0.25,
  PERIODS: { loop: 53, wobble: 29, turn: 41, pulse: 30 },
  // How far the near roots follow the mouse (px, with the mouse at the window's edge), and how quickly (s).
  PARALLAX_X: 9,
  PARALLAX_Y: 6,
  EASE_S: 0.7,

  init() {
    this.layers = [...document.querySelectorAll('.roots__layer')].map((el) => ({
      el,
      depth: el.classList.contains('roots__layer--far') ? this.DEPTHS.far : this.DEPTHS.near,
    }));
    if (!this.layers.length) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.still = motion.matches;
    motion.addEventListener('change', () => {
      this.still = motion.matches;
      this._show();
    });
    window.addEventListener('pointermove', (e) => {
      this.mouse.x = Math.max(-1, Math.min(1, (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1));
      this.mouse.y = Math.max(-1, Math.min(1, (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1));
    }, { passive: true });
    // The mouse gone from the window: back to the middle.
    document.documentElement.addEventListener('mouseleave', () => {
      this.mouse.x = 0;
      this.mouse.y = 0;
    });
    this._show();
    if (!Store.away) this._start();
  },

  /** Flow's window into the tray (true): no more frames; back (false): on from where it stood. */
  rest(on) {
    if (!this.layers.length) return;
    if (on) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
      return;
    }
    this._start();
  },

  _start() {
    if (this.raf !== null || !this.layers.length) return;
    this.last = 0;
    this.raf = requestAnimationFrame((t) => this._frame(t));
  },

  /** Whether the roots are still on their way to where the mouse wants them. */
  _following() {
    return Math.abs(this.mouse.x - this.follow.x) > 0.002 || Math.abs(this.mouse.y - this.follow.y) > 0.002;
  },

  _frame(now) {
    this.raf = requestAnimationFrame((t) => this._frame(t));
    const following = !this.still && this._following();
    if (now - this.last < 1000 / (following ? this.FOLLOW_FPS : this.FPS)) return;
    // Not seen: nothing changed (and the time not counted, so it goes on from there).
    const hidden = document.hidden || (typeof Visualizer !== 'undefined' && Visualizer.shown)
      || (document.body.classList.contains('mobile') && !document.body.classList.contains('drawer-open'));
    const dt = this.last ? Math.min(0.2, (now - this.last) / 1000) : 0;
    this.last = now;
    if (hidden || this.still) return;
    this.time += dt;
    const k = 1 - Math.exp(-dt / this.EASE_S);
    this.follow.x += (this.mouse.x - this.follow.x) * k;
    this.follow.y += (this.mouse.y - this.follow.y) * k;
    this._show();
  },

  /** The layers where they are at `time` (still: in their middle, at full brightness). */
  _show() {
    const still = this.still;
    const p = this.PERIODS;
    const t = still ? 0 : this.time;
    for (const { el, depth } of this.layers) {
      const wave = (period, shift = 0) => Math.sin((t / period + shift + depth.phase) * Math.PI * 2);
      // Round the loop at an even pace (cos and sin of the same angle: never both still).
      const round = (t / p.loop + depth.phase) * Math.PI * 2;
      const size = (1 + this.WOBBLE * wave(p.wobble)) * depth.amount;
      // Against the mouse, as things nearer by seem to move more when one looks past them.
      const x = this.LOOP_X * size * Math.cos(round) - (still ? 0 : this.follow.x * this.PARALLAX_X * depth.amount);
      const y = this.LOOP_Y * size * Math.sin(round) - (still ? 0 : this.follow.y * this.PARALLAX_Y * depth.amount);
      const turn = this.TURN * depth.amount * wave(p.turn, 0.6);
      // From 1 - PULSE up to 1 and back, eased (a breath rather than a blink); the depths by turns.
      const pulse = still ? 1 : 1 - this.PULSE * (0.5 - 0.5 * Math.sin((t / p.pulse + 0.25 + (depth === this.DEPTHS.far ? 0.5 : 0)) * Math.PI * 2));
      el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${turn.toFixed(3)}deg)`;
      el.style.opacity = pulse.toFixed(3);
    }
  },
};
