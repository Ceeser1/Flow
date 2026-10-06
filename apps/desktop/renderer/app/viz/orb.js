'use strict';

// Orb: a sphere of light that the music pushes out of shape. Its surface is a
// grid of points, each band of the spectrum swelling one belt of it (the bass
// round the middle, the highs towards the poles), stirred by slow noise so it
// moves like something alive; it turns, swells on the kicks, and a ring of
// sparks circles it, quickening with the highs.
//
// Its cogwheel: dots or a wireframe, the colours, how fast it turns, the ring.
//
// WebGL (viz/gl.js): the points or lines as light into a texture, that
// blurred twice for the glow, the background and both together in one pass.

(() => {
  const LON = 72;
  const LAT = 40;
  const RING = 700;
  const PALETTES = {
    aurora: [[0.2, 1, 0.85], [0.55, 0.35, 1]],
    ember: [[1, 0.85, 0.3], [1, 0.2, 0.15]],
    ice: [[0.85, 0.95, 1], [0.25, 0.5, 1]],
    white: [[1, 1, 1], [0.75, 0.8, 0.9]],
  };

  const OUT_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D light;
    uniform sampler2D glowA;
    uniform sampler2D glowB;
    uniform vec2 res;
    uniform vec3 tint;
    uniform float pulse, time;
    out vec4 o;
    void main() {
      vec2 p = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      float r = length(p);
      vec3 col = vec3(0.008, 0.008, 0.016) + tint * 0.05 * exp(-r * r * 4.0) * (1.0 + pulse);
      col += texture(light, uv).rgb + texture(glowA, uv).rgb * 1.2 + texture(glowB, uv).rgb * 1.8;
      col = 1.0 - exp(-col * 1.2);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  function hsv(h, s, v) {
    const f = (n) => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }

  /** A smooth noise in 3D, cheap: sums of sines. */
  function wobble(x, y, z, t) {
    return Math.sin(x * 2.1 + t * 0.9) * Math.sin(y * 2.7 - t * 0.7) * Math.sin(z * 1.9 + t * 0.5)
      + 0.5 * Math.sin(x * 4.3 - t * 1.3 + y * 3.1) * Math.sin(z * 3.7 + t * 1.1);
  }

  class Orb {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.out = VizGL.program(gl, VizGL.SCREEN_VS, OUT_FS);
      this.lines = VizGL.lines(gl, (LON * LAT * 2 + RING + 200) * 6);
      this.turn = 0;
      this.age = 0;
      this.pts = new Float32Array(LON * LAT * 3);   // screen x, y and depth 0..1 (1 front)
      this.belt = new Float32Array(LAT);
      this.ring = [];
      for (let i = 0; i < RING; i += 1) {
        const band = Math.random() ** 1.5;
        this.ring.push({ a: Math.random() * Math.PI * 2, r: 1.62 + band * 0.32, y: (Math.random() - 0.5) * 0.025, v: 0.25 + Math.random() * 0.25, s: Math.random() });
      }
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.a, this.qa, this.qb, this.ea, this.eb]) VizGL.freeTarget(gl, t);
      this.a = VizGL.target(gl, w, h);
      const q = (d) => [Math.max(1, Math.round(w / d)), Math.max(1, Math.round(h / d))];
      this.qa = VizGL.target(gl, ...q(3));
      this.qb = VizGL.target(gl, ...q(3));
      this.ea = VizGL.target(gl, ...q(8));
      this.eb = VizGL.target(gl, ...q(8));
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      const spin = set('obSpin') / 100;
      this.turn += dt * spin * (0.25 + 0.5 * a.mid) * (a.playing ? 1 : 0.4);
      const t = this.age;
      const w = this.w;
      const h = this.h;
      const cx = w / 2;
      const cy = h / 2;
      const R = h * 0.24 * (1 + 0.08 * a.kick);
      const f = 3.2;   // the eye this many radii away
      const tilt = 0.42 + 0.12 * Math.sin(t * 0.13);
      const cy1 = Math.cos(this.turn);
      const sy1 = Math.sin(this.turn);
      const cx1 = Math.cos(tilt);
      const sx1 = Math.sin(tilt);
      const project = (x, y, z, out, k) => {
        // Turned about the upright, then tipped towards the eye.
        const x1 = x * cy1 + z * sy1;
        const z1 = -x * sy1 + z * cy1;
        const y2 = y * cx1 - z1 * sx1;
        const z2 = y * sx1 + z1 * cx1;
        const s = f / (f - z2);
        out[k] = cx + x1 * R * s;
        out[k + 1] = cy - y2 * R * s;
        out[k + 2] = (z2 + 1.6) / 3.2;
      };

      // Each belt's swelling: its band of the spectrum, the bass round the middle.
      const bands = a.dynamic;
      const nb = bands.length;
      for (let j = 0; j < LAT; j += 1) {
        const lat = Math.abs(j / (LAT - 1) - 0.5) * 2;      // 0 at the middle, 1 at the poles
        const f2 = Math.min(nb - 1, lat * nb * 0.85);
        const lo = Math.floor(f2);
        const v = bands[lo] * (1 - (f2 - lo)) + bands[Math.min(nb - 1, lo + 1)] * (f2 - lo);
        this.belt[j] += (v - this.belt[j]) * (1 - Math.exp(-dt / 0.06));
      }
      const pts = this.pts;
      for (let j = 0; j < LAT; j += 1) {
        const phi = (j / (LAT - 1)) * Math.PI;
        const sp = Math.sin(phi);
        const cp = Math.cos(phi);
        for (let i = 0; i < LON; i += 1) {
          const th = (i / LON) * Math.PI * 2;
          const x = sp * Math.cos(th);
          const z = sp * Math.sin(th);
          const y = cp;
          const r = 1 + 0.55 * this.belt[j] * (0.55 + 0.45 * wobble(x, y, z, t)) + 0.04 * wobble(x * 2, y * 2, z * 2, t * 1.5);
          project(x * r, y * r, z * r, pts, (j * LON + i) * 3);
        }
      }

      const palette = set('obColors');
      const pal = PALETTES[palette];
      const colour = (j, depth) => {
        const x = j / (LAT - 1);
        if (palette === 'rainbow') return hsv((x * 0.8 + t * 0.03) % 1, 0.7, 1);
        const m = Math.abs(x - 0.5) * 2;
        return [0, 1, 2].map((c) => pal[0][c] + (pal[1][c] - pal[0][c]) * m);
      };
      const lines = this.lines;
      const unit = h / 1080;
      const wire = set('obStyle') === 'wire';
      for (let j = 0; j < LAT; j += 1) {
        // Towards the poles the grid crowds together: there each point counts less.
        const thin = Math.sin((j / (LAT - 1)) * Math.PI) ** 0.8;
        for (let i = 0; i < LON; i += 1) {
          if (!wire && thin < 0.35 && i % 3) continue;
          const k = (j * LON + i) * 3;
          const depth = pts[k + 2];
          const bright = (0.12 + 0.88 * depth * depth) * (wire ? 0.4 + 0.6 * thin : Math.max(0.35, thin));
          const rgb = colour(j, depth);
          if (wire) {
            const kr = (j * LON + (i + 1) % LON) * 3;
            lines.seg(pts[k], pts[k + 1], pts[kr], pts[kr + 1], 0.9 * unit, rgb, bright * 0.5);
            if (j < LAT - 1) {
              const kd = ((j + 1) * LON + i) * 3;
              lines.seg(pts[k], pts[k + 1], pts[kd], pts[kd + 1], 0.9 * unit, rgb, bright * 0.5);
            }
          } else {
            lines.dot(pts[k], pts[k + 1], (1.2 + 1.6 * depth) * unit * (1 + this.belt[j]), rgb, bright * 0.85);
          }
        }
      }

      // The ring of sparks, going round.
      if (set('obRing')) {
        const out = [0, 0, 0];
        const ringRgb = palette === 'rainbow' ? [1, 1, 1] : pal[0];
        for (const s of this.ring) {
          s.a += dt * s.v * (0.3 + 1.6 * a.treble) * (a.playing ? 1 : 0.3);
          const r = s.r * (1 + 0.1 * a.kick);
          project(Math.cos(s.a) * r, s.y, Math.sin(s.a) * r, out, 0);
          const bright = (0.2 + 0.8 * out[2]) * (0.5 + 0.8 * a.treble) * (0.6 + 0.4 * Math.sin(t * 3 + s.s * 20));
          lines.dot(out[0], out[1], (1 + 1.4 * out[2]) * unit, ringRgb, Math.min(1, bright));
        }
      }

      const gl = this.gl;
      VizGL.into(gl, this.a);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      lines.draw(w, h);
      gl.disable(gl.BLEND);
      VizGL.blur(gl, this.a, this.qa, this.qb, 1.3);
      VizGL.blur(gl, this.qb, this.ea, this.eb, 2);
      VizGL.into(gl, null);
      gl.useProgram(this.out.p);
      const u = this.out.u;
      VizGL.bind(gl, u.light, this.a.tex, 0);
      VizGL.bind(gl, u.glowA, this.qb.tex, 1);
      VizGL.bind(gl, u.glowB, this.eb.tex, 2);
      gl.uniform2f(u.res, w, h);
      const tint = palette === 'rainbow' ? [0.6, 0.4, 1] : pal[1];
      gl.uniform3f(u.tint, ...tint);
      gl.uniform1f(u.pulse, a.kick);
      gl.uniform1f(u.time, t);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'orb',
    name: 'Orb',
    desc: 'A sphere of light the music pushes out of shape, the bass round its middle and the highs at its poles, a ring of sparks around it',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="6"/><ellipse cx="12" cy="12" rx="10.5" ry="3"/></svg>',
    gl: true,
    create: (canvas) => new Orb(canvas),
    options: [
      { type: 'choice', key: 'obStyle', label: 'Surface', choices: [['dots', 'Dots'], ['wire', 'Wireframe']] },
      { type: 'choice', key: 'obColors', label: 'Colors', choices: [['aurora', 'Aurora'], ['ember', 'Ember'], ['ice', 'Ice'], ['rainbow', 'Rainbow'], ['white', 'White']] },
      { type: 'slider', key: 'obSpin', label: 'Turning', min: 0, max: 200, step: 5 },
      { type: 'check', key: 'obRing', label: 'Ring' },
    ],
  });
})();
