'use strict';

// The equalizer behind the content: the main player's sound, 20 Hz to 4 kHz,
// mirrored about the top edge of the player bar. It reaches a third of the way
// up the pages, and the half below the line runs behind the player bar and off
// the bottom of the window.
//
// It also owns the player's route to the speakers, since the analysis has to
// sit on it. The player has two elements (the second plays the next song
// during a song transition), each with its own two gains:
//
//   element -> loudness -> fade --+
//   element -> loudness -> fade --+-> mix -> [limiter] -> analyser -> volume -> out
//
// "loudness" evens out loud and quiet songs (Equalize volume), "fade" is the
// song transition, and the limiter catches the peaks of a song turned up. The
// analyser comes before the volume, so the picture shows the song rather than
// the volume knob. If Web Audio is not to be had, the elements play as before
// and there is no equalizer, transition or evening out.
//
// It is background, not a feature: soft bars with a little glow, slow to fall.
// Drawn at full size (at half size the thin bars came out stepped once they
// were no longer heavily blurred): sharp bars onto a scratch canvas,
// faded towards their tips, then that twice onto the visible one, once very
// blurred and stretched far upwards for the shine, and once blurred for the
// bars themselves. Last, the whole picture is faded out towards the top of the
// canvas, so the shine ends in full transparency instead of at an edge.
//
// With WebGL 2 (and float targets) the same picture is made there instead,
// far cheaper than the canvas's blur filters (see _webgl): the shine blurred
// at a quarter size, the bars' softening at half size.

const Equalizer = {
  ctx: null,
  analyser: null,
  gain: null,
  spec: null,
  samples: null,
  levels: new Float32Array(0),
  canvas: null,
  scratch: null,
  elements: [],
  channels: null,      // element -> { norm, fade } gains
  mix: null,
  limiter: null,
  raf: null,
  lastFrame: 0,
  geom: null,
  bass: 0,             // 0..1, the kick band right now, unsmoothed (ambient.js)
  feelBars: 0,         // how many bars that is
  rainbowShift: 0,     // 0..1, how far Rainbow has drifted; held while nothing plays
  bassWeights: null,   // per bar, how much it counts towards `bass` (BASS_*)

  // Look. Distances are in css pixels.
  SCALE: 1,            // canvas resolution against css pixels
  PITCH: 4,            // one bar every 4 px
  BAR: 2.5,            // of which the bar is this wide
  // Measured on music: half of all bars sit below about -50 dB, one in ten
  // above -30, one in a hundred above -15. This range leaves the quiet bands
  // low and gives the loud ones the height.
  FLOOR_DB: -58,       // the level a bar starts at
  CEIL_DB: -8,         // and reaches full height at
  // Height and shine follow Settings (50% each by default): at 50% the bars
  // reach a third of the pages' height and the shine 1.7 times as far.
  REACH: 1 / 3,        // full height at 50%, as a share of the pages' height
  SHINE: 1.7,          // how much further the shine reaches at 50%
  // The bars are drawn solid and the shine at SHINE_ALPHA of them; Settings'
  // Visibility is then the whole canvas's opacity, so 100% is fully opaque.
  // Above 50% the shine also starts brighter at the bars (up to SHINE_BOOST
  // times) and fades out faster away from them, as (1 - distance) to the
  // power of up to SHINE_FALLOFF; below 50% it starts dimmer.
  CORE_BLUR: 4,
  CORE_ALPHA: 1,
  SHINE_BLUR: 36,
  SHINE_ALPHA: 0.59,
  SHINE_BOOST: 1.4,
  SHINE_FALLOFF: 2,
  // Bars rise over about 60 ms (the analysis itself adds as much again, so a
  // sound still shows within 100 ms) and fall back over about half a second,
  // which turns the flicker of single frames into a slow breathing.
  ATTACK_MS: 30,
  RELEASE_MS: 480,
  // The bass level the clouds' pulse reacts to: the bars
  // weighted by how close they are to BASS_PEAK_HZ, where a kick drum punches,
  // falling in a straight line to nothing at BASS_LOW_HZ (sub rumble and the
  // long tails of kicks) and at BASS_HIGH_HZ (bass lines, snare, voices).
  BASS_LOW_HZ: 20,
  BASS_PEAK_HZ: 70,
  BASS_HIGH_HZ: 120,
  RAINBOW_MS: 15000,   // Rainbow drifts one screen width to the right in this long

  /** Wires the player's elements through Web Audio. False when that failed. */
  attach(elements) {
    this.elements = elements;
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      this.spec = new Spectrum.Analyser({ sampleRate: ctx.sampleRate, bars: 1 });
      // The analyser only keeps the newest fftSize samples; two frames need
      // the window plus the hop between them. At least 16384: the
      // visualizers' notes (notes.js) look at a longer window.
      analyser.fftSize = Math.min(32768, Math.max(16384, 2 ** Math.ceil(Math.log2(this.spec.inputLength))));
      const mix = ctx.createGain();
      // Only there to catch peaks: fast, hard, and just under full scale.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -2;
      limiter.knee.value = 1;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      const gain = ctx.createGain();
      // The output delay (output.js): the sound itself held back, to the
      // sample, before the analyser so the bars stay with what is heard.
      const delay = ctx.createDelay(1);
      delay.delayTime.value = Output.delay() / 1000;
      delay.connect(analyser);
      this.channels = new Map();
      for (const el of elements) {
        const norm = ctx.createGain();
        const fade = ctx.createGain();
        ctx.createMediaElementSource(el).connect(norm);
        norm.connect(fade);
        fade.connect(mix);
        this.channels.set(el, { norm, fade });
      }
      analyser.connect(gain);
      gain.connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
      this.mix = mix;
      this.limiter = limiter;
      this.delay = delay;
      this.gain = gain;
      this.samples = new Float32Array(analyser.fftSize);
      this.setLimiter(Store.settings.normalize);
    } catch (err) {
      console.warn('No equalizer:', err);
      this.ctx = null;
      this.channels = null;
      return false;
    }

    this.canvas = $('eqCanvas');
    this.gl = this._webgl();
    this.scratch = document.createElement('canvas');
    this.glow = document.createElement('canvas'); // the shine, before it joins the bars
    this._layout();
    this._applyVisibility();
    new ResizeObserver(() => this._layout()).observe(document.querySelector('.content'));
    Store.onSettings((patch) => {
      if (['eqOn', 'eqHeight', 'eqShine', 'eqShineSpread', 'eqColors'].some((k) => k in patch)) this._layout();
      if ('eqVisibility' in patch) this._applyVisibility();
      if ('normalize' in patch) this.setLimiter(Store.settings.normalize);
    });

    for (const el of elements) {
      el.addEventListener('play', () => this.wake());
      el.addEventListener('playing', () => this.wake());
    }
    return true;
  },

  get active() {
    return !!this.ctx;
  },

  /** The gains of one of the player's elements, or null without Web Audio. */
  channel(el) {
    return this.channels ? this.channels.get(el) || null : null;
  },

  /**
   * An analyser for each channel, beside the one for both, for the
   * visualizers that show left against right; made the first time one asks.
   */
  stereo() {
    if (!this.ctx) return null;
    if (!this._stereo) {
      const split = this.ctx.createChannelSplitter(2);
      const left = this.ctx.createAnalyser();
      const right = this.ctx.createAnalyser();
      left.fftSize = 4096;
      right.fftSize = 4096;
      this.delay.connect(split);
      split.connect(left, 0);
      split.connect(right, 1);
      this._stereo = { left, right };
    }
    return this._stereo;
  },

  /** The limiter goes in with "Equalize volume", which may turn songs up. */
  setLimiter(on) {
    if (!this.ctx) return;
    this.mix.disconnect();
    this.limiter.disconnect();
    if (on) {
      this.mix.connect(this.limiter);
      this.limiter.connect(this.delay);
    } else {
      this.mix.connect(this.delay);
    }
  },

  /** Holds the sound back `ms` (output.js), gliding there: a jump would click. */
  setDelay(ms) {
    if (!this.delay) return;
    const v = Math.max(0, Math.min(1000, Number(ms) || 0)) / 1000;
    if (Math.abs(this.delay.delayTime.value - v) < 0.00005) return;
    this.delay.delayTime.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  },

  setVolume(v) {
    if (!this.gain) return;
    // A short glide rather than a jump, which would click.
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  },

  /** Starts drawing; it stops by itself once paused and settled. */
  wake() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.raf === null) {
      this.lastFrame = performance.now();
      this.raf = requestAnimationFrame((t) => this._frame(t));
    }
  },

  _sounding() {
    return this.elements.some((a) => !a.paused && !a.ended && !!a.getAttribute('src'));
  },

  /** Full height (share of the pages' height) and shine reach, from Settings. */
  _look() {
    const s = Store.settings;
    return {
      reach: this.REACH * (s.eqHeight || 50) / 50,
      shine: s.eqShine === false ? 0 : 1 + (this.SHINE - 1) * (s.eqShineSpread || 50) / 50,
    };
  },

  _applyVisibility() {
    this.canvas.style.opacity = String((Store.settings.eqVisibility || 50) / 100);
  },

  // ---- geometry ----

  _layout() {
    const content = document.querySelector('.content');
    const player = $('player');
    if (!content || !player || !this.canvas) return;
    const width = content.clientWidth;
    // The top edge of the player bar.
    const lineY = player.offsetTop;
    const look = this._look();
    const reach = lineY * look.reach;
    const top = Math.max(0, lineY - reach * Math.max(1, look.shine) * 1.05);
    const height = content.clientHeight - top;
    this.geom = { width, height, top, center: lineY - top, reach, shine: look.shine };
    this.canvas.style.top = top + 'px';
    this.canvas.style.height = height + 'px';
    const w = Math.max(1, Math.round(width * this.SCALE));
    const h = Math.max(1, Math.round(height * this.SCALE));
    for (const c of [this.canvas, this.scratch, this.glow]) {
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
    }

    const bars = Math.max(16, Math.floor(width / this.PITCH));
    if (this.ctx && (!this.spec || this.spec.bars !== bars)) {
      this.spec = new Spectrum.Analyser({ sampleRate: this.ctx.sampleRate, bars });
      this.bassWeights = new Float32Array(bars);
      for (let i = 0; i < bars; i += 1) {
        const hz = this.spec.barHz(i);
        const w = hz <= this.BASS_PEAK_HZ
          ? (hz - this.BASS_LOW_HZ) / (this.BASS_PEAK_HZ - this.BASS_LOW_HZ)
          : (this.BASS_HIGH_HZ - hz) / (this.BASS_HIGH_HZ - this.BASS_PEAK_HZ);
        this.bassWeights[i] = Math.max(0, w);
      }
      const old = this.levels;
      this.levels = new Float32Array(bars);
      // Keep what was showing, stretched to the new count, so a resize does not blink.
      for (let i = 0; i < bars && old.length; i += 1) {
        this.levels[i] = old[Math.min(old.length - 1, Math.floor((i / bars) * old.length))];
      }
    }
    if (this.raf === null) this._draw();
  },

  // ---- frames ----

  _frame(now) {
    this.raf = null;
    const dt = Math.min(100, Math.max(1, now - this.lastFrame));
    this.lastFrame = now;
    const levels = this.levels;
    const sounding = this._sounding();
    const fall = Math.exp(-dt / this.RELEASE_MS);
    const rise = 1 - Math.exp(-dt / this.ATTACK_MS);
    this.rainbowShift = (this.rainbowShift + dt / this.RAINBOW_MS) % 1;

    if (sounding && this.spec) {
      this.analyser.getFloatTimeDomainData(this.samples);
      const db = this.spec.analyse(this.samples);
      let bass = 0;
      let weight = 0;
      for (let i = 0; i < levels.length; i += 1) {
        const w = this.bassWeights[i];
        if (!w) continue;
        bass += w * Spectrum.unit(db[i], this.FLOOR_DB, this.CEIL_DB);
        weight += w;
      }
      this.bass = weight ? bass / weight : 0;
      for (let i = 0; i < levels.length; i += 1) {
        // Each bar leans a little on its neighbours, so single bars do not
        // jump out on their own.
        const l = Spectrum.unit(db[Math.max(0, i - 1)], this.FLOOR_DB, this.CEIL_DB);
        const c = Spectrum.unit(db[i], this.FLOOR_DB, this.CEIL_DB);
        const r = Spectrum.unit(db[Math.min(levels.length - 1, i + 1)], this.FLOOR_DB, this.CEIL_DB);
        const target = 0.25 * l + 0.5 * c + 0.25 * r;
        levels[i] = target >= levels[i]
          ? levels[i] + (target - levels[i]) * rise
          : target + (levels[i] - target) * fall;
      }
    } else {
      this.bass = 0;
      for (let i = 0; i < levels.length; i += 1) levels[i] *= fall;
    }

    this._draw();

    let peak = 0;
    for (let i = 0; i < levels.length; i += 1) if (levels[i] > peak) peak = levels[i];
    if (sounding || peak > 0.004) {
      this.raf = requestAnimationFrame((t) => this._frame(t));
    } else {
      levels.fill(0);
      this._draw();
    }
  },

  /**
   * The equalizer in WebGL 2, or null (then the canvas draws it). draw(p)
   * with what _draw works out (null: nothing to show). The same picture as
   * the canvas's, made the cheap way: the bars (each pixel covered as far as
   * the bar covers it, as the canvas's edges are) faded towards their tips;
   * the shine drawn straight into a quarter-size target, stretched upwards,
   * and blurred there (a gaussian of a quarter the width, the same blur on
   * the screen); the bars' own softening blurred at half size; then one pass
   * laying the bars over the shine, the shine's fade, the fade towards the
   * top and a speckle of a 255th against steps.
   */
  _webgl() {
    let gl = null;
    try {
      gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      // No float target: back to the canvas (a fresh one, this one being WebGL's now).
      const fresh = this.canvas.cloneNode(false);
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
      return null;
    }
    const shader = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, `#version 300 es
precision highp float;
${src}`);
      gl.compileShader(sh);
      return sh;
    };
    const program = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`equalizer: ${gl.getProgramInfoLog(p)}`);
      const u = {};
      const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i += 1) {
        const name = gl.getActiveUniform(p, i).name;
        u[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, name);
      }
      return { p, u };
    };
    const SCREEN_VS = `
      out vec2 uv;
      void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        uv = p;
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`;
    let bars;
    let blur;
    let show;
    try {
      // A bar: its rectangle on the canvas (css pixels, y down), drawn into a
      // target at k of that size, stretched about cy by stretch.
      bars = program(`
        layout(location = 0) in vec4 rect;      // left, right, top, bottom
        layout(location = 1) in vec3 colour;
        uniform vec2 size;                      // the target's, in its pixels
        uniform float k, cy, stretch;
        flat out vec4 box;                      // the rectangle in the target's pixels
        flat out vec3 col;
        void main() {
          int v = gl_VertexID;
          vec2 corner = vec2(v == 1 || v == 4 || v == 5 ? 1.0 : 0.0, v == 2 || v == 3 || v == 5 ? 1.0 : 0.0);
          box = vec4(rect.xy * k, (cy + (rect.zw - cy) * stretch) * k);
          col = colour;
          // A pixel round it, for its edges' partly covered pixels.
          vec2 p = vec2(mix(box.x - 1.0, box.y + 1.0, corner.x), mix(box.z - 1.0, box.w + 1.0, corner.y));
          gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
        }`, `
        flat in vec4 box;
        flat in vec3 col;
        uniform vec2 size;
        uniform float k, cy, stretch;
        uniform vec2 fade;                      // the tips' fade: from, to (css pixels): 0.25 at from, 1 halfway, 0.5 at to
        out vec4 o;
        void main() {
          vec2 p = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
          float cx = clamp(min(p.x + 0.5, box.y) - max(p.x - 0.5, box.x), 0.0, 1.0);
          float cyv = clamp(min(p.y + 0.5, box.w) - max(p.y - 0.5, box.z), 0.0, 1.0);
          // Where this is on the bars before stretching, for the fade.
          float y = cy + (p.y / k - cy) / stretch;
          float t = clamp((y - fade.x) / (fade.y - fade.x), 0.0, 1.0);
          float f = t < 0.5 ? mix(0.25, 1.0, t * 2.0) : mix(1.0, 0.5, t * 2.0 - 1.0);
          float a = cx * cyv * f;
          o = vec4(col * a, a);
        }`);
      // A gaussian along step (one texel of the source), sigma texels; what
      // lies past the edges counts as nothing, as the canvas has it.
      blur = program(SCREEN_VS, `
        in vec2 uv;
        uniform sampler2D src;
        uniform vec2 step;
        uniform float sigma;
        uniform int reach;
        out vec4 o;
        void main() {
          vec4 sum = vec4(0.0);
          float total = 0.0;
          for (int i = -reach; i <= reach; i++) {
            float w = exp(-float(i * i) / (2.0 * sigma * sigma));
            vec2 at = uv + step * float(i);
            total += w;
            if (at.x >= 0.0 && at.x <= 1.0 && at.y >= 0.0 && at.y <= 1.0) sum += texture(src, at) * w;
          }
          o = sum / total;
        }`);
      show = program(SCREEN_VS, `
        in vec2 uv;
        uniform sampler2D shine, core;
        uniform vec2 res;                       // the canvas, in its pixels
        uniform float cy, shineAlpha, power;    // power 0: no fade of the shine
        out vec4 o;
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * .1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        void main() {
          float y = (1.0 - uv.y) * res.y;       // down from the top
          vec4 s = texture(shine, uv) * shineAlpha;
          if (power > 0.0) {
            // The shine's fade: 12 steps from the top down to the line, 4 on below it.
            float m;
            if (y <= cy) {
              float t = y / cy * 12.0;
              float i = min(floor(t), 11.0);
              m = mix(pow(i / 12.0, power), pow((i + 1.0) / 12.0, power), t - i);
            } else {
              float t = (y - cy) / (res.y - cy) * 4.0;
              float i = min(floor(t), 3.0);
              m = mix(pow(1.0 - i / 4.0, power), pow(1.0 - (i + 1.0) / 4.0, power), t - i);
            }
            s *= m;
          }
          vec4 c = texture(core, uv);
          vec4 col = c + s * (1.0 - c.a);
          // Everything fades to nothing towards the top.
          float t = clamp(y / cy, 0.0, 1.0);
          col *= t < 0.45 ? mix(0.0, 0.35, t / 0.45) : mix(0.35, 1.0, (t - 0.45) / 0.55);
          if (col.a > 0.0) {
            col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
            col.a = clamp(col.a, 0.0, 1.0);
            col.rgb = clamp(col.rgb, 0.0, col.a);
          }
          o = col;
        }`);
    } catch (err) {
      console.warn(err);
      return null;
    }
    const most = 4096;
    const data = new Float32Array(most * 7);
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 28, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    const targets = {};
    const target = (name, w, h) => {
      let t = targets[name];
      if (t && t.w === w && t.h === h) return t;
      if (t) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fb);
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      t = { tex, fb, w, h };
      targets[name] = t;
      return t;
    };
    const into = (t) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
      gl.viewport(0, 0, t ? t.w : gl.drawingBufferWidth, t ? t.h : gl.drawingBufferHeight);
    };
    const clear = () => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    };
    // The bars into t (k of the canvas's size), stretched about cy.
    const drawBars = (p, t, k, stretch) => {
      into(t);
      clear();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(bars.p);
      gl.uniform2f(bars.u.size, t.w, t.h);
      gl.uniform1f(bars.u.k, k);
      gl.uniform1f(bars.u.cy, p.cy);
      gl.uniform1f(bars.u.stretch, stretch);
      gl.uniform2f(bars.u.fade, p.fadeFrom, p.fadeTo);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, p.n);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    };
    // src blurred both ways into dst, through tmp (all one size), sigma in its texels.
    const blurBoth = (src, tmp, dst, sigma) => {
      gl.useProgram(blur.p);
      gl.uniform1f(blur.u.sigma, sigma);
      gl.uniform1i(blur.u.reach, Math.max(1, Math.ceil(sigma * 3)));
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(blur.u.src, 0);
      into(tmp);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(blur.u.step, 1 / src.w, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      into(dst);
      gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
      gl.uniform2f(blur.u.step, 0, 1 / tmp.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    return {
      data,
      most,
      /** p: null (nothing) or { w, h, n bars in data, cy, fadeFrom, fadeTo, shine, shineSigma, shineAlpha, power, coreSigma }. */
      draw: (p) => {
        into(null);
        clear();
        if (!p) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, p.n * 7);
        // The bars, softened: at half size.
        const hw = Math.max(1, Math.round(p.w / 2));
        const hh = Math.max(1, Math.round(p.h / 2));
        const coreA = target('coreA', hw, hh);
        const coreB = target('coreB', hw, hh);
        drawBars(p, coreA, 0.5, 1);
        blurBoth(coreA, coreB, coreA, p.coreSigma / 2);
        // The shine: stretched up, at a quarter size, blurred.
        const qw = Math.max(1, Math.round(p.w / 4));
        const qh = Math.max(1, Math.round(p.h / 4));
        const shineA = target('shineA', qw, qh);
        const shineB = target('shineB', qw, qh);
        if (p.shine > 0) {
          drawBars(p, shineA, 0.25, p.shine);
          blurBoth(shineA, shineB, shineA, p.shineSigma / 4);
        } else {
          into(shineA);
          clear();
        }
        into(null);
        gl.useProgram(show.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, shineA.tex);
        gl.uniform1i(show.u.shine, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, coreA.tex);
        gl.uniform1i(show.u.core, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform2f(show.u.res, p.w, p.h);
        gl.uniform1f(show.u.cy, p.cy);
        gl.uniform1f(show.u.shineAlpha, p.shine > 0 ? p.shineAlpha : 0);
        gl.uniform1f(show.u.power, p.power);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  },

  /**
   * What the WebGL path draws now, as _draw's canvas steps have it: the
   * bars into gl.data (left, right, top, bottom in the canvas's pixels; r, g,
   * b), the shine's stretch, blur, strength and fade, the bars' blur; null
   * when there is nothing to show.
   */
  _glPicture() {
    const g = this.geom;
    if (Store.settings.eqOn === false || Visualizer.shown) return null;
    const levels = this.levels;
    const s = this.SCALE;
    const data = this.gl.data;
    const offset = (g.width - levels.length * this.PITCH) / 2;
    const scheme = Store.settings.eqColors || 'rainbow';
    const solid = Palette.solid[scheme] || null;
    let n = 0;
    for (let i = 0; i < levels.length && n < this.gl.most; i += 1) {
      const v = levels[i];
      if (v <= 0.004) continue;
      const h = v * g.reach;
      const rgb = Palette.rgb(solid || (scheme === 'rainbow' ? Palette.rainbow(i / levels.length - this.rainbowShift) : Palette.by(scheme, v)));
      const k = n * 7;
      data[k] = (offset + i * this.PITCH) * s;
      data[k + 1] = (offset + i * this.PITCH + this.BAR) * s;
      data[k + 2] = (g.center - h) * s;
      data[k + 3] = (g.center + h) * s;
      data[k + 4] = rgb[0];
      data[k + 5] = rgb[1];
      data[k + 6] = rgb[2];
      n += 1;
    }
    if (!n) return null;
    const spread = (g.shine - 1) / (this.SHINE - 1);
    const vis = (Store.settings.eqVisibility || 50) / 100;
    const above = Math.max(0, vis - 0.5) * 2;
    const boost = vis >= 0.5 ? 1 + (this.SHINE_BOOST - 1) * above : 0.6 + 0.8 * vis;
    return {
      w: this.canvas.width,
      h: this.canvas.height,
      n,
      cy: g.center * s,
      fadeFrom: (g.center - g.reach) * s,
      fadeTo: (g.center + g.reach) * s,
      shine: g.shine,
      shineSigma: Number((this.SHINE_BLUR * (0.4 + 0.6 * spread) * s).toFixed(1)),
      shineAlpha: Math.min(1, this.SHINE_ALPHA * boost),
      power: above > 0 ? this.SHINE_FALLOFF * above : 0,
      coreSigma: this.CORE_BLUR * s,
    };
  },

  _draw() {
    const g = this.geom;
    if (!g || !this.canvas) return;
    if (this.gl) {
      this.gl.draw(this._glPicture());
      return;
    }
    const s = this.SCALE;
    const out = this.canvas.getContext('2d');
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Turned off: nothing drawn, but the analysis goes on for the clouds.
    // Under the full-screen visualizer nobody would see it.
    if (Store.settings.eqOn === false || Visualizer.shown) return;
    const levels = this.levels;
    let any = false;
    for (let i = 0; i < levels.length; i += 1) {
      if (levels[i] > 0.004) {
        any = true;
        break;
      }
    }
    if (!any) return;

    // 1. Sharp bars, coloured by the chosen scheme: by their own height
    // (Spectrum, and Greyscale: the taller the whiter), by where they stand
    // (Rainbow), or all one colour.
    const sc = this.scratch.getContext('2d');
    sc.setTransform(s, 0, 0, s, 0, 0);
    sc.globalCompositeOperation = 'source-over';
    sc.clearRect(0, 0, g.width, g.height);
    const offset = (g.width - levels.length * this.PITCH) / 2;
    const scheme = Store.settings.eqColors || 'rainbow';
    const solid = Palette.solid[scheme] || null;
    if (solid) sc.fillStyle = solid;
    for (let i = 0; i < levels.length; i += 1) {
      const v = levels[i];
      if (v <= 0.004) continue;
      const h = v * g.reach;
      if (!solid) sc.fillStyle = scheme === 'rainbow' ? Palette.rainbow(i / levels.length - this.rainbowShift) : Palette.by(scheme, v);
      sc.fillRect(offset + i * this.PITCH, g.center - h, this.BAR, h * 2);
    }

    // 2. Faded towards the tips, so it reads as light rather than as blocks.
    sc.globalCompositeOperation = 'destination-in';
    const fade = sc.createLinearGradient(0, g.center - g.reach, 0, g.center + g.reach);
    fade.addColorStop(0, 'rgba(0,0,0,0.25)');
    fade.addColorStop(0.5, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0.5)');
    sc.fillStyle = fade;
    sc.fillRect(0, 0, g.width, g.height);
    sc.globalCompositeOperation = 'source-over';

    // 3. The shine: blurred wide and stretched upwards from the line, as far
    // as Settings' spread says. Its blur grows with it, and Visibility sets
    // how bright it starts and how fast it fades (the constants above).
    const w = this.canvas.width;
    const hgt = this.canvas.height;
    const cy = g.center * s;
    if (g.shine > 0) {
      const spread = (g.shine - 1) / (this.SHINE - 1);
      const vis = (Store.settings.eqVisibility || 50) / 100;
      const above = Math.max(0, vis - 0.5) * 2; // 0 up to 50%, 1 at 100%
      const gl = this.glow.getContext('2d');
      gl.setTransform(1, 0, 0, 1, 0, 0);
      gl.globalCompositeOperation = 'source-over';
      gl.clearRect(0, 0, w, hgt);
      gl.filter = `blur(${(this.SHINE_BLUR * (0.4 + 0.6 * spread) * s).toFixed(1)}px)`;
      gl.drawImage(this.scratch, 0, cy - cy * g.shine, w, hgt * g.shine);
      gl.filter = 'none';
      if (above > 0) {
        const power = this.SHINE_FALLOFF * above;
        const mask = gl.createLinearGradient(0, 0, 0, hgt);
        for (let i = 0; i <= 12; i += 1) {
          const y = (cy * i) / 12; // from the top down to the line
          mask.addColorStop(y / hgt, `rgba(0,0,0,${((i / 12) ** power).toFixed(3)})`);
        }
        for (let i = 1; i <= 4; i += 1) {
          const y = cy + ((hgt - cy) * i) / 4; // and on down below it
          mask.addColorStop(Math.min(1, y / hgt), `rgba(0,0,0,${((1 - i / 4) ** power).toFixed(3)})`);
        }
        gl.globalCompositeOperation = 'destination-in';
        gl.fillStyle = mask;
        gl.fillRect(0, 0, w, hgt);
        gl.globalCompositeOperation = 'source-over';
      }
      const boost = vis >= 0.5 ? 1 + (this.SHINE_BOOST - 1) * above : 0.6 + 0.8 * vis;
      out.globalAlpha = Math.min(1, this.SHINE_ALPHA * boost);
      out.drawImage(this.glow, 0, 0);
    }
    // 4. The bars, only softened.
    out.filter = `blur(${this.CORE_BLUR * s}px)`;
    out.globalAlpha = this.CORE_ALPHA;
    out.drawImage(this.scratch, 0, 0);
    out.filter = 'none';
    out.globalAlpha = 1;
    // 5. Everything fades to nothing towards the top of the canvas.
    out.globalCompositeOperation = 'destination-in';
    const top = out.createLinearGradient(0, 0, 0, cy);
    top.addColorStop(0, 'rgba(0,0,0,0)');
    top.addColorStop(0.45, 'rgba(0,0,0,0.35)');
    top.addColorStop(1, 'rgba(0,0,0,1)');
    out.fillStyle = top;
    // The whole canvas: destination-in clears whatever the fill leaves out.
    out.fillRect(0, 0, w, hgt);
    out.globalCompositeOperation = 'source-over';
  },
};

// Blue -> green -> yellow -> orange -> red -> dark red, by height: round the
// colour wheel from 220° down to red at RED, then only darker. (It used to end
// in purple, which the clouds behind swallowed.)
const Palette = {
  steps: 128,
  cache: null,
  RED: 0.85,
  at(v) {
    if (!this.cache) {
      this.cache = [];
      for (let i = 0; i < this.steps; i += 1) {
        const t = i / (this.steps - 1);
        const sweep = Math.min(1, t / this.RED);
        const hue = 220 * (1 - sweep);
        const dark = Math.max(0, (t - this.RED) / (1 - this.RED));
        const light = 52 + 10 * Math.sin(Math.PI * sweep) - 18 * dark;
        this.cache.push(`hsl(${hue.toFixed(1)}, 90%, ${light.toFixed(1)}%)`);
      }
    }
    const i = Math.max(0, Math.min(this.steps - 1, Math.round(v * (this.steps - 1))));
    return this.cache[i];
  },

  // Greyscale: dark grey when low, up to white at full height.
  greyCache: null,
  grey(v) {
    if (!this.greyCache) {
      this.greyCache = [];
      for (let i = 0; i < this.steps; i += 1) this.greyCache.push(`hsl(0, 0%, ${(22 + 74 * (i / (this.steps - 1))).toFixed(1)}%)`);
    }
    const i = Math.max(0, Math.min(this.steps - 1, Math.round(v * (this.steps - 1))));
    return this.greyCache[i];
  },

  /** A bar of height `v` in a scheme coloured by height. */
  by(scheme, v) {
    return scheme === 'greyscale' ? this.grey(v) : this.at(v);
  },

  // Rainbow: by where the bar stands, once round the whole colour wheel from
  // blue on the left through violet, red, orange, yellow and green back to
  // blue on the right. Both ends being blue, `x` wraps round, so the equalizer
  // can drift it sideways without a seam. A step a degree, so it drifts
  // smoothly.
  rainbowCache: null,
  rainbow(x) {
    if (!this.rainbowCache) {
      this.rainbowCache = [];
      for (let i = 0; i < 360; i += 1) this.rainbowCache.push(`hsl(${(220 + i) % 360}, 90%, 56%)`);
    }
    const i = Math.round((x - Math.floor(x)) * 360) % 360;
    return this.rainbowCache[i];
  },

  /** A colour of these as the canvas paints it: r, g, b 0..1 (worked out once each). */
  rgbCache: new Map(),
  rgb(css) {
    let c = this.rgbCache.get(css);
    if (!c) {
      this.probe = this.probe || document.createElement('canvas').getContext('2d');
      this.probe.fillStyle = css;
      const hex = this.probe.fillStyle;
      c = /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255) : [1, 1, 1];
      this.rgbCache.set(css, c);
    }
    return c;
  },

  // The one-colour schemes.
  solid: {
    white: 'hsl(0, 0%, 92%)',
    red: 'hsl(0, 85%, 52%)',
    green: 'hsl(130, 70%, 48%)',
    yellow: 'hsl(52, 95%, 55%)',
    blue: 'hsl(215, 90%, 58%)',
    purple: 'hsl(275, 75%, 62%)',
    black: 'hsl(0, 0%, 0%)',
  },
};
