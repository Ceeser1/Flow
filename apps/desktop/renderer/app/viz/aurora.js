'use strict';

// Aurora: the northern lights over dark mountains and a still lake. Curtains
// of light hang across the sky, rippling and drifting, made of fine rays;
// across the sky each part of a curtain belongs to a band of the spectrum
// (the bass in the middle) and glows with it, the music's intensity sets how
// restless they are, and the kicks make them flare. The lake mirrors it all,
// broken by small waves.
//
// Its cogwheel: the colours (green, the rarer red and violet, rainbow), how
// restless, the lake, the stars.
//
// WebGL (viz/gl.js): one pass over the screen; below the horizon each pixel
// works out the sky again where it would be mirrored.

(() => {
  const PALETTES = {
    // low edge, top
    green: [[0.15, 1.0, 0.45], [0.55, 0.2, 0.9]],
    red: [[1.0, 0.25, 0.35], [0.5, 0.1, 0.8]],
    violet: [[0.55, 0.45, 1.0], [1.0, 0.3, 0.75]],
    rainbow: [[0.2, 1.0, 0.6], [1.0, 0.3, 0.5]],
  };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D bands;
    uniform vec2 res;
    uniform float time, drift, flare, lake, stars, rainbow;
    uniform vec3 low, high;
    out vec4 o;

    const float HORIZON = 0.3;

    float ridge(float x) {
      return HORIZON + 0.012 + 0.09 * max(0.0, fbm(vec2(x * 1.4 + 2.0, 1.3)) - 0.3) + 0.012 * vnoise(vec2(x * 11.0, 4.0));
    }

    vec3 sky(vec2 p, float aspect) {
      float x = p.x * aspect;
      vec3 col = mix(vec3(0.01, 0.02, 0.05), vec3(0.0, 0.004, 0.02), smoothstep(HORIZON, 1.0, p.y));
      if (stars > 0.0) {
        vec2 g = floor(p * vec2(aspect, 1.0) * 380.0);
        float h = hash12(g);
        if (h > 0.997) col += vec3(0.75) * (h - 0.997) / 0.003 * (0.6 + 0.4 * sin(time * 2.0 + h * 60.0)) * smoothstep(HORIZON, HORIZON + 0.2, p.y);
      }
      // Three curtains, one behind the other.
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        // The curtain's lower edge folds and waves across the sky.
        float base = 0.44 + fi * 0.08 + 0.07 * sin(x * (1.3 + fi * 0.4) + drift * (0.5 + fi * 0.2) + fi * 2.0)
          + 0.14 * (fbm(vec2(x * 0.7 + fi * 3.7 + drift * 0.4, fi + drift * 0.1)) - 0.5);
        float d = p.y - base;
        float tall = 0.2 + 0.08 * fi;
        {
          // Fine rays, drifting along, leaning a little as they rise.
          float rx = x + d * 0.25;
          float rays = vnoise(vec2(rx * 70.0 + fi * 13.0 + drift * 3.0, fi)) * 0.6 + vnoise(vec2(rx * 23.0 - drift * 1.3, fi + 5.0)) * 0.6;
          rays = pow(rays, 1.8);
          float profile = smoothstep(-0.02, 0.012, d) * exp(-max(d, 0.0) / (tall * 0.35));
          float level = texture(bands, vec2(clamp(abs(p.x - 0.5) * 2.0, 0.0, 1.0) * 0.85 + 0.02, 0.5)).r;
          float glow = profile * (0.2 + rays) * (0.15 + 1.4 * level + 0.6 * flare) * (1.0 - fi * 0.25);
          vec3 c = mix(low, high, smoothstep(0.0, tall, d));
          if (rainbow > 0.5) c = hsv2rgb(vec3(fract(x * 0.12 + drift * 0.03 + fi * 0.2), 0.7, 1.0));
          col += c * glow * 0.75;
          // Its light on the air below the curtain's edge.
          col += low * exp(min(d, 0.0) * 30.0) * 0.04 * (0.3 + level) * step(d, 0.0);
        }
      }
      return col;
    }

    void main() {
      float aspect = res.x / res.y;
      vec2 p = uv;
      vec3 col;
      if (p.y >= HORIZON || lake < 0.5) {
        col = sky(p, aspect);
      } else {
        // The lake: the sky mirrored, broken by small waves, darker.
        float depth = (HORIZON - p.y) / HORIZON;
        float wave = (vnoise(vec2(p.x * aspect * 40.0, p.y * 260.0 - time * 0.8)) - 0.5) * 0.012 * (0.3 + depth);
        vec2 m = vec2(p.x + wave, 2.0 * HORIZON - p.y + wave * 0.5);
        col = sky(m, aspect) * (0.55 - 0.25 * depth);
        col += vec3(0.0, 0.01, 0.02);
      }
      // The mountains, black against the sky, a little of the aurora's light on their snow.
      float top = ridge(p.x * aspect);
      float mirrored = 2.0 * HORIZON - ridge(p.x * aspect);
      if ((p.y < top && p.y > HORIZON) || (lake < 0.5 && p.y < top)) {
        float snow = smoothstep(top - 0.03, top, p.y) * 0.5;
        col = vec3(0.006, 0.008, 0.014) + low * snow * 0.04;
      } else if (lake > 0.5 && p.y < HORIZON && p.y > mirrored) {
        col = vec3(0.003, 0.005, 0.01);
      }
      col = 1.0 - exp(-col * 1.4);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Aurora {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.bandTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.levels = null;
      this.bytes = null;
      this.drift = Math.random() * 50;
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
      const n = a.BANDS;
      if (!this.levels) {
        this.levels = new Float32Array(n);
        this.bytes = new Uint8Array(n);
      }
      // Slower to fall than the bars: light that lingers.
      for (let i = 0; i < n; i += 1) {
        const v = 0.5 * a.smooth[i] + 0.5 * a.dynamic[i];
        this.levels[i] = v > this.levels[i] ? this.levels[i] + (v - this.levels[i]) * Math.min(1, dt * 12) : this.levels[i] + (v - this.levels[i]) * Math.min(1, dt * 1.5);
        this.bytes[i] = Math.round(Math.min(1, this.levels[i]) * 255);
      }
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, n, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this.bytes);

      const restless = set('auActivity') / 100;
      this.drift += dt * restless * (0.08 + 0.5 * a.intensity + 0.3 * a.level) * (a.playing ? 1 : 0.4);
      const pal = PALETTES[set('auColors')] || PALETTES.green;
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.bands, this.bandTex, 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.drift, this.drift);
      gl.uniform1f(u.flare, a.kick);
      gl.uniform1f(u.lake, set('auLake') ? 1 : 0);
      gl.uniform1f(u.stars, set('auStars') ? 1 : 0);
      gl.uniform1f(u.rainbow, set('auColors') === 'rainbow' ? 1 : 0);
      gl.uniform3f(u.low, ...pal[0]);
      gl.uniform3f(u.high, ...pal[1]);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'aurora',
    name: 'Aurora',
    desc: 'The northern lights over mountains and a still lake, the curtains glowing with the music',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 10c3-4 6 2 9-2s6 1 9-3M3 14c3-3 6 2 9-1s6 1 9-2"/><path d="M2 21l5-5 3 3 4-5 8 7"/></svg>',
    gl: true,
    create: (canvas) => new Aurora(canvas),
    options: [
      { type: 'choice', key: 'auColors', label: 'Colors', choices: [['green', 'Green'], ['red', 'Red'], ['violet', 'Violet'], ['rainbow', 'Rainbow']] },
      { type: 'slider', key: 'auActivity', label: 'Restless', min: 25, max: 300, step: 5 },
      { type: 'check', key: 'auLake', label: 'Lake' },
      { type: 'check', key: 'auStars', label: 'Stars' },
    ],
  });
})();
