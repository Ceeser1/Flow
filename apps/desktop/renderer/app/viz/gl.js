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

  /** A program from its two shaders; u: its uniforms by name, located once. */
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
    const u = {};
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i += 1) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
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

  /** Frees the GPU's memory now rather than whenever the page gets round to it. */
  lose(gl) {
    const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  },

  /** '#rrggbb' as [r, g, b] 0..1. */
  rgb(hex) {
    return [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) / 255 || 0);
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
};
