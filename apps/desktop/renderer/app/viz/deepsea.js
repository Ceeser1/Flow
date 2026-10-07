'use strict';

// Deep Sea: glowing jellyfish drifting up through dark water. Each bell
// contracts on the beat (some every beat, some every other, some on the off
// beat) and the push carries it up a little, its tentacles and frilled arms
// trailing behind, swaying in the current; each glows with its own part of
// the spectrum. Light comes down from the surface in shafts that brighten
// with the music; specks drift in it, and the kicks set plankton flashing.
// Without a clear beat they pulse at their own calm pace.
//
// Its cogwheel: their colours, how many, the light from above.
//
// WebGL (viz/gl.js): the water, its light and the specks are one pass over
// the screen; the jellyfish soft lines (their tentacles chains that follow
// the bell) added up in a texture, blurred small for the glow.

(() => {
  const MAX = 16;
  const TENTACLES = 10;
  const LINKS = 16;
  const ARMS = 4;
  const ARM_LINKS = 10;
  const PALETTES = {
    aurora: [0.5, 0.55, 0.78, 0.86, 0.95],
    ember: [0.0, 0.04, 0.08, 0.93, 0.97],
    ice: [0.52, 0.56, 0.6, 0.62, 0.66],
    rainbow: null,
  };

  const WATER_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D jelly, glow;
    uniform vec2 res;
    uniform float time, light, flash, shafts;
    out vec4 o;
    void main() {
      float asp = res.x / res.y;
      vec3 col = mix(vec3(0.0, 0.012, 0.035), vec3(0.0, 0.12, 0.2), pow(uv.y, 2.2));
      // Shafts of light from the surface, slanting, waving.
      float x = uv.x * asp + (1.0 - uv.y) * 0.35;
      float s = fbm(vec2(x * 2.6 + time * 0.03, time * 0.07));
      float beams = pow(smoothstep(0.35, 0.85, s), 2.0) * pow(uv.y, 1.4) * shafts * light;
      col += vec3(0.25, 0.55, 0.65) * beams * 0.55;
      // The surface's shimmer at the very top.
      col += vec3(0.2, 0.45, 0.5) * pow(uv.y, 12.0) * (0.6 + 0.4 * vnoise(vec2(uv.x * asp * 20.0, time))) * shafts;
      // Marine snow: specks in three depths, sinking slowly, a few flashing on the kicks.
      for (int k = 0; k < 3; k++) {
        float fk = float(k);
        float sc = 70.0 - fk * 18.0;
        vec2 p = vec2(uv.x * asp, uv.y) * sc + vec2(sin(time * 0.1 + fk) * 0.5, time * (0.25 + fk * 0.12));
        vec2 cell = floor(p);
        vec2 f = fract(p) - vec2(hash12(cell), hash12(cell + 7.0));
        float h = hash12(cell + 13.0 + fk * 5.0);
        float d = length(f * vec2(1.0, 1.0));
        float speck = smoothstep(0.06 + fk * 0.02, 0.0, d) * step(0.55, h) * (0.15 + 0.15 * fk);
        float glowk = step(0.97, h) * flash;
        col += vec3(0.5, 0.75, 0.8) * speck * (0.6 + 0.6 * beams) + vec3(0.3, 1.0, 0.9) * glowk * smoothstep(0.15, 0.0, d);
      }
      vec3 j = texture(jelly, uv).rgb;
      vec3 g = texture(glow, uv).rgb;
      col += j + g * 1.1;
      col = 1.0 - exp(-col * 1.25);
      col *= 1.0 - 0.3 * pow(length(uv - 0.5) * 1.3, 2.0);
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

  class DeepSea {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.water = VizGL.program(gl, VizGL.SCREEN_VS, WATER_FS);
      this.lines = VizGL.lines(gl, 60000);
      this.jellies = [];
      this.age = 0;
      this.ph = 0;
      this.beatN = 0;
      this.flash = 0;
      this.palette = null;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.t, this.b1, this.b2]) VizGL.freeTarget(gl, t);
      this.t = VizGL.target(gl, w, h);
      const sw = Math.max(1, Math.round(w / 4));
      const sh = Math.max(1, Math.round(h / 4));
      this.b1 = VizGL.target(gl, sw, sh);
      this.b2 = VizGL.target(gl, sw, sh);
      this.jellies = [];
      this.fresh = true;
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    /** A jellyfish, somewhere below (or anywhere, at the start). */
    _jelly(anywhere) {
      const z = 0.35 + Math.random() * 0.65;
      const R = this.h * (0.035 + 0.04 * z) * (0.8 + Math.random() * 0.4);
      const hues = PALETTES[this.palette];
      const hue = hues ? hues[Math.floor(Math.random() * hues.length)] : Math.random();
      const j = {
        z,
        R,
        x: Math.random() * this.w,
        y: anywhere ? Math.random() * this.h * 1.1 : this.h + R * 2 + Math.random() * this.h * 0.3,
        vx: 0,
        vy: 0,
        tilt: (Math.random() - 0.5) * 0.4,
        hue,
        band: Math.floor(Math.random() * 6),
        div: Math.random() < 0.35 ? 2 : 1,
        off: Math.random() < 0.3 ? 0.5 : 0,
        own: 0.6 + Math.random() * 0.5,   // its own pace, without a beat
        ownPh: Math.random(),
        squeeze: 0,
        lastPh: 0,
        drift: Math.random() * 100,
        tentacles: [],
        arms: [],
      };
      const chain = (n, x, y) => Array.from({ length: n }, (_, i) => ({ x, y: y + i * 2, px: x, py: y + i * 2 }));
      for (let i = 0; i < TENTACLES; i += 1) j.tentacles.push(chain(LINKS, j.x, j.y));
      for (let i = 0; i < ARMS; i += 1) j.arms.push(chain(ARM_LINKS, j.x, j.y));
      return j;
    }

    /** The bell's point at t (-1 left rim .. 1 right rim), in its own frame (y up), squeezed by s. */
    _bell(j, t, s) {
      const R = j.R * (1 - 0.22 * s);
      const H = j.R * (0.8 + 0.2 * s);
      const a = (t * Math.PI) / 2;
      const flare = 1 + 0.14 * (1 - s) * t ** 4;
      return [Math.sin(a) * R * flare, Math.cos(a) ** 0.75 * H];
    }

    _world(j, lx, ly) {
      const ux = Math.sin(j.tilt);
      const uy = -Math.cos(j.tilt);
      const rx = Math.cos(j.tilt);
      const ry = Math.sin(j.tilt);
      return [j.x + rx * lx + ux * ly, j.y + ry * lx + uy * ly];
    }

    /** A chain hanging from (x, y): each link follows the one before at its length, sinking a little, swaying. */
    _follow(chain, x, y, len, sway, dt, phase = 0) {
      chain[0].x = x;
      chain[0].y = y;
      for (let i = 1; i < chain.length; i += 1) {
        const p = chain[i];
        p.x += sway * Math.sin(this.age * 1.1 + i * 0.35 + phase) * dt;
        p.y += len * 2.2 * dt;
        const q = chain[i - 1];
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        const d = Math.hypot(dx, dy) || 1;
        p.x = q.x + (dx / d) * len;
        p.y = q.y + (dy / d) * len;
      }
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      dt = Math.min(dt, 0.05);
      this.age += dt;
      const palette = set('dsColors');
      const count = Number(set('dsCount'));
      if (palette !== this.palette) {
        this.palette = palette;
        this.jellies = [];
        this.fresh = true;
      }
      // Spread over the water at first, coming up from below after.
      while (this.jellies.length < count) this.jellies.push(this._jelly(this.fresh));
      this.fresh = false;
      if (this.jellies.length > count) this.jellies.length = count;

      // The beat: the tempo's when it is clear.
      const sure = a.playing && a.sure >= 0.35 && a.bpm;
      if (sure) {
        if (a.tick) this.beatN += 1;
        this.ph = a.phase;
      }
      if (a.playing && a.onset) this.flash = Math.max(this.flash, a.onsetPower);
      this.flash *= Math.exp(-dt * 5);

      const l = this.lines;
      for (const j of this.jellies) {
        // Where in its stroke: on the beat (every one or every other, or the
        // off beat), else its own calm pace; paused, it barely moves.
        let ph;
        if (sure) ph = (((this.beatN + this.ph) / j.div + j.off) % 1 + 1) % 1;
        else {
          j.ownPh = (j.ownPh + dt * j.own * (a.playing ? 0.9 : 0.25)) % 1;
          ph = j.ownPh;
        }
        // A quick squeeze, a slow letting go; the push when it squeezes.
        const s = ph < 0.16 ? Math.sin((ph / 0.16) * Math.PI / 2) : Math.exp(-(ph - 0.16) * 5);
        if (ph >= 0.08 && (j.lastPh < 0.08 || ph < j.lastPh)) j.vy -= (a.playing ? 26 : 8) * j.z * (this.h / 1080);
        j.lastPh = ph;
        j.squeeze = s;
        j.vy += ((-5 * j.z * (this.h / 1080)) - j.vy) * Math.min(1, dt * 2);
        j.vx = Math.sin(this.age * 0.15 + j.drift) * 10 * j.z;
        j.x += j.vx * dt;
        j.y += j.vy * dt;
        j.tilt += ((j.vx * 0.012 + Math.sin(this.age * 0.3 + j.drift) * 0.12) - j.tilt) * Math.min(1, dt * 1.5);
        if (j.y < -j.R * 6) Object.assign(j, this._jelly(false));
        if (j.x < -j.R * 3) j.x += this.w + j.R * 6;
        if (j.x > this.w + j.R * 3) j.x -= this.w + j.R * 6;

        // Glowing with its part of the spectrum.
        const from = Math.floor((j.band / 6) * a.BANDS * 0.9);
        const to = Math.floor(((j.band + 1) / 6) * a.BANDS * 0.9);
        let lv = 0;
        for (let k = from; k < to; k += 1) lv += a.dynamic[k];
        lv /= to - from;
        const bright = (0.35 + 0.65 * j.z) * (a.playing ? 0.55 + 0.8 * lv : 0.4);
        const col = hsv(j.hue, 0.75, 1);
        const pale = hsv(j.hue, 0.35, 1);
        const wd = Math.max(0.8, j.R * 0.035);

        // The bell: filled faintly (a fan of soft strokes from its top to the
        // rim, its canals), its rim bright, four loops inside as theirs have.
        const N = 24;
        const [topX, topY] = this._world(j, 0, j.R * 0.55);
        let prev = null;
        for (let i = 0; i <= N; i += 1) {
          const t = -1 + (2 * i) / N;
          const [bx, by] = this._bell(j, t, s);
          const [x, y] = this._world(j, bx, by);
          const [ix, iy] = this._world(j, bx * 0.97, by * 0.97 - j.R * 0.02);
          l.seg(topX, topY, ix, iy, j.R * 0.16, col, 0.05 * bright);
          if (i % 3 === 0) l.seg(topX, topY, ix, iy, wd * 0.6, pale, 0.12 * bright);
          if (prev) l.seg(prev[0], prev[1], x, y, wd * 1.3, pale, 0.85 * bright);
          prev = [x, y];
        }
        for (let k = 0; k < 4; k += 1) {
          const cx0 = [-0.27, -0.09, 0.09, 0.27][k] * j.R;
          const ry = j.R * (0.3 + (k % 2 ? 0.04 : -0.02));
          let q = null;
          for (let m = 0; m <= 8; m += 1) {
            const an = (m / 8) * Math.PI * 2;
            const [x, y] = this._world(j, cx0 + Math.cos(an) * j.R * 0.11, ry + Math.sin(an) * j.R * 0.13);
            if (q) l.seg(q[0], q[1], x, y, wd * 0.9, col, 0.16 * bright);
            q = [x, y];
          }
        }

        // Tentacles from the rim, arms from the middle, trailing.
        for (let i = 0; i < TENTACLES; i += 1) {
          const t = -0.92 + (1.84 * i) / (TENTACLES - 1);
          const [bx, by] = this._bell(j, t, s);
          const [rx, ry] = this._world(j, bx * 0.96, by * 0.05);
          const chain = j.tentacles[i];
          this._follow(chain, rx, ry, j.R * (0.17 + 0.09 * ((i * 7) % 5) / 4), 34 * j.z, dt, i * 1.9 + j.drift);
          for (let k = 1; k < chain.length; k += 1) {
            const fade = 1 - k / chain.length;
            l.seg(chain[k - 1].x, chain[k - 1].y, chain[k].x, chain[k].y, wd * 0.7, col, 0.5 * bright * fade);
          }
        }
        for (let i = 0; i < ARMS; i += 1) {
          const [rx, ry] = this._world(j, (i - 1.5) * j.R * 0.12, j.R * 0.1);
          const chain = j.arms[i];
          this._follow(chain, rx, ry, j.R * 0.15, 16 * j.z, dt, i * 2.3 + j.drift);
          // A frilled ribbon: two edges weaving about the chain.
          for (const side of [-1, 1]) {
            let q = null;
            for (let k = 0; k < chain.length; k += 1) {
              const c = chain[Math.min(k, chain.length - 1)];
              const n = chain[Math.min(k + 1, chain.length - 1)];
              const pv = chain[Math.max(k - 1, 0)];
              const dx = n.x - pv.x;
              const dy = n.y - pv.y;
              const d = Math.hypot(dx, dy) || 1;
              const off = side * j.R * 0.05 * (1 - k / chain.length * 0.5) * (1 + 0.8 * Math.sin(k * 1.6 + this.age * 2.5 + i + side));
              const x = c.x - (dy / d) * off;
              const y = c.y + (dx / d) * off;
              if (q) l.seg(q[0], q[1], x, y, wd * 0.8, pale, 0.3 * bright * (1 - k / chain.length));
              q = [x, y];
            }
          }
        }
      }

      VizGL.into(gl, this.t);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      l.draw(this.w, this.h);
      gl.disable(gl.BLEND);
      VizGL.blur(gl, this.t, this.b1, this.b2, 1);
      VizGL.blur(gl, this.b2, this.b1, this.b2, 1.5);

      VizGL.into(gl, null);
      gl.useProgram(this.water.p);
      const u = this.water.u;
      VizGL.bind(gl, u.jelly, this.t.tex, 0);
      VizGL.bind(gl, u.glow, this.b2.tex, 1);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.light, a.playing ? 0.6 + 0.6 * a.level + 0.3 * a.intensity : 0.5);
      gl.uniform1f(u.flash, this.flash);
      gl.uniform1f(u.shafts, set('dsLight') ? 1 : 0);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'deepsea',
    name: 'Deep Sea',
    desc: 'Glowing jellyfish drifting up through dark water, their bells beating with the music, light falling from the surface',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a8 8 0 0 1 16 0z"/><path d="M7 11c0 3-1 5 0 9M10 11c0 3 1 6 0 10M14 11c0 3-1 6 0 10M17 11c0 3 1 5 0 9"/></svg>',
    gl: true,
    create: (canvas) => new DeepSea(canvas),
    options: [
      { type: 'choice', key: 'dsColors', label: 'Colours', choices: [['aurora', 'Aurora'], ['ember', 'Ember'], ['ice', 'Ice'], ['rainbow', 'Rainbow']] },
      { type: 'slider', key: 'dsCount', label: 'Jellyfish', min: 3, max: MAX, step: 1, unit: '' },
      { type: 'check', key: 'dsLight', label: 'Light from above' },
    ],
  });
})();
