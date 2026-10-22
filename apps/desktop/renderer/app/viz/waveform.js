'use strict';

// Waveform: like the equalizer behind the pages (equalizer.js), mirrored
// about the middle of the screen and glowing: distinct bars with a thin gap
// between, or one smooth wave, faded towards their tips, a wide shine
// stretched out from the middle round them.
//
// Its cogwheel: the colours (the equalizer's schemes, or its own), bars or a
// wave, the shine and how far it spreads.
//
// WebGL (viz/gl.js): the bars (or the wave) worked out at each pixel from
// their heights, sharp, into a texture; the shine from that, stretched out
// from the middle and made small, then blurred wide; the bars only softened;
// both onto the screen. (It was Canvas 2D, whose two full-screen blurs cost
// a weaker graphics card dearly.)

(() => {
  const PITCH = 7;           // Bars: a bar this far from the next,
  const BAR = 5;             // this wide (a thin gap between)
  const BAR_BLUR = 0.6;      // and only this softened, so the gaps stay
  const STEP = 4;            // Wave: a point of the outline this far from the next,
  const SMOOTH = 3;          // smoothed over about this many points each way
  const FLOOR_DB = -58;
  const CEIL_DB = -8;
  const REACH = 0.32;        // a full bar reaches this share of the screen, each way
  const SHINE = 1.8;         // the shine reaches this much further (at 50% spread;
  const SHINE_BLUR = 40;     // nothing further and less blurred at 0%, twice at 100%)
  const SHINE_ALPHA = 0.6;
  const CORE_BLUR = 3;
  const ATTACK_MS = 30;
  const RELEASE_MS = 360;
  const RAINBOW_MS = 15000;
  const STOPS = 48;          // the wave's colour along it: a stop every so often
  const SHRINK = 8;          // the shine worked out at an eighth of the size

  // The bars (or the wave), sharp, mirrored about the middle, faded towards
  // their tips; premultiplied.
  const SHAPE_FS = `
    in vec2 uv;
    uniform sampler2D levels;   // each bar's (or point's) height, 0..1
    uniform sampler2D colors;   // bars: each bar's colour; the wave: its stops along it
    uniform vec2 res;
    uniform int n, wave;
    uniform float reach, offset;
    out vec4 o;
    float halfAt(int i) {
      return max(1.0, texelFetch(levels, ivec2(clamp(i, 0, n - 1), 0), 0).r * reach);
    }
    void main() {
      vec2 f = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
      float dy = abs(f.y - res.y * 0.5);
      vec3 col = vec3(0.0);
      float cov = 0.0;
      if (wave == 0) {
        // On whole pixels, so the gaps stay sharp.
        int i = int(floor((f.x - offset + 0.5) / ${PITCH}.0));
        float x0 = floor(offset + float(i) * ${PITCH}.0 + 0.5);
        if (i >= 0 && i < n && f.x > x0 && f.x < x0 + ${BAR}.0) {
          cov = clamp(halfAt(i) - dy + 0.5, 0.0, 1.0);
          col = texelFetch(colors, ivec2(i, 0), 0).rgb;
        }
      } else {
        // Through the middles between its points, curving at each.
        float seg = res.x / float(n);
        float fi = f.x / seg;
        int i = clamp(int(floor(fi)), 0, n - 1);
        float t = clamp(fi - float(i), 0.0, 1.0);
        float c = halfAt(i);
        float s = i == 0 ? c : 0.5 * (halfAt(i - 1) + c);
        float e = i == n - 1 ? c : 0.5 * (c + halfAt(i + 1));
        float h = (1.0 - t) * (1.0 - t) * s + 2.0 * t * (1.0 - t) * c + t * t * e;
        cov = clamp(h - dy + 0.5, 0.0, 1.0);
        col = texture(colors, vec2((f.x / res.x * ${STOPS}.0 + 0.5) / ${STOPS + 1}.0, 0.5)).rgb;
      }
      // Faded towards the tips, so it reads as light rather than as blocks.
      float a = cov * (1.0 - 0.7 * min(1.0, dy / reach));
      o = vec4(col * a, a);
    }`;

  // The shine's start: the shape stretched out from the middle (by stretch)
  // and made small, each pixel the mean of the 8 x 8 under it (thin bars
  // would flicker in and out of a single look).
  const STRETCH_FS = `
    in vec2 uv;
    uniform sampler2D src;
    uniform vec2 srcTexel;
    uniform float stretch;
    out vec4 o;
    void main() {
      vec4 c = vec4(0.0);
      for (int j = 0; j < 4; j++) {
        for (int i = 0; i < 4; i++) {
          vec2 d = (vec2(float(i), float(j)) - 1.5) * 2.0 * srcTexel;
          vec2 p = uv + d;
          p.y = 0.5 + (p.y - 0.5) / stretch;
          c += texture(src, p);
        }
      }
      o = c / 16.0;
    }`;

  // A gaussian blur along dir (a texel), sigma texels wide, two taps a look.
  const GAUSS_FS = `
    in vec2 uv;
    uniform sampler2D src;
    uniform vec2 dir;
    uniform float sigma;
    out vec4 o;
    void main() {
      float k = -0.5 / (sigma * sigma);
      vec4 c = texture(src, uv);
      float sum = 1.0;
      int taps = int(ceil(sigma * 3.0));
      for (int i = 1; i < 64; i += 2) {
        if (i > taps) break;
        // Texels i and i + 1 in one look, between them by their weights.
        float w0 = exp(float(i * i) * k);
        float w1 = exp(float((i + 1) * (i + 1)) * k);
        float w = w0 + w1;
        float at = float(i) + w1 / w;
        c += (texture(src, uv + dir * at) + texture(src, uv - dir * at)) * w;
        sum += 2.0 * w;
      }
      o = c / sum;
    }`;

  // Onto the screen: the shine on black, the bars over it.
  const SHOW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D shine, core;
    uniform float shineAlpha, time;
    out vec4 o;
    void main() {
      vec3 c = texture(shine, uv).rgb * shineAlpha;
      vec4 k = texture(core, uv);
      c = k.rgb + c * (1.0 - k.a);
      o = vec4(c + (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0, 1.0);
    }`;

  // The palette's CSS colours (hsl() or #rrggbb) as 0..1 numbers, each worked out once.
  const parsed = new Map();
  function cssRgb(css) {
    let c = parsed.get(css);
    if (c) return c;
    const m = /^hsl\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\s*\)$/.exec(css);
    if (m) {
      const h = Number(m[1]) / 360;
      const s = Number(m[2]) / 100;
      const l = Number(m[3]) / 100;
      const a = s * Math.min(l, 1 - l);
      const f = (k) => {
        const x = (k + h * 12) % 12;
        return l - a * Math.max(-1, Math.min(x - 3, 9 - x, 1));
      };
      c = [f(0), f(8), f(4)];
    } else {
      c = VizGL.rgb(css);
    }
    parsed.set(css, c);
    return c;
  }

  class Waveform {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.shape = VizGL.program(gl, VizGL.SCREEN_VS, SHAPE_FS);
      this.stretchP = VizGL.program(gl, VizGL.SCREEN_VS, STRETCH_FS);
      this.gauss = VizGL.program(gl, VizGL.SCREEN_VS, GAUSS_FS);
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      const tex = (filter) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this.levelTex = tex(gl.NEAREST);
      this.colorTex = tex(gl.LINEAR);
      this.spec = null;
      this.levels = new Float32Array(0);
      this.shift = 0;
      this.style = null;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.s, this.k1, this.k2, this.g1, this.g2]) VizGL.freeTarget(gl, t);
      this.s = VizGL.target(gl, w, h);
      this.k1 = VizGL.target(gl, w, h);
      this.k2 = VizGL.target(gl, w, h);
      const sw = Math.max(1, Math.round(w / SHRINK));
      const sh = Math.max(1, Math.round(h / SHRINK));
      this.g1 = VizGL.target(gl, sw, sh);
      this.g2 = VizGL.target(gl, sw, sh);
      this.spec = null;
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    /** As many bars (or points of the wave) as fit across, the analysis to match. */
    _layout(style) {
      this.style = style;
      const bars = Math.max(16, Math.floor(this.w / (style === 'wave' ? STEP : PITCH)));
      if (this.spec && this.spec.bars === bars) return;
      this.spec = new Spectrum.Analyser({ sampleRate: Equalizer.ctx.sampleRate, bars });
      this.levels = new Float32Array(bars);
      this.shown = new Float32Array(bars);
      this.colorData = new Uint8Array(Math.max(bars, STOPS + 1) * 4);
    }

    /** `levels` smoothed with a bell curve SMOOTH points wide, into this.shown. */
    _smooth(levels) {
      const n = levels.length;
      const reach = SMOOTH * 3;
      if (!this.kernel) this.kernel = Float32Array.from({ length: reach + 1 }, (_, k) => Math.exp(-(k * k) / (2 * SMOOTH ** 2)));
      const kern = this.kernel;
      for (let i = 0; i < n; i += 1) {
        let sum = 0;
        let weight = 0;
        for (let k = -reach; k <= reach; k += 1) {
          const j = i + k;
          if (j < 0 || j >= n) continue;
          const g = kern[Math.abs(k)];
          sum += levels[j] * g;
          weight += g;
        }
        this.shown[i] = sum / weight;
      }
      return this.shown;
    }

    /** A blur of src (sigma texels of it) along x then y, through tmp into dst (all one size). */
    _blur(src, tmp, dst, sigma) {
      const gl = this.gl;
      const u = this.gauss.u;
      gl.useProgram(this.gauss.p);
      gl.uniform1f(u.sigma, Math.max(0.3, sigma));
      VizGL.into(gl, tmp);
      VizGL.bind(gl, u.src, src.tex, 0);
      gl.uniform2f(u.dir, 1 / src.w, 0);
      VizGL.screen(gl);
      VizGL.into(gl, dst);
      VizGL.bind(gl, u.src, tmp.tex, 0);
      gl.uniform2f(u.dir, 0, 1 / tmp.h);
      VizGL.screen(gl);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      const style = set('wfStyle');
      if (style !== this.style || !this.spec) this._layout(style);
      const wave = style === 'wave';
      const levels = this.levels;
      const n = levels.length;
      const ms = dt * 1000;
      const fall = Math.exp(-ms / RELEASE_MS);
      const rise = 1 - Math.exp(-ms / ATTACK_MS);
      this.shift = (this.shift + ms / RAINBOW_MS) % 1;
      if (a.playing) {
        const db = this.spec.analyse(a.samples);
        for (let i = 0; i < n; i += 1) {
          const target = Spectrum.unit(db[i], FLOOR_DB, CEIL_DB);
          levels[i] = target >= levels[i] ? levels[i] + (target - levels[i]) * rise : target + (levels[i] - target) * fall;
        }
      } else {
        for (let i = 0; i < n; i += 1) levels[i] *= fall;
      }
      // Bars: each its own. Wave: smoothed out over its neighbours, so it is one shape.
      const shown = wave ? this._smooth(levels) : levels;

      // Their colours: each bar's, or the wave's stops along it.
      const scheme = set('wfColors');
      const solid = scheme === 'custom' ? set('wfColor') : Palette.solid[scheme] || null;
      const colour = (i, v) => cssRgb(solid || (scheme === 'rainbow' ? Palette.rainbow(i / n - this.shift) : Palette.by(scheme, v)));
      const cd = this.colorData;
      const count = wave ? STOPS + 1 : n;
      for (let k = 0; k < count; k += 1) {
        const i = wave ? Math.min(n - 1, Math.round((k / STOPS) * (n - 1))) : k;
        const c = colour(i, shown[i]);
        cd[k * 4] = Math.round(c[0] * 255);
        cd[k * 4 + 1] = Math.round(c[1] * 255);
        cd[k * 4 + 2] = Math.round(c[2] * 255);
        cd[k * 4 + 3] = 255;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, count, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, cd.subarray(0, count * 4));
      gl.bindTexture(gl.TEXTURE_2D, this.levelTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, n, 1, 0, gl.RED, gl.FLOAT, shown);

      // 1. Sharp, mirrored about the middle, faded towards the tips.
      gl.disable(gl.BLEND);
      VizGL.into(gl, this.s);
      gl.useProgram(this.shape.p);
      const u = this.shape.u;
      VizGL.bind(gl, u.levels, this.levelTex, 0);
      VizGL.bind(gl, u.colors, this.colorTex, 1);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1i(u.n, n);
      gl.uniform1i(u.wave, wave ? 1 : 0);
      gl.uniform1f(u.reach, this.h * REACH);
      gl.uniform1f(u.offset, (this.w - n * PITCH) / 2 + (PITCH - BAR) / 2);
      VizGL.screen(gl);

      // 2. The shine, stretched out from the middle both ways (unless turned off).
      const shine = !!set('wfShine');
      if (shine) {
        const spread = set('wfShineSpread') / 50;
        VizGL.into(gl, this.g1);
        gl.useProgram(this.stretchP.p);
        VizGL.bind(gl, this.stretchP.u.src, this.s.tex, 0);
        gl.uniform2f(this.stretchP.u.srcTexel, 1 / this.w, 1 / this.h);
        gl.uniform1f(this.stretchP.u.stretch, 1 + (SHINE - 1) * spread);
        VizGL.screen(gl);
        this._blur(this.g1, this.g2, this.g1, (SHINE_BLUR * (0.4 + 0.6 * spread)) / (this.w / this.g1.w));
      }

      // 3. The bars (or the wave), only softened.
      this._blur(this.s, this.k1, this.k2, wave ? CORE_BLUR : BAR_BLUR);

      // 4. Onto the screen.
      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      VizGL.bind(gl, this.show.u.shine, this.g1.tex, 0);
      VizGL.bind(gl, this.show.u.core, this.k2.tex, 1);
      gl.uniform1f(this.show.u.shineAlpha, shine ? SHINE_ALPHA : 0);
      gl.uniform1f(this.show.u.time, this.shift * 100);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'waveform',
    name: 'Waveform',
    desc: 'The equalizer, glowing out from the middle of the screen',
    glyph: Icons.pulse,
    image: '../images/viz-waveform.jpg',
    gl: true,
    create: (canvas) => new Waveform(canvas),
    options: [
      {
        type: 'choice',
        key: 'wfColors',
        label: 'Color',
        choices: [['rainbow', 'Rainbow'], ['spectrum', 'Spectrum'], ['greyscale', 'Greyscale']],
        color: { value: 'custom', key: 'wfColor', presets: Visualizer.OWN_PRESETS },
      },
      { type: 'choice', key: 'wfStyle', label: 'Style', choices: [['bars', 'Bars'], ['wave', 'Wave']] },
      { type: 'check', key: 'wfShine', label: 'Shine', amount: { key: 'wfShineSpread', min: 0, max: 100, step: 5 } },
    ],
  });
})();
