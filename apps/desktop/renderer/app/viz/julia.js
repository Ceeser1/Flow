'use strict';

// Fractals: the Julia set of z^2 + c, its c gliding along the edge of the
// Mandelbrot set, where the shapes are richest: islands joining into
// coastlines and breaking into dust again. The glide moves on with the
// tempo and a little further on each beat; the bass draws the view in; it
// turns slowly; the colours shift with the harmony.
//
// Its cogwheel: the look (glowing edges, the classic bands, ink), how fast
// it changes.
//
// WebGL (viz/gl.js): one pass over the screen, each pixel iterated up to
// 200 times; how fast it escapes gives the bands, its distance to the set
// (worked out from the derivative on the way) the glowing edges.

(() => {
  const LOOKS = { neon: 0, classic: 1, ink: 2 };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res, c;
    uniform float zoom, turn, time, hue, glow;
    uniform int look;
    out vec4 o;
    vec3 pal(float t) {
      return 0.5 + 0.5 * cos(6.2831853 * (vec3(1.0, 1.0, 1.0) * t + vec3(0.0, 0.33, 0.67) + hue));
    }
    void main() {
      vec2 p = (uv - 0.5) * vec2(res.x / res.y, 1.0) * zoom;
      float cs = cos(turn), sn = sin(turn);
      vec2 z = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
      vec2 dz = vec2(1.0, 0.0);
      float trap = 1e9;
      int n = 0;
      float m2 = 0.0;
      for (int i = 0; i < 200; i++) {
        dz = 2.0 * vec2(z.x * dz.x - z.y * dz.y, z.x * dz.y + z.y * dz.x);
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        m2 = dot(z, z);
        trap = min(trap, abs(z.y) + 0.3 * abs(z.x - 0.5));
        if (m2 > 256.0) break;
        n++;
      }
      vec3 col;
      if (n >= 200) {
        // Inside the set: dark, its orbits faintly traced.
        col = pal(0.6 + trap * 0.5) * 0.12 * exp(-trap * 3.0) * (look == 2 ? 0.0 : 1.0);
      } else {
        float sm = float(n) - log2(log2(m2)) + 4.0;
        float dist = 0.5 * sqrt(m2) * log(m2) / max(length(dz), 1e-9);
        float px = zoom / res.y;
        float edge = exp(-dist / (px * 2.5));
        if (look == 0) {
          float halo = exp(-dist / (px * 24.0));
          col = pal(sm * 0.02) * (pow(edge, 0.6) * (0.9 + glow) + halo * 0.25 * (0.5 + glow));
        } else if (look == 1) {
          col = pal(sm * 0.035) * (1.0 - exp(-sm * 0.045)) * (0.85 + 0.3 * edge * glow);
        } else {
          float ink = 1.0 - edge;
          col = vec3(0.93, 0.9, 0.84) * mix(0.25, 1.0, ink) * (0.95 + 0.05 * vnoise(gl_FragCoord.xy * 0.5));
        }
      }
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Julia {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.angle = Math.random() * Math.PI * 2;
      this.owed = 0;
      this.turn = 0;
      this.zoom = 2.6;
      this.hue = 0;
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
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      const speed = set('jlSpeed') / 100;
      // Along the edge of the Mandelbrot set's main body: on with the tempo,
      // a little further on each beat (given over a moment, not at once).
      if (a.playing && (a.lock > 0.5 ? a.tick : a.onset)) this.owed += 0.025 * speed;
      const give = this.owed * (1 - Math.exp(-dt * 6));
      this.owed -= give;
      this.angle += give + dt * 0.035 * speed * (a.playing ? a.pace : 0.2);
      // Just outside the edge, breathing in and out across it.
      const t = this.angle;
      const k = 1.0 + 0.04 * Math.sin(this.age * 0.21) + 0.02 * (a.playing ? a.bass : 0);
      const cx = (Math.cos(t) / 2 - Math.cos(2 * t) / 4) * k;
      const cy = (Math.sin(t) / 2 - Math.sin(2 * t) / 4) * k;
      this.turn += dt * 0.03 * (a.playing ? a.pace : 0.2);
      const target = 2.6 - 0.35 * (a.playing ? a.bass : 0) - 0.15 * a.throb;
      this.zoom += (target - this.zoom) * Math.min(1, dt * 3);
      const nh = a.noteHue();
      if (nh.strength > 0.15) {
        let d = nh.hue - this.hue;
        d -= Math.round(d);
        this.hue += d * Math.min(1, dt * 0.8);
      } else this.hue += dt * 0.01;

      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform2f(u.c, cx, cy);
      gl.uniform1f(u.zoom, this.zoom);
      gl.uniform1f(u.turn, this.turn);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.hue, this.hue);
      gl.uniform1f(u.glow, a.playing ? 0.3 + 0.9 * a.throb : 0.2);
      gl.uniform1i(u.look, LOOKS[set('jlLook')] ?? 0);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'julia',
    name: 'Fractals',
    desc: 'A Julia set gliding along the edge of the Mandelbrot set with the tempo, its islands joining and breaking apart, glowing with the beat',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 12c2-4 7-4 8 0s-4 6-8 3-6-1-8-3 4-6 8 0z"/><circle cx="6" cy="7" r="1.5"/><circle cx="18" cy="17" r="1.5"/></svg>',
    gl: true,
    create: (canvas) => new Julia(canvas),
    options: [
      { type: 'choice', key: 'jlLook', label: 'Look', choices: [['neon', 'Glowing edges'], ['classic', 'Bands'], ['ink', 'Ink']] },
      { type: 'slider', key: 'jlSpeed', label: 'Changing', min: 25, max: 300, step: 5 },
    ],
  });
})();
