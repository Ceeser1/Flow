'use strict';

// Inferno: the spectrum on fire. Along the bottom each band feeds the flames
// above it with heat as loud as it is (the bass in the middle and the highs
// out to the sides, or low to high across), the kicks make them flare, and
// the heat rises, sways and cools into tongues of flame; embers fly up off
// the loudest parts.
//
// Its cogwheel: the flame's colour (fire, blue gas, toxic green, purple, or
// a rainbow across), its height, the layout, the embers.
//
// WebGL (viz/gl.js): the heat is a texture at a quarter of the screen's size
// worked on 120 times a second whatever the screen's rate (each step: the heat
// below risen, swayed by noise, spread and cooled, the bands' heat added at
// the bottom), then coloured onto the screen.

(() => {
  const STEP_S = 1 / 120;
  // The flames' height at 100%: the cooling each step allows for (twice what
  // was 100% before ifFlameHeight).
  const TALL = 2;
  const PALETTES = {
    // Each channel comes in from lo to hi heat.
    fire: [[0.02, 0.32, 0.75], [0.55, 1.0, 1.4]],
    blue: [[0.75, 0.32, 0.02], [1.4, 1.0, 0.55]],
    green: [[0.5, 0.02, 0.8], [1.1, 0.55, 1.4]],
    purple: [[0.12, 0.75, 0.02], [0.7, 1.35, 0.6]],
  };

  const SIM_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D prev;
    uniform sampler2D bands;
    uniform vec2 texel;
    uniform float time, cool, flare, centre;
    out vec4 o;
    void main() {
      // Where this heat came from: below, swayed sideways by the noise.
      float n = vnoise(vec2(uv.x * 22.0, uv.y * 9.0 - time * 2.6));
      float m = vnoise(vec2(uv.x * 48.0 + 5.0, uv.y * 24.0 - time * 5.5));
      vec2 from = uv - vec2((n - 0.5) * texel.x * 2.2, texel.y * 1.6);
      float heat = texture(prev, from).r * 0.5
        + (texture(prev, from + vec2(texel.x, 0.0)).r + texture(prev, from - vec2(texel.x, 0.0)).r) * 0.25;
      // Cooling, unevenly: the tongues of flame.
      heat -= cool * (0.2 + 1.8 * m * m);
      // The bands' heat along the bottom.
      float x = centre > 0.5 ? abs(uv.x - 0.5) * 2.0 : uv.x;
      float level = texture(bands, vec2(x * 0.98 + 0.01, 0.5)).r;
      float base = 1.0 - smoothstep(0.0, 0.035, uv.y);
      float feed = (level * 1.05 + flare * 0.25) * (0.6 + 0.8 * m);
      heat = max(heat, feed * base);
      o = vec4(max(heat, 0.0), 0.0, 0.0, 1.0);
    }`;

  const OUT_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D heat;
    uniform vec3 lo, hi;
    uniform float rainbow, time;
    out vec4 o;
    vec3 colour(float t) {
      if (rainbow > 0.5) {
        vec3 c = hsv2rgb(vec3(fract(uv.x * 0.8 + time * 0.05), 1.0 - smoothstep(0.6, 1.2, t), smoothstep(0.0, 0.55, t)));
        return c;
      }
      return smoothstep(lo, hi, vec3(t));
    }
    void main() {
      float t = texture(heat, uv).r;
      // A faint glow of the fire on the air above it.
      float g = textureLod(heat, uv - vec2(0.0, 0.02), 3.0).r;
      vec3 col = colour(t) + colour(min(g, 0.6)) * 0.25;
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Inferno {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.sim = VizGL.program(gl, VizGL.SCREEN_VS, SIM_FS);
      this.out = VizGL.program(gl, VizGL.SCREEN_VS, OUT_FS);
      this.lines = VizGL.lines(gl, 6000);
      this.bandTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.bandBytes = null;
      this.owed = 0;
      this.age = 0;
      this.embers = [];
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.a, this.b]) VizGL.freeTarget(gl, t);
      const sw = Math.max(64, Math.round(w / 4));
      const sh = Math.max(36, Math.round(h / 4));
      // Mipmapped for the glow, so not clamped to the edge's texel only.
      this.a = VizGL.target(gl, sw, sh);
      this.b = VizGL.target(gl, sw, sh);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      this.age += dt;
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);

      // The bands, as a row of bytes: louder and jumpier than the bars, mixed.
      const n = a.BANDS;
      if (!this.bandBytes) this.bandBytes = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) {
        const v = 0.55 * a.smooth[i] + 0.6 * a.dynamic[i] * a.smooth[i] ** 0.5;
        this.bandBytes[i] = Math.max(0, Math.min(255, Math.round(v * 220)));
      }
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, n, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this.bandBytes);

      // The fire, 120 steps a second: rising and swaying twice as fast as it
      // first did (each step lifts the heat as far and cools it as much as
      // before, so the flames stand as tall; the sway's noise runs twice as
      // fast).
      const height = (set('ifFlameHeight') / 100) * TALL;
      const cool = 0.02 / height;
      this.owed = Math.min(8, this.owed + dt / STEP_S);
      gl.disable(gl.BLEND);
      gl.useProgram(this.sim.p);
      const u = this.sim.u;
      while (this.owed >= 1) {
        this.owed -= 1;
        VizGL.into(gl, this.b);
        VizGL.bind(gl, u.prev, this.a.tex, 0);
        VizGL.bind(gl, u.bands, this.bandTex, 1);
        gl.uniform2f(u.texel, 1 / this.a.w, 1 / this.a.h);
        gl.uniform1f(u.time, this.age * 2);
        gl.uniform1f(u.cool, cool);
        gl.uniform1f(u.flare, a.kick);
        gl.uniform1f(u.centre, set('ifLayout') === 'centre' ? 1 : 0);
        VizGL.screen(gl);
        [this.a, this.b] = [this.b, this.a];
      }
      gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);

      // Onto the screen.
      VizGL.into(gl, null);
      gl.useProgram(this.out.p);
      const o = this.out.u;
      VizGL.bind(gl, o.heat, this.a.tex, 0);
      const palette = set('ifColor');
      const p = PALETTES[palette] || PALETTES.fire;
      gl.uniform3f(o.lo, ...p[0]);
      gl.uniform3f(o.hi, ...p[1]);
      gl.uniform1f(o.rainbow, palette === 'rainbow' ? 1 : 0);
      gl.uniform1f(o.time, this.age);
      VizGL.screen(gl);
      gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

      if (set('ifEmbers')) this._embers(a, dt, palette, p);
    }

    /** Embers flying up off the loudest bands, more on the kicks. */
    _embers(a, dt, palette, p) {
      const unit = this.h / 1080;
      const centre = Visualizer.setting('ifLayout') === 'centre';
      const born = a.playing ? (6 + 60 * a.kick + (a.onset ? 25 * a.onsetPower : 0)) * dt : 0;
      this._owedEmbers = Math.min(3, (this._owedEmbers || 0) + born);
      while (this._owedEmbers >= 1 && this.embers.length < 500) {
        this._owedEmbers -= 1;
        // Where the fire is: a band picked by how loud it is.
        let i = 0;
        for (let k = 0; k < 6; k += 1) {
          const j = Math.floor(Math.random() * a.BANDS);
          if (a.smooth[j] > a.smooth[i]) i = j;
        }
        const x = i / a.BANDS;
        const sx = centre ? 0.5 + (Math.random() < 0.5 ? -1 : 1) * x * 0.5 : x;
        this.embers.push({
          x: sx * this.w, y: this.h * (0.92 - Math.random() * 0.25 * a.smooth[i]), vx: (Math.random() - 0.5) * 40 * unit,
          vy: -(120 + Math.random() * 260) * unit * (0.6 + a.smooth[i]), life: 1, fade: 0.35 + Math.random() * 0.5, size: (1 + Math.random() * 1.6) * unit, seed: Math.random() * 100,
        });
      }
      const heatColour = (t) => {
        if (palette === 'rainbow') return [1, 0.9, 0.6];
        return [0, 1, 2].map((c) => {
          const x = Math.min(1, Math.max(0, (t - p[0][c]) / (p[1][c] - p[0][c])));
          return x * x * (3 - 2 * x);
        });
      };
      for (const e of this.embers) {
        e.life -= dt * e.fade;
        e.vx += Math.sin(this.age * 3 + e.seed) * 60 * unit * dt;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        const t = 0.55 + 0.6 * e.life * (0.7 + 0.3 * Math.sin(this.age * 20 + e.seed));
        const col = heatColour(t);
        this.lines.dot(e.x, e.y, e.size * 6, col, Math.max(0, e.life) * 0.12);
        this.lines.dot(e.x, e.y, e.size * 2.4, col, Math.max(0, e.life));
      }
      this.embers = this.embers.filter((e) => e.life > 0 && e.y > -20);
      const gl = this.gl;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.lines.draw(this.w, this.h);
      gl.disable(gl.BLEND);
    }
  }

  Visualizer.add({
    id: 'inferno',
    name: 'Inferno',
    desc: 'The spectrum on fire: every band feeds the flames above it, the kicks make them flare, embers fly',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c4 0 7-3 7-7 0-5-4-7-5-12-2 3-2 5-1 7-2-1-3-3-3-5-3 3-5 6-5 10 0 4 3 7 7 7z"/></svg>',
    gl: true,
    create: (canvas) => new Inferno(canvas),
    options: [
      { type: 'choice', key: 'ifColor', label: 'Flames', choices: [['fire', 'Fire'], ['blue', 'Blue'], ['green', 'Toxic'], ['purple', 'Purple'], ['rainbow', 'Rainbow']] },
      { type: 'slider', key: 'ifFlameHeight', label: 'Height', min: 25, max: 150, step: 5 },
      { type: 'choice', key: 'ifLayout', label: 'Bass', choices: [['centre', 'In the middle'], ['across', 'On the left']] },
      { type: 'check', key: 'ifEmbers', label: 'Embers' },
    ],
  });
})();
