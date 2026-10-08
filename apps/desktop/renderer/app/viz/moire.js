'use strict';

// Moiré: fine gratings of lines or rings laid over each other, so close in
// spacing and angle that between them great slow fringes appear, sweeping
// and bending as they move: the angle between two sets of lines opening and
// closing with the music, the middles of two sets of rings drifting apart on
// the bass, the spacing breathing on the beat, everything turning with the
// tempo.
//
// Its cogwheel: the gratings (lines, rings, both), the colours (ink on
// paper, three inks as in print, neon lines in the dark following the
// harmony).
//
// WebGL (viz/gl.js): one pass; each grating a pattern of thin lines,
// smoothed across a pixel (its fwidth) so the screen's own grid adds no
// moiré of its own; on paper the inks multiply, in the dark the lines add.

(() => {
  const KINDS = { lines: 0, rings: 1, both: 2 };
  const COLORS = { paper: 0, print: 1, neon: 2 };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform float time, turn, spread, apart, spacing, glow;
    uniform vec2 drift;
    uniform int kind, palette;
    uniform vec3 hue1, hue2, hue3;
    out vec4 o;

    // A grating's lines at u (in spacings): 1 on a line, 0 between.
    float lines(float u, float width) {
      float g = fract(u);
      float m = min(g, 1.0 - g);
      float aa = fwidth(u) * 0.75;
      return 1.0 - smoothstep(width - aa, width + aa, m);
    }

    vec2 rot(vec2 p, float a) {
      float c = cos(a), s = sin(a);
      return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    }

    // The three gratings' lines at p.
    vec3 gratings(vec2 p) {
      float w = 0.13;
      vec3 l;
      if (kind == 0) {
        l.x = lines(rot(p, turn).x / spacing, w);
        l.y = lines(rot(p, turn + spread).x / spacing, w);
        l.z = lines(rot(p, turn - spread * 0.5 + 1.0472).x / (spacing * 1.02), w);
      } else if (kind == 1) {
        vec2 c1 = rot(vec2(apart, 0.0), turn) + drift;
        vec2 c2 = -c1 + drift * 0.5;
        l.x = lines(length(p - c1) / spacing, w);
        l.y = lines(length(p - c2) / spacing, w);
        l.z = lines(length(p - rot(c1, 2.1)) / (spacing * 1.01), w);
      } else {
        vec2 c1 = rot(vec2(apart * 0.6, 0.0), turn * 1.3) + drift;
        l.x = lines(length(p - c1) / spacing, w);
        l.y = lines(rot(p, turn).x / (spacing * (1.0 + spread * 0.3)), w);
        l.z = lines(length(p + c1) / (spacing * 1.015), w);
      }
      return l;
    }

    void main() {
      vec2 p = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      vec3 l = gratings(p);
      vec3 col;
      if (palette == 0) {
        // Black ink on cream paper, two sheets (the third only faintly).
        col = vec3(0.94, 0.92, 0.87) * (1.0 - 0.88 * l.x) * (1.0 - 0.88 * l.y) * (1.0 - 0.3 * l.z);
      } else if (palette == 1) {
        // Cyan, magenta and yellow over each other, as in print.
        col = vec3(0.97, 0.96, 0.93);
        col *= 1.0 - l.x * (1.0 - vec3(0.0, 0.62, 0.9));
        col *= 1.0 - l.y * (1.0 - vec3(0.92, 0.1, 0.55));
        col *= 1.0 - l.z * (1.0 - vec3(1.0, 0.88, 0.0));
      } else {
        // Glowing lines in the dark, adding up where they cross.
        col = vec3(0.006, 0.006, 0.012);
        col += hue1 * l.x * 0.8 + hue2 * l.y * 0.8 + hue3 * l.z * 0.3;
        col *= 0.8 + 0.6 * glow;
        col = 1.0 - exp(-col * 1.6);
      }
      vec2 v = uv - 0.5;
      col *= 1.0 - 0.35 * dot(v, v) * 2.0;
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

  class Moire {
    constructor(canvas) {
      const gl = VizGL.context(canvas, { antialias: false });
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.age = 0;
      this.turn = Math.random() * Math.PI;
      this.wander = Math.random() * 100;
      this.bass = 0;
      this.glow = 0;
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
      const pace = a.playing ? a.pace : 0.3;
      this.turn += dt * 0.04 * pace;
      this.wander += dt * (0.25 + 0.5 * a.intensity * playing);
      this.bass += ((a.bass * playing) - this.bass) * Math.min(1, dt * 4);
      this.glow += ((a.throb * playing) - this.glow) * Math.min(1, dt * 10);
      // The angle between the sets of lines: a few degrees, opening and closing.
      const spread = (0.035 + 0.025 * Math.sin(this.wander * 0.31) + 0.012 * this.glow) * (1 + 0.5 * Math.sin(this.wander * 0.07));
      const apart = 0.04 + 0.12 * this.bass + 0.03 * Math.sin(this.wander * 0.23);
      const drift = [0.08 * Math.sin(this.wander * 0.17), 0.06 * Math.cos(this.wander * 0.13)];
      // Lines about every 15 pixels at 1080, breathing on the beat.
      const spacing = 0.0135 * (1 + 0.025 * this.glow);
      const nh = a.playing ? a.noteHue() : { hue: 0.6, strength: 0 };
      const k = Math.min(1, dt * 0.8 * (0.2 + nh.strength));
      this.hx += (Math.cos(nh.hue * Math.PI * 2) - this.hx) * k;
      this.hy += (Math.sin(nh.hue * Math.PI * 2) - this.hy) * k;
      const hue = ((Math.atan2(this.hy, this.hx) / (Math.PI * 2)) + 1) % 1;

      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.turn, this.turn);
      gl.uniform1f(u.spread, spread);
      gl.uniform1f(u.apart, apart);
      gl.uniform2f(u.drift, drift[0], drift[1]);
      gl.uniform1f(u.spacing, spacing);
      gl.uniform1f(u.glow, this.glow);
      gl.uniform1i(u.kind, KINDS[set('mrKind')] ?? 0);
      gl.uniform1i(u.palette, COLORS[set('mrColors')] ?? 0);
      gl.uniform3f(u.hue1, ...hsv(hue, 0.8, 1));
      gl.uniform3f(u.hue2, ...hsv((hue + 0.45) % 1, 0.8, 1));
      gl.uniform3f(u.hue3, ...hsv((hue + 0.2) % 1, 0.6, 1));
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'moire',
    name: 'Moiré',
    desc: 'Fine lines and rings laid over each other, the great fringes between them sweeping and bending with the music',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/><circle cx="9" cy="12" r="2.5"/><circle cx="15" cy="12" r="2.5"/></svg>',
    gl: true,
    create: (canvas) => new Moire(canvas),
    options: [
      { type: 'choice', key: 'mrKind', label: 'Gratings', choices: [['lines', 'Lines'], ['rings', 'Rings'], ['both', 'Both']] },
      { type: 'choice', key: 'mrColors', label: 'Colours', choices: [['paper', 'Ink on paper'], ['print', 'Print'], ['neon', 'Neon']] },
    ],
  });
})();
