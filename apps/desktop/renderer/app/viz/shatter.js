'use strict';

// Shatter: the song's cover as a pane of glass. Small kicks make it shiver;
// a big hit breaks it from wherever it struck, the break running out from
// there, and the shards fly and tumble outwards, catching the light, on
// until the last has left the screen. A new pane waits behind the broken
// one, coming forward out of the dark, and is the next to break. Behind it
// all the cover again, blurred and dark. A song without a cover gets a
// pattern.
//
// Its cogwheel: how many shards, how hard it breaks, how often (on the big
// hits only, or on every bar's first beat).
//
// WebGL (viz/gl.js): the pane is cut into jittered triangles once; each
// shard is turned and moved in the vertex shader by how far its flight has
// got (from the moment the break reaches it), lit by its tilt; the same
// worked out for each shard here, to know when the last has gone.

(() => {
  const FLY_BEATS = 3;      // flying at the speed they broke with, then faster
  const NEW_BEATS = 2;      // the new pane coming forward behind them
  const WAVE = 0.25;        // the break's delay per pane unit from the impact
  const GRAVITY = 0.225;

  const BG_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D cover;
    uniform vec2 res;
    uniform float time, glow;
    out vec4 o;
    void main() {
      vec2 p = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      vec2 c = p * 0.55 + 0.5;
      vec3 col = textureLod(cover, vec2(c.x, 1.0 - c.y), 6.0).rgb * (0.16 + 0.1 * glow);
      col *= 1.0 - 0.6 * length(p);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  const SHARD_VS = `
    layout(location = 0) in vec2 corner;    // the pane's coordinates, -1..1
    layout(location = 1) in vec2 center;    // the shard's middle
    layout(location = 2) in vec4 seed;      // its spin axis (xy), spin, speed
    uniform vec2 res, impact;
    uniform float flight, size, wave, shiver, time;
    out vec2 vuv;
    out float vlight;
    out float vedge;
    mat3 rot(vec3 a, float ang) {
      a = normalize(a);
      float s = sin(ang), c = cos(ang), t = 1.0 - c;
      return mat3(t * a.x * a.x + c, t * a.x * a.y + s * a.z, t * a.x * a.z - s * a.y,
        t * a.x * a.y - s * a.z, t * a.y * a.y + c, t * a.y * a.z + s * a.x,
        t * a.x * a.z + s * a.y, t * a.y * a.z - s * a.x, t * a.z * a.z + c);
    }
    void main() {
      vuv = corner * 0.5 + 0.5;
      // How far this shard's flight has got: the break reaches it later the
      // further it is from the impact.
      float delay = length(center - impact) * wave;
      float f = max(flight - delay, 0.0);
      vec3 dir = normalize(vec3(center - impact + 0.001, 0.6 + seed.w));
      vec3 off = dir * f * (0.7 + seed.w * 0.9) - vec3(0.0, ${GRAVITY}, 0.0) * f * f;
      mat3 r = rot(vec3(seed.xy, 0.3), f * seed.z * 3.0);
      vec3 local = vec3(corner - center, 0.0);
      // Shivering on the small kicks: each shard nudged a hair.
      vec2 jit = (seed.xy - 0.5) * shiver * 0.012;
      vec3 p = r * local + vec3(center + jit, 0.0) + off;
      vec3 n = r * vec3(0.0, 0.0, 1.0);
      vlight = n.z;
      vedge = f;
      // A little perspective, the pane size high; one past the eye is cut
      // away (w below 0).
      gl_Position = vec4(p.x * size / (res.x / res.y), p.y * size, 0.0, 1.0 - p.z * 0.25);
    }`;

  const SHARD_FS = `
    in vec2 vuv;
    in float vlight;
    in float vedge;
    uniform sampler2D cover;
    uniform float glint, dim;
    out vec4 o;
    void main() {
      vec3 c = texture(cover, vec2(vuv.x, 1.0 - vuv.y)).rgb * dim;
      float l = abs(vlight);
      // Turned away: darker; turned to the light: a glint off the glass.
      float spec = pow(clamp(1.0 - abs(vlight - 0.82) * 4.0, 0.0, 1.0), 3.0) * step(0.01, vedge);
      vec3 col = c * (0.35 + 0.65 * l) + vec3(1.0) * spec * 0.6 + glint * 0.08;
      o = vec4(col, 1.0);
    }`;

  // The cracks while it is whole: thin bright lines along the shards' edges.
  const EDGE_FS = `
    in vec2 vuv;
    in float vlight;
    in float vedge;
    uniform float crack;
    out vec4 o;
    void main() {
      o = vec4(vec3(1.0) * crack, 1.0);
    }`;

  class Shatter {
    constructor(canvas) {
      const gl = VizGL.context(canvas, { antialias: true });
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.bg = VizGL.program(gl, VizGL.SCREEN_VS, BG_FS);
      this.shards = VizGL.program(gl, SHARD_VS, SHARD_FS);
      this.edges = VizGL.program(gl, SHARD_VS, EDGE_FS);
      this.cover = new VizCover(gl, { standIn: 'pattern' });
      this.vao = gl.createVertexArray();
      this.buf = gl.createBuffer();
      this.lineVao = gl.createVertexArray();
      this.lineBuf = gl.createBuffer();
      this.built = 0;
      this.state = 'whole';
      this.flight = 0;
      this.flown = 0;
      this.impact = [0, 0];
      this.wholeFor = 0;
      this.shiver = 0;
      this.crack = 0;
      this.glint = 0;
      this.age = 0;
      this.w = 1;
      this.h = 1;
    }

    /** The pane cut into jittered triangles: per vertex corner xy, the shard's middle, its seed. */
    _cut(n) {
      const gl = this.gl;
      const pts = [];
      for (let j = 0; j <= n; j += 1) {
        for (let i = 0; i <= n; i += 1) {
          const edge = i === 0 || j === 0 || i === n || j === n;
          const jx = edge && (i === 0 || i === n) ? 0 : (Math.random() - 0.5) * 0.7;
          const jy = edge && (j === 0 || j === n) ? 0 : (Math.random() - 0.5) * 0.7;
          pts.push([-1 + ((i + jx) * 2) / n, -1 + ((j + jy) * 2) / n]);
        }
      }
      const at = (i, j) => pts[j * (n + 1) + i];
      const tris = [];
      for (let j = 0; j < n; j += 1) {
        for (let i = 0; i < n; i += 1) {
          const a = at(i, j);
          const b = at(i + 1, j);
          const c = at(i + 1, j + 1);
          const d = at(i, j + 1);
          if (Math.random() < 0.5) tris.push([a, b, c], [a, c, d]);
          else tris.push([a, b, d], [b, c, d]);
        }
      }
      const data = new Float32Array(tris.length * 3 * 8);
      const lines = new Float32Array(tris.length * 6 * 8);
      let k = 0;
      let m = 0;
      this.pieces = [];
      for (const t of tris) {
        const cx = (t[0][0] + t[1][0] + t[2][0]) / 3;
        const cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
        const seed = [Math.random(), Math.random(), (Math.random() - 0.5) * 2, Math.random()];
        const r = Math.max(...t.map((v) => Math.hypot(v[0] - cx, v[1] - cy)));
        this.pieces.push({ cx, cy, r, speed: seed[3] });
        for (const v of t) {
          data.set([v[0], v[1], cx, cy, ...seed], k);
          k += 8;
        }
        for (const [p, q] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
          lines.set([p[0], p[1], cx, cy, ...seed, q[0], q[1], cx, cy, ...seed], m);
          m += 16;
        }
      }
      const layout = (vao, buf, arr) => {
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 8);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
        gl.bindVertexArray(null);
      };
      layout(this.vao, this.buf, data);
      layout(this.lineVao, this.lineBuf, lines);
      this.count = tris.length * 3;
      this.lineCount = tris.length * 6;
      this.built = n;
    }

    size(w, h) {
      this.w = w;
      this.h = h;
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    /**
     * Whether every shard has left the screen: each one's flight worked out
     * as in the vertex shader, its corners somewhere within r of its middle
     * (whichever way it has turned), off a side or past the eye.
     */
    _allGone(size) {
      const aspect = this.w / this.h;
      const [ix, iy] = this.impact;
      for (const s of this.pieces) {
        const dx = s.cx - ix + 0.001;
        const dy = s.cy - iy + 0.001;
        const dz = 0.6 + s.speed;
        const f = Math.max(0, this.flight - Math.hypot(dx, dy) * WAVE);
        const v = (f * (0.7 + s.speed * 0.9)) / Math.hypot(dx, dy, dz);
        const x = s.cx + dx * v;
        const y = s.cy + dy * v - GRAVITY * f * f;
        const z = dz * v;
        const r = s.r;
        // Its nearest to the middle of the screen: its corners at their
        // furthest (any nearer than the eye are cut away).
        const far = 1 - (z - r) * 0.25;
        if (far <= 0) continue;   // all of it past the eye
        const gone = (x - r) * size / far > aspect || -(x + r) * size / far > aspect
          || (y - r) * size / far > 1 || -(y + r) * size / far > 1;
        if (!gone) return false;
      }
      return true;
    }

    _break(power) {
      this.state = 'flying';
      this.flight = 0;
      this.flown = 0;
      this.power = 0.6 + 0.8 * power;
      this.impact = [(Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2];
      this.glint = 1;
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      if (this.cover.update()) this.state = 'whole';
      const n = Number(set('shPieces'));
      if (n !== this.built) this._cut(n);
      const force = set('shForce') / 100;
      const beatLen = a.sure >= 0.35 && a.bpm ? 60 / a.bpm : 0.5;

      const size = 0.72 * (1 + 0.025 * a.throb);

      // Whole: shivering on the kicks, breaking on a big hit (or each bar).
      if (a.playing && a.onset) this.shiver = Math.max(this.shiver, a.onsetPower);
      if (this.state === 'whole') {
        this.wholeFor += dt;
        const every = set('shWhen') === 'bar';
        const big = every ? a.tick && a.beats % 4 === 0 && a.lock > 0.5 : a.onset && a.onsetPower > 0.75 && a.beat > 0.8;
        if (a.playing && this.wholeFor > beatLen * 4 && big) this._break(a.onsetPower || 0.8);
        this.crack = Math.max(this.crack * Math.exp(-dt * 4), this.shiver > 0.7 ? this.shiver * 0.25 : 0);
      } else {
        // Flying: at the speed they broke with, then faster and faster, until
        // the last has left the screen; then the new pane is the one, cut anew.
        const beats = (dt / beatLen) * (a.playing ? 1 : 0.2);
        const late = Math.max(0, this.flown - FLY_BEATS);
        this.flown += beats;
        this.flight += beats * 0.22 * force * this.power * (1 + 0.6 * late * late);
        if (this.flown >= NEW_BEATS && (this._allGone(size) || this.flown > 32)) {
          this.state = 'whole';
          this.wholeFor = 0;
          this.flight = 0;
          this.crack = 0;
          this._cut(n);
        }
      }
      this.shiver *= Math.exp(-dt * 10);
      this.glint *= Math.exp(-dt * 3);

      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.bg.p);
      VizGL.bind(gl, this.bg.u.cover, this.cover.tex, 0);
      gl.uniform2f(this.bg.u.res, this.w, this.h);
      gl.uniform1f(this.bg.u.time, this.age);
      gl.uniform1f(this.bg.u.glow, a.level);
      VizGL.screen(gl);

      const flying = this.state === 'flying';
      const pane = (p, flight, sz, shiver) => {
        const u = p.u;
        gl.useProgram(p.p);
        gl.uniform2f(u.res, this.w, this.h);
        gl.uniform2f(u.impact, this.impact[0], this.impact[1]);
        gl.uniform1f(u.flight, flight);
        gl.uniform1f(u.size, sz);
        gl.uniform1f(u.wave, WAVE);
        gl.uniform1f(u.shiver, shiver);
        gl.uniform1f(u.time, this.age);
      };
      const shards = (flight, sz, shiver, dim, glint) => {
        pane(this.shards, flight, sz, shiver);
        VizGL.bind(gl, this.shards.u.cover, this.cover.tex, 0);
        gl.uniform1f(this.shards.u.dim, dim);
        gl.uniform1f(this.shards.u.glint, glint);
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, this.count);
      };
      // The new pane behind the broken one, coming forward out of the dark.
      if (flying) {
        const t = Math.min(1, this.flown / NEW_BEATS);
        const e = t * t * (3 - 2 * t);
        shards(0, size * (0.88 + 0.12 * e), this.shiver, 0.4 + 0.6 * e, 0);
      }
      shards(flying ? this.flight : 0, size, flying ? 0 : this.shiver, 1, this.glint);
      // The cracks, while it is whole.
      if (!flying && this.crack > 0.02) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        pane(this.edges, 0, size, this.shiver);
        gl.uniform1f(this.edges.u.crack, this.crack * 0.35);
        gl.bindVertexArray(this.lineVao);
        gl.drawArrays(gl.LINES, 0, this.lineCount);
        gl.disable(gl.BLEND);
      }
      gl.bindVertexArray(null);
    }
  }

  Visualizer.add({
    id: 'shatter',
    name: 'Shatter',
    desc: "The song's cover as a pane of glass, shivering on the kicks and breaking on the big hits, its shards flying and tumbling off the screen, a new pane behind it",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h12l-3 6 4 3-7 9H3z"/><path d="M18 4l3-1M19 9l3 1M18 15l2 3"/></svg>',
    gl: true,
    create: (canvas) => new Shatter(canvas),
    options: [
      { type: 'slider', key: 'shPieces', label: 'Shards', min: 4, max: 20, step: 1, unit: '' },
      { type: 'slider', key: 'shForce', label: 'Force', min: 25, max: 200, step: 5 },
      { type: 'choice', key: 'shWhen', label: 'Breaks', choices: [['hits', 'On the big hits'], ['bar', 'Every bar']] },
    ],
  });
})();
