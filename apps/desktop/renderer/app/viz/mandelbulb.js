'use strict';

// Mandelbulb: a slow flight round the three-dimensional cousin of the
// Mandelbrot set, solid and lit, breathing with the music: its power (how
// many lobes it folds into) drifts and swells with the bass, a twist runs
// through it, it glows brighter round its edges on the kicks, and its colours
// follow the harmony (or a palette of their own). The eye circles it, faster
// with the music; from close up it fills the screen with its folds.
//
// Its cogwheel: the colours (the notes, fire, ice, rainbow), the view (the
// whole of it, or close up), how much it breathes.
//
// WebGL (viz/gl.js): raymarched at half the screen's size (the distance to it
// estimated each step: the usual formula for the bulb), coloured by how near
// its points came to the axes on the way (orbit traps), with a soft shadow,
// the steps' count for its crevices' shade and the near misses for a glow;
// then blurred for a bloom and laid on the screen.

(() => {
  const COLORS = { notes: 0, fire: 1, ice: 2, rainbow: 3 };
  // Distance from the middle and how fast it circles, per view.
  const VIEWS = { whole: { dist: 3.45, look: 0.0 }, close: { dist: 2.0, look: 0.3 } };

  const SCENE_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform vec3 eye, target;
    uniform float power, twist, time, glowAmt, hue, hue2;
    uniform int palette;
    out vec4 o;

    // The distance to the bulb from p, and its orbit traps (how near the
    // point's orbit came to each axis, and to the middle).
    float bulb(vec3 p, out vec4 trap) {
      vec3 z = p;
      float dr = 1.0;
      float r = length(z);
      trap = vec4(abs(z), dot(z, z));
      for (int i = 0; i < 8; i++) {
        r = length(z);
        if (r > 2.0) break;
        float th = acos(clamp(z.z / r, -1.0, 1.0)) * power + twist;
        float ph = atan(z.y, z.x) * power;
        dr = pow(r, power - 1.0) * power * dr + 1.0;
        z = pow(r, power) * vec3(sin(th) * cos(ph), sin(th) * sin(ph), cos(th)) + p;
        trap = min(trap, vec4(abs(z), dot(z, z)));
      }
      return 0.5 * log(max(r, 1e-6)) * r / dr;
    }

    float bulbD(vec3 p) {
      vec4 t;
      return bulb(p, t);
    }

    vec3 normalAt(vec3 p, float e) {
      const vec2 k = vec2(1.0, -1.0);
      return normalize(k.xyy * bulbD(p + k.xyy * e) + k.yyx * bulbD(p + k.yyx * e)
        + k.yxy * bulbD(p + k.yxy * e) + k.xxx * bulbD(p + k.xxx * e));
    }

    float shadow(vec3 p, vec3 l) {
      float s = 1.0;
      float t = 0.01;
      for (int i = 0; i < 24; i++) {
        float d = bulbD(p + l * t);
        s = min(s, 10.0 * d / t);
        t += clamp(d, 0.01, 0.12);
        if (s < 0.02 || t > 2.0) break;
      }
      return clamp(s, 0.0, 1.0);
    }

    // The surface's colour from its traps.
    vec3 paint(vec4 trap) {
      float a = clamp(sqrt(trap.w), 0.0, 1.0);
      if (palette == 1) return mix(mix(vec3(0.5, 0.04, 0.01), vec3(1.0, 0.45, 0.05), a), vec3(1.0, 0.85, 0.4), clamp(trap.x * 2.0, 0.0, 1.0));
      if (palette == 2) return mix(mix(vec3(0.03, 0.08, 0.35), vec3(0.2, 0.6, 1.0), a), vec3(0.85, 0.95, 1.0), clamp(trap.y * 2.0, 0.0, 1.0));
      if (palette == 3) return hsv2rgb(vec3(fract(a * 1.3 + trap.x * 0.6 + time * 0.03), 0.75, 1.0));
      vec3 c1 = hsv2rgb(vec3(hue, 0.75, 1.0));
      vec3 c2 = hsv2rgb(vec3(hue2, 0.7, 0.9));
      return mix(mix(c1 * 0.35, c1, a), c2, clamp(trap.y * 1.8, 0.0, 1.0));
    }

    vec3 glowColour() {
      if (palette == 1) return vec3(1.0, 0.4, 0.08);
      if (palette == 2) return vec3(0.3, 0.6, 1.0);
      if (palette == 3) return hsv2rgb(vec3(fract(time * 0.05), 0.7, 1.0));
      return hsv2rgb(vec3(hue2, 0.65, 1.0));
    }

    void main() {
      vec2 sp = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      vec3 fw = normalize(target - eye);
      vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(rt, fw);
      vec3 rd = normalize(fw * 1.6 + rt * sp.x + up * sp.y);

      // The bulb lies inside a ball of 1.25: start where the ray meets it.
      float b = dot(eye, rd);
      float c = dot(eye, eye) - 1.25 * 1.25;
      float disc = b * b - c;
      vec3 bg = vec3(0.004, 0.004, 0.01) + glowColour() * 0.06 * smoothstep(1.0, 0.0, length(sp)) * (0.6 + glowAmt);
      vec3 col = bg;
      float glow = 0.0;
      if (disc > 0.0) {
        float t = max(0.0, -b - sqrt(disc));
        float tEnd = -b + sqrt(disc);
        float pix = 1.2 / res.y;
        bool hit = false;
        float steps = 0.0;
        vec4 trap;
        for (int i = 0; i < 110; i++) {
          vec3 p = eye + rd * t;
          float d = bulb(p, trap);
          glow += exp(-d * 90.0) * 0.0035 * step(0.004, d);
          if (d < pix * t) { hit = true; break; }
          t += d * 0.9;
          steps += 1.0;
          if (t > tEnd) break;
        }
        if (hit) {
          vec3 p = eye + rd * t;
          vec3 n = normalAt(p, pix * t * 0.5);
          // A key light above and beside the eye, a fill in the second colour from below.
          vec3 l = normalize(up * 0.8 + rt * 0.5 - fw * 0.4);
          float diff = max(dot(n, l), 0.0) * shadow(p + n * 0.003, l);
          float fill = max(dot(n, normalize(-up * 0.6 - rt * 0.6 - fw * 0.3)), 0.0);
          float ao = clamp(1.0 - steps / 70.0, 0.0, 1.0);
          ao *= ao;
          vec3 h = normalize(l - rd);
          float spec = pow(max(dot(n, h), 0.0), 32.0) * diff;
          float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
          vec3 base = paint(trap);
          col = base * (0.1 + 1.25 * diff) * (0.35 + 0.65 * ao) + glowColour() * fill * 0.18 * ao + spec * 0.6 + glowColour() * rim * 0.5 * (0.5 + glowAmt);
          // Further away: into the dark.
          col = mix(col, bg, smoothstep(length(eye) - 0.2, length(eye) + 1.0, t) * 0.5);
        }
      }
      col += glowColour() * glow * (0.4 + 1.6 * glowAmt);
      o = vec4(col, 1.0);
    }`;

  const SHOW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D scene, bloom;
    uniform float time;
    out vec4 o;
    void main() {
      vec3 c = texture(scene, uv).rgb + texture(bloom, uv).rgb * 0.7;
      c = 1.0 - exp(-c * 1.4);
      // Darker towards the corners.
      vec2 d = uv - 0.5;
      c *= 1.0 - 0.45 * dot(d, d) * 2.0;
      c += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(c, 1.0);
    }`;

  class Mandelbulb {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.scene = VizGL.program(gl, VizGL.SCREEN_VS, SCENE_FS);
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.age = 0;
      this.orbit = Math.random() * Math.PI * 2;
      this.tilt = Math.random() * 10;
      this.morph = Math.random() * 100;
      this.dist = null;
      this.look = 0;
      this.glow = 0.3;
      this.bass = 0;
      // The harmony's colour as a point on the colour circle, so it glides round it.
      this.hx = 1;
      this.hy = 0;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.t, this.b1, this.b2]) VizGL.freeTarget(gl, t);
      this.t = VizGL.target(gl, Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
      const sw = Math.max(1, Math.round(w / 6));
      const sh = Math.max(1, Math.round(h / 6));
      this.b1 = VizGL.target(gl, sw, sh);
      this.b2 = VizGL.target(gl, sw, sh);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      const playing = a.playing ? 1 : 0;
      const breathe = set('mbMorph') / 100;
      // The flight: round it, faster with the music, rising and sinking slowly.
      const speed = a.playing ? a.motion(0.25, 1.2) : 0.2;
      this.orbit += dt * 0.07 * speed;
      this.tilt += dt * 0.05 * speed;
      this.morph += dt * (0.4 + 0.6 * a.intensity) * playing * breathe;
      this.bass += ((a.bass * playing) - this.bass) * Math.min(1, dt * 6);
      const view = VIEWS[set('mbView')] ?? VIEWS.whole;
      const dist = view.dist - 0.25 * a.intensity;
      this.dist = this.dist === null ? dist : this.dist + (dist - this.dist) * Math.min(1, dt * 0.8);
      this.look += (view.look - this.look) * Math.min(1, dt * 0.8);
      const elev = 0.55 * Math.sin(this.tilt);
      const eye = [
        Math.cos(this.orbit) * Math.cos(elev) * this.dist,
        Math.sin(elev) * this.dist,
        Math.sin(this.orbit) * Math.cos(elev) * this.dist,
      ];
      // From close up it looks a little past the middle, along its folds.
      const side = [Math.cos(this.orbit + 1.2) * this.look, Math.sin(this.tilt * 0.7) * this.look * 0.6, Math.sin(this.orbit + 1.2) * this.look];
      const power = 8 + breathe * (1.6 * Math.sin(this.morph * 0.13) + 0.9 * this.bass);
      const twist = breathe * (0.35 * Math.sin(this.morph * 0.21) + 0.25 * a.throb * playing);
      const target = a.playing ? 0.15 + 0.5 * a.throb + 0.3 * a.intensity : 0.1;
      this.glow += (target - this.glow) * Math.min(1, dt * 8);
      const nh = a.playing ? a.noteHue() : { hue: 0, strength: 0 };
      const k = Math.min(1, dt * 0.8 * (0.2 + nh.strength));
      this.hx += (Math.cos(nh.hue * Math.PI * 2) - this.hx) * k;
      this.hy += (Math.sin(nh.hue * Math.PI * 2) - this.hy) * k;
      const hue = ((Math.atan2(this.hy, this.hx) / (Math.PI * 2)) + 1) % 1;

      gl.disable(gl.BLEND);
      VizGL.into(gl, this.t);
      gl.useProgram(this.scene.p);
      const u = this.scene.u;
      gl.uniform2f(u.res, this.t.w, this.t.h);
      gl.uniform3f(u.eye, eye[0], eye[1], eye[2]);
      gl.uniform3f(u.target, side[0], side[1], side[2]);
      gl.uniform1f(u.power, power);
      gl.uniform1f(u.twist, twist);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.glowAmt, this.glow);
      gl.uniform1f(u.hue, hue);
      gl.uniform1f(u.hue2, (hue + 0.12) % 1);
      gl.uniform1i(u.palette, COLORS[set('mbColors')] ?? 0);
      VizGL.screen(gl);

      VizGL.blur(gl, this.t, this.b1, this.b2, 1);
      VizGL.blur(gl, this.b2, this.b1, this.b2, 1.5);
      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      VizGL.bind(gl, this.show.u.scene, this.t.tex, 0);
      VizGL.bind(gl, this.show.u.bloom, this.b2.tex, 1);
      gl.uniform1f(this.show.u.time, this.age);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'mandelbulb',
    name: 'Mandelbulb',
    desc: 'A slow flight round a three-dimensional fractal, breathing and twisting with the music, its colours following the harmony',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.9 2.9M15.5 15.5l2.9 2.9M5.6 18.4l2.9-2.9M15.5 8.5l2.9-2.9"/></svg>',
    gl: true,
    create: (canvas) => new Mandelbulb(canvas),
    options: [
      { type: 'choice', key: 'mbColors', label: 'Colours', choices: [['notes', 'By the notes'], ['fire', 'Fire'], ['ice', 'Ice'], ['rainbow', 'Rainbow']] },
      { type: 'choice', key: 'mbView', label: 'View', choices: [['whole', 'The whole'], ['close', 'Close up']] },
      { type: 'slider', key: 'mbMorph', label: 'Breathing', min: 0, max: 200, step: 5 },
    ],
  });
})();
