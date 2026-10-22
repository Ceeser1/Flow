'use strict';

// Orb: a sphere of light that the music pushes out of shape. Its surface is a
// grid of points, each band of the spectrum swelling one belt of it (the bass
// round the middle, the highs towards the poles), stirred by slow noise so it
// moves like something alive; it turns, swells on the kicks, and a ring of
// sparks circles it, quickening with the highs.
//
// Its cogwheel: dots or a wireframe, the colours (aurora, rainbow, its own),
// how fast it turns, the ring,
// and whether the view zooms in on the kicks (and how far).
//
// WebGL (viz/gl.js): the points or lines as light into a texture, that
// blurred twice for the glow, the background and both together in one pass.

(() => {
  const LON = 72;
  const LAT = 40;
  const RING = 700;
  const PALETTES = {
    aurora: [[0.2, 1, 0.85], [0.55, 0.35, 1]],
  };

  // The dots: round points of light, a solid disc with a smooth edge (a
  // pixel wide, so even a small one is round) and a soft halo round it,
  // HALO times their radius wide.
  const HALO = 7;
  const DOT_VS = `
    layout(location = 0) in vec2 pos;
    layout(location = 1) in vec4 color;
    layout(location = 2) in float radius;
    uniform vec2 res;
    out vec4 c;
    out float r;
    void main() {
      c = color;
      r = radius;
      gl_Position = vec4(pos.x / res.x * 2.0 - 1.0, 1.0 - pos.y / res.y * 2.0, 0.0, 1.0);
      gl_PointSize = radius * 2.0 * ${HALO}.0;
    }`;
  const DOT_FS = `
    in vec4 c;
    in float r;
    out vec4 o;
    void main() {
      // In radii from the middle, and in pixels.
      float q = length(gl_PointCoord - 0.5) * 2.0 * ${HALO}.0;
      float d = q * r;
      float disc = clamp(0.75 * r - d + 0.5, 0.0, 1.0) * (0.75 + 0.25 * exp(-q * q * 1.5));
      float f = 0.6 * disc + 0.07 * exp(-q * 0.9) * (1.0 - q / ${HALO}.0);
      f = max(f, 0.0) * c.a;
      o = vec4(c.rgb * f, f);
    }`;

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
  // The surface's wobble at a point x, y, z at time t:
  //   sin(x * 2.1 + t * 0.9) * sin(y * 2.7 - t * 0.7) * sin(z * 1.9 + t * 0.5)
  //   + 0.5 * sin(x * 4.3 + y * 3.1 - t * 1.3) * sin(z * 3.7 + t * 1.1),
  // each sine from its point's part (waves, from q + o) and the frame's
  // (turns, from o), sine and cosine each: sin(a + b) = sin a cos b + cos a sin b.
  function wobble(waves, turns, q, o) {
    const s0 = waves[q + o] * turns[o + 1] + waves[q + o + 1] * turns[o];
    const s1 = waves[q + o + 2] * turns[o + 3] + waves[q + o + 3] * turns[o + 2];
    const s2 = waves[q + o + 4] * turns[o + 5] + waves[q + o + 5] * turns[o + 4];
    const s3 = waves[q + o + 6] * turns[o + 7] + waves[q + o + 7] * turns[o + 6];
    const s4 = waves[q + o + 8] * turns[o + 9] + waves[q + o + 9] * turns[o + 8];
    return s0 * s1 * s2 + 0.5 * s3 * s4;
  }

  class Orb {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.out = VizGL.program(gl, VizGL.SCREEN_VS, OUT_FS);
      this.lines = VizGL.lines(gl, (LON * LAT * 2 + 200) * 6);
      this.dotProg = VizGL.program(gl, DOT_VS, DOT_FS);
      this.dotStream = VizGL.stream(gl, [[0, 2], [1, 4], [2, 1]], LON * LAT + RING);
      this.dotCount = 0;
      this.turn = 0;
      this.age = 0;
      this.pts = new Float32Array(LON * LAT * 3);   // screen x, y and depth 0..1 (1 front)
      this.belt = new Float32Array(LAT);
      // The grid's points on the unit sphere (x, y, z), the same every frame.
      this.unit = new Float64Array(LON * LAT * 3);
      for (let j = 0; j < LAT; j += 1) {
        const phi = (j / (LAT - 1)) * Math.PI;
        const sp = Math.sin(phi);
        const cp = Math.cos(phi);
        for (let i = 0; i < LON; i += 1) {
          const th = (i / LON) * Math.PI * 2;
          const k = (j * LON + i) * 3;
          this.unit[k] = sp * Math.cos(th);
          this.unit[k + 1] = cp;
          this.unit[k + 2] = sp * Math.sin(th);
        }
      }
      // wobble's angles at each point (twice: as it is asked at the point
      // and at twice it), their sines and cosines, so a frame only turns
      // them on by its time: sin(a + b) = sin a cos b + cos a sin b.
      this.waves = new Float64Array(LON * LAT * 20);
      for (let p = 0; p < LON * LAT; p += 1) {
        for (let n = 0; n < 2; n += 1) {
          const x = this.unit[p * 3] * (n + 1);
          const y = this.unit[p * 3 + 1] * (n + 1);
          const z = this.unit[p * 3 + 2] * (n + 1);
          const angles = [x * 2.1, y * 2.7, z * 1.9, x * 4.3 + y * 3.1, z * 3.7];
          for (let m = 0; m < 5; m += 1) {
            this.waves[p * 20 + n * 10 + m * 2] = Math.sin(angles[m]);
            this.waves[p * 20 + n * 10 + m * 2 + 1] = Math.cos(angles[m]);
          }
        }
      }
      this.turns = new Float64Array(20);
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

    /** A round dot of light at x, y (pixels), `radius` its core. */
    _dot(x, y, radius, rgb, a) {
      if (this.dotCount >= LON * LAT + RING) return;
      const d = this.dotStream.data;
      const k = this.dotCount * 7;
      d[k] = x;
      d[k + 1] = y;
      d[k + 2] = rgb[0];
      d[k + 3] = rgb[1];
      d[k + 4] = rgb[2];
      d[k + 5] = a;
      d[k + 6] = radius;
      this.dotCount += 1;
    }

    _drawDots(w, h) {
      if (!this.dotCount) return;
      const gl = this.gl;
      gl.useProgram(this.dotProg.p);
      gl.uniform2f(this.dotProg.u.res, w, h);
      this.dotStream.put(this.dotCount);
      gl.drawArrays(gl.POINTS, 0, this.dotCount);
      gl.bindVertexArray(null);
      this.dotCount = 0;
    }

    /**
     * Each point pushed out by its belt's swelling and the wobble, then
     * projected (into pts). A method of its own, so that wobble is inlined
     * here and its numbers are not boxed on the way out.
     */
    _swell(project) {
      const pts = this.pts;
      const unitPts = this.unit;
      const waves = this.waves;
      const turns = this.turns;
      for (let j = 0; j < LAT; j += 1) {
        for (let i = 0; i < LON; i += 1) {
          const u = (j * LON + i) * 3;
          const x = unitPts[u];
          const y = unitPts[u + 1];
          const z = unitPts[u + 2];
          const q = (j * LON + i) * 20;
          const r = 1 + 0.55 * this.belt[j] * (0.55 + 0.45 * wobble(waves, turns, q, 0)) + 0.04 * wobble(waves, turns, q, 10);
          project(x * r, y * r, z * r, pts, (j * LON + i) * 3);
        }
      }
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
      // How far it zooms on the kicks: 80% as it first was.
      const zoom = set('obZoom') ? a.kick * (set('obZoomAmount') / 80) : 0;
      const R = h * 0.24 * (1 + 0.08 * zoom);
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
      // The wobble at the point and at twice it (t * 1.5): its waves' time
      // parts (sine, cosine) for this frame.
      const turns = this.turns;
      for (let n = 0; n < 2; n += 1) {
        const tt = n ? t * 1.5 : t;
        const by = [tt * 0.9, -tt * 0.7, tt * 0.5, -tt * 1.3, tt * 1.1];
        for (let m = 0; m < 5; m += 1) {
          turns[n * 10 + m * 2] = Math.sin(by[m]);
          turns[n * 10 + m * 2 + 1] = Math.cos(by[m]);
        }
      }
      this._swell(project);

      const palette = set('obColors');
      let pal = PALETTES[palette] || PALETTES.aurora;
      if (palette === 'custom') {
        // Its own colour round the middle, paler and darker towards the poles.
        const c = VizGL.rgb(set('obColor'));
        pal = [c, c.map((v) => (v * 0.55 + 0.45) * 0.85)];
      }
      // A belt's colour (the same for all its points: worked out once a belt).
      const rgb = [0, 0, 0];
      const colour = (j) => {
        const x = j / (LAT - 1);
        if (palette === 'rainbow') return hsv((x * 0.8 + t * 0.03) % 1, 0.7, 1);
        const m = Math.abs(x - 0.5) * 2;
        for (let c = 0; c < 3; c += 1) rgb[c] = pal[0][c] + (pal[1][c] - pal[0][c]) * m;
        return rgb;
      };
      const lines = this.lines;
      const unit = h / 1080;
      const wire = set('obStyle') === 'wire';
      for (let j = 0; j < LAT; j += 1) {
        // Towards the poles the grid crowds together: there each point counts less.
        const thin = Math.sin((j / (LAT - 1)) * Math.PI) ** 0.8;
        const col = colour(j);
        for (let i = 0; i < LON; i += 1) {
          if (!wire && thin < 0.35 && i % 3) continue;
          const k = (j * LON + i) * 3;
          const depth = pts[k + 2];
          const bright = (0.12 + 0.88 * depth * depth) * (wire ? 0.4 + 0.6 * thin : Math.max(0.35, thin));
          if (wire) {
            const kr = (j * LON + (i + 1) % LON) * 3;
            lines.seg(pts[k], pts[k + 1], pts[kr], pts[kr + 1], 0.9 * unit, col, bright * 0.5);
            if (j < LAT - 1) {
              const kd = ((j + 1) * LON + i) * 3;
              lines.seg(pts[k], pts[k + 1], pts[kd], pts[kd + 1], 0.9 * unit, col, bright * 0.5);
            }
          } else {
            this._dot(pts[k], pts[k + 1], (1.2 + 1.6 * depth) * unit * (1 + this.belt[j]), col, bright);
          }
        }
      }

      // The ring of sparks, going round.
      if (set('obRing')) {
        const out = [0, 0, 0];
        const ringRgb = palette === 'rainbow' ? [1, 1, 1] : pal[0];
        for (const s of this.ring) {
          s.a += dt * s.v * (0.3 + 1.6 * a.treble) * (a.playing ? 1 : 0.3);
          const r = s.r * (1 + 0.1 * zoom);
          project(Math.cos(s.a) * r, s.y, Math.sin(s.a) * r, out, 0);
          const bright = (0.2 + 0.8 * out[2]) * (0.5 + 0.8 * a.treble) * (0.6 + 0.4 * Math.sin(t * 3 + s.s * 20));
          this._dot(out[0], out[1], (1 + 1.4 * out[2]) * unit, ringRgb, Math.min(1, bright));
        }
      }

      const gl = this.gl;
      VizGL.into(gl, this.a);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      lines.draw(w, h);
      this._drawDots(w, h);
      gl.disable(gl.BLEND);
      // The glow: the light made smaller by averaging (so each dot's share
      // is kept, not caught by one pixel and drawn back as a square), then
      // blurred; the wide one twice, from that.
      VizGL.shrink(gl, this.a, this.qb);
      VizGL.blur(gl, this.qb, this.qa, this.qb, 1.3);
      VizGL.blur(gl, this.qb, this.qa, this.qb, 1.3);
      VizGL.shrink(gl, this.qb, this.eb);
      VizGL.blur(gl, this.eb, this.ea, this.eb, 2);
      VizGL.blur(gl, this.eb, this.ea, this.eb, 2);
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
    // At the screen's own pixels, so the dots are round, not blown up.
    sharp: true,
    create: (canvas) => new Orb(canvas),
    options: [
      { type: 'choice', key: 'obStyle', label: 'Surface', choices: [['dots', 'Dots'], ['wire', 'Wireframe']] },
      { type: 'choice', key: 'obColors', label: 'Colors', choices: [['aurora', 'Aurora'], ['rainbow', 'Rainbow']], color: { value: 'custom', key: 'obColor', presets: Visualizer.OWN_PRESETS } },
      { type: 'slider', key: 'obSpin', label: 'Turning', min: 0, max: 200, step: 5 },
      { type: 'check', key: 'obRing', label: 'Ring' },
      { type: 'check', key: 'obZoom', label: 'Bass Zoom', amount: { key: 'obZoomAmount', min: 0, max: 100, step: 5 } },
    ],
  });
})();
