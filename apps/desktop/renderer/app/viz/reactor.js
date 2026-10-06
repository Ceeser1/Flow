'use strict';

// Reactor: a heads-up display of concentric rings, as on a starship's
// console. Each ring is cut into segments and is a level meter for one part
// of the spectrum (the bass inside, the highs outside), lighting up from the
// top round both sides as loud as its part is, a peak segment hanging above;
// the rings turn, every other one the other way, faster with the music; the
// core glows with the bass and flashes on the kicks; the outermost ring
// traces the waveform, and fine ticks and markers sit between.
//
// Its cogwheel: the colour, how many rings, how fast they turn.
//
// WebGL (viz/gl.js): one pass over the screen in polar coordinates; the
// rings' levels and peaks, their turning and the waveform come as small
// textures and uniforms.

(() => {
  const MAX_RINGS = 16;
  const WAVE = 256;
  const PRESETS = ['#38e8ff', '#ffb02e', '#ff3b5c', '#58ff8a', '#c77dff', '#ffffff'];

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D wave;
    uniform vec2 res;
    uniform float rings, time, core, flash;
    uniform vec3 color;
    uniform vec4 ring[${MAX_RINGS}];   // level, peak, turn, segments
    out vec4 o;
    const float PI = 3.14159265;
    void main() {
      // Scaled so the waveform round the outside stays on the screen.
      const float FIT = 1.18;
      vec2 p = (uv - 0.5) * vec2(res.x / res.y, 1.0) * FIT;
      float r = length(p);
      float a = atan(p.x, p.y);                 // 0 at the top, -PI..PI
      float px = FIT / res.y;
      vec3 col = vec3(0.0);
      float r0 = 0.11, r1 = 0.43;
      float dr = (r1 - r0) / rings;

      // The rings of segments.
      if (r > r0 && r < r1) {
        float fi = floor((r - r0) / dr);
        int i = int(fi);
        vec4 g = ring[i];
        float inner = r0 + fi * dr;
        float t = (r - inner) / dr;
        float band = smoothstep(0.12, 0.12 + px / dr * 1.5, t) * (1.0 - smoothstep(0.82 - px / dr * 1.5, 0.82, t));
        float turned = a + g.z;
        float seg = turned / (2.0 * PI) * g.w;
        float within = fract(seg);
        float gap = smoothstep(0.0, 0.08, within) * (1.0 - smoothstep(0.78, 0.86, within));
        // Lit from the top round both sides: how far round this segment's middle is.
        float mid = (floor(seg) + 0.5) / g.w * 2.0 * PI - g.z;
        float round = abs(mod(mid + PI, 2.0 * PI) - PI) / PI;   // 0 at the top, 1 at the bottom
        float lit = step(round, g.x);
        float peak = step(abs(round - g.y), 0.5 / g.w * 2.0) * step(0.02, g.y);
        float on = max(lit, peak);
        col += color * band * gap * (0.08 + 0.95 * on) * (0.75 + 0.25 * (1.0 - fi / rings));
        col += color * band * gap * peak * 0.5;
      }

      // Thin circles between, and ticks round the outside.
      float lines = 0.0;
      for (int k = 0; k < 3; k++) {
        float rr = k == 0 ? r0 - 0.012 : (k == 1 ? r1 + 0.012 : r1 + 0.075);
        lines += 1.0 - smoothstep(0.0, px * 1.4, abs(r - rr));
      }
      float tick = (1.0 - smoothstep(0.0, px * 1.5, abs(fract((a + time * 0.05) / (2.0 * PI) * 72.0 + 0.5) - 0.5) * (2.0 * PI * r / 72.0)))
        * step(r1 + 0.02, r) * step(r, r1 + 0.04);
      col += color * (lines * 0.35 + tick * 0.5);

      // The waveform round the outside.
      float wr = r1 + 0.075;
      float w = texture(wave, vec2(fract(a / (2.0 * PI) + 0.5), 0.5)).r * 2.0 - 1.0;
      float d = abs(r - (wr + w * 0.035));
      col += color * (1.0 - smoothstep(0.0, px * 2.0, d)) * 0.9 + color * exp(-d * 180.0) * 0.25;

      // The core.
      float c = exp(-r * r / (0.07 * 0.07)) * (0.4 + 1.2 * core) + flash * exp(-r * r / (0.12 * 0.12)) * 0.6;
      col += mix(color, vec3(1.0), 0.5) * c;
      col += color * 0.04 * exp(-r * 3.0);

      col = 1.0 - exp(-col * 1.3);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Reactor {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.waveTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.waveBytes = new Uint8Array(WAVE);
      this.data = new Float32Array(MAX_RINGS * 4);
      this.levels = new Float32Array(MAX_RINGS);
      this.peaks = new Float32Array(MAX_RINGS);
      this.fall = new Float32Array(MAX_RINGS);
      this.turns = new Float32Array(MAX_RINGS);
      this.age = 0;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      this.w = w;
      this.h = h;
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      const n = Math.max(4, Math.min(MAX_RINGS, Number(set('rxRings'))));
      const spin = set('rxSpin') / 100;
      const nb = a.BANDS;
      for (let i = 0; i < n; i += 1) {
        // Ring i: its share of the bands, 0 the lowest.
        const from = Math.floor((i / n) * nb * 0.88);
        const to = Math.max(from + 1, Math.floor(((i + 1) / n) * nb * 0.88));
        let v = 0;
        for (let j = from; j < to; j += 1) v += 0.4 * a.smooth[j] + 0.6 * a.dynamic[j];
        v = Math.min(1, v / (to - from));
        this.levels[i] = Math.max(v, this.levels[i] - dt * 1.8);
        if (this.levels[i] >= this.peaks[i]) {
          this.peaks[i] = this.levels[i];
          this.fall[i] = -0.4;   // hangs a moment
        } else {
          this.fall[i] += dt * 1.5;
          if (this.fall[i] > 0) this.peaks[i] = Math.max(this.levels[i], this.peaks[i] - this.fall[i] * dt);
        }
        this.turns[i] += dt * spin * (i % 2 ? -1 : 1) * (0.06 + 0.05 * (i % 3)) * (a.playing ? 0.6 + 1.2 * a.level : 0.2);
        this.data[i * 4] = this.levels[i];
        this.data[i * 4 + 1] = this.peaks[i];
        this.data[i * 4 + 2] = this.turns[i];
        this.data[i * 4 + 3] = 24 + i * 6;
      }
      const wave = a.lowWave(WAVE);
      for (let i = 0; i < WAVE; i += 1) {
        // Joined end to end round the circle, eased together at the seam.
        const edge = Math.min(1, i / 12, (WAVE - 1 - i) / 12);
        this.waveBytes[i] = Math.round((0.5 + 0.5 * wave[i] * edge * (a.playing ? 1 : 0)) * 255);
      }
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, WAVE, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this.waveBytes);

      const c = VizGL.rgb(set('rxColor'));
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.wave, this.waveTex, 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.rings, n);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.core, a.bass);
      gl.uniform1f(u.flash, a.kick);
      gl.uniform3f(u.color, c[0], c[1], c[2]);
      gl.uniform4fv(u.ring, this.data);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'reactor',
    name: 'Reactor',
    desc: "A starship's display of turning rings, each a level meter for its part of the spectrum, the core glowing with the bass",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M12 5a7 7 0 0 1 7 7M12 19a7 7 0 0 1-7-7M12 2a10 10 0 0 1 10 10M12 22A10 10 0 0 1 2 12"/></svg>',
    gl: true,
    create: (canvas) => new Reactor(canvas),
    options: [
      { type: 'color', key: 'rxColor', label: 'Color', presets: PRESETS },
      { type: 'slider', key: 'rxRings', label: 'Rings', min: 4, max: 16, step: 1, unit: '' },
      { type: 'slider', key: 'rxSpin', label: 'Turning', min: 0, max: 300, step: 5 },
    ],
  });
})();
