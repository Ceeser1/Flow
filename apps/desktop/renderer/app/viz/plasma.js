'use strict';

// Plasma Globe: a glass sphere on a black stand, crackling tendrils of
// plasma reaching from the glowing electrode in its middle out to the glass.
// More of them the louder the music, wriggling with the mids, flickering
// with the highs, all brighter on the beat; the big kicks are a fingertip on
// the glass, the tendrils gathering to it in a bright bundle and wandering
// off again.
//
// Its cogwheel: the colours, how many tendrils at most, the stand.
//
// WebGL (viz/gl.js): one pass over the screen; each tendril a wavering line
// from the middle to a point on the glass (the points wander over the
// sphere, those behind dimmer), its distance from each pixel worked out
// along twenty pieces; then the glass's shine and the stand.

(() => {
  const MAX = 14;
  const PALETTES = {
    plasma: [[1.0, 0.35, 0.85], [0.55, 0.3, 1.0]],
    blue: [[0.35, 0.7, 1.0], [0.2, 0.35, 1.0]],
    green: [[0.4, 1.0, 0.55], [0.1, 0.7, 0.6]],
    rainbow: null,
  };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform float time, glow, wiggle, flicker, touch, stand;
    uniform vec4 tips[${MAX}];      // x, y (on the globe, -1..1), depth (-1 behind .. 1 in front), strength
    uniform vec3 cols[${MAX}];
    uniform vec4 pts[${MAX * 11}];  // each tendril's 21 points, two to a vec4
    uniform vec3 inner;
    uniform int count;
    out vec4 o;

    float segDist(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a, ba = b - a;
      return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
    }

    void main() {
      vec2 p = (uv - vec2(0.5, 0.54)) * vec2(res.x / res.y, 1.0);
      const float R = 0.36;
      vec2 q = p / R;
      float r = length(q);
      float px = 1.0 / (res.y * R);
      vec3 col = vec3(0.01, 0.008, 0.015) * (1.0 - 0.5 * length(uv - 0.5));
      // The room lit faintly by the globe.
      col += inner * 0.05 * glow * exp(-r * 1.2);
      if (r < 1.02) {
        // Inside the glass: a dim haze of the gas.
        float inside = smoothstep(1.0 + px, 1.0 - px, r);
        vec3 gas = inner * (0.05 + 0.08 * glow) * (1.0 - r * 0.6) * (0.8 + 0.4 * fbm(q * 3.0 + time * 0.3));
        vec3 light = vec3(0.0);
        for (int i = 0; i < ${MAX}; i++) {
          if (i >= count) break;
          vec4 tip = tips[i];
          if (tip.w <= 0.0) continue;
          vec2 e = tip.xy;
          float seed = float(i) * 7.31;
          float d = 1e3;
          for (int k = 0; k < 10; k++) {
            vec4 ab = pts[i * 11 + k];
            vec2 c = pts[i * 11 + k + 1].xy;
            d = min(d, min(segDist(q, ab.xy, ab.zw), segDist(q, ab.zw, c)));
          }
          float bright = tip.w * (0.55 + 0.45 * (tip.z * 0.5 + 0.5));
          float fl = 1.0 - flicker * 0.5 * vnoise(vec2(time * 40.0, seed));
          light += cols[i] * (exp(-d * d / (px * px * 12.0)) * 1.5 + exp(-d * 14.0) * 0.4) * bright * fl;
          light += vec3(1.0) * exp(-d * d / (px * px * 1.5)) * 0.6 * bright * fl;
          // Where it meets the glass: a bright spot.
          light += cols[i] * exp(-pow(length(q - e) / 0.06, 2.0)) * bright * 0.8;
        }
        // The electrode: a hot ball in the middle.
        float core = exp(-pow(r / 0.12, 2.0));
        light += mix(inner, vec3(1.0), 0.6) * core * (1.2 + glow) + inner * exp(-r * 6.0) * 0.6 * glow;
        col = mix(col, col * 0.5 + gas + light, inside);
        // The glass: darker and tinted at its rim, a window's glint, a soft ring.
        float rim = smoothstep(0.75, 1.0, r) * inside;
        col += inner * rim * 0.12 * (0.5 + glow);
        vec2 g = q - vec2(-0.42, 0.45);
        float glint = exp(-pow(length(g * vec2(1.0, 1.6)) / 0.18, 2.0)) * 0.35 + exp(-pow((r - 0.93) / 0.03, 2.0)) * 0.08;
        col += vec3(0.9, 0.92, 1.0) * glint * inside;
        col += vec3(0.6, 0.65, 0.8) * exp(-pow((r - 1.0) / (px * 2.0), 2.0)) * 0.35;
      }
      // The stand: a black cone with a chrome band, under the globe.
      if (stand > 0.5) {
        vec2 s = q - vec2(0.0, -1.0);
        float top = 0.34, bottom = 0.62, h = 0.55;
        float y = -s.y / h;
        float half_ = mix(top, bottom, clamp(y, 0.0, 1.0));
        if (y > -0.05 && y < 1.0 && abs(s.x) < half_ && r > 0.97) {
          float shade = 0.03 + 0.05 * pow(1.0 - abs(s.x) / half_, 2.0) + inner.x * 0.0;
          vec3 base = vec3(shade);
          float band = smoothstep(0.02, 0.0, abs(y - 0.12) - 0.04);
          base = mix(base, vec3(0.3, 0.31, 0.33) * (0.5 + 0.8 * pow(1.0 - abs(s.x) / half_, 3.0)), band);
          base += inner * 0.15 * glow * smoothstep(0.3, 0.0, y);
          col = base;
        }
      }
      col = 1.0 - exp(-col * 1.3);
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

  /** A random point on the unit sphere. */
  function onSphere() {
    const z = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    return [Math.cos(a) * r, Math.sin(a) * r, z];
  }

  class PlasmaGlobe {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.tendrils = Array.from({ length: MAX }, (_, i) => ({ d: onSphere(), drift: onSphere(), on: 0, hue: i / MAX }));
      this.touch = 0;
      this.finger = [0, 0, 1];
      this.glow = 0.5;
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
      const most = Number(set('pgCount'));
      const pal = PALETTES[set('pgColors')];
      // More tendrils the louder; a fingertip on the big kicks.
      const want = a.playing ? 3 + (most - 3) * Math.min(1, a.level * 1.4 + a.intensity * 0.3) : 3;
      if (a.playing && a.onset && a.onsetPower > 0.6) {
        this.touch = 1;
        const ang = (Math.random() - 0.5) * 2.4 + Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1);
        const z = 0.55;
        this.finger = [Math.cos(ang) * Math.sqrt(1 - z * z), Math.sin(ang) * Math.sqrt(1 - z * z), z];
      }
      this.touch *= Math.exp(-dt * 1.6);
      const target = a.playing ? 0.4 + 0.7 * a.throb + 0.3 * a.level : 0.3;
      this.glow += (target - this.glow) * Math.min(1, dt * 8);
      const speed = (a.playing ? 0.6 + 0.8 * a.mid : 0.25) * a.pace;

      const tips = new Float32Array(MAX * 4);
      const cols = new Float32Array(MAX * 3);
      const pts = new Float32Array(MAX * 11 * 4);
      const wiggle = a.playing ? a.mid : 0.2;
      const jitter = a.playing ? a.treble : 0.1;
      this.phase = (this.phase || 0) + dt * (a.playing ? 1 + a.level : 0.4);
      this.tendrils.forEach((t, i) => {
        // Wandering over the sphere: drawn towards a point that moves itself.
        for (let k = 0; k < 3; k += 1) t.drift[k] += (Math.random() - 0.5) * dt * 2;
        let len = Math.hypot(...t.drift);
        t.drift = t.drift.map((v) => v / len);
        const pull = this.touch * (i % 3 === 0 ? 0.25 : 0.9);
        const goal = t.drift.map((v, k) => v + (this.finger[k] - v) * pull);
        t.d = t.d.map((v, k) => v + (goal[k] - v) * Math.min(1, dt * speed * (1 + 4 * pull)));
        len = Math.hypot(...t.d);
        t.d = t.d.map((v) => v / len);
        t.on += ((i < want ? 1 : 0) - t.on) * Math.min(1, dt * 4);
        const strength = t.on * this.glow * (1 + this.touch * 0.8);
        tips.set([t.d[0] * 0.97, t.d[1] * 0.97, t.d[2], strength], i * 4);
        // Its line: from the middle to the tip, wavering (slow waves, quicker
        // ripples with the highs), still at both ends.
        const ex = t.d[0] * 0.97;
        const ey = t.d[1] * 0.97;
        const span = Math.hypot(ex, ey) || 1;
        const nx = -ey / span;
        const ny = ex / span;
        const amp = (0.1 + 0.16 * wiggle) * span;
        const ph = this.phase;
        for (let k = 0; k <= 20; k += 1) {
          const f = k / 20;
          const wob = Math.sin(f * 5 + ph * 3.1 + i * 1.7) * 0.6 + Math.sin(f * 10.5 - ph * 4.7 + i * 2.9) * 0.3
            + Math.sin(f * 16 + ph * 11 + i * 5.3) * 0.1 * (0.4 + jitter);
          const off = wob * amp * Math.sin(Math.PI * f);
          pts[(i * 11) * 4 + k * 2] = ex * f + nx * off;
          pts[(i * 11) * 4 + k * 2 + 1] = ey * f + ny * off;
        }
        const c = pal ? pal[i % 2] : hsv((t.hue + this.age * 0.03) % 1, 0.7, 1);
        cols.set(c, i * 3);
      });
      const inner = pal ? pal[0] : hsv((this.age * 0.03) % 1, 0.6, 1);

      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.glow, this.glow);
      gl.uniform1f(u.wiggle, a.playing ? a.mid : 0.2);
      gl.uniform1f(u.flicker, a.playing ? 0.3 + a.treble : 0.2);
      gl.uniform1f(u.touch, this.touch);
      gl.uniform1f(u.stand, set('pgStand') ? 1 : 0);
      gl.uniform4fv(u.tips, tips);
      gl.uniform3fv(u.cols, cols);
      gl.uniform4fv(u.pts, pts);
      gl.uniform3f(u.inner, inner[0], inner[1], inner[2]);
      gl.uniform1i(u.count, MAX);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'plasmaglobe',
    name: 'Plasma Globe',
    desc: 'A plasma globe crackling with the music, its tendrils reaching for the glass and gathering to a fingertip on the big kicks',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="8"/><path d="M12 10l-4-5M12 10l5-3M12 10l-1 6M12 10l6 3"/><path d="M8 21h8l-1-3H9z"/></svg>',
    gl: true,
    create: (canvas) => new PlasmaGlobe(canvas),
    options: [
      { type: 'choice', key: 'pgColors', label: 'Colours', choices: [['plasma', 'Plasma'], ['blue', 'Blue'], ['green', 'Green'], ['rainbow', 'Rainbow']] },
      { type: 'slider', key: 'pgCount', label: 'Tendrils', min: 4, max: MAX, step: 1, unit: '' },
      { type: 'check', key: 'pgStand', label: 'Stand' },
    ],
  });
})();
