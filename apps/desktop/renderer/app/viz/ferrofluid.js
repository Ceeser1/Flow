'use strict';

// Ferrofluid: a puddle of liquid metal, glossy black, on a dark mirror, a
// magnet under it pulling it up into spikes with the music: the big ones in
// the middle with the bass, finer ones towards its edge with the higher
// parts of the spectrum, all of them jumping on the kicks. Coloured lights
// round about glint in it and in the mirror (their colours the harmony's,
// or a palette); the eye circles slowly.
//
// Its cogwheel: the lights' colours (by the notes, neon, gold, ice), how
// high the spikes stand.
//
// WebGL (viz/gl.js): one pass. The puddle is a height field (a lens-shaped
// mound and, on a hexagonal grid, a cone for each spike), marched in small
// steps inside its box; whatever it reflects is a dark room with soft
// coloured strips of light; the mirror below reflects both.

(() => {
  const COLORS = { notes: 0, neon: 1, gold: 2, ice: 3 };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform vec3 eye;
    uniform float time, level, kick, spikes, turn;
    uniform float bands[8];
    uniform vec3 c1, c2, c3;
    out vec4 o;

    const float CELL = 0.16;
    const float R = 0.85;

    // The nearest point of a hexagonal grid (unit spacing).
    vec2 hexNear(vec2 p) {
      const vec2 s = vec2(1.0, 1.7320508);
      vec4 hc = floor(vec4(p, p - vec2(0.5, 0.8660254)) / s.xyxy) + 0.5;
      vec2 a = hc.xy * s;
      vec2 b = (hc.zw) * s + vec2(0.5, 0.8660254);
      return dot(p - a, p - a) < dot(p - b, p - b) ? a : b;
    }

    float bandAt(float r) {
      float x = clamp(r / R, 0.0, 1.0) * 7.0;
      int i = int(floor(x));
      float f = fract(x);
      return mix(bands[i], bands[min(i + 1, 7)], f);
    }

    // The puddle's height at p.
    float height(vec2 p) {
      float r = length(p);
      float mound = 0.22 * (0.75 + 0.35 * level) * sqrt(max(0.0, 1.0 - (r / R) * (r / R)));
      vec2 c = hexNear(p / CELL) * CELL;
      float rc = length(c);
      float env = smoothstep(R * 1.02, R * 0.55, rc);
      float b = bandAt(rc);
      // Each its own little wobble.
      float wob = 0.85 + 0.15 * sin(time * 3.0 + hash12(c * 7.0) * 6.28);
      float amp = env * spikes * (0.03 + (0.3 * b + 0.12 * kick) * (1.0 - 0.45 * rc / R)) * wob;
      float d = length(p - c) / CELL;
      float spike = amp * pow(max(0.0, 1.0 - d / 0.55), 1.7);
      return max(mound + spike * smoothstep(R * 1.05, R * 0.8, r), 0.0);
    }

    // The room: dark, a ring of coloured light high round about (its colour
    // going round from one to the next, brighter in three places), a soft
    // white light straight above.
    vec3 room(vec3 d) {
      vec3 col = vec3(0.004, 0.004, 0.006) + vec3(0.01, 0.01, 0.014) * max(d.y, 0.0);
      float az = atan(d.z, d.x) + turn;
      float el = asin(clamp(d.y, -1.0, 1.0));
      float k = fract(az / 6.28318) * 3.0;
      vec3 c = k < 1.0 ? mix(c1, c2, k) : k < 2.0 ? mix(c2, c3, k - 1.0) : mix(c3, c1, k - 2.0);
      float ring = smoothstep(0.08, 0.2, el) * smoothstep(0.55, 0.35, el);
      float spots = pow(0.5 + 0.5 * cos(az * 3.0), 6.0);
      col += c * ring * (0.7 + 2.6 * spots);
      // A dim backdrop of the same colours down to the floor.
      col += c * 0.05 * smoothstep(0.6, 0.0, abs(el - 0.05));
      col += vec3(0.85, 0.88, 1.0) * smoothstep(0.93, 0.97, d.y) * 0.9;
      return col;
    }

    // Marches the puddle along o + d t; returns t, or -1.
    float march(vec3 o, vec3 d, int steps) {
      // Its box.
      vec3 lo = vec3(-1.15, 0.0, -1.15);
      vec3 hi = vec3(1.15, 0.9, 1.15);
      vec3 inv = 1.0 / d;
      vec3 t0 = (lo - o) * inv;
      vec3 t1 = (hi - o) * inv;
      vec3 tmin = min(t0, t1);
      vec3 tmax = max(t0, t1);
      float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
      float tf = min(min(tmax.x, tmax.y), tmax.z);
      if (tn > tf) return -1.0;
      float t = tn;
      for (int i = 0; i < 160; i++) {
        if (i >= steps) break;
        vec3 p = o + d * t;
        float h = p.y - height(p.xz);
        if (h < 0.0008 * t) return t;
        t += max(h * 0.2, 0.0015);
        if (t > tf) break;
      }
      return -1.0;
    }

    vec3 normalAt(vec2 p) {
      const float e = 0.0015;
      float hx = height(p + vec2(e, 0.0)) - height(p - vec2(e, 0.0));
      float hz = height(p + vec2(0.0, e)) - height(p - vec2(0.0, e));
      return normalize(vec3(-hx, 2.0 * e, -hz));
    }

    // The fluid's colour where the ray d meets it at p.
    vec3 fluid(vec3 p, vec3 d) {
      vec3 n = normalAt(p.xz);
      vec3 rf = reflect(d, n);
      float fres = 0.12 + 0.88 * pow(1.0 - max(dot(n, -d), 0.0), 4.0);
      // What it reflects: the room, or the mirror under it (dark) when it looks down.
      vec3 env = rf.y > 0.0 ? room(rf) : room(vec3(rf.x, -rf.y, rf.z)) * 0.25;
      return env * fres + vec3(0.003);
    }

    void main() {
      vec2 sp = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      vec3 fw = normalize(vec3(0.0, 0.12, 0.0) - eye);
      vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(rt, fw);
      vec3 d = normalize(fw * 2.0 + rt * sp.x + up * sp.y);
      vec3 col;
      float t = march(eye, d, 150);
      if (t > 0.0) {
        col = fluid(eye + d * t, d);
      } else if (d.y < 0.0) {
        // The mirror: the room and the puddle in it, darkened, a little blurred by its grain.
        float tp = -eye.y / d.y;
        vec3 p = eye + d * tp;
        vec3 rd = vec3(d.x, -d.y, d.z);
        float tr = march(p + rd * 0.002, rd, 70);
        vec3 refl = tr > 0.0 ? fluid(p + rd * tr, rd) : room(rd);
        float fres = 0.3 + 0.7 * pow(1.0 - abs(d.y), 5.0);
        col = refl * fres * 0.55;
        // The fluid's shadow on it, and the rim of the puddle.
        float r = length(p.xz);
        col *= 0.4 + 0.6 * smoothstep(R * 0.95, R * 1.3, r);
        // Fading into the dark far off.
        col *= exp(-max(tp - 2.0, 0.0) * 0.35);
      } else {
        col = room(d) * 0.4;
      }
      col = 1.0 - exp(-col * 1.4);
      vec2 v = uv - 0.5;
      col *= 1.0 - 0.6 * dot(v, v);
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

  const PALETTES = {
    neon: [[1, 0.1, 0.6], [0.1, 0.9, 1], [0.6, 0.2, 1]],
    gold: [[1, 0.7, 0.25], [1, 0.45, 0.12], [1, 0.9, 0.6]],
    ice: [[0.4, 0.75, 1], [0.7, 0.9, 1], [0.25, 0.4, 1]],
  };

  class Ferrofluid {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.age = 0;
      this.orbit = Math.random() * Math.PI * 2;
      this.turn = 0;
      this.level = 0;
      this.kick = 0;
      this.bands = new Float32Array(8);
      this.hx = 1;
      this.hy = 0;
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
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      const playing = a.playing ? 1 : 0;
      this.orbit += dt * 0.05 * (a.playing ? a.pace : 0.4);
      this.turn += dt * 0.03;
      this.level += ((a.level * playing) - this.level) * Math.min(1, dt * 4);
      this.kick += ((a.throb * playing) - this.kick) * Math.min(1, dt * 18);
      for (let i = 0; i < 8; i += 1) {
        const from = Math.floor((i / 8) * a.BANDS * 0.85);
        const to = Math.floor(((i + 1) / 8) * a.BANDS * 0.85);
        let v = 0;
        for (let j = from; j < to; j += 1) v += a.smooth[j];
        v = (v / (to - from)) * playing;
        // Quick to rise, slower to sink, as the fluid would.
        this.bands[i] += (v - this.bands[i]) * Math.min(1, dt * (v > this.bands[i] ? 14 : 4));
      }
      const eye = [Math.cos(this.orbit) * 2.9, 1.5, Math.sin(this.orbit) * 2.9];
      // The lights' colours.
      let cs = PALETTES[set('ffColors')];
      if (!cs) {
        const nh = a.playing ? a.noteHue() : { hue: 0.6, strength: 0 };
        const k = Math.min(1, dt * 0.8 * (0.2 + nh.strength));
        this.hx += (Math.cos(nh.hue * Math.PI * 2) - this.hx) * k;
        this.hy += (Math.sin(nh.hue * Math.PI * 2) - this.hy) * k;
        const hue = ((Math.atan2(this.hy, this.hx) / (Math.PI * 2)) + 1) % 1;
        cs = [hsv(hue, 0.8, 1), hsv((hue + 0.33) % 1, 0.7, 1), hsv((hue + 0.6) % 1, 0.75, 1)];
      }
      const lift = 0.5 + 0.7 * this.level + 0.3 * this.kick;

      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform3f(u.eye, ...eye);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.level, this.level);
      gl.uniform1f(u.kick, this.kick);
      gl.uniform1f(u.spikes, set('ffSpikes') / 100);
      gl.uniform1f(u.turn, this.turn);
      gl.uniform1fv(u.bands, this.bands);
      gl.uniform3f(u.c1, ...cs[0].map((v) => v * lift));
      gl.uniform3f(u.c2, ...cs[1].map((v) => v * lift));
      gl.uniform3f(u.c3, ...cs[2].map((v) => v * lift));
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'ferrofluid',
    name: 'Ferrofluid',
    desc: 'A puddle of glossy black liquid metal pulled up into spikes by the music, the bass in the middle, the highs at its edge, coloured lights glinting in it',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 19h18"/><path d="M5 19l2-4 1.5 3L10 11l2 7 2-9 1.5 9L17 14l2 5"/></svg>',
    gl: true,
    create: (canvas) => new Ferrofluid(canvas),
    options: [
      { type: 'choice', key: 'ffColors', label: 'Lights', choices: [['notes', 'By the notes'], ['neon', 'Neon'], ['gold', 'Gold'], ['ice', 'Ice']] },
      { type: 'slider', key: 'ffSpikes', label: 'Spikes', min: 25, max: 200, step: 5 },
    ],
  });
})();
