'use strict';

// Warp: flying through the stars. They stream past from a glow far ahead,
// faster on the kicks and the more intense the music; each star belongs to a
// band of the spectrum and lights up with it, so the field sparkles with the
// sound, the bass near the middle and the highs out at the edges. A big drop
// can jump to hyperspace: the stars stretch into long lines for a moment.
// The field rolls slowly and sways with the music.
//
// Its cogwheel: Speed, Stars (how many), Colors (white, the spectrum's or
// a nebula's), Hyperspace jumps.
//
// WebGL (viz/gl.js): a glowing nebula behind as one pass, every star a soft
// streak from where it was a moment ago to where it is, drawn twice (wide
// and faint, then thin and bright) for its glow.

(() => {
  const BASE_STARS = 1600;
  const NEAR = 0.04;
  const FAR = 1.4;

  const BG_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform float time, glow, jump;
    uniform vec3 tintA, tintB;
    out vec4 o;
    void main() {
      vec2 p = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      float r = length(p);
      // A soft nebula at the vanishing point, its wisps turning slowly and
      // coming on (read round a circle, so it has no seam).
      float t = time * 0.03;
      vec2 dir = mat2(cos(t), -sin(t), sin(t), cos(t)) * (p / max(r, 1e-4));
      float n = fbm(dir * 1.6 + vec2(log(r + 0.05) * 2.0 - time * 0.25, 3.0));
      n = mix(0.55, n, smoothstep(0.0, 0.18, r));
      float core = exp(-r * r * 9.0) * (0.25 + 0.6 * glow);
      vec3 col = mix(tintA, tintB, n) * (core + 0.08 * n * exp(-r * 1.8));
      col += vec3(0.6, 0.75, 1.0) * jump * exp(-r * r * 3.0) * 0.6;
      col += vec3(0.004, 0.005, 0.012);
      col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  function hsv(h, s, v) {
    const f = (n) => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }

  class Warp {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.bg = VizGL.program(gl, VizGL.SCREEN_VS, BG_FS);
      this.lines = VizGL.lines(gl, BASE_STARS * 2 * 2 * 6 + 600);
      this.stars = [];
      this.speed = 0.3;
      this.roll = 0;
      this.sway = [0, 0];
      this.age = 0;
      this.jump = 0;       // 0..1, a hyperspace jump under way
      this.lastJump = -20;
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

    /** A star far ahead (or anywhere along the way, at the start). */
    _star(s, anywhere) {
      // Bass near the middle, the highs further out.
      const band = Math.random();
      const ang = Math.random() * Math.PI * 2;
      const r = 0.06 + band * 0.9 + Math.random() * 0.25;
      s.x = Math.cos(ang) * r;
      s.y = Math.sin(ang) * r;
      s.z = anywhere ? NEAR + Math.random() * (FAR - NEAR) : FAR * (0.85 + Math.random() * 0.15);
      s.band = band;
      s.size = 0.6 + Math.random() * Math.random() * 1.8;
      s.tone = Math.random();
      return s;
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      const want = Math.round(BASE_STARS * set('wpCount') / 100);
      while (this.stars.length < want) this.stars.push(this._star({}, true));
      if (this.stars.length > want) this.stars.length = want;

      // Hyperspace: a strong beat in an intense part, not too often.
      if (set('wpJumps') && a.onset && a.beat > 0.85 && a.intensity > 0.8 && this.age - this.lastJump > 12 && Math.random() < 0.35) {
        this.lastJump = this.age;
      }
      const since = this.age - this.lastJump;
      this.jump = since < 1.6 ? Math.sin(Math.min(1, since / 1.6) * Math.PI) ** 0.7 : 0;

      const target = (a.playing ? 0.22 * (1 + 2.4 * a.kick + 1.2 * a.intensity) : 0.04) * (set('wpSpeed') / 100);
      this.speed += (target - this.speed) * (1 - Math.exp(-dt / 0.25));
      const speed = this.speed * (1 + 7 * this.jump);
      this.roll += dt * (0.03 + 0.12 * a.mid);
      // The view sways a little, steered by the music.
      const t = this.age;
      this.sway = [Math.sin(t * 0.23) * 0.05 + Math.sin(t * 0.61) * 0.02 * a.level, Math.cos(t * 0.17) * 0.04];

      const gl = this.gl;
      const w = this.w;
      const h = this.h;
      const colors = set('wpColor');
      const tint = colors === 'nebula' ? [[0.35, 0.15, 0.7], [0.1, 0.45, 0.9]] : (colors === 'spectrum' ? [[0.5, 0.2, 0.6], [0.9, 0.35, 0.2]] : [[0.25, 0.3, 0.5], [0.45, 0.4, 0.55]]);
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.bg.p);
      const u = this.bg.u;
      gl.uniform2f(u.res, w, h);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.glow, a.bass * 0.8 + a.kick * 0.5);
      gl.uniform1f(u.jump, this.jump);
      gl.uniform3f(u.tintA, ...tint[0]);
      gl.uniform3f(u.tintB, ...tint[1]);
      VizGL.screen(gl);

      // The stars.
      const f = h * 0.55;
      const cx = w / 2 + this.sway[0] * h;
      const cy = h / 2 + this.sway[1] * h;
      const cos = Math.cos(this.roll);
      const sin = Math.sin(this.roll);
      const unit = h / 1080;
      const bands = a.dynamic;
      const nb = bands.length;
      // How long a streak is: the way it came over this long.
      const trail = 0.018 + 0.05 * this.jump;
      const glows = [];
      for (const s of this.stars) {
        s.z -= speed * dt;
        if (s.z < NEAR) this._star(s, false);
        const x = s.x * cos - s.y * sin;
        const y = s.x * sin + s.y * cos;
        const z0 = s.z + speed * trail;
        const x1 = cx + (x / s.z) * f;
        const y1 = cy + (y / s.z) * f;
        if (x1 < -50 || x1 > w + 50 || y1 < -50 || y1 > h + 50) {
          if (s.z < FAR * 0.5) this._star(s, false);
          continue;
        }
        const x0 = cx + (x / z0) * f;
        const y0 = cy + (y / z0) * f;
        const near = 1 - s.z / FAR;
        const level = bands[Math.min(nb - 1, Math.floor(s.band * nb))] || 0;
        let rgb;
        if (colors === 'spectrum') rgb = hsv((0.62 - s.band * 0.62 + 1) % 1, 0.65, 1);
        else if (colors === 'nebula') rgb = hsv(0.55 + s.tone * 0.25, 0.45, 1);
        else rgb = s.tone < 0.15 ? [1, 0.85, 0.7] : (s.tone < 0.3 ? [0.75, 0.85, 1] : [1, 1, 1]);
        const bright = Math.min(1.2, near ** 1.5 * (0.5 + 1.4 * level) * (a.playing ? 1 : 0.6) + 0.06);
        const width = Math.max(0.6, s.size * (0.4 + 1.6 * near)) * unit;
        this.lines.seg(x0, y0, x1, y1, width, rgb, bright);
        if (bright > 0.35) glows.push([x0, y0, x1, y1, width * 3.5, rgb, bright * 0.12]);
      }
      for (const g of glows) this.lines.seg(...g);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.lines.draw(w, h);
      gl.disable(gl.BLEND);
    }
  }

  Visualizer.add({
    id: 'warp',
    name: 'Warp',
    desc: 'Flying through the stars, faster on the kicks; every star shines with its part of the spectrum, and big drops jump to hyperspace',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 12l-8-6M12 12l8-6M12 12l-8 6M12 12l8 6M12 12V3M12 12v9M12 12H2M12 12h10"/></svg>',
    gl: true,
    create: (canvas) => new Warp(canvas),
    options: [
      { type: 'slider', key: 'wpSpeed', label: 'Speed', min: 25, max: 300, step: 5 },
      { type: 'slider', key: 'wpCount', label: 'Stars', min: 25, max: 200, step: 5 },
      { type: 'choice', key: 'wpColor', label: 'Colors', choices: [['white', 'White'], ['spectrum', 'Spectrum'], ['nebula', 'Nebula']] },
      { type: 'check', key: 'wpJumps', label: 'Hyperspace jumps' },
    ],
  });
})();
