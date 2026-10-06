'use strict';

// Skyline: the spectrum as a city of bars in 3D, as Winamp's 3D spectrum
// plugins did, only solid and lit. Across: the bands, bass on the left;
// into the distance: the last few seconds, the newest row at the front, so
// the music leaves a landscape of towers behind it that the camera circles
// slowly. The bars' colour goes with their height, their tops glow.
//
// Its cogwheel: the colours (classic, neon, ice, fire), the camera (circling,
// from the front, from above), how far back the history reaches.
//
// WebGL (viz/gl.js) with a depth buffer: one cube drawn for every bar at once
// (instanced), each lit by a light from the upper left and fogged into the
// distance, over a floor with a faint grid.

(() => {
  const COLS = 40;
  const MAX_ROWS = 60;
  const TOP = 9;            // a full bar's height, in cells
  const PALETTES = {
    classic: [[0.12, 0.72, 0.12], [1.0, 0.88, 0.1], [1.0, 0.16, 0.1]],
    neon: [[0.1, 0.2, 1.0], [0.85, 0.2, 1.0], [0.2, 1.0, 1.0]],
    ice: [[0.05, 0.2, 0.55], [0.2, 0.7, 1.0], [0.95, 1.0, 1.0]],
    fire: [[0.45, 0.02, 0.0], [1.0, 0.45, 0.0], [1.0, 0.95, 0.5]],
  };

  const BAR_VS = `
    layout(location = 0) in vec3 pos;
    layout(location = 1) in vec3 normal;
    layout(location = 2) in vec4 inst;    // x, z, height, fade
    uniform mat4 view, proj;
    uniform float width;
    out vec3 n;
    out float y;
    out float height;
    out float dist;
    out float fade;
    void main() {
      float hgt = max(inst.z, 0.004);
      vec3 world = vec3(inst.x + pos.x * width, pos.y * hgt, inst.y + pos.z * width);
      vec4 eye = view * vec4(world, 1.0);
      gl_Position = proj * eye;
      n = normal;
      y = pos.y * hgt;
      height = hgt;
      dist = -eye.z;
      fade = inst.w;
    }`;
  const BAR_FS = `
    in vec3 n;
    in float y;
    in float height;
    in float dist;
    in float fade;
    uniform vec3 c0, c1, c2;
    uniform float fog, top;
    out vec4 o;
    vec3 palette(float t) {
      return t < 0.5 ? mix(c0, c1, t * 2.0) : mix(c1, c2, (t - 0.5) * 2.0);
    }
    void main() {
      vec3 base = palette(clamp(y / top, 0.0, 1.0));
      // From above and in front, so both sides of a bar look alike.
      vec3 l = normalize(vec3(0.0, 0.8, 0.6));
      float lit = 0.35 + 0.65 * max(dot(n, l), 0.0) + 0.12 * abs(n.x);
      vec3 col = base * lit;
      // The tops glow.
      if (n.y > 0.5) col = mix(col, palette(clamp(height / top, 0.0, 1.0)) * 1.4 + 0.15, 0.6);
      col *= fade;
      float f = exp(-dist * fog);
      o = vec4(col * f, 1.0);
    }`;

  const FLOOR_VS = `
    layout(location = 0) in vec2 pos;
    uniform mat4 view, proj;
    out vec2 w;
    out float dist;
    void main() {
      w = pos;
      vec4 eye = view * vec4(pos.x, 0.0, pos.y, 1.0);
      dist = -eye.z;
      gl_Position = proj * eye;
    }`;
  const FLOOR_FS = `
    in vec2 w;
    in float dist;
    uniform vec3 tint;
    uniform float fog;
    out vec4 o;
    void main() {
      vec2 g = abs(fract(w) - 0.5);
      vec2 fw = fwidth(w);
      float line = max(1.0 - smoothstep(0.0, fw.x * 1.5, 0.5 - g.x), 1.0 - smoothstep(0.0, fw.y * 1.5, 0.5 - g.y));
      vec3 col = vec3(0.01, 0.012, 0.02) + tint * line * 0.12;
      o = vec4(col * exp(-dist * fog), 1.0);
    }`;

  // A unit cube, x and z -0.5..0.5, y 0..1, with its faces' normals.
  function cube() {
    const faces = [
      [[0, 1, 0], [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]],
      [[0, 0, 1], [[-1, 0, 1], [1, 0, 1], [1, 1, 1], [-1, 1, 1]]],
      [[0, 0, -1], [[1, 0, -1], [-1, 0, -1], [-1, 1, -1], [1, 1, -1]]],
      [[1, 0, 0], [[1, 0, 1], [1, 0, -1], [1, 1, -1], [1, 1, 1]]],
      [[-1, 0, 0], [[-1, 0, -1], [-1, 0, 1], [-1, 1, 1], [-1, 1, -1]]],
    ];
    const out = [];
    for (const [nrm, q] of faces) {
      for (const i of [0, 1, 2, 0, 2, 3]) out.push(q[i][0] * 0.5, q[i][1], q[i][2] * 0.5, ...nrm);
    }
    return new Float32Array(out);
  }

  // Column-major 4 x 4 matrices.
  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function lookAt(eye, at, up) {
    const z = norm(sub(eye, at));
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(...a) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };

  class Skyline {
    constructor(canvas) {
      const gl = VizGL.context(canvas, { depth: true, antialias: true });
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.bar = VizGL.program(gl, BAR_VS, BAR_FS);
      this.floor = VizGL.program(gl, FLOOR_VS, FLOOR_FS);

      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const geo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, geo);
      gl.bufferData(gl.ARRAY_BUFFER, cube(), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      this.instBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, COLS * MAX_ROWS * 16, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(2, 1);
      this.floorVao = gl.createVertexArray();
      gl.bindVertexArray(this.floorVao);
      const fb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, fb);
      const S = 80;
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-S, -S, S, -S, S, S, -S, -S, S, S, -S, S]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindVertexArray(null);

      this.inst = new Float32Array(COLS * MAX_ROWS * 4);
      this.rows = [];        // newest first, each COLS heights 0..1
      this.offset = 0;
      this.map = null;
      this.angle = -0.5;
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

    /** The heights now: the bands gathered into COLS, 40 Hz to 14 kHz. */
    _row(a) {
      if (!this.map) {
        this.map = [];
        for (let i = 0; i <= COLS; i += 1) {
          const hz = 40 * (14000 / 40) ** (i / COLS);
          this.map.push(Math.max(0, Math.min(a.BANDS, Math.round(Math.log(hz / a.MIN_HZ) / Math.log(a.MAX_HZ / a.MIN_HZ) * a.BANDS))));
        }
      }
      const row = new Float32Array(COLS);
      for (let i = 0; i < COLS; i += 1) {
        const from = this.map[i];
        const to = Math.max(from + 1, this.map[i + 1]);
        let v = 0;
        for (let j = from; j < to; j += 1) v = Math.max(v, 0.35 * a.smooth[Math.min(a.BANDS - 1, j)] + 0.7 * a.dynamic[Math.min(a.BANDS - 1, j)]);
        row[i] = Math.min(1, v) ** 1.8;
      }
      return row;
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      const depth = Math.round((MAX_ROWS * set('skHistory')) / 100);
      // About 14 rows a second (seven a beat at 120 BPM: the tempo's pace),
      // the newest one following the music every frame.
      this.offset += dt * 14 * (a.playing ? a.pace : 0.2);
      if (!this.rows.length) this.rows.unshift(this._row(a));
      while (this.offset >= 1) {
        this.offset -= 1;
        this.rows.unshift(this._row(a));
      }
      this.rows[0] = this._row(a);
      if (this.rows.length > depth + 1) this.rows.length = depth + 1;

      let count = 0;
      for (let r = 0; r < this.rows.length; r += 1) {
        const z = -(r + (r ? this.offset : 0)) * 1.0;
        const fade = Math.min(1, (depth - r - this.offset) / 4);
        if (fade <= 0) continue;
        const row = this.rows[r];
        for (let i = 0; i < COLS; i += 1) {
          const k = count * 4;
          // A bar, not a gap, in the middle: seen from the front a gap would
          // open a dark line all the way back.
          this.inst[k] = i - COLS / 2;
          this.inst[k + 1] = z;
          this.inst[k + 2] = row[i] * TOP;
          this.inst[k + 3] = fade;
          count += 1;
        }
      }

      // The camera.
      const camera = set('skCamera');
      let eye;
      let at;
      if (camera === 'front') {
        eye = [0, 13, 24];
        at = [0, 2, -10];
      } else if (camera === 'above') {
        eye = [Math.sin(this.age * 0.05) * 6, 42, 10];
        at = [0, 0, -14];
      } else {
        this.angle += dt * 0.12 * (a.playing ? 1 : 0.3);
        const r = 34;
        eye = [Math.sin(this.angle) * r, 14 + 4 * Math.sin(this.age * 0.17), -10 + Math.cos(this.angle) * r];
        at = [0, 2, -12];
      }
      const view = lookAt(eye, at, [0, 1, 0]);
      const proj = perspective(0.9, this.w / this.h, 0.5, 300);
      const pal = PALETTES[set('skColors')] || PALETTES.classic;
      const fog = 0.022;

      const gl = this.gl;
      VizGL.into(gl, null);
      gl.clearColor(0.004, 0.005, 0.01, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      gl.useProgram(this.floor.p);
      gl.uniformMatrix4fv(this.floor.u.view, false, view);
      gl.uniformMatrix4fv(this.floor.u.proj, false, proj);
      gl.uniform3f(this.floor.u.tint, ...pal[1]);
      gl.uniform1f(this.floor.u.fog, fog);
      gl.bindVertexArray(this.floorVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.useProgram(this.bar.p);
      const u = this.bar.u;
      gl.uniformMatrix4fv(u.view, false, view);
      gl.uniformMatrix4fv(u.proj, false, proj);
      gl.uniform1f(u.width, 0.78);
      gl.uniform3f(u.c0, ...pal[0]);
      gl.uniform3f(u.c1, ...pal[1]);
      gl.uniform3f(u.c2, ...pal[2]);
      gl.uniform1f(u.fog, fog);
      gl.uniform1f(u.top, TOP);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, count * 4);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, count);
      gl.bindVertexArray(null);
      gl.disable(gl.DEPTH_TEST);
    }
  }

  Visualizer.add({
    id: 'skyline',
    name: 'Skyline',
    desc: 'The spectrum as a city of bars in 3D: the last few seconds stretch away into the distance as the camera circles',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V11h3v10M10 21V6h4v15M16 21v-7h3v7"/></svg>',
    gl: true,
    create: (canvas) => new Skyline(canvas),
    options: [
      { type: 'choice', key: 'skColors', label: 'Colors', choices: [['classic', 'Classic'], ['neon', 'Neon'], ['ice', 'Ice'], ['fire', 'Fire']] },
      { type: 'choice', key: 'skCamera', label: 'Camera', choices: [['orbit', 'Circling'], ['front', 'Front'], ['above', 'Above']] },
      { type: 'slider', key: 'skHistory', label: 'History', min: 25, max: 100, step: 5 },
    ],
  });
})();
