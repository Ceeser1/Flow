'use strict';

// The clouds behind the content: a few large, shapeless clouds of deep colour,
// each a wide core with a far, faint shine around it, that drift about slowly
// and never stop. Each one also comes and goes on its own slow cycle, so at
// any time some of the background is plain and some is tinted, and it is
// never the same twice. While a song plays they breathe with it: a kick or a
// bass note that stands out from the last half second swells and brightens
// them a little.
//
// A cloud is a loose scatter of puffs, each drifting and swelling on its own.
// A puff is a round glow that falls off like a bell curve, a dense middle
// running out into a wide, faint shine, drawn with many colour steps so the
// fall-off has no corners. Where puffs overlap the cloud is denser, which is
// what gives it its uneven, changing shape. (Not the canvas blur filter: at
// these widths Chromium blurs in shrunk-down stages, which leaves streaks.)
//
// The visible canvas is solid: it is painted with the page background first
// and the clouds are mixed into that. A see-through canvas holding such faint
// colour keeps too few steps of it (colour and see-through are each rounded
// to 256 steps, and at a few percent the two roundings disagree), which shows
// as rings that fade out and start again. Solid, only the colour is rounded,
// in steps too small to see.
//
// At full size: Chromium speckles colour fades by a step to hide banding,
// invisible pixel by pixel, but a canvas drawn smaller and stretched turns the
// speckles into a grid. The equalizer's canvas lies on top of this one.
//
// With WebGL 2 (and float targets) they are drawn there instead: the same
// puffs, laid over each other the same way, into a quarter-size picture of
// half floats, then stretched over the screen with a speckle of its own at
// each of the screen's pixels (the clouds are so soft that the quarter size
// loses nothing, and the speckle hides the steps as Chromium's does). Drawn
// at full size by the canvas, the puffs' wide gradients were most of the
// app's GPU work.
//
// Settings: in Rainbow each cloud takes a random colour every time it comes
// back; a solid scheme gives them all that one. The amount at 50% is the
// first half of CLOUDS (the look as designed), 100% all of them, 0% none.

const Ambient = {
  canvas: null,
  background: '#1e1e22',
  raf: null,
  lastDraw: 0,
  lastFrame: 0,
  time: 0,          // seconds of drift so far
  bassAverage: 0,
  pulse: 0,         // 0..1, the swell of the last bass hit
  frozen: false,    // Windows' "Show animations" off: the clouds stand still

  IDLE_FPS: 24,     // without a song they only drift, which needs no more
  // One puff: its strength in the middle, and how far the shine reaches, in
  // puff radii. Where several overlap the cloud gets stronger.
  PUFF_ALPHA: 0.1,   // at Settings' 50% intensity; 100% doubles it
  SHINE_SHARE: 0.35, // the shine's strength against the core's
  SHINE_WIDTH: 2.2,  // the shine's width against the core's
  REACH: 3.4,        // where the puff has faded to nothing
  STOPS: 24,
  // The pulse: bass above its own average of the last AVERAGE_MS by more than
  // THRESHOLD, rising over ATTACK_MS and falling back over RELEASE_MS.
  AVERAGE_MS: 500,
  THRESHOLD: 0.06,
  GAIN: 2.3,
  ATTACK_MS: 40,
  RELEASE_MS: 280,
  PULSE_ALPHA: 0.8, // a full pulse makes a cloud this much brighter
  PULSE_GROW: 0.08, // and this much larger (both at Settings' 25% reaction)
  PUFFS: 9,         // per cloud

  // Each cloud: saturation and lightness of its colour (the hue is Rainbow's
  // pick), size (share of the larger side), the slow paths it drifts along
  // (centre, reach and period in seconds, for x and for y), and how long one
  // round of coming and going takes. It is away for about a third of that.
  CLOUDS: [
    { sat: 90, light: 46, size: 0.24, x: [0.2, 0.2, 97], y: [0.3, 0.2, 131], hueSwing: 14, cycle: 71 },
    { sat: 85, light: 48, size: 0.22, x: [0.78, 0.16, 113], y: [0.25, 0.18, 89], hueSwing: 18, cycle: 97 },
    { sat: 90, light: 38, size: 0.22, x: [0.6, 0.28, 149], y: [0.7, 0.2, 103], hueSwing: 12, cycle: 83 },
    { sat: 85, light: 46, size: 0.2, x: [0.3, 0.24, 167], y: [0.75, 0.18, 119], hueSwing: 16, cycle: 109 },
    { sat: 80, light: 50, size: 0.22, x: [0.5, 0.32, 83], y: [0.45, 0.26, 157], hueSwing: 20, cycle: 61 },
    { sat: 85, light: 44, size: 0.18, x: [0.85, 0.1, 139], y: [0.6, 0.26, 127], hueSwing: 14, cycle: 131 },
    // Above 50%.
    { sat: 85, light: 44, size: 0.2, x: [0.4, 0.3, 107], y: [0.2, 0.15, 137], hueSwing: 14, cycle: 79 },
    { sat: 88, light: 42, size: 0.21, x: [0.7, 0.22, 127], y: [0.45, 0.3, 101], hueSwing: 16, cycle: 103 },
    { sat: 80, light: 48, size: 0.19, x: [0.15, 0.12, 151], y: [0.6, 0.3, 109], hueSwing: 12, cycle: 89 },
    { sat: 85, light: 45, size: 0.23, x: [0.55, 0.35, 173], y: [0.85, 0.12, 113], hueSwing: 18, cycle: 127 },
    { sat: 90, light: 40, size: 0.18, x: [0.9, 0.08, 93], y: [0.15, 0.12, 143], hueSwing: 14, cycle: 67 },
    { sat: 82, light: 47, size: 0.2, x: [0.35, 0.28, 131], y: [0.5, 0.35, 163], hueSwing: 16, cycle: 113 },
  ],

  // The solid schemes: [hue, saturation, lightness], as the equalizer's.
  SOLID: {
    white: [0, 0, 78],
    red: [0, 85, 46],
    green: [130, 70, 40],
    yellow: [52, 95, 48],
    blue: [215, 90, 50],
    purple: [275, 75, 52],
    black: [0, 0, 0],
  },

  init() {
    this.canvas = $('ambientCanvas');
    if (!this.canvas) return;
    this.background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || this.background;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.frozen = motion.matches;
    motion.addEventListener('change', () => {
      this.frozen = motion.matches;
    });
    this._makeFalloff();
    this._makePuffs();
    this.gl = this._webgl();
    // Each start somewhere else along the paths.
    this.time = Math.random() * 600;
    this._layout();
    new ResizeObserver(() => this._layout()).observe(document.querySelector('.content'));
    this.raf = requestAnimationFrame((t) => this._frame(t));
    Store.onSettings((patch) => {
      if (['cloudsOn', 'cloudsIntensity', 'cloudsColors', 'cloudsAmount'].some((k) => k in patch)) this._draw();
    });
  },

  /**
   * The clouds in WebGL 2, or null (then the canvas draws them): size(w, h)
   * when the canvas changes, draw(n) the first n of puffData (none: the
   * plain background). Each puff a square round it (instanced), its colour
   * at its strength times falloff (the same steps, read between them as
   * the canvas's gradient does) laid over what is there, as the canvas lays
   * it; into a quarter-size half-float target, then stretched onto the
   * screen with a speckle of a 255th at each pixel.
   */
  _webgl() {
    let gl = null;
    try {
      gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
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
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`clouds: ${gl.getProgramInfoLog(p)}`);
      return p;
    };
    const STOPS = this.STOPS;
    let puffProg;
    let showProg;
    try {
      puffProg = program(`
        layout(location = 0) in vec4 puff;     // x, y, reach (pixels, y down), strength
        layout(location = 1) in vec3 colour;
        uniform vec2 res;
        out vec2 at;                           // where in the puff, in reaches
        flat out vec4 col;
        void main() {
          int k = gl_VertexID;
          vec2 corner = vec2(k == 1 || k == 4 || k == 5 ? 1.0 : -1.0, k == 2 || k == 3 || k == 5 ? 1.0 : -1.0);
          at = corner;
          col = vec4(colour, puff.w);
          vec2 p = puff.xy + corner * puff.z;
          gl_Position = vec4(p.x / res.x * 2.0 - 1.0, 1.0 - p.y / res.y * 2.0, 0.0, 1.0);
        }`, `
        in vec2 at;
        flat in vec4 col;
        uniform float falloff[${STOPS + 1}];
        out vec4 o;
        void main() {
          float k = min(length(at), 1.0) * ${STOPS}.0;
          int i = min(int(k), ${STOPS - 1});
          float v = mix(falloff[i], falloff[i + 1], k - float(i));
          o = vec4(col.rgb, col.a * v);
        }`);
      showProg = program(`
        out vec2 uv;
        void main() {
          vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
          uv = p;
          gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
        }`, `
        in vec2 uv;
        uniform sampler2D clouds;
        uniform vec2 part;                     // how much of the target the screen covers (from its top left)
        out vec4 o;
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * .1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        void main() {
          vec3 c = texture(clouds, vec2(uv.x * part.x, 1.0 - (1.0 - uv.y) * part.y)).rgb;
          o = vec4(c + (hash12(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
        }`);
    } catch (err) {
      console.warn(err);
      return null;
    }
    const u = {
      res: gl.getUniformLocation(puffProg, 'res'),
      falloff: gl.getUniformLocation(puffProg, 'falloff[0]'),
      clouds: gl.getUniformLocation(showProg, 'clouds'),
      part: gl.getUniformLocation(showProg, 'part'),
    };
    gl.useProgram(puffProg);
    gl.uniform1fv(u.falloff, this.falloff.map(([, v]) => v));
    // The puffs, one instance each: x, y, reach, strength, r, g, b.
    const data = new Float32Array(this.CLOUDS.length * this.PUFFS * 7);
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
    // The background as the canvas has it, 0..1.
    const probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = this.background;
    const hex = probe.fillStyle;
    const bg = /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255) : [30 / 255, 30 / 255, 34 / 255];
    let target = null;
    let w = 1;
    let h = 1;
    return {
      size: (cw, ch) => {
        w = cw;
        h = ch;
        const tw = Math.max(1, Math.ceil(cw / 4));
        const th = Math.max(1, Math.ceil(ch / 4));
        if (target && target.w === tw && target.h === th) return;
        if (target) {
          gl.deleteTexture(target.tex);
          gl.deleteFramebuffer(target.fb);
        }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, tw, th, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        target = { tex, fb, w: tw, h: th };
      },
      draw: (n) => {
        if (!target) return;
        if (!n) {
          // The plain background, straight onto the screen.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
          gl.clearColor(bg[0], bg[1], bg[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          return;
        }
        const P = this.puffData;
        for (let k = 0; k < n; k += 1) {
          const q = k * 7;
          data[q] = P[q];
          data[q + 1] = P[q + 1];
          data[q + 2] = P[q + 2];
          data[q + 3] = P[q + 6];
          data[q + 4] = P[q + 3];
          data[q + 5] = P[q + 4];
          data[q + 6] = P[q + 5];
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
        gl.viewport(0, 0, target.w, target.h);
        gl.clearColor(bg[0], bg[1], bg[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        gl.useProgram(puffProg);
        // The quarter-size target covers the pixels the screen's would (4 a texel).
        gl.uniform2f(u.res, target.w * 4, target.h * 4);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * 7);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.useProgram(showProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        gl.uniform1i(u.clouds, 0);
        gl.uniform2f(u.part, w / (target.w * 4), h / (target.h * 4));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  },

  /**
   * Each cloud's puffs: scattered wide around its middle (the same every
   * start), each wandering and swelling on its own periods, so the cloud has
   * no shape to speak of and a different one every minute.
   */
  _makePuffs() {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (const cl of this.CLOUDS) {
      // Some lie, some stand.
      const stretch = 0.6 + rand() * 1.1;
      cl.puffs = [];
      for (let k = 0; k < this.PUFFS; k += 1) {
        const angle = rand() * Math.PI * 2;
        const dist = Math.sqrt(rand()) * 1.3;
        cl.puffs.push({
          dx: Math.cos(angle) * dist * stretch,
          dy: Math.sin(angle) * dist / stretch,
          r: 0.25 + rand() * 0.45,
          wander: 0.25 + rand() * 0.35,
          period: 31 + rand() * 50,
          phase: rand() * Math.PI * 2,
        });
      }
    }
  },

  /**
   * A puff's strength from its middle (0) to its edge (1), sampled at STOPS
   * points: a bell curve for the core plus a wider, fainter one for the shine,
   * lowered so it ends at exactly nothing.
   */
  _makeFalloff() {
    const at = (u) => Math.exp(-u * u) + this.SHINE_SHARE * Math.exp(-(u * u) / (this.SHINE_WIDTH * this.SHINE_WIDTH));
    const end = at(this.REACH);
    const top = at(0) - end;
    this.falloff = [];
    for (let k = 0; k <= this.STOPS; k += 1) {
      const d = k / this.STOPS;
      this.falloff.push([d, Math.max(0, (at(d * this.REACH) - end) / top)]);
    }
  },

  _layout() {
    const content = document.querySelector('.content');
    const w = Math.max(1, content.clientWidth);
    const h = Math.max(1, content.clientHeight);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (this.gl) this.gl.size(w, h);
    this._draw();
  },

  _frame(now) {
    this.raf = requestAnimationFrame((t) => this._frame(t));
    const dt = Math.min(100, Math.max(0, now - (this.lastFrame || now)));
    this.lastFrame = now;
    // Turned off in Settings: the plain background, drawn once by _draw.
    if (Store.settings.cloudsOn === false) return;
    this._follow(dt);
    // Under the full-screen visualizer nobody would see them: they were
    // about half the GPU's work there, drawn for nothing.
    if (Visualizer.shown) return;
    // With nothing playing and no pulse left to fade, fewer frames will do.
    const lively = Equalizer.bass > 0 || this.pulse > 0.002;
    if (!lively && now - this.lastDraw < 1000 / this.IDLE_FPS) return;
    if (!this.frozen) this.time += (now - (this.lastDraw || now)) / 1000;
    this.lastDraw = now;
    this._draw();
  },

  /** The bass pulse, from the equalizer's bass level. */
  _follow(dt) {
    const bass = Equalizer.bass || 0;
    // A song starting is not a hit: the average starts where the bass is.
    if (bass > 0 && !this._hearing) this.bassAverage = bass;
    this._hearing = bass > 0;
    this.bassAverage += (bass - this.bassAverage) * (1 - Math.exp(-dt / this.AVERAGE_MS));
    const hit = Math.min(1, Math.max(0, bass - this.bassAverage - this.THRESHOLD) * this.GAIN);
    this.pulse = hit > this.pulse
      ? this.pulse + (hit - this.pulse) * (1 - Math.exp(-dt / this.ATTACK_MS))
      : hit + (this.pulse - hit) * Math.exp(-dt / this.RELEASE_MS);
  },

  _draw() {
    const c = this.canvas;
    if (!c) return;
    const s = Store.settings;
    const puffs = s.cloudsOn === false ? 0 : this._puffs(c.width, c.height);
    if (this.gl) {
      this.gl.draw(puffs);
      return;
    }
    const out = c.getContext('2d');
    out.fillStyle = this.background;
    out.fillRect(0, 0, c.width, c.height);
    const P = this.puffData;
    for (let k = 0; k < puffs; k += 1) {
      const q = k * 7;
      const px = P[q];
      const py = P[q + 1];
      const reach = P[q + 2];
      const colour = this.puffColour[k];
      const strength = P[q + 6];
      const grad = out.createRadialGradient(px, py, 0, px, py, reach);
      for (const [d, v] of this.falloff) grad.addColorStop(d, colour + (strength * v).toFixed(4) + ')');
      out.fillStyle = grad;
      out.fillRect(px - reach, py - reach, reach * 2, reach * 2);
    }
  },

  /**
   * The puffs to draw now, in the order they are laid on, into puffData
   * (x, y, reach in pixels, r, g, b 0..1, strength; 7 floats each) and
   * puffColour (the canvas's 'hsla(h, s%, l%, ' each). Returns how many.
   */
  _puffs(w, h) {
    const s = Store.settings;
    const t = this.time;
    const tau = 2 * Math.PI;
    const side = Math.max(w, h);
    // Settings: intensity at 50% and bass reaction at 25% are the look as
    // designed; 100% reaction is four times that.
    const react = s.cloudsBass === false ? 0 : (s.cloudsBassAmount || 50) / 25;
    const swell = 1 + this.PULSE_GROW * this.pulse * react;
    const brighter = 1 + this.PULSE_ALPHA * this.pulse * react;
    const intensity = (s.cloudsIntensity || 50) / 50;
    const at = ([centre, reach, period], phase) => centre + reach * Math.sin((tau * t) / period + phase);
    const solid = this.SOLID[s.cloudsColors] || null;
    const amount = Number.isFinite(s.cloudsAmount) ? s.cloudsAmount : 50;
    const count = Math.round((this.CLOUDS.length * amount) / 100);
    if (!this.puffData) {
      this.puffData = new Float64Array(this.CLOUDS.length * this.PUFFS * 7);
      this.puffColour = [];
    }
    const P = this.puffData;
    let n = 0;

    this.CLOUDS.forEach((cl, i) => {
      if (i >= count) return;
      // Away while the wave is well below zero, easing in and out around it.
      const wave = Math.min(1, Math.max(0, 0.5 + 0.8 * Math.sin((tau * t) / cl.cycle + i * 2.1)));
      const here = wave * wave * (3 - 2 * wave);
      if (here < 0.005) {
        cl.away = true;
        return;
      }
      // Rainbow: a new colour each time it comes back.
      if (cl.away || cl.hue == null) {
        cl.hue = Math.random() * 360;
        cl.away = false;
      }
      const x = at(cl.x, i * 1.7) * w;
      const y = at(cl.y, i * 2.3 + 1) * h;
      // Growing as it comes, shrinking as it goes.
      const r = cl.size * side * swell * (0.7 + 0.3 * here);
      const hue = solid ? solid[0] : Number((cl.hue + cl.hueSwing * Math.sin((tau * t) / 211 + i)).toFixed(1));
      const sat = solid ? solid[1] : cl.sat;
      const light = solid ? solid[2] : cl.light;
      const colour = `hsla(${solid ? hue : hue.toFixed(1)}, ${sat}%, ${light}%, `;
      const rgb = this._rgb(hue, sat, light);
      const strength = Math.min(1, this.PUFF_ALPHA * intensity * here * brighter);

      for (const p of cl.puffs) {
        const a = (tau * t) / p.period + p.phase;
        const q = n * 7;
        P[q] = x + (p.dx + p.wander * Math.sin(a)) * r;
        P[q + 1] = y + (p.dy + p.wander * 0.6 * Math.cos(a * 0.83)) * r;
        P[q + 2] = p.r * r * (1 + 0.3 * Math.sin(a * 1.37 + 1)) * this.REACH;
        P[q + 3] = rgb[0];
        P[q + 4] = rgb[1];
        P[q + 5] = rgb[2];
        P[q + 6] = strength;
        this.puffColour[n] = colour;
        n += 1;
      }
    });
    return n;
  },

  /** hsl (degrees, percent) as the canvas takes it: r, g, b in whole 255ths, as 0..1. */
  _rgb(h, s, l) {
    const sat = s / 100;
    const lig = l / 100;
    const f = (k0) => {
      const k = (k0 + h / 30) % 12;
      const a = sat * Math.min(lig, 1 - lig);
      return Math.round(255 * (lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))) / 255;
    };
    this._rgbOut = this._rgbOut || [0, 0, 0];
    this._rgbOut[0] = f(0);
    this._rgbOut[1] = f(8);
    this._rgbOut[2] = f(4);
    return this._rgbOut;
  },

};
