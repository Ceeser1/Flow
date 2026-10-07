'use strict';

// Aurora: the northern lights over dark mountains and a still lake. Three
// curtains of light hang across the sky, rippling and drifting, made of fine
// rays. Each listens to its own part of the music, low to high from left to
// right on a log axis (CURTAINS): the lowest the bass (to 400 Hz), the middle
// one the mids (to 2 kHz), the highest the highs. Where its part is loud the
// curtain glows brighter, and where it is louder than it just was its lower
// edge lifts a little (quieter: dips), easing back as it settles. The
// music's intensity sets how restless they are, and the kicks make them
// flare. Fir trees stand scattered over the hills, and the lake
// mirrors it all, broken by small waves.
//
// Its cogwheel: the colours (green, the rarer red and violet, rainbow), how
// restless, how high the curtains shine (Glare), the lake, the stars (faint and bright ones, each twinkling in its
// own time, the brightest with a glare flashing a little with the bass).
//
// WebGL (viz/gl.js): one pass over the screen; below the horizon each pixel
// works out the sky again where it would be mirrored.

(() => {
  // Each curtain's part of the music, lowest curtain first (Hz; VizAudio's
  // bands start at 30 Hz and end at 16 kHz).
  const CURTAINS = [[30, 400], [400, 2000], [2000, 16000]];
  const ACROSS = 64;       // levels across each curtain
  const LIFT = 0.02;       // the most the edge moves up or down, of the screen (the curtains are 0.08 apart)
  const LIFT_GAIN = 5;     // a level this many times its rise over its average
  const SETTLE_S = 1.2;    // the average each place is measured against
  const SHINE = 0.67;      // how high the curtains shine at Glare 100% (of what they first did)

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
    uniform float time, drift, flare, lake, stars, rainbow, lift, boom, shine;
    uniform vec3 low, high;
    out vec4 o;

    const float HORIZON = 0.3;

    float ridge(float x) {
      return HORIZON + 0.012 + 0.09 * max(0.0, fbm(vec2(x * 1.4 + 2.0, 1.3)) - 0.3) + 0.012 * vnoise(vec2(x * 11.0, 4.0));
    }

    // A star's twinkle: its own speed and moment, a little irregular; depth
    // is how far it dims.
    float twinkle(vec2 g, float depth) {
      float phase = hash12(g + 31.1) * 6.2831853;
      float speed = 1.2 + 4.0 * hash12(g + 41.7);
      float t = 0.5 + 0.3 * sin(time * speed + phase) + 0.2 * sin(time * speed * 2.37 + phase * 1.7);
      return 1.0 - depth * t;
    }

    // The stars at px (pixels): many faint ones a pixel across, and fewer
    // bright ones, larger, white to blue or warm, the brightest with a halo
    // and four thin spikes of glare.
    vec3 starField(vec2 px) {
      vec3 sum = vec3(0.0);
      {
        const float CELL = 5.0;
        vec2 g = floor(px / CELL);
        if (hash12(g + 11.3) > 0.955) {
          vec2 c = (g + 0.2 + 0.6 * vec2(hash12(g + 3.1), hash12(g + 7.7))) * CELL;
          vec2 d = px - c;
          float b = 0.1 + 0.3 * hash12(g + 5.2) * hash12(g + 8.8);
          sum += vec3(0.85, 0.9, 1.0) * b * twinkle(g, 0.6) * exp(-dot(d, d) / 0.45);
        }
      }
      // The bright ones look into the cells round about too: their glare
      // reaches past their own.
      const float BIG = 40.0;
      vec2 g0 = floor(px / BIG);
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 g = g0 + vec2(float(i), float(j));
          if (hash12(g + 23.9) < 0.8) continue;
          vec2 c = (g + 0.5 + 0.8 * (vec2(hash12(g + 1.7), hash12(g + 9.4)) - 0.5)) * BIG;
          vec2 d = px - c;
          // Most of them modest, a few brilliant.
          float m = pow(hash12(g + 4.4), 3.0);
          float r = 0.65 + 1.1 * m;
          float glow = exp(-dot(d, d) / (r * r));
          glow += 0.1 * m * exp(-length(d) / (2.0 + 4.0 * m));
          if (m > 0.5) {
            // Flashing a little with the bass.
            float reach = (3.0 + 8.0 * m) * (1.0 + 0.3 * boom);
            glow += 0.25 * m * (1.0 + 0.8 * boom) * (exp(-abs(d.y) / 0.45 - abs(d.x) / reach) + exp(-abs(d.x) / 0.45 - abs(d.y) / reach));
          }
          vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.88, 0.72), hash12(g + 6.6));
          sum += tint * (0.3 + 1.0 * m) * twinkle(g, 0.45) * glow;
        }
      }
      return sum;
    }

    vec3 sky(vec2 p, float aspect) {
      float x = p.x * aspect;
      vec3 col = mix(vec3(0.01, 0.02, 0.05), vec3(0.0, 0.004, 0.02), smoothstep(HORIZON, 1.0, p.y));
      if (stars > 0.0) col += starField(p * res) * smoothstep(HORIZON, HORIZON + 0.2, p.y);
      // Three curtains, one behind the other.
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        // Its part of the music here (a row each, low to high across): how
        // loud (r), and how much louder or quieter than it just was (g, 0.5
        // as before).
        vec2 heard = texture(bands, vec2(clamp(p.x, 0.0, 1.0), (fi + 0.5) / 3.0)).rg;
        float level = heard.r;
        // The curtain's lower edge folds and waves across the sky, lifted
        // where its part of the music rises.
        float base = 0.44 + fi * 0.08 + 0.07 * sin(x * (1.3 + fi * 0.4) + drift * (0.5 + fi * 0.2) + fi * 2.0)
          + 0.14 * (fbm(vec2(x * 0.7 + fi * 3.7 + drift * 0.4, fi + drift * 0.1)) - 0.5) + lift * (heard.g - 0.5) * 2.0;
        float d = p.y - base;
        float tall = (0.2 + 0.08 * fi) * shine;
        {
          // Fine rays, drifting along, leaning a little as they rise.
          float rx = x + d * 0.25;
          float rays = vnoise(vec2(rx * 70.0 + fi * 13.0 + drift * 3.0, fi)) * 0.6 + vnoise(vec2(rx * 23.0 - drift * 1.3, fi + 5.0)) * 0.6;
          rays = pow(rays, 1.8);
          float profile = smoothstep(-0.02, 0.012, d) * exp(-max(d, 0.0) / (tall * 0.35));
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

    // The fir trees on the hills, x across (screen heights) and y above the
    // shore, laid over col; top: the hill's height here, above the shore.
    // Seen from across the lake: DEPTHS rows going back, each further up the
    // hill (bunching towards its top, as far things do), smaller and hazier,
    // each tree a little higher or lower than its row, so they stand
    // scattered over the hillside from the water to near the top. In clusters
    // with clearings between, each its own size (a few larger all round, up
    // to three times the rest by the water, less so further back), in tiers
    // narrowing to the tip. Drawn from the back.
    const int DEPTHS = 5;
    // Value noise along a line, for the clusters (cheaper than vnoise).
    float noise1(float x) {
      float i = floor(x);
      float f = fract(x);
      return mix(hash12(vec2(i, 7.0)), hash12(vec2(i + 1.0, 7.0)), f * f * (3.0 - 2.0 * f));
    }
    vec3 forest(vec3 col, float x, float y, float top) {
      if (y < 0.0 || y > top + 0.08) return col;
      float edge = 1.2 / res.y;
      const float FAR = 1.0 / (1.0 + 0.7 * float(DEPTHS - 1));
      for (int row = DEPTHS - 1; row >= 0; row--) {
        float fr = float(row);
        float scale = 1.0 / (1.0 + 0.7 * fr);
        float back = (1.0 - scale) / (1.0 - FAR);      // 0 at the water, 1 the farthest
        float foot = top * 0.8 * back;
        vec3 shade = mix(vec3(0.0015, 0.002, 0.003), vec3(0.013, 0.017, 0.028), 0.7 * back);
        float tallest = 0.026 * scale;
        float w = 0.45 * tallest;
        float cell = floor(x / w);
        float cover = 0.0;
        // Nothing of this row reaches here.
        float spread = top * 0.075;
        float most = 3.0 - 1.6 * back;                 // the largest a tree here grows
        if (y < foot - spread || y > foot + spread + most * tallest) continue;
        for (int k = -2; k <= 2; k++) {
          // The cheap tests first: most trees do not reach this point.
          float c = cell + float(k);
          vec2 id = vec2(c, fr * 17.0);
          float cx = (c + 0.5 + 0.4 * (hash12(id + 8.2) - 0.5)) * w;
          // Most about the same, a few larger all round.
          float grow = 1.0 + (most - 1.0) * pow(hash12(id + 6.4), 6.0);
          float h = tallest * (0.55 + 0.45 * hash12(id + 5.1)) * grow;
          if (abs(x - cx) > h * 0.27 + edge) continue;
          float at = foot + (hash12(id + 2.6) - 0.5) * 2.0 * spread * (row == 0 ? 0.0 : 1.0);
          float t = (y - at) / h;
          if (t < 0.0 || t > 1.0 || at > top - 0.002) continue;
          // In a clearing, or not there anyway.
          float dense = smoothstep(0.3, 0.6, noise1((c + 0.5) * w * 6.0 + fr * 5.3));
          if (hash12(id + 3.3) > dense * 0.92) continue;
          float tiers = 4.0 + floor(3.0 * hash12(id + 9.9));
          float wide = h * 0.26 * (1.0 - t) * (0.62 + 0.38 * fract((1.0 - t) * tiers));
          if (t < 0.1) wide = max(wide, h * 0.025);   // the trunk
          cover = max(cover, smoothstep(-edge, edge, wide - abs(x - cx)) * smoothstep(-edge, edge, h - (y - at)));
        }
        col = mix(col, shade, cover);
      }
      return col;
    }

    void main() {
      float aspect = res.x / res.y;
      vec2 p = uv;
      vec3 col;
      float wave = 0.0;
      if (p.y >= HORIZON || lake < 0.5) {
        col = sky(p, aspect);
      } else {
        // The lake: the sky mirrored, broken by small waves, darker.
        float depth = (HORIZON - p.y) / HORIZON;
        wave = (vnoise(vec2(p.x * aspect * 40.0, p.y * 260.0 - time * 0.8)) - 0.5) * 0.012 * (0.3 + depth);
        vec2 m = vec2(p.x + wave, 2.0 * HORIZON - p.y + wave * 0.5);
        col = sky(m, aspect) * (0.55 - 0.25 * depth);
        col += vec3(0.0, 0.01, 0.02);
      }
      // The mountains, dark against the sky (a little hazy, being far), a
      // little of the aurora's light on their snow.
      float top = ridge(p.x * aspect);
      float mirrored = 2.0 * HORIZON - ridge(p.x * aspect);
      if ((p.y < top && p.y > HORIZON) || (lake < 0.5 && p.y < top)) {
        float snow = smoothstep(top - 0.03, top, p.y) * 0.5;
        col = vec3(0.013, 0.017, 0.028) + low * snow * 0.04;
      } else if (lake > 0.5 && p.y < HORIZON && p.y > mirrored) {
        // The low land barely shows in the water; what stands on it does.
        col = mix(col, vec3(0.006, 0.009, 0.016), 0.12);
      }
      // The trees in front, and mirrored in the lake, broken by its waves.
      if (p.y >= HORIZON) col = forest(col, p.x * aspect, p.y - HORIZON, top - HORIZON);
      else if (lake > 0.5) col = forest(col, (p.x + wave) * aspect, HORIZON - p.y + wave * 0.5, top - HORIZON);
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
      this.levels = new Float32Array(3 * ACROSS);
      this.settled = new Float32Array(3 * ACROSS);   // each place's level, averaged over SETTLE_S
      this.bytes = new Uint8Array(3 * ACROSS * 2);    // level, rise
      this.raw = new Float32Array(ACROSS);
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
      this._listen(a, dt);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, ACROSS, 3, 0, gl.RG, gl.UNSIGNED_BYTE, this.bytes);

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
      gl.uniform1f(u.lift, LIFT);
      gl.uniform1f(u.boom, a.kick);
      gl.uniform1f(u.shine, SHINE * (set('auGlare') / 100));
      gl.uniform1f(u.lake, set('auLake') ? 1 : 0);
      gl.uniform1f(u.stars, set('auStars') ? 1 : 0);
      gl.uniform1f(u.rainbow, set('auColors') === 'rainbow' ? 1 : 0);
      gl.uniform3f(u.low, ...pal[0]);
      gl.uniform3f(u.high, ...pal[1]);
      VizGL.screen(gl);
    }

    /** Each curtain's levels across, from its part of VizAudio's bands, and their rises, into this.bytes. */
    _listen(a, dt) {
      const n = a.BANDS;
      const span = Math.log(a.MAX_HZ / a.MIN_HZ);
      const raw = this.raw;
      // Up fast, down slowly: light that lingers, an edge that sinks back.
      const up = Math.min(1, dt * 12);
      const down = Math.min(1, dt * 1.5);
      const settle = 1 - Math.exp(-dt / SETTLE_S);
      CURTAINS.forEach(([lo, hi], c) => {
        for (let k = 0; k < ACROSS; k += 1) {
          // The band (fractional) at this frequency: bands sit at
          // MIN_HZ * (MAX_HZ / MIN_HZ) ** ((i + 0.5) / n).
          const hz = lo * (hi / lo) ** ((k + 0.5) / ACROSS);
          const f = Math.max(0, Math.min(n - 1, (Math.log(hz / a.MIN_HZ) / span) * n - 0.5));
          const i = Math.min(n - 2, Math.floor(f));
          const t = f - i;
          const at = (j) => 0.5 * a.smooth[j] + 0.5 * a.dynamic[j];
          raw[k] = at(i) * (1 - t) + at(i + 1) * t;
        }
        for (let k = 0; k < ACROSS; k += 1) {
          // A little of the neighbours, so the edge billows rather than jags.
          const v = 0.25 * raw[Math.max(0, k - 1)] + 0.5 * raw[k] + 0.25 * raw[Math.min(ACROSS - 1, k + 1)];
          const j = c * ACROSS + k;
          const level = (this.levels[j] += (v - this.levels[j]) * (v > this.levels[j] ? up : down));
          const was = (this.settled[j] += (level - this.settled[j]) * settle);
          const rise = Math.max(-1, Math.min(1, (level - was) * LIFT_GAIN));
          this.bytes[j * 2] = Math.round(Math.min(1, level) * 255);
          this.bytes[j * 2 + 1] = Math.round((0.5 + 0.5 * rise) * 255);
        }
      });
    }
  }

  Visualizer.add({
    id: 'aurora',
    name: 'Aurora',
    desc: 'The northern lights over mountains and a still lake, each curtain rising and glowing with its own part of the music: bass, mids and highs',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 10c3-4 6 2 9-2s6 1 9-3M3 14c3-3 6 2 9-1s6 1 9-2"/><path d="M2 21l5-5 3 3 4-5 8 7"/></svg>',
    gl: true,
    create: (canvas) => new Aurora(canvas),
    options: [
      { type: 'choice', key: 'auColors', label: 'Colors', choices: [['green', 'Green'], ['red', 'Red'], ['violet', 'Violet'], ['rainbow', 'Rainbow']] },
      { type: 'slider', key: 'auActivity', label: 'Restless', min: 25, max: 300, step: 5 },
      { type: 'slider', key: 'auGlare', label: 'Glare', min: 50, max: 150, step: 5 },
      { type: 'check', key: 'auLake', label: 'Lake' },
      { type: 'check', key: 'auStars', label: 'Stars' },
    ],
  });
})();
