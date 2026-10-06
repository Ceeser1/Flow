'use strict';

// Tunnel: flying down an endless tunnel of light, as in the demos of old.
// Its walls are a grid lit by the spectrum round them (the bass along the
// floor and the ceiling, the highs at the sides), it winds and twists with
// the music, rushes on faster on the kicks, and each beat shoots a ring of
// light away down it. Far ahead its end glows with the bass.
//
// Its cogwheel: round, square or hexagonal; its walls (a grid, hexes or
// rings); its colours; how fast it flies.
//
// WebGL (viz/gl.js): one pass over the screen. Each pixel's distance from
// the middle says how far down the tunnel it looks (1/r), its angle where
// round it, and both together where on the wall's pattern it lands.

(() => {
  const RINGS = 8;
  const PALETTES = {
    neon: [[0.0, 0.9, 1.0], [1.0, 0.15, 0.85]],
    sunset: [[1.0, 0.45, 0.1], [0.75, 0.1, 0.55]],
    matrix: [[0.2, 1.0, 0.35], [0.0, 0.45, 0.2]],
    ice: [[0.75, 0.9, 1.0], [0.2, 0.4, 1.0]],
    gold: [[1.0, 0.85, 0.4], [0.6, 0.35, 0.1]],
  };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D bands;
    uniform vec2 res, bend;
    uniform float travel, spin, twist, shape, walls, glow, flash, time;
    uniform vec3 colA, colB;
    uniform vec2 rings[${RINGS}];   // how far down, how bright
    out vec4 o;

    float hexDist(vec2 p) {
      p = abs(p);
      return max(dot(p, vec2(0.8660254, 0.5)), p.y);
    }

    void main() {
      vec2 p = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      // The far end swings about: the tunnel winds.
      float l = length(p);
      vec2 q = p - bend * (1.0 - smoothstep(0.0, 0.9, l));
      float r = shape < 0.5 ? length(q) : (shape < 1.5 ? max(abs(q.x), abs(q.y)) : hexDist(q));
      r = max(r, 1e-3);
      float z = 0.32 / r;                       // how far down the tunnel
      float ang = atan(q.y, q.x) / 6.2831853;   // -0.5 .. 0.5 round it
      ang += spin + twist * z * 0.015;
      vec2 t = vec2(ang * 16.0, z * 1.6 + travel);
      // How wide a line is on screen; round the tunnel measured where the
      // angle does not jump from one side to the other.
      vec2 fw = vec2(min(fwidth(ang), fwidth(fract(ang + 0.5))) * 16.0, fwidth(t.y));

      // The pattern on the walls, its lines smoothed by their width on screen.
      float line;
      if (walls < 0.5) {
        vec2 g = abs(fract(t) - 0.5);
        vec2 w = fw * 1.2;
        line = max(smoothstep(0.5 - w.x - 0.03, 0.5, g.x), smoothstep(0.5 - w.y - 0.03, 0.5, g.y));
      } else if (walls < 1.5) {
        vec2 h = vec2(t.x, t.y * 1.1547);
        vec2 a = mod(h, vec2(1.0, 1.732)) - vec2(0.5, 0.866);
        vec2 b = mod(h + vec2(0.5, 0.866), vec2(1.0, 1.732)) - vec2(0.5, 0.866);
        vec2 c = dot(a, a) < dot(b, b) ? a : b;
        float e = 0.5 - hexDist(c.yx);
        line = 1.0 - smoothstep(0.0, 0.04 + max(fw.x, fw.y) * 1.5, e);
      } else {
        float g = abs(fract(t.y) - 0.5);
        line = smoothstep(0.5 - fw.y * 1.2 - 0.05, 0.5, g);
      }

      // The spectrum round the wall: floor and ceiling the bass, the sides the highs.
      float side = abs(abs(fract(ang + 0.25) * 2.0 - 1.0) * 2.0 - 1.0);
      float level = texture(bands, vec2(1.0 - side * 0.9 - 0.05, 0.5)).r;
      vec3 tint = mix(colA, colB, 0.5 + 0.5 * sin(t.y * 0.35 + time * 0.2));
      vec3 col = tint * line * (0.25 + 1.6 * level) + tint * level * 0.12;

      // The rings of light shooting away down it.
      for (int i = 0; i < ${RINGS}; i++) {
        vec2 ring = rings[i];
        if (ring.y <= 0.0) continue;
        float d = (z - ring.x) * 2.2;
        col += mix(colB, vec3(1.0), 0.4) * ring.y * exp(-d * d);
      }

      // Fog far down, the end glowing, the near walls dimmer, a flash on the kicks.
      float fog = exp(-z * 0.11);
      col *= fog * smoothstep(0.0, 0.25, l + 0.05);
      float lq = length(q);
      col += mix(colA, vec3(1.0), 0.6) * glow * exp(-lq * lq * 40.0) * 0.8;
      col += tint * flash * 0.08;
      col = 1.0 - exp(-col * 1.3);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Tunnel {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.bandTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.bytes = null;
      this.travel = 0;
      this.spin = 0;
      this.twist = 0;
      this.speed = 1;
      this.rings = [];
      this.ringData = new Float32Array(RINGS * 2);
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

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      const n = a.BANDS;
      if (!this.bytes) this.bytes = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) this.bytes[i] = Math.round(Math.min(1, a.dynamic[i]) * 255);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, n, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this.bytes);

      const pace = set('tnSpeed') / 100;
      // With a clear beat as fast as the kicks pushed it on average, swelling
      // gently with each beat (VizAudio.surge); without one pushed on by the
      // kicks; faster the more intense.
      const byKick = 1 + 3.2 * a.kick;
      const byBeat = 1.85 * a.surge(0.25);
      const target = a.playing ? byKick + (byBeat - byKick) * a.lock + 1.5 * a.intensity : 0.25;
      this.speed += (target - this.speed) * (1 - Math.exp(-dt / (0.2 - 0.08 * a.lock)));
      this.travel += dt * this.speed * pace;
      this.spin += dt * (0.01 + 0.04 * a.mid) * (a.playing ? 1 : 0.3);
      this.twist += ((a.playing ? Math.sin(this.age * 0.15) * (2 + 4 * a.intensity) : 0) - this.twist) * (1 - Math.exp(-dt / 1.5));
      const t = this.age;
      const bend = [0.18 * Math.sin(t * 0.31) + 0.06 * Math.sin(t * 0.83), 0.12 * Math.sin(t * 0.23 + 1) + 0.05 * Math.sin(t * 0.67)];

      // A ring on each beat, from just ahead off down the tunnel: on the
      // tempo's beats while it is clear (brighter on the first of a bar),
      // else on the onsets.
      const ring = a.lock > 0.5 ? (a.tick ? 0.55 + 0.35 * a.beat + (a.beats % 4 === 0 ? 0.3 : 0) : 0) : (a.onset ? 0.5 + 0.8 * a.onsetPower : 0);
      if (ring && this.rings.length < RINGS) this.rings.push({ z: 0.6, p: ring });
      for (const ring of this.rings) {
        ring.z += dt * (6 + 10 * this.speed) * pace;
        ring.p *= Math.exp(-dt * 1.4);
      }
      this.rings = this.rings.filter((r) => r.z < 40 && r.p > 0.02);
      this.ringData.fill(0);
      this.rings.forEach((r, i) => {
        this.ringData[i * 2] = r.z;
        this.ringData[i * 2 + 1] = r.p;
      });

      const pal = PALETTES[set('tnColors')] || PALETTES.neon;
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.bands, this.bandTex, 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform2f(u.bend, bend[0], bend[1]);
      gl.uniform1f(u.travel, this.travel);
      gl.uniform1f(u.spin, this.spin);
      gl.uniform1f(u.twist, this.twist);
      gl.uniform1f(u.shape, { round: 0, square: 1, hex: 2 }[set('tnShape')] || 0);
      gl.uniform1f(u.walls, { grid: 0, hex: 1, rings: 2 }[set('tnWalls')] || 0);
      gl.uniform1f(u.glow, 0.3 + a.bass);
      gl.uniform1f(u.flash, a.kick);
      gl.uniform1f(u.time, t);
      gl.uniform3f(u.colA, ...pal[0]);
      gl.uniform3f(u.colB, ...pal[1]);
      gl.uniform2fv(u.rings, this.ringData);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'tunnel',
    name: 'Tunnel',
    desc: 'Flying down a tunnel of light that winds with the music, its walls lit by the spectrum, rings shooting away on the beats',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.5"/></svg>',
    gl: true,
    create: (canvas) => new Tunnel(canvas),
    options: [
      { type: 'choice', key: 'tnShape', label: 'Shape', choices: [['round', 'Round'], ['square', 'Square'], ['hex', 'Hexagon']] },
      { type: 'choice', key: 'tnWalls', label: 'Walls', choices: [['grid', 'Grid'], ['hex', 'Hexes'], ['rings', 'Rings']] },
      { type: 'choice', key: 'tnColors', label: 'Colors', choices: [['neon', 'Neon'], ['sunset', 'Sunset'], ['matrix', 'Matrix'], ['ice', 'Ice'], ['gold', 'Gold']] },
      { type: 'slider', key: 'tnSpeed', label: 'Speed', min: 25, max: 300, step: 5 },
    ],
  });
})();
