'use strict';

// Scope: an analog oscilloscope's phosphor screen. The beam draws the sound
// and glows where it moves slowly, fading behind it as a real tube's
// phosphor does. Four ways to look at it:
//
//   XY          left against right (a Lissajous figure): a mono song is a
//               diagonal line, a wide one a cloud
//   Goniometer  the same turned 45 degrees, as studio vectorscopes show it:
//               mono stands upright, the wider the stereo the wider it spreads
//   Wave        the waveform across the screen, held still on its rising edge
//   Polar       the waveform bent into a ring that swells on the kicks
//
// The size follows the song (a quiet one is drawn as large as a loud one).
// Its cogwheel: the mode, the phosphor's colour, how long it glows on, and
// the graticule (the scope's grid).
//
// WebGL (viz/gl.js): the beam goes, as light, into a texture that keeps the
// last frames fading (half float, so the long tail does not band); that
// blurred twice is the glow; the screen tints both with the phosphor colour.

(() => {
  const PRESETS = ['#5dff7a', '#ffb347', '#6ec8ff', '#ffffff', '#ff5ef0', '#ff4d4d'];
  const MAX_VERTS = 120000;

  const FADE_FS = `
    in vec2 uv;
    uniform sampler2D prev;
    uniform float keep;
    out vec4 o;
    void main() {
      o = vec4(texture(prev, uv).rgb * keep, 1.0);
    }`;

  const OUT_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D beam;
    uniform sampler2D glowA;
    uniform sampler2D glowB;
    uniform vec2 res;
    uniform vec3 color;
    uniform float grid;
    out vec4 o;
    void main() {
      float b = texture(beam, uv).r;
      float g = texture(glowA, uv).r * 1.6 + texture(glowB, uv).r * 2.4;
      // The tube's face: near black, a little lighter in the middle.
      vec2 v = uv - 0.5;
      v.x *= res.x / res.y;
      vec3 col = vec3(0.012, 0.016, 0.014) * (1.0 - 0.6 * length(v));
      // The graticule: ten by eight squares in a square, with ticks on the axes.
      if (grid > 0.0) {
        float side = min(res.x, res.y) * 0.9;
        vec2 p = (uv * res - res * 0.5) / side;
        vec2 cell = abs(fract(p * 8.0 + 0.5) - 0.5) * side / 8.0;
        float line = 1.0 - smoothstep(0.4, 1.3, min(cell.x, cell.y));
        vec2 tick = abs(fract(p * 40.0 + 0.5) - 0.5) * side / 40.0;
        float ticks = (1.0 - smoothstep(0.4, 1.2, abs(p.x) * side)) * (1.0 - smoothstep(3.0, 4.0, tick.y))
          + (1.0 - smoothstep(0.4, 1.2, abs(p.y) * side)) * (1.0 - smoothstep(3.0, 4.0, tick.x));
        float inside = step(abs(p.x), 0.5 + 0.5 / side) * step(abs(p.y), 0.5 + 0.5 / side);
        col += color * 0.06 * grid * inside * max(line, min(1.0, ticks));
      }
      // The beam: its colour, white where it is brightest.
      col += color * g + mix(color, vec3(1.0), clamp(b * 0.5, 0.0, 0.7)) * b;
      col = 1.0 - exp(-col * 1.2);
      col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Scope {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.fade = VizGL.program(gl, VizGL.SCREEN_VS, FADE_FS);
      this.out = VizGL.program(gl, VizGL.SCREEN_VS, OUT_FS);
      this.lines = VizGL.lines(gl, MAX_VERTS);
      this.peak = 0.1;
      this.w = 1;
      this.h = 1;
      this.rate = Equalizer.ctx ? Equalizer.ctx.sampleRate : 48000;
      this.owed = 0;
    }

    size(w, h) {
      const gl = this.gl;
      for (const t of [this.a, this.b, this.qa, this.qb, this.ea, this.eb]) VizGL.freeTarget(gl, t);
      this.w = w;
      this.h = h;
      this.a = VizGL.target(gl, w, h);
      this.b = VizGL.target(gl, w, h);
      const q = (d) => [Math.max(1, Math.round(w / d)), Math.max(1, Math.round(h / d))];
      this.qa = VizGL.target(gl, ...q(3));
      this.qb = VizGL.target(gl, ...q(3));
      this.ea = VizGL.target(gl, ...q(10));
      this.eb = VizGL.target(gl, ...q(10));
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      const mode = set('scMode');
      const L = a.left;
      const R = a.right;
      const n = L ? L.length : 0;

      // The size follows the song: its recent peak, sinking back slowly.
      let peak = 0;
      if (n && a.playing) {
        for (let i = n - 2048; i < n; i += 1) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      }
      this.peak = Math.max(peak, this.peak * Math.exp(-dt / 2.5), 0.05);
      const gain = 0.85 / this.peak;

      // 1. What glowed fades: by Persistence, the share left after a second.
      const persist = set('scPersist') / 100;
      // A sweep fades faster than a figure: each frame draws it all again.
      const sweep = mode === 'wave' || mode === 'polar';
      const keep = Math.pow(Math.min(0.97, 0.02 + 0.6 * persist), dt * (sweep ? 9 : 4));
      gl.disable(gl.BLEND);
      gl.useProgram(this.fade.p);
      VizGL.into(gl, this.b);
      VizGL.bind(gl, this.fade.u.prev, this.a.tex, 0);
      gl.uniform1f(this.fade.u.keep, keep);
      VizGL.screen(gl);

      // 2. The beam, as light: the newer the sound, the more of it.
      if (n && a.playing) {
        if (mode === 'wave' || mode === 'polar') this._trace(a, mode, gain);
        else this._xy(L, R, n, dt, mode === 'gonio', gain);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        this.lines.draw(this.w, this.h);
        gl.disable(gl.BLEND);
      }

      // 3. Its glow.
      VizGL.blur(gl, this.b, this.qa, this.qb, 1.4);
      VizGL.blur(gl, this.qb, this.ea, this.eb, 1.6);

      // 4. The screen.
      VizGL.into(gl, null);
      gl.useProgram(this.out.p);
      const u = this.out.u;
      VizGL.bind(gl, u.beam, this.b.tex, 0);
      VizGL.bind(gl, u.glowA, this.qb.tex, 1);
      VizGL.bind(gl, u.glowB, this.eb.tex, 2);
      gl.uniform2f(u.res, this.w, this.h);
      const c = VizGL.rgb(set('scColor'));
      gl.uniform3f(u.color, c[0], c[1], c[2]);
      gl.uniform1f(u.grid, set('scGrid') ? 1 : 0);
      VizGL.screen(gl);

      [this.a, this.b] = [this.b, this.a];
    }

    /**
     * XY: the samples heard since the last frame (and a little before), each
     * step of the beam as bright as it is slow, as on a real tube.
     */
    _xy(L, R, n, dt, gonio, gain) {
      this.owed += dt * this.rate;
      const count = Math.min(n - 1, Math.ceil(this.owed) + 64);
      this.owed = 0;
      const side = Math.min(this.w, this.h) * 0.45 * gain;
      const cx = this.w / 2;
      const cy = this.h / 2;
      const unit = this.h / 1080;
      const width = 1.25 * unit;
      const white = [1, 1, 1];
      // Upsampled twice between samples (a little curve, not corners).
      let px = null;
      let py = 0;
      // A gentle low pass (about 4 kHz) takes the hiss's fuzz off the figure.
      const lo = this._smooth(L, n - count - 8, n, 'l');
      const ro = this._smooth(R, n - count - 8, n, 'r');
      const at = (i) => {
        const l = lo[i - (n - count - 8)];
        const r = ro[i - (n - count - 8)];
        // Turned, the sum reaches further: halved, so it fits as XY does.
        return gonio ? [(r - l) * 0.5, (l + r) * 0.5] : [l, r];
      };
      for (let i = n - count; i < n - 1; i += 1) {
        const p0 = at(i - 1);
        const p1 = at(i);
        const p2 = at(i + 1);
        const p3 = at(Math.min(n - 1, i + 2));
        for (let s = 0; s < 2; s += 1) {
          const t = s / 2;
          const t2 = t * t;
          const t3 = t2 * t;
          const f = (a0, a1, a2, a3) => 0.5 * (2 * a1 + (-a0 + a2) * t + (2 * a0 - 5 * a1 + 4 * a2 - a3) * t2 + (-a0 + 3 * a1 - 3 * a2 + a3) * t3);
          const vx = f(p0[0], p1[0], p2[0], p3[0]);
          const vy = f(p0[1], p1[1], p2[1], p3[1]);
          const x = cx + vx * side;
          const y = cy - vy * side;
          if (px !== null) {
            const len = Math.hypot(x - px, y - py);
            // Slow: bright; fast: faint, as the beam's light spreads over its way.
            const bright = Math.min(1.2, 1.6 / (1 + len / (2.5 * unit)));
            this.lines.seg(px, py, x, y, width, white, bright * 0.38);
          }
          px = x;
          py = y;
        }
      }
    }

    /** src[from..to) through a one-pole low pass, into a buffer kept per name. */
    _smooth(src, from, to, name, k = 0.42) {
      const len = to - from;
      this._buf = this._buf || {};
      if (!this._buf[name] || this._buf[name].length < len) this._buf[name] = new Float32Array(src.length);
      const out = this._buf[name];
      let y = src[Math.max(0, from)];
      for (let i = 0; i < len; i += 1) {
        y += (src[Math.max(0, from + i)] - y) * k;
        out[i] = y;
      }
      return out;
    }

    /** Wave and Polar: one sweep of the newest sound, held still on a rising edge. */
    _trace(a, mode, gain) {
      // Smoother still (about 1 kHz): one clean line rather than a band.
      const s = this._smooth(a.samples, 0, a.samples.length, 'm', 0.13);
      const span = 2048;
      // A rising edge of the low end, so the picture stands still.
      let start = s.length - span;
      let low = 0;
      let lastLow = 0;
      for (let i = s.length - span - 1500; i < s.length - span; i += 1) {
        low += (s[i] - low) * 0.02;
        if (lastLow <= 0 && low > 0 && i > 0) {
          start = i;
        }
        lastLow = low;
      }
      const unit = this.h / 1080;
      const white = [1, 1, 1];
      const cx = this.w / 2;
      const cy = this.h / 2;
      let px = null;
      let py = 0;
      const step = 2;
      for (let i = 0; i < span; i += step) {
        const v = s[start + i] * gain;
        let x;
        let y;
        if (mode === 'wave') {
          x = (i / span) * this.w;
          y = cy - v * this.h * 0.38;
        } else {
          const ang = (i / span) * Math.PI * 2 - Math.PI / 2;
          const r = Math.min(this.w, this.h) * (0.24 + 0.05 * a.kick) * (1 + 0.45 * v);
          x = cx + Math.cos(ang) * r;
          y = cy + Math.sin(ang) * r;
        }
        if (px !== null) {
          const len = Math.hypot(x - px, y - py);
          this.lines.seg(px, py, x, y, 1.3 * unit, white, Math.min(1, 1.4 / (1 + len / (6 * unit))) * 0.45);
        }
        px = x;
        py = y;
      }
    }
  }

  Visualizer.add({
    id: 'scope',
    name: 'Scope',
    desc: "An analog oscilloscope's glowing screen: left against right, a goniometer, the waveform, or a ring",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M5 12c2-6 4-6 5 0s3 6 5 0 3-6 4 0"/></svg>',
    gl: true,
    stereo: true,
    create: (canvas) => new Scope(canvas),
    options: [
      { type: 'choice', key: 'scMode', label: 'Mode', choices: [['xy', 'XY'], ['gonio', 'Goniometer'], ['wave', 'Wave'], ['polar', 'Polar']] },
      { type: 'color', key: 'scColor', label: 'Phosphor', presets: PRESETS },
      { type: 'slider', key: 'scPersist', label: 'Persistence', min: 0, max: 100, step: 5 },
      { type: 'check', key: 'scGrid', label: 'Grid' },
    ],
  });
})();
