'use strict';

// Lava: glossy liquid blobs drifting, meeting and melting into each other, as
// in a lava lamp. Each blob carries a part of the spectrum (the big slow ones
// the bass, the small quick ones the highs) and swells with it; the kicks
// make them all bulge, and they rise and sink as the warm wax does.
//
// Its cogwheel: the colours (lava, neon, ocean, candy, chrome), how many
// blobs, how fast they drift, the gloss.
//
// WebGL (viz/gl.js): one pass over the screen summing each blob's field;
// where it is strong enough is liquid, its slope gives the surface's tilt for
// the light, so it shines like wax.

(() => {
  const MAX = 16;
  const PALETTES = {
    // background, liquid deep, liquid bright, light
    lava: [[0.09, 0.02, 0.1], [0.75, 0.08, 0.05], [1, 0.6, 0.1], [1, 0.9, 0.7]],
    neon: [[0.02, 0.01, 0.06], [0.45, 0.0, 0.9], [0.0, 0.95, 1], [1, 1, 1]],
    ocean: [[0.0, 0.04, 0.08], [0.0, 0.25, 0.55], [0.1, 0.85, 0.8], [0.85, 1, 1]],
    candy: [[0.1, 0.04, 0.1], [1, 0.25, 0.6], [1, 0.8, 0.35], [1, 1, 1]],
    chrome: [[0.03, 0.03, 0.04], [0.25, 0.27, 0.32], [0.85, 0.88, 0.95], [1, 1, 1]],
  };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform vec4 blobs[${MAX}];   // x, y (0..1 of the height, x across the width), radius, glow
    uniform int count;
    uniform vec3 bg, deep, bright, light;
    uniform float gloss, time;
    out vec4 o;
    void main() {
      vec2 p = vec2(uv.x * res.x / res.y, uv.y);
      float f = 0.0;
      vec2 grad = vec2(0.0);
      float heat = 0.0;
      for (int i = 0; i < ${MAX}; i++) {
        if (i >= count) break;
        vec4 b = blobs[i];
        vec2 d = p - b.xy;
        float dd = dot(d, d) + 1e-4;
        float k = b.z * b.z / dd;
        f += k;
        grad += -2.0 * k / dd * d;
        heat += k * b.w;
      }
      // The surface where the field reaches 1, soft over a pixel or two.
      float edge = fwidth(f) * 1.2;
      float inside = smoothstep(1.0 - edge, 1.0 + edge, f);
      // Its tilt: the slope of 1 - 1/f, which is 0 at the surface and levels
      // off inside, so each blob is a dome (the field's own slope would dimple
      // at every middle).
      vec3 n = normalize(vec3(-grad / max(f * f, 0.04) * 0.05, 1.0));
      vec3 l = normalize(vec3(-0.45, 0.6, 0.65));
      float diff = max(dot(n, l), 0.0);
      float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 40.0) * gloss;
      float rim = pow(1.0 - n.z, 2.0);
      float t = clamp(heat / max(f, 1e-3), 0.0, 1.0);
      vec3 liquid = mix(deep, bright, clamp(0.25 + 0.75 * t, 0.0, 1.0)) * (0.35 + 0.75 * diff) + light * spec + bright * rim * 0.35;
      // A warm glow round the blobs in the dark.
      vec3 col = bg * (1.0 - 0.5 * length(uv - 0.5)) + deep * smoothstep(0.25, 1.0, f) * 0.35;
      col = mix(col, liquid, inside);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Lava {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.blobs = [];
      for (let i = 0; i < MAX; i += 1) {
        // The first are big and slow (bass), the later small and quick (highs).
        const k = i / (MAX - 1);
        this.blobs.push({
          k,
          base: 0.11 - 0.06 * k,
          fx: 0.05 + Math.random() * 0.08 + 0.1 * k,
          fy: 0.04 + Math.random() * 0.07 + 0.08 * k,
          px: Math.random() * 6.3,
          py: Math.random() * 6.3,
          r: 0.1,
          level: 0,
        });
      }
      this.data = new Float32Array(MAX * 4);
      this.time = 0;
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
      const count = Math.max(3, Math.min(MAX, Number(set('lvBlobs'))));
      const speed = set('lvSpeed') / 100;
      this.time += dt * speed * (a.playing ? 0.6 + 0.8 * a.level : 0.25);
      const aspect = this.w / this.h;
      const bands = a.dynamic;
      const nb = bands.length;
      for (let i = 0; i < count; i += 1) {
        const b = this.blobs[i];
        // Its share of the spectrum: blob 0 the lowest.
        const from = Math.floor((i / count) * nb * 0.85);
        const to = Math.max(from + 1, Math.floor(((i + 1) / count) * nb * 0.85));
        let v = 0;
        for (let j = from; j < to; j += 1) v += bands[j];
        v /= to - from;
        b.level += (v - b.level) * (1 - Math.exp(-dt / 0.08));
        const t = this.time;
        // Rising and sinking like wax, swaying sideways.
        const x = 0.5 + 0.42 * Math.sin(t * b.fx * 6.3 + b.px) * (0.8 + 0.2 * Math.sin(t * 0.13 + i));
        const y = 0.5 + 0.4 * Math.sin(t * b.fy * 6.3 + b.py);
        b.r = b.base * (0.75 + 0.75 * b.level + 0.25 * a.kick);
        this.data[i * 4] = x * aspect;
        this.data[i * 4 + 1] = y;
        this.data[i * 4 + 2] = b.r;
        this.data[i * 4 + 3] = b.level;
      }

      const p = PALETTES[set('lvColors')] || PALETTES.lava;
      const gl = this.gl;
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform4fv(u.blobs, this.data);
      gl.uniform1i(u.count, count);
      gl.uniform3f(u.bg, ...p[0]);
      gl.uniform3f(u.deep, ...p[1]);
      gl.uniform3f(u.bright, ...p[2]);
      gl.uniform3f(u.light, ...p[3]);
      gl.uniform1f(u.gloss, set('lvGloss') ? 1 : 0.15);
      gl.uniform1f(u.time, this.age);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'lava',
    name: 'Lava',
    desc: 'Glossy liquid blobs drifting and melting into each other as in a lava lamp, each swelling with its part of the music',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l2 8-2 10H9L7 11z"/><circle cx="12" cy="9" r="1.6"/><path d="M10 15a2 2 0 0 0 4 0"/></svg>',
    gl: true,
    create: (canvas) => new Lava(canvas),
    options: [
      { type: 'choice', key: 'lvColors', label: 'Colors', choices: [['lava', 'Lava'], ['neon', 'Neon'], ['ocean', 'Ocean'], ['candy', 'Candy'], ['chrome', 'Chrome']] },
      { type: 'slider', key: 'lvBlobs', label: 'Blobs', min: 4, max: 16, step: 1, unit: '' },
      { type: 'slider', key: 'lvSpeed', label: 'Drift', min: 25, max: 300, step: 5 },
      { type: 'check', key: 'lvGloss', label: 'Gloss' },
    ],
  });
})();
