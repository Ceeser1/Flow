'use strict';

// Attractor: a strange attractor drawn by a million points, each one sent
// round the same simple formula until it settles onto the shape the formula
// keeps coming back to. Every eight bars the formula's numbers glide to
// another set and the shape melts into the next; the bass and the mids
// nudge them, so it breathes with the music; it turns slowly, faster with
// the tempo, and flares on the kicks. Clifford's and De Jong's are flat
// webs of silk; Lorenz's is the butterfly, turning in space.
//
// Its cogwheel: which attractor, the colours, how fast it turns.
//
// WebGL (viz/gl.js): the points cost nothing to keep: each frame every
// point starts again from its own random place and is iterated in the
// vertex shader, coloured by its last step, and added up in a float
// texture, which is then lit with a soft glow.

(() => {
  const POINTS = 1 << 20;
  const SETS = {
    clifford: [[-1.4, 1.6, 1.0, 0.7], [1.1, -1.32, -1.03, 1.54], [1.7, 1.7, 0.06, 1.2], [-1.7, 1.3, -0.1, -1.21], [-1.8, -2.0, -0.5, -0.9], [1.5, -1.8, 1.6, 0.9]],
    dejong: [[1.641, 1.902, 0.316, 1.525], [-2.24, 0.43, -0.65, -2.43], [2.01, -2.53, 1.61, -0.33], [-2.7, -0.09, -0.86, -2.2], [1.4, -2.3, 2.4, -2.1]],
    // Lorenz: sigma, rho, beta, (unused)
    lorenz: [[10, 28, 8 / 3, 0], [10, 32, 8 / 3, 0], [12, 26, 2.4, 0], [9, 30, 3, 0]],
  };
  const PALETTES = { fire: 0, ice: 1, rainbow: 2, gold: 3 };

  const POINT_VS = `
    uniform vec4 P;
    uniform int kind;
    uniform vec2 res;
    uniform float turn, tilt, scale, weight;
    uniform int palette;
    out vec3 vcol;
    uint hash(uint x) {
      x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
      return x;
    }
    float rnd(uint s) { return float(hash(s)) / 4294967295.0; }
    vec3 hsv2rgb(vec3 c) {
      vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
      return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
    }
    vec3 shade(float t) {
      if (palette == 0) return mix(mix(vec3(0.6, 0.05, 0.02), vec3(1.0, 0.45, 0.05), smoothstep(0.0, 0.5, t)), vec3(1.0, 0.9, 0.5), smoothstep(0.5, 1.0, t));
      if (palette == 1) return mix(mix(vec3(0.05, 0.15, 0.7), vec3(0.1, 0.7, 1.0), smoothstep(0.0, 0.5, t)), vec3(0.85, 0.95, 1.0), smoothstep(0.5, 1.0, t));
      if (palette == 3) return mix(vec3(0.55, 0.3, 0.05), vec3(1.0, 0.85, 0.45), t);
      return hsv2rgb(vec3(t, 0.75, 1.0));
    }
    void main() {
      uint id = uint(gl_VertexID);
      vec2 p = vec2(rnd(id * 2u), rnd(id * 2u + 1u)) * 4.0 - 2.0;
      vec2 prev = p;
      vec2 pos;
      float t;
      if (kind == 2) {
        // (Long enough to settle onto the butterfly from anywhere.)
        vec3 q = vec3(p * 12.0, 10.0 + rnd(id * 7u + 3u) * 30.0);
        vec3 dq = vec3(0.0);
        for (int i = 0; i < 380; i++) {
          dq = vec3(P.x * (q.y - q.x), q.x * (P.y - q.z) - q.y, q.x * q.y - P.z * q.z);
          q += dq * 0.009;
        }
        q.z -= P.y - 3.0;
        float c = cos(turn), s = sin(turn);
        q = vec3(c * q.x + s * q.y, -s * q.x + c * q.y, q.z);
        float ct = cos(tilt), st = sin(tilt);
        q = vec3(q.x, ct * q.y - st * q.z, st * q.y + ct * q.z);
        float persp = 1.0 / (1.0 + q.y * 0.012);
        pos = vec2(q.x, q.z) * persp / 30.0;
        t = clamp(length(dq) / 220.0, 0.0, 1.0);
      } else {
        for (int i = 0; i < 30; i++) {
          prev = p;
          if (kind == 0) p = vec2(sin(P.x * p.y) + P.z * cos(P.x * p.x), sin(P.y * p.x) + P.w * cos(P.y * p.y));
          else p = vec2(sin(P.x * p.y) - cos(P.y * p.x), sin(P.z * p.x) - cos(P.w * p.y));
        }
        vec2 d = p - prev;
        t = fract(atan(d.y, d.x) / 6.2831853 + 0.5);
        if (palette != 2) t = clamp(length(d) / 2.5, 0.0, 1.0);
        pos = kind == 0 ? p / vec2(1.0 + abs(P.z), 1.0 + abs(P.w)) : p / 1.7;
        float c = cos(turn), s = sin(turn);
        pos = vec2(c * pos.x - s * pos.y, s * pos.x + c * pos.y);
      }
      vcol = shade(t) * weight;
      gl_Position = vec4(pos * scale / vec2(res.x / res.y, 1.0), 0.0, 1.0);
      gl_PointSize = 1.0;
    }`;

  // Lorenz's: one long path, worked out once per shape, drawn as a thread
  // turning in space, a comet running along it.
  const PATH = 120000;
  const LINE_VS = `
    layout(location = 0) in vec4 pos;      // x, y, z, speed
    uniform vec2 res;
    uniform float turn, tilt, scale, weight, head, tail, rho;
    uniform int palette;
    out vec3 vcol;
    vec3 hsv2rgb(vec3 c) {
      vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
      return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
    }
    vec3 shade(float t) {
      if (palette == 0) return mix(mix(vec3(0.6, 0.05, 0.02), vec3(1.0, 0.45, 0.05), smoothstep(0.0, 0.5, t)), vec3(1.0, 0.9, 0.5), smoothstep(0.5, 1.0, t));
      if (palette == 1) return mix(mix(vec3(0.05, 0.15, 0.7), vec3(0.1, 0.7, 1.0), smoothstep(0.0, 0.5, t)), vec3(0.85, 0.95, 1.0), smoothstep(0.5, 1.0, t));
      if (palette == 3) return mix(vec3(0.55, 0.3, 0.05), vec3(1.0, 0.85, 0.45), t);
      return hsv2rgb(vec3(t * 0.8, 0.75, 1.0));
    }
    void main() {
      vec3 q = pos.xyz;
      q.z -= rho - 3.0;
      float c = cos(turn), s = sin(turn);
      q = vec3(c * q.x + s * q.y, -s * q.x + c * q.y, q.z);
      float ct = cos(tilt), st = sin(tilt);
      q = vec3(q.x, ct * q.y - st * q.z, st * q.y + ct * q.z);
      float persp = 1.0 / (1.0 + q.y * 0.012);
      vec2 p = vec2(q.x, q.z) * persp / 30.0;
      // The comet: brightest at its head, fading along its tail behind.
      float behind = head - float(gl_VertexID);
      if (behind < 0.0) behind += ${PATH}.0;
      float comet = behind < tail ? pow(1.0 - behind / tail, 2.0) : 0.0;
      vcol = shade(clamp(pos.w / 220.0, 0.0, 1.0)) * weight * (1.0 + comet * 14.0) + vec3(1.0) * comet * weight * 6.0;
      gl_Position = vec4(p * scale / vec2(res.x / res.y, 1.0), 0.0, 1.0);
    }`;

  const POINT_FS = `
    in vec3 vcol;
    out vec4 o;
    void main() {
      o = vec4(vcol, 1.0);
    }`;

  const SHOW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D dens, glow;
    uniform float exposure, time, flare;
    out vec4 o;
    void main() {
      vec3 d = texture(dens, uv).rgb;
      vec3 g = texture(glow, uv).rgb;
      vec3 c = 1.0 - exp(-(d * exposure + g * exposure * (0.6 + flare)));
      c = pow(c, vec3(0.9));
      c += vec3(0.008, 0.008, 0.014) * (1.0 - length(uv - 0.5));
      c += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(c, 1.0);
    }`;

  class Attractor {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.points = VizGL.program(gl, POINT_VS, POINT_FS);
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.vao = gl.createVertexArray();
      this.line = VizGL.program(gl, LINE_VS, POINT_FS);
      this.pathVao = gl.createVertexArray();
      this.pathBuf = gl.createBuffer();
      this.pathFor = null;
      this.head = 0;
      this.kind = null;
      this.from = null;
      this.to = null;
      this.blend = 1;
      this.index = 0;
      this.beatN = 0;
      this.ph = 0;
      this.turn = 0;
      this.flare = 0;
      this.age = 0;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.t, this.b1, this.b2]) VizGL.freeTarget(gl, t);
      this.t = VizGL.target(gl, w, h);
      const sw = Math.max(1, Math.round(w / 4));
      const sh = Math.max(1, Math.round(h / 4));
      this.b1 = VizGL.target(gl, sw, sh);
      this.b2 = VizGL.target(gl, sw, sh);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    _next() {
      const sets = SETS[this.kind];
      this.from = this._params();
      this.index = (this.index + 1 + Math.floor(Math.random() * (sets.length - 1))) % sets.length;
      this.to = sets[this.index];
      this.blend = 0;
    }

    /** Lorenz's path for these numbers: a long run of small steps, once settled. */
    _path(P) {
      const gl = this.gl;
      const [sg, rho, beta] = P;
      const data = new Float32Array(PATH * 4);
      let x = 0.1;
      let y = 0;
      let z = 0;
      const h = 0.004;
      const d = (x1, y1, z1) => [sg * (y1 - x1), x1 * (rho - z1) - y1, x1 * y1 - beta * z1];
      for (let i = -2000; i < PATH; i += 1) {
        // Runge-Kutta, so the path keeps its shape over all those steps.
        const k1 = d(x, y, z);
        const k2 = d(x + (h / 2) * k1[0], y + (h / 2) * k1[1], z + (h / 2) * k1[2]);
        const k3 = d(x + (h / 2) * k2[0], y + (h / 2) * k2[1], z + (h / 2) * k2[2]);
        const k4 = d(x + h * k3[0], y + h * k3[1], z + h * k3[2]);
        x += (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
        y += (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
        z += (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
        if (i >= 0) data.set([x, y, z, Math.hypot(k1[0], k1[1], k1[2])], i * 4);
      }
      gl.bindVertexArray(this.pathVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pathBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      gl.bindVertexArray(null);
      this.pathFor = P.join();
    }

    _params() {
      const e = this.blend * this.blend * (3 - 2 * this.blend);
      return this.from.map((v, i) => v + (this.to[i] - v) * e);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      const kind = set('atKind');
      if (kind !== this.kind) {
        this.kind = kind;
        const sets = SETS[kind] || SETS.clifford;
        this.index = Math.floor(Math.random() * sets.length);
        this.from = sets[this.index];
        this.to = sets[this.index];
        this.blend = 1;
      }
      // The beat: another shape every eight bars (or every 16 s without one).
      let tick = false;
      if (a.playing) {
        if (a.sure >= 0.35 && a.bpm) {
          tick = a.tick;
          this.ph = a.phase;
        } else {
          this.ph += dt * 2;
          tick = this.ph >= 1;
          if (tick) this.ph -= 1;
        }
      }
      if (tick && ++this.beatN % 32 === 0) this._next();
      this.blend = Math.min(1, this.blend + dt / 4);
      if (a.playing && a.onset) this.flare = Math.max(this.flare, a.onsetPower);
      this.flare *= Math.exp(-dt * 4);
      this.turn += dt * 0.08 * (set('atSpin') / 100) * (a.playing ? a.pace : 0.2);

      // The numbers, nudged by the music: it breathes.
      const P = this._params();
      const lorenz = this.kind === 'lorenz';
      if (a.playing) {
        if (lorenz) P[1] += (a.bass - 0.4) * 3;
        else {
          P[0] += (a.bass - 0.4) * 0.06;
          P[1] += (a.mid - 0.3) * 0.05;
        }
      }

      VizGL.into(gl, this.t);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      if (lorenz) {
        // The path for the shape it is gliding to (changed in a stroke).
        const target = this.to;
        if (this.pathFor !== target.join()) this._path(target);
        // The comet runs round at the tempo.
        this.head = (this.head + dt * (a.playing ? 2400 * a.rush : 300)) % PATH;
        gl.useProgram(this.line.p);
        const w = this.line.u;
        gl.uniform2f(w.res, this.w, this.h);
        gl.uniform1f(w.turn, this.turn * 3);
        gl.uniform1f(w.tilt, 0.25 + 0.15 * Math.sin(this.age * 0.05));
        gl.uniform1f(w.scale, 1.1 * (1 + 0.02 * a.throb));
        gl.uniform1f(w.weight, 0.05 * (this.h / 1080));
        gl.uniform1f(w.head, this.head);
        gl.uniform1f(w.tail, 1500 + 2500 * a.level);
        gl.uniform1f(w.rho, target[1]);
        gl.uniform1i(w.palette, PALETTES[set('atColors')] ?? 0);
        gl.bindVertexArray(this.pathVao);
        gl.drawArrays(gl.LINE_STRIP, 0, PATH);
        gl.bindVertexArray(null);
      }
      gl.useProgram(this.points.p);
      const u = this.points.u;
      gl.uniform4f(u.P, P[0], P[1], P[2], P[3]);
      gl.uniform1i(u.kind, lorenz ? 2 : this.kind === 'dejong' ? 1 : 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.turn, this.turn * (lorenz ? 3 : 1));
      gl.uniform1f(u.tilt, 0.25 + 0.15 * Math.sin(this.age * 0.05));
      gl.uniform1f(u.scale, lorenz ? 1.55 : 0.88 * (1 + 0.02 * a.throb));
      // Each point's share of the light: about the same whatever the screen.
      gl.uniform1f(u.weight, (this.w * this.h) / POINTS * (lorenz ? 0.12 : 0.05));
      gl.uniform1i(u.palette, PALETTES[set('atColors')] ?? 0);
      gl.bindVertexArray(this.vao);
      if (!lorenz) gl.drawArrays(gl.POINTS, 0, POINTS);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      VizGL.blur(gl, this.t, this.b1, this.b2, 1);
      VizGL.blur(gl, this.b2, this.b1, this.b2, 1.5);

      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      const v = this.show.u;
      VizGL.bind(gl, v.dens, this.t.tex, 0);
      VizGL.bind(gl, v.glow, this.b2.tex, 1);
      gl.uniform1f(v.exposure, (a.playing ? 0.8 + 0.6 * a.level : 0.7) * (1 + this.flare * 0.6));
      gl.uniform1f(v.time, this.age);
      gl.uniform1f(v.flare, this.flare);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'attractor',
    name: 'Attractor',
    desc: 'A strange attractor drawn by a million points, melting into a new shape every few bars and breathing with the bass',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 12c-3-5-9-4-9 0s6 5 9 0 9-4 9 0-6 5-9 0z"/><path d="M12 12c-2-3-5-2.5-5 0s3 3 5 0 5-2.5 5 0-3 3-5 0z"/></svg>',
    gl: true,
    create: (canvas) => new Attractor(canvas),
    options: [
      { type: 'choice', key: 'atKind', label: 'Attractor', choices: [['clifford', 'Clifford'], ['dejong', 'De Jong'], ['lorenz', 'Lorenz']] },
      { type: 'choice', key: 'atColors', label: 'Colours', choices: [['fire', 'Fire'], ['ice', 'Ice'], ['rainbow', 'Rainbow'], ['gold', 'Gold']] },
      { type: 'slider', key: 'atSpin', label: 'Turning', min: 0, max: 300, step: 5 },
    ],
  });
})();
