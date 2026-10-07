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

  const FS = VizGL.NOISE + VizGL.STARS + `
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

    vec3 sky(vec2 p, float aspect) {
      float x = p.x * aspect;
      vec3 col = mix(vec3(0.01, 0.02, 0.05), vec3(0.0, 0.004, 0.02), smoothstep(HORIZON, 1.0, p.y));
      if (stars > 0.0) col += starField(p * res, time, boom) * smoothstep(HORIZON, HORIZON + 0.2, p.y);
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
    // Seen from across the lake: DEPTHS rows going back, each smaller and
    // hazier and standing on its own band of the hill's height (the front
    // row the lowest third, mostly on a narrow bank by the water, the back
    // row the highest), every tree anywhere in its band, so they cover the
    // hillside from the water to the top. In clusters
    // with clearings between, each its own size (a few larger all round, up
    // to three times the rest by the water, less so further back), in tiers
    // narrowing to the tip, on a stem. Drawn from the back.
    const int DEPTHS = 3;   // few rows of fair-sized trees rather than thousands of tiny ones
    // Value noise along a line, for the clusters (cheaper than vnoise).
    float noise1(float x) {
      float i = floor(x);
      float f = fract(x);
      return mix(hash12(vec2(i, 7.0)), hash12(vec2(i + 1.0, 7.0)), f * f * (3.0 - 2.0 * f));
    }
    // ink: how much they cover (the water mirrors them lighter).
    vec3 forest(vec3 col, float x, float y, float top, float ink) {
      if (y < 0.0 || y > top + 0.08) return col;
      float edge = 1.2 / res.y;
      const float FAR = 1.0 / (1.0 + 0.125 * float(DEPTHS - 1));
      for (int row = DEPTHS - 1; row >= 0; row--) {
        float fr = float(row);
        float scale = 1.0 / (1.0 + 0.125 * fr);      // 1, 0.89, 0.8
        float back = (1.0 - scale) / (1.0 - FAR);      // 0 at the water, 1 the farthest
        // This row's band of the hillside, each tree somewhere in it: the
        // front row the lowest third, the middle one the middle, the back
        // row the top third, up to the top.
        float lo = top * 0.325 * fr;
        float hi = top * min(1.0, 0.35 + 0.325 * fr);
        // Dark brownish green, the stems browner; hazier further back.
        vec3 haze = vec3(0.013, 0.017, 0.028);
        vec3 shade = mix(vec3(0.009, 0.0075, 0.0045), haze, 0.7 * back);
        vec3 wood = mix(vec3(0.022, 0.012, 0.005), haze, 0.7 * back);
        float tallest = 0.026 * scale;
        float w = 0.45 * tallest;
        float cell = floor(x / w);
        float cover = 0.0;
        float bark = 0.0;
        float most = 3.0 - 1.6 * back;                 // the largest a tree here grows
        // Each tree's crown lifted onto a stem in the middle of it, by row
        // (screen pixels): the front 9 high and 3 wide, the middle 6 by 2,
        // the back 3 by 1.
        float px = 1.0 / res.y;
        float lift = (9.0 - 3.0 * fr) * px;
        float stem = lift / 3.0;
        // Nothing of this row reaches here.
        if (y < lo || y > hi + lift + most * tallest) continue;
        for (int k = -2; k <= 2; k++) {
          // The cheap tests first: most trees do not reach this point.
          float c = cell + float(k);
          vec2 id = vec2(c, fr * 17.0);
          float cx = (c + 0.5 + 0.4 * (hash12(id + 8.2) - 0.5)) * w;
          // Most about the same, a few larger all round.
          float grow = 1.0 + (most - 1.0) * pow(hash12(id + 6.4), 6.0);
          float h = tallest * (0.55 + 0.45 * hash12(id + 5.1)) * grow;
          if (abs(x - cx) > max(h * 0.27, stem) + edge) continue;
          // Anywhere in its band; most of the front row on a narrow bank
          // just above the water.
          float up = hash12(id + 2.6);
          float at = row == 0 && hash12(id + 4.7) < 0.55 ? 0.002 + 0.004 * up : mix(max(lo, 0.006), hi, up);
          if (y < at || y > at + lift + h || at > top) continue;
          // In a clearing, or not there anyway.
          float dense = smoothstep(0.2, 0.5, noise1((c + 0.5) * w * 6.0 + fr * 5.3));
          if (hash12(id + 3.3) > dense * (0.92 - 0.15 * back)) continue;   // a little sparser further back
          if (y < at + lift) {
            // The stem, whole pixels wide.
            bark = max(bark, clamp((stem * 0.5 - abs(x - cx)) / px + 0.5, 0.0, 1.0));
            continue;
          }
          float t = (y - at - lift) / h;
          float tiers = 4.0 + floor(3.0 * hash12(id + 9.9));
          float wide = h * 0.26 * (1.0 - t) * (0.62 + 0.38 * fract((1.0 - t) * tiers));
          cover = max(cover, smoothstep(-edge, edge, wide - abs(x - cx)) * smoothstep(-edge, edge, h - (y - at - lift)));
        }
        col = mix(col, wood, bark * ink);
        col = mix(col, shade, cover * ink);
      }
      return col;
    }

    // Where the water meets the land across the screen (x 0..1): not
    // straight but gently rising and falling, as a real shore does (low on
    // the left, up to around 40%, down past 60% to around 70%, a little
    // rise near 80%, down again to the right), with a little unevenness.
    float shore(float x) {
      float xs[6] = float[](0.0, 0.4, 0.6, 0.7, 0.78, 1.0);
      float ys[6] = float[](-0.6, 0.8, 0.0, -0.5, -0.2, -0.8);
      float y = ys[0];
      for (int i = 0; i < 5; i++) {
        float t = clamp((x - xs[i]) / (xs[i + 1] - xs[i]), 0.0, 1.0);
        if (x >= xs[i]) y = mix(ys[i], ys[i + 1], t * t * (3.0 - 2.0 * t));
      }
      return HORIZON + 0.012 * y + 0.003 * (vnoise(vec2(x * 25.0, 2.0)) - 0.5) + 0.0012 * (vnoise(vec2(x * 110.0, 5.0)) - 0.5);
    }

    void main() {
      float aspect = res.x / res.y;
      vec2 p = uv;
      float H = shore(p.x);
      vec3 col;
      float wave = 0.0;
      if (p.y >= H || lake < 0.5) {
        col = sky(p, aspect);
      } else {
        // The lake: the sky mirrored, broken by small waves, darker.
        float depth = (H - p.y) / H;
        wave = (vnoise(vec2(p.x * aspect * 40.0, p.y * 260.0 - time * 0.8)) - 0.5) * 0.012 * (0.3 + depth);
        vec2 m = vec2(p.x + wave, 2.0 * H - p.y + wave * 0.5);
        col = sky(m, aspect) * (0.55 - 0.25 * depth);
        col += vec3(0.0, 0.01, 0.02);
      }
      // The mountains, dark against the sky (a little hazy, being far), a
      // little of the aurora's light on their snow.
      float top = ridge(p.x * aspect) + H - HORIZON;
      if ((p.y < top && p.y > H) || (lake < 0.5 && p.y < top)) {
        float snow = smoothstep(top - 0.03, top, p.y) * 0.5;
        col = vec3(0.013, 0.017, 0.028) + low * snow * 0.04;
      } else if (lake > 0.5 && p.y < H && H - p.y + wave * 0.5 < ridge((p.x + wave) * aspect) - HORIZON) {
        // The land mirrored softly, broken by the waves like the rest (the
        // trees on it stand on its reflection), a little more so at the
        // water's edge.
        col = mix(col, vec3(0.008, 0.011, 0.019), mix(0.7, 0.45, smoothstep(0.0, 0.007, H - p.y)));
      }
      // The trees in front, and mirrored in the lake, broken by its waves.
      if (p.y >= H) col = forest(col, p.x * aspect, p.y - H, top - H, 1.0);
      else if (lake > 0.5) col = forest(col, (p.x + wave) * aspect, H - p.y + wave * 0.5, top - H, 0.65);
      // A thin glint along the water's edge, where the calm water catches the sky.
      if (lake > 0.5) col += low * 0.035 * (0.5 + 0.5 * vnoise(vec2(p.x * aspect * 90.0, time * 0.3))) * exp(-abs(p.y - H) * res.y / 1.3);
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
