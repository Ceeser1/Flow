'use strict';

// The little WebGL 2 the visualizers in this folder share: programs, a
// triangle that covers the screen, render targets to draw into and read back
// (the feedback ones draw each frame over the last), and buffers refilled
// every frame. Canvas 2D draws long paths on the CPU (see landscape.js), so
// whatever is made of many lines or pixels goes through here.

const VizGL = {
  /** The canvas's WebGL 2, or null (the visualizer then says so). */
  context(canvas, opts = {}) {
    return canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, ...opts,
    });
  },

  /** A program from its two shaders (compiled now, waiting for it); u: its uniforms by name. */
  program(gl, vs, fs) {
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, '#version 300 es\nprecision highp float;\n' + src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
    return { p, u: this._uniforms(gl, p) };
  },

  /**
   * A program compiled in the background where the browser can
   * (KHR_parallel_shader_compile), for a big shader that would hold the
   * page up for seconds the first time (before the browser has cached it):
   * ready() says whether it can be had now without waiting, done() gives
   * { p, u } as program() does (waiting if it must, throwing if it failed).
   */
  programLater(gl, vs, fs) {
    const ext = gl.getExtension('KHR_parallel_shader_compile');
    const { p, v, f } = this._link(gl, vs, fs);
    let result = null;
    return {
      ready: () => !!result || !ext || gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR),
      done: () => {
        if (result) return result;
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
          for (const s of [v, f]) {
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
          }
          throw new Error('program: ' + gl.getProgramInfoLog(p));
        }
        result = { p, u: this._uniforms(gl, p) };
        return result;
      },
    };
  },

  /** Starts compiling and linking a program, without asking how it went (which would wait for it). */
  _link(gl, vs, fs) {
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, '#version 300 es\nprecision highp float;\n' + src);
      gl.compileShader(s);
      return s;
    };
    const v = shader(gl.VERTEX_SHADER, vs);
    const f = shader(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    return { p, v, f };
  },

  /**
   * Compiles a visualizer's shaders ahead, so that when it opens the browser
   * has them cached (shared between canvases) and nothing waits: make is its
   * create(canvas). Run on a throwaway canvas, its programs are only noted
   * (none compiled there); they are compiled in a context of their own, in
   * the background (KHR_parallel_shader_compile; without it, not at all, as
   * it would hold the page up just the same), which is dropped once they
   * are done. Returns a function that stops it sooner.
   */
  warm(make) {
    const sources = [];
    const { program, programLater } = this;
    this.program = (gl, vs, fs) => {
      sources.push([vs, fs]);
      return { p: null, u: {} };
    };
    this.programLater = (gl, vs, fs) => {
      sources.push([vs, fs]);
      return { ready: () => false, done: () => { throw new Error('only being warmed'); } };
    };
    const scratch = document.createElement('canvas');
    try {
      const scene = make(scratch);
      if (scene && scene.destroy) scene.destroy();
    } catch {
      // It could not be made here; it will say so when it opens.
    } finally {
      this.program = program;
      this.programLater = programLater;
    }
    this.lose(scratch.getContext('webgl2'));

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = sources.length ? this.context(canvas) : null;
    const ext = gl && gl.getExtension('KHR_parallel_shader_compile');
    if (!ext) {
      this.lose(gl);
      return () => {};
    }
    const progs = sources.map(([vs, fs]) => this._link(gl, vs, fs).p);
    let timer = null;
    const stop = () => {
      clearInterval(timer);
      this.lose(gl);
    };
    timer = setInterval(() => {
      if (gl.isContextLost() || progs.every((p) => gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR))) stop();
    }, 250);
    return stop;
  },

  /** A program's uniforms by name, located once. */
  _uniforms(gl, p) {
    const u = {};
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i += 1) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, info.name);
    }
    return u;
  },

  // The vertex shader for a full-screen pass: uv 0..1 across it.
  SCREEN_VS: `
    out vec2 uv;
    void main() {
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      uv = p;
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`,

  /** Draws a full-screen pass with the program in use (no buffers needed). */
  screen(gl) {
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  },

  /**
   * A texture to draw into: { tex, fb, w, h }. half: 16-bit float, so faint
   * trails fading over many frames do not band or stick.
   */
  target(gl, w, h, { half = true, filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE } = {}) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const float = half && gl.getExtension('EXT_color_buffer_float');
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  },

  freeTarget(gl, t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
  },

  /** Draws into t (null: the screen) from here on. */
  into(gl, t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : gl.drawingBufferWidth, t ? t.h : gl.drawingBufferHeight);
  },

  /** Binds texture tex to unit `unit` and points the sampler uniform at it. */
  bind(gl, loc, tex, unit = 0) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  },

  /**
   * A vertex buffer refilled each frame, its attributes laid out as given:
   * [[location, size], ...] interleaved floats. Returns { vao, buf, stride,
   * data, put(count) }; write into data, then put the vertices used.
   */
  stream(gl, layout, capacity) {
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const floats = layout.reduce((n, [, size]) => n + size, 0);
    const stride = floats * 4;
    let offset = 0;
    for (const [loc, size] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      offset += size * 4;
    }
    gl.bufferData(gl.ARRAY_BUFFER, capacity * stride, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    const s = {
      vao,
      buf,
      floats,
      data: new Float32Array(capacity * floats),
      put(count) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.data, 0, count * floats);
        gl.bindVertexArray(vao);
      },
    };
    return s;
  },

  /**
   * Blurs src into dst through tmp (all targets of one size; src may be any
   * size, it is scaled down on the way): two passes, across then down, a
   * gaussian `spread` texels of dst wide. For glow.
   */
  blur(gl, src, tmp, dst, spread = 1) {
    let b = this._blurs.get(gl);
    if (!b) {
      b = this.program(gl, this.SCREEN_VS, `
        in vec2 uv;
        uniform sampler2D src;
        uniform vec2 step;
        out vec4 o;
        void main() {
          // 9 taps of a gaussian read as 5, between texels.
          vec4 c = texture(src, uv) * 0.2270270270;
          c += (texture(src, uv + step * 1.3846153846) + texture(src, uv - step * 1.3846153846)) * 0.3162162162;
          c += (texture(src, uv + step * 3.2307692308) + texture(src, uv - step * 3.2307692308)) * 0.0702702703;
          o = c;
        }`);
      this._blurs.set(gl, b);
    }
    gl.disable(gl.BLEND);
    gl.useProgram(b.p);
    this.into(gl, tmp);
    this.bind(gl, b.u.src, src.tex);
    gl.uniform2f(b.u.step, spread / tmp.w, 0);
    this.screen(gl);
    this.into(gl, dst);
    this.bind(gl, b.u.src, tmp.tex);
    gl.uniform2f(b.u.step, 0, spread / dst.h);
    this.screen(gl);
  },
  _blurs: new WeakMap(),

  /**
   * src made smaller into dst, each of dst's pixels the mean of all of src
   * under it (n x n samples), so small bright things are not missed or
   * caught whole by a single pixel, which blurred and drawn large again
   * shows as a square round them.
   */
  shrink(gl, src, dst) {
    let p = this._shrinks.get(gl);
    if (!p) {
      p = this.program(gl, this.SCREEN_VS, `
        in vec2 uv;
        uniform sampler2D src;
        uniform vec2 cell;
        uniform int n;
        out vec4 o;
        void main() {
          vec4 c = vec4(0.0);
          for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) c += texture(src, uv + ((vec2(i, j) + 0.5) / float(n) - 0.5) * cell);
          }
          o = c / float(n * n);
        }`);
      this._shrinks.set(gl, p);
    }
    gl.disable(gl.BLEND);
    gl.useProgram(p.p);
    this.into(gl, dst);
    this.bind(gl, p.u.src, src.tex);
    gl.uniform2f(p.u.cell, 1 / dst.w, 1 / dst.h);
    gl.uniform1i(p.u.n, Math.min(12, Math.ceil(Math.max(src.w / dst.w, src.h / dst.h))));
    this.screen(gl);
  },
  _shrinks: new WeakMap(),

  /**
   * Soft lines in pixels (y down), each a quad with a falloff across it:
   * seg(x0, y0, x1, y1, halfWidth, rgb, a, a1) adds one, draw(w, h) draws
   * them all with the blending set by the caller and starts over. rgb is
   * [r, g, b] 0..1; the colour leaves premultiplied (rgb * a, alpha a). a1,
   * if given, is the alpha at the far end, blended smoothly along it.
   */
  lines(gl, capacity = 30000) {
    let prog = this._lines.get(gl);
    if (!prog) {
      prog = this.program(gl, `
        layout(location = 0) in vec2 pos;
        layout(location = 1) in vec4 color;
        layout(location = 2) in float across;
        uniform vec2 res;
        out vec4 c;
        out float x;
        void main() {
          c = color;
          x = across;
          gl_Position = vec4(pos.x / res.x * 2.0 - 1.0, 1.0 - pos.y / res.y * 2.0, 0.0, 1.0);
        }`, `
        in vec4 c;
        in float x;
        out vec4 o;
        void main() {
          float f = max(0.0, 1.0 - x * x);
          f *= f;
          o = vec4(c.rgb * c.a * f, c.a * f);
        }`);
      this._lines.set(gl, prog);
    }
    const stream = this.stream(gl, [[0, 2], [1, 4], [2, 1]], capacity);
    const d = stream.data;
    const l = {
      count: 0,
      seg(x0, y0, x1, y1, width, rgb, a, a1 = a) {
        const [r, g, b] = rgb;
        if (l.count > capacity - 6) return;
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        const nx = (-(y1 - y0) / len) * width;
        const ny = ((x1 - x0) / len) * width;
        let k = l.count * 7;
        const put = (x, y, s, al) => {
          d[k] = x;
          d[k + 1] = y;
          d[k + 2] = r;
          d[k + 3] = g;
          d[k + 4] = b;
          d[k + 5] = al;
          d[k + 6] = s;
          k += 7;
        };
        put(x0 + nx, y0 + ny, 1, a);
        put(x0 - nx, y0 - ny, -1, a);
        put(x1 + nx, y1 + ny, 1, a1);
        put(x1 + nx, y1 + ny, 1, a1);
        put(x0 - nx, y0 - ny, -1, a);
        put(x1 - nx, y1 - ny, -1, a1);
        l.count += 6;
      },
      /** A solid triangle (no falloff), drawn in its place among the lines. */
      tri(x0, y0, x1, y1, x2, y2, rgb, a) {
        if (l.count > capacity - 3) return;
        let k = l.count * 7;
        for (const [x, y] of [[x0, y0], [x1, y1], [x2, y2]]) {
          d[k] = x;
          d[k + 1] = y;
          d[k + 2] = rgb[0];
          d[k + 3] = rgb[1];
          d[k + 4] = rgb[2];
          d[k + 5] = a;
          d[k + 6] = 0;
          k += 7;
        }
        l.count += 3;
      },
      /** A round dot: a short segment as long as it is wide. */
      dot(x, y, radius, rgb, a) {
        l.seg(x - radius * 0.5, y, x + radius * 0.5, y, radius, rgb, a);
      },
      draw(w, h) {
        if (!l.count) return;
        gl.useProgram(prog.p);
        gl.uniform2f(prog.u.res, w, h);
        stream.put(l.count);
        gl.drawArrays(gl.TRIANGLES, 0, l.count);
        gl.bindVertexArray(null);
        l.count = 0;
      },
    };
    return l;
  },
  _lines: new WeakMap(),

  /** Frees the GPU's memory now rather than whenever the page gets round to it. */
  lose(gl) {
    const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  },

  /** '#rrggbb' as [r, g, b] 0..1. */
  rgb(hex) {
    return [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) / 255 || 0);
  },

  /** A random place on the stars' sky (STARS' starShift), in whole pixels. */
  starShift() {
    return [Math.floor(Math.random() * 20000), Math.floor(Math.random() * 20000)];
  },

  /**
   * The stars of STAR_CELLS drawn ahead each frame into a texture of their
   * own, each only round itself, so a sky reads them in one look a pixel
   * (STAR_SKY's starField) rather than working out every star near each of
   * its pixels, as STARS does (a third of Aurora's time at 1440p). Returns
   * { draw(x, y, w, h, time, boom), use(u, unit) }: draw the part of the sky
   * from x, y (pixels on it, as the shader will ask) w by h, one texel a
   * pixel (leaves it drawing into the texture, the blending off); use binds
   * it for program uniforms u (starTex, starView) on texture unit `unit`.
   */
  starLayer(gl) {
    const prog = this.program(gl, this.NOISE + this.STAR_CELLS + this.STAR_LAYER_VS, this.NOISE + this.STAR_CELLS + this.STAR_LAYER_FS);
    const shift = this.starShift();
    let target = null;
    let view = [0, 0, 1, 1];
    return {
      draw(x, y, w, h, time, boom) {
        w = Math.max(1, Math.ceil(w));
        h = Math.max(1, Math.ceil(h));
        if (!target || target.w !== w || target.h !== h) {
          VizGL.freeTarget(gl, target);
          target = VizGL.target(gl, w, h);
        }
        view = [x, y, w, h];
        VizGL.into(gl, target);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindVertexArray(null);
        gl.useProgram(prog.p);
        const u = prog.u;
        gl.uniform2f(u.origin, x, y);
        gl.uniform2f(u.size, w, h);
        gl.uniform2f(u.starShift, ...shift);
        gl.uniform1f(u.time, time);
        gl.uniform1f(u.boom, boom);
        // The cells under it: the faint ones in their own, the bright ones
        // shining into the cells round theirs.
        for (const [bright, cell, past, corners] of [[0, 5, 0, 6], [1, 40, 1, 18]]) {
          const fx = Math.floor((x + shift[0]) / cell) - past;
          const fy = Math.floor((y + shift[1]) / cell) - past;
          const cols = Math.floor((x + w + shift[0]) / cell) + past - fx + 1;
          const rows = Math.floor((y + h + shift[1]) / cell) + past - fy + 1;
          gl.uniform2f(u.first, fx, fy);
          gl.uniform1i(u.cols, cols);
          gl.uniform1i(u.bright, bright);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, corners, cols * rows);
        }
        gl.disable(gl.BLEND);
      },
      use(u, unit) {
        if (!target) return;
        VizGL.bind(gl, u.starTex, target.tex, unit);
        gl.uniform4f(u.starView, ...view);
      },
    };
  },

  // Shared shader code: hashes and noise.
  NOISE: `
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * .1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 3.7); a *= 0.5; }
      return v;
    }
    vec3 hsv2rgb(vec3 c) {
      vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
      return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
    }`,

  // Shared shader code: a night sky's stars, one at a time (after NOISE).
  // Many faint ones a pixel across, one in some of the small cells, and
  // fewer bright ones, one in some of the big cells, larger, white to blue
  // or warm, the brightest with a halo and four thin spikes of glare
  // (flashing a little with boom, the kick).
  STAR_CELLS: `
    const float STAR_CELL = 5.0;
    const float STAR_BIG = 40.0;

    // A star's twinkle: its own speed and moment, a little irregular; depth
    // is how far it dims.
    float twinkle(vec2 g, float depth, float time) {
      float phase = hash12(g + 31.1) * 6.2831853;
      float speed = 1.2 + 4.0 * hash12(g + 41.7);
      float t = 0.5 + 0.3 * sin(time * speed + phase) + 0.2 * sin(time * speed * 2.37 + phase * 1.7);
      return 1.0 - depth * t;
    }

    // Whether small cell g has a faint star: where (c, pixels) and its light now.
    bool faintStar(vec2 g, float time, out vec2 c, out vec3 col) {
      bool on = hash12(g + 11.3) > 0.955;
      c = vec2(0.0);
      col = vec3(0.0);
      if (on) {
        c = (g + 0.2 + 0.6 * vec2(hash12(g + 3.1), hash12(g + 7.7))) * STAR_CELL;
        float b = 0.1 + 0.3 * hash12(g + 5.2) * hash12(g + 8.8);
        col = vec3(0.85, 0.9, 1.0) * b * twinkle(g, 0.6, time);
      }
      return on;
    }
    float faintGlow(vec2 d) {
      return exp(-dot(d, d) / 0.45);
    }

    // Whether big cell g has a bright star: where, how bright (m, most of
    // them modest, a few brilliant) and its light now.
    bool brightStar(vec2 g, float time, out vec2 c, out float m, out vec3 col) {
      bool on = hash12(g + 23.9) >= 0.8;
      c = vec2(0.0);
      m = 0.0;
      col = vec3(0.0);
      if (on) {
        c = (g + 0.5 + 0.8 * (vec2(hash12(g + 1.7), hash12(g + 9.4)) - 0.5)) * STAR_BIG;
        m = pow(hash12(g + 4.4), 3.0);
        vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.88, 0.72), hash12(g + 6.6));
        col = tint * (0.3 + 1.0 * m) * twinkle(g, 0.45, time);
      }
      return on;
    }
    // Its round glow at d from it.
    float brightGlow(vec2 d, float m) {
      float r = 0.65 + 1.1 * m;
      return exp(-dot(d, d) / (r * r)) + 0.1 * m * exp(-length(d) / (2.0 + 4.0 * m));
    }
    // Its spike along x (the brighter half of them), flashing a little with the bass.
    float brightSpike(vec2 d, float m, float boom) {
      if (m <= 0.5) return 0.0;
      float reach = (3.0 + 8.0 * m) * (1.0 + 0.3 * boom);
      return 0.25 * m * (1.0 + 0.8 * boom) * exp(-abs(d.y) / 0.45 - abs(d.x) / reach);
    }`,

  // Shared shader code: the stars worked out at each pixel (after NOISE),
  // for a sky seen bent (Black Hole's); a flat one is far cheaper drawn
  // ahead (starLayer).
  STARS: `
    // Where on the endless sky this one looks (VizGL.starShift(), a new place
    // each time a visualizer opens).
    uniform vec2 starShift;

    // The stars at px (pixels).
    vec3 starField(vec2 px, float time, float boom) {
      px += starShift;
      vec3 sum = vec3(0.0);
      vec2 c;
      vec3 col;
      if (faintStar(floor(px / STAR_CELL), time, c, col)) sum += col * faintGlow(px - c);
      // The bright ones look into the cells round about too: their glare
      // reaches past their own.
      vec2 g0 = floor(px / STAR_BIG);
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          float m;
          if (!brightStar(g0 + vec2(float(i), float(j)), time, c, m, col)) continue;
          vec2 d = px - c;
          sum += col * (brightGlow(d, m) + brightSpike(d, m, boom) + brightSpike(d.yx, m, boom));
        }
      }
      return sum;
    }`,

  // Shared shader code: the stars of a starLayer, read at px (pixels on its
  // sky; after NOISE).
  STAR_SKY: `
    uniform sampler2D starTex;
    uniform vec4 starView;   // the part of the sky in it: from, size (pixels)
    vec3 starField(vec2 px) {
      return texture(starTex, (px - starView.xy) / starView.zw).rgb;
    }`,

  // The starLayer's stars, each drawn as small squares round it: one
  // instance a cell (the program's bright: the big cells), most of them
  // empty (drawn as nothing). A bright star is a square as far as its glow
  // reaches and, the brightest, a bar each way for its spikes (outside the
  // square); a faint one a square within its own cell, a bright one within
  // the cells round its own, as far as STARS looks.
  STAR_LAYER_VS: `
    uniform vec2 origin, size, starShift, first;
    uniform int cols;
    uniform bool bright;
    uniform float time, boom;
    out vec2 d;
    flat out vec3 col;
    flat out vec3 shape;   // 0 faint, 1 the square, 2-3 a bar; m; the square's half width
    const float FAINT = 0.0015;   // what is not drawn
    void main() {
      vec2 g = first + vec2(float(gl_InstanceID % cols), float(gl_InstanceID / cols));
      int part = gl_VertexID / 6;
      int k = gl_VertexID % 6;
      vec2 corner = vec2(k == 1 || k == 4 || k == 5 ? 1.0 : 0.0, k == 2 || k == 3 || k == 5 ? 1.0 : 0.0);
      vec2 c, lo, hi;
      bool on;
      if (!bright) {
        on = faintStar(g, time, c, col);
        lo = max(c - 2.0, g * STAR_CELL);
        hi = min(c + 2.0, (g + 1.0) * STAR_CELL);
        shape = vec3(0.0);
      } else {
        float m;
        on = brightStar(g, time, c, m, col);
        float r = 0.65 + 1.1 * m;
        float disc = max(r * sqrt(log((0.3 + m) / FAINT)), (2.0 + 4.0 * m) * log(max(0.1 * m * (0.3 + m) / FAINT, 1.0)));
        float spike = m > 0.5 ? log(max(0.25 * m * (1.0 + 0.8 * boom) * (0.3 + m) / FAINT, 1.0)) : 0.0;
        float along = (3.0 + 8.0 * m) * (1.0 + 0.3 * boom) * spike;
        float across = 0.45 * spike;
        disc = max(disc, across);
        if (part > 0 && along <= disc) on = false;
        vec2 ext = part == 0 ? vec2(disc) : part == 1 ? vec2(along, across) : vec2(across, along);
        lo = max(c - ext, (g - 1.0) * STAR_BIG);
        hi = min(c + ext, (g + 2.0) * STAR_BIG);
        shape = vec3(float(part + 1), m, disc);
      }
      vec2 at = mix(lo, hi, corner);
      d = at - c;
      gl_Position = on ? vec4((at - starShift - origin) / size * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
    }`,

  STAR_LAYER_FS: `
    in vec2 d;
    flat in vec3 col;
    flat in vec3 shape;
    uniform float boom;
    out vec4 o;
    void main() {
      float k = shape.x;
      float m = shape.y;
      float glow;
      if (k < 0.5) glow = faintGlow(d);
      else if (k < 1.5) glow = brightGlow(d, m) + brightSpike(d, m, boom) + brightSpike(d.yx, m, boom);
      else if (max(abs(d.x), abs(d.y)) < shape.z) glow = 0.0;
      else glow = brightSpike(k < 2.5 ? d : d.yx, m, boom);
      o = vec4(col * glow, 1.0);
    }`,
};
