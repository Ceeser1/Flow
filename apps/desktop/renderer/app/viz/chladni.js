'use strict';

// Chladni: sand on a metal plate set ringing by the music, gathering where
// the plate stands still. Which way it rings (its mode, and so the figure
// the sand draws) comes from the note the music has dwelt on lately: a new
// one, held a moment, and the sand runs from the old lines to the new ones,
// on a beat when there is one. The louder, the more the grains dance off the
// lines and the faster they find them again; a kick jolts them all.
// A click rings the next figure.
//
// Its cogwheel: a square or a round plate or the whole screen, the sand's
// colour (or the colour of the harmony), how hard it shakes.
//
// WebGL (viz/gl.js): the grains (a quarter of a million) live in a float
// texture, moved each frame by a pass over it towards the nearest line of
// the figure (a Newton step on the plate's motion) plus a random dance as
// big as the plate moves there; they are then drawn as points into a texture
// of how much sand lies where, laid on the plate with a little shadow.

(() => {
  const SIDE = 512;            // grains: SIDE x SIDE
  // The figures: [n, m, sign] for the square plate (the two modes n, m
  // ringing together, in or out of step), [l, k] for the round one (l
  // diameters, k circles). One per pitch class, C first.
  const SQUARE = [[1, 4, -1], [2, 5, 1], [3, 4, -1], [1, 6, 1], [3, 5, -1], [2, 7, -1], [4, 5, 1], [3, 7, -1], [1, 8, -1], [5, 6, 1], [4, 7, -1], [3, 8, 1]];
  // Round: [l, k, mix], a second mode (l + 4 diameters, k + 1 circles)
  // ringing with the first as strong as mix, bending its lines.
  const ROUND = [[2, 2, 0.5], [3, 2, -0.6], [4, 3, 0.45], [1, 3, 0.7], [5, 2, -0.5], [2, 4, 0.55], [6, 3, -0.4], [3, 4, 0.6], [4, 2, -0.7], [7, 3, 0.4], [5, 4, -0.5], [0, 3, 0.8]];
  const SAND = { sand: [0.96, 0.9, 0.78], gold: [1, 0.78, 0.38], ice: [0.75, 0.9, 1] };

  const FIELD = `
    const float PI = 3.14159265;
    uniform vec3 modeA, modeB;
    uniform float blend;
    uniform int shape;          // 0 square (or the screen), 1 round
    uniform vec2 stretch;       // the whole screen: wider than high, the figure not stretched
    float fieldOf(vec3 md, vec2 p) {
      if (shape == 1) {
        float r = length(p);
        float th = atan(p.y, p.x);
        return (cos(md.x * th) * sin(md.y * PI * r) + md.z * cos((md.x + 4.0) * th) * sin((md.y + 1.0) * PI * r)) / (1.0 + abs(md.z));
      }
      vec2 u = p * stretch * 0.5 + 0.5;
      float a = md.x * PI, b = md.y * PI;
      return 0.5 * (cos(a * u.x) * cos(b * u.y) + md.z * cos(b * u.x) * cos(a * u.y));
    }
    float field(vec2 p) {
      return mix(fieldOf(modeA, p), fieldOf(modeB, p), blend);
    }`;

  const STEP_FS = VizGL.NOISE + FIELD + `
    uniform sampler2D state;
    uniform float dt, sdt, time, shake, pull, jolt;
    out vec4 o;
    vec2 rand2(vec2 s) {
      return vec2(hash12(s), hash12(s + 71.3)) * 2.0 - 1.0;
    }
    bool outside(vec2 p) {
      return shape == 1 ? dot(p, p) > 1.0 : (abs(p.x) > 1.0 || abs(p.y) > 1.0);
    }
    void main() {
      vec4 s = texelFetch(state, ivec2(gl_FragCoord.xy), 0);
      vec2 p = s.xy;
      const float e = 0.0015;
      float f = field(p);
      vec2 g = vec2(field(p + vec2(e, 0.0)) - field(p - vec2(e, 0.0)), field(p + vec2(0.0, e)) - field(p - vec2(0.0, e))) / (2.0 * e);
      float gl = max(length(g), 1e-3);
      // Towards the nearest still line: half the way there (the slope says
      // how far), at most as far as the plate's pull carries a grain.
      float dist = abs(f) / gl;
      p -= sign(f) * (g / gl) * min(dist * 0.3, pull * dt);
      // The dance: as big as the plate moves here (and a little even on the
      // still lines, so they lie a few grains wide); a jolt for all.
      vec2 seed = gl_FragCoord.xy + fract(time * 13.37) * 1000.0;
      p += rand2(seed) * ((abs(f) + 0.16) * shake * sdt + jolt * (0.004 + abs(f) * 0.04));
      // Off the edge: sprinkled back on somewhere.
      if (outside(p)) {
        vec2 q = rand2(seed + 19.1);
        if (shape == 1) q = normalize(q + 1e-4) * sqrt(hash12(seed + 5.7)) * 0.99;
        p = q;
      }
      o = vec4(p, s.zw);
    }`;

  const POINT_VS = `
    uniform sampler2D state;
    uniform vec2 center, halfSize, res;
    uniform float size;
    out float weight;
    void main() {
      int id = gl_VertexID;
      vec4 s = texelFetch(state, ivec2(id % ${SIDE}, id / ${SIDE}), 0);
      vec2 px = center + s.xy * halfSize;
      gl_Position = vec4(px / res * 2.0 - 1.0, 0.0, 1.0);
      gl_PointSize = size;
      weight = 0.55 + 0.9 * s.z;
    }`;

  const POINT_FS = `
    in float weight;
    out vec4 o;
    void main() {
      o = vec4(weight, 0.0, 0.0, 1.0);
    }`;

  const SHOW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D dens;
    uniform vec2 res, center, halfSize;
    uniform int shape;
    uniform bool full;
    uniform vec3 sand;
    uniform float time, quake, glow;
    out vec4 o;
    void main() {
      vec2 px = uv * res;
      vec2 p = (px - center) / halfSize;
      float aa = 1.5 / halfSize.y;
      // The plate: square or round, its edge, the bolt it is held by.
      float edge = shape == 1 ? length(p) : max(abs(p.x), abs(p.y));
      float inside = full ? 1.0 : 1.0 - smoothstep(1.0 - aa, 1.0 + aa, edge);
      vec3 room = vec3(0.025, 0.024, 0.028) * (1.0 - 0.6 * length(uv - 0.5)) + vec3(0.03, 0.028, 0.025) * exp(-dot(p, p) * 0.6);
      // Dark steel: a soft sheen across, a finer grain, the rim catching light.
      float sheen = exp(-pow(dot(p, normalize(vec2(1.0, -0.6))) * 1.2 - 0.3, 2.0) * 2.0);
      float grain = vnoise(px * vec2(0.6, 0.02)) * 0.5 + vnoise(px * 0.9) * 0.5;
      vec3 steel = vec3(0.055, 0.06, 0.068) + vec3(0.05, 0.052, 0.058) * sheen + (grain - 0.5) * 0.012;
      float rim = full ? 0.0 : smoothstep(0.985, 1.0, edge) * inside;
      steel += rim * 0.12;
      float bolt = length(px - center);
      float br = halfSize.y * 0.035;
      vec3 boltCol = vec3(0.16, 0.165, 0.17) * (0.7 + 0.6 * dot(normalize(p + 1e-4), normalize(vec2(-0.6, 0.7))) * smoothstep(br * 0.4, br, bolt));
      steel = mix(steel, boltCol, 1.0 - smoothstep(br - 1.0, br + 1.0, bolt));
      vec3 col = mix(room, steel, inside);
      // The sand, with a little shadow down and to the right of it.
      vec2 sh = vec2(1.5, -1.5) / res;
      float d = texture(dens, uv).r;
      float ds = texture(dens, uv + sh).r;
      col *= 1.0 - 0.55 * (1.0 - exp(-ds * 0.35)) * inside;
      float cover = 1.0 - exp(-d * 0.22);
      vec3 grains = sand * (0.75 + 0.35 * cover) + glow * sand * cover * 0.6;
      col = mix(col, grains, cover * inside);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  function hsv(h, s, v) {
    const f = (n) => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }

  class Chladni {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no float textures');
      this.gl = gl;
      this.step = VizGL.program(gl, VizGL.SCREEN_VS, STEP_FS);
      this.points = VizGL.program(gl, POINT_VS, POINT_FS);
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.vao = gl.createVertexArray();
      this.state = [this._stateTarget(), this._stateTarget()];
      this.cur = 0;
      this.shape = null;
      this.mode = 0;          // the pitch class whose figure is ringing
      this.prevMode = 0;
      this.blend = 1;
      this.chroma = new Float32Array(12);
      this.pending = 0;
      this.since = 0;
      this.age = 0;
      this.jolt = 0;
      this.hue = 0;
      this.w = 1;
      this.h = 1;
    }

    /** A float texture of SIDE x SIDE grains: x, y on the plate (-1..1), a weight, spare. */
    _stateTarget() {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SIDE, SIDE, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fb, w: SIDE, h: SIDE };
    }

    /** Sand sprinkled evenly over the plate. */
    _sprinkle(round) {
      const gl = this.gl;
      const data = new Float32Array(SIDE * SIDE * 4);
      for (let i = 0; i < SIDE * SIDE; i += 1) {
        let x;
        let y;
        do {
          x = Math.random() * 2 - 1;
          y = Math.random() * 2 - 1;
        } while (round && x * x + y * y > 0.98);
        data[i * 4] = x;
        data[i * 4 + 1] = y;
        data[i * 4 + 2] = Math.random();
        data[i * 4 + 3] = 0;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.state[this.cur].tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SIDE, SIDE, gl.RGBA, gl.FLOAT, data);
    }

    size(w, h) {
      this.w = w;
      this.h = h;
      VizGL.freeTarget(this.gl, this.dens);
      this.dens = VizGL.target(this.gl, w, h);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    /** The next figure, now (a click). */
    next() {
      this._ring((this.mode + 1) % 12);
    }

    _ring(mode) {
      this.prevMode = this.mode;
      this.mode = mode;
      this.blend = 0;
      this.since = 0;
      this.pending = 0;
      this.jolt = Math.max(this.jolt, 0.6);
    }

    _uniformsMode(u, shape) {
      const gl = this.gl;
      const md = (i) => (shape === 1 ? ROUND[i] : SQUARE[i]);
      gl.uniform3fv(u.modeA, md(this.prevMode));
      gl.uniform3fv(u.modeB, md(this.mode));
      gl.uniform1f(u.blend, this.blend * this.blend * (3 - 2 * this.blend));
      gl.uniform1i(u.shape, shape);
      gl.uniform2f(u.stretch, this.stretch, 1);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      dt = Math.min(dt, 0.04);
      this.age += dt;
      this.since += dt;
      const plate = set('chPlate');
      const shape = plate === 'round' ? 1 : 0;
      const full = plate === 'full';
      this.stretch = full ? this.w / this.h : 1;
      if (plate !== this.shape) {
        this.shape = plate;
        this._sprinkle(shape === 1);
      }

      // The note dwelt on: the chroma over the last second or so. A new one
      // that has stood out half a second rings its figure, not sooner than
      // 2.5 s after the last, on a beat when the beat is clear.
      const notes = a.notes();
      const k = 1 - Math.exp(-dt / 0.8);
      let best = 0;
      for (let p = 0; p < 12; p += 1) {
        this.chroma[p] += ((a.playing ? notes.chroma[p] * (0.3 + 0.7 * notes.tonal) : 0) - this.chroma[p]) * k;
        if (this.chroma[p] > this.chroma[best]) best = p;
      }
      if (best !== this.mode && this.chroma[best] > this.chroma[this.mode] * 1.15 + 0.02) this.pending += dt;
      else this.pending = 0;
      if (this.pending > 0.5 && this.since > 2.5 && (a.lock < 0.5 || a.tick || this.pending > 2)) this._ring(best);
      this.blend = Math.min(1, this.blend + dt / 0.6);

      // How the plate moves: hard with the music, still when it stops.
      const amount = set('chShake') / 100;
      const shake = a.playing ? (0.12 + 0.55 * a.level + 0.5 * a.kick) * amount : 0;
      const pull = a.playing ? 0.12 + 0.35 * a.level : 0.02;
      if (a.playing && a.onset) this.jolt = Math.max(this.jolt, a.onsetPower * 0.5 * amount);
      const jolt = this.jolt;
      this.jolt *= Math.exp(-dt * 14);

      // The grains, moved.
      const src = this.state[this.cur];
      const dst = this.state[1 - this.cur];
      gl.disable(gl.BLEND);
      VizGL.into(gl, dst);
      gl.useProgram(this.step.p);
      let u = this.step.u;
      VizGL.bind(gl, u.state, src.tex, 0);
      this._uniformsMode(u, shape);
      gl.uniform1f(u.dt, dt);
      gl.uniform1f(u.sdt, Math.sqrt(dt));
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.shake, shake);
      gl.uniform1f(u.pull, pull);
      gl.uniform1f(u.jolt, jolt);
      VizGL.screen(gl);
      this.cur = 1 - this.cur;

      // Where the sand lies.
      const half = full ? [this.w / 2, this.h / 2] : [Math.min(this.w, this.h) * 0.45, Math.min(this.w, this.h) * 0.45];
      const center = [this.w / 2, this.h / 2];
      VizGL.into(gl, this.dens);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.points.p);
      u = this.points.u;
      VizGL.bind(gl, u.state, dst.tex, 0);
      gl.uniform2f(u.center, center[0], center[1]);
      gl.uniform2f(u.halfSize, half[0], half[1]);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.size, Math.max(1, this.h / 800));
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.POINTS, 0, SIDE * SIDE);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);

      // The colour: chosen, or the harmony's, gliding.
      let sand = SAND[set('chColors')];
      if (!sand) {
        const nh = a.noteHue();
        if (nh.strength > 0.15) {
          let d = nh.hue - this.hue;
          d -= Math.round(d);
          this.hue = (this.hue + d * Math.min(1, dt * 1.5) + 1) % 1;
        }
        sand = hsv(this.hue, 0.65, 1);
      }

      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      u = this.show.u;
      VizGL.bind(gl, u.dens, this.dens.tex, 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform2f(u.center, center[0], center[1]);
      gl.uniform2f(u.halfSize, half[0], half[1]);
      gl.uniform1i(u.shape, shape);
      gl.uniform1i(u.full, full ? 1 : 0);
      gl.uniform3f(u.sand, sand[0], sand[1], sand[2]);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.glow, 0.3 + 0.7 * a.throb);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'chladni',
    name: 'Chladni',
    desc: 'Sand on a ringing metal plate, gathering in the figure of the note the music dwells on and running to the next when it changes',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/>'
      + '<path d="M3 9c4 0 5 3 9 3s5-3 9-3M3 15c4 0 5-3 9-3s5 3 9 3M9 3c0 4 3 5 3 9s-3 5-3 9M15 3c0 4-3 5-3 9s3 5 3 9"/></svg>',
    gl: true,
    create: (canvas) => new Chladni(canvas),
    click: (scene) => scene.next(),
    options: [
      { type: 'choice', key: 'chPlate', label: 'Plate', choices: [['square', 'Square'], ['round', 'Round'], ['full', 'Whole screen']] },
      { type: 'choice', key: 'chColors', label: 'Sand', choices: [['sand', 'Sand'], ['gold', 'Gold'], ['ice', 'Ice'], ['notes', 'By the notes']] },
      { type: 'slider', key: 'chShake', label: 'Shaking', min: 25, max: 200, step: 5 },
    ],
  });
})();
