'use strict';

// Laser Show: a concert's lasers cutting through the haze over a crowd. A
// bank of lasers behind the crowd plays one pattern after another, another
// every two bars: a fan opening and closing with the bar, beams chasing
// each other along the stage, two fans crossing, a tunnel of beams turning
// round its middle, and a row of beams leaning with their part of the
// spectrum. Every pattern swings with the beat; the kicks flash the beams;
// the crowd's heads bob and their hands go up on the beat. A strobe on the
// drops, if you like.
//
// Its cogwheel: the colours, the crowd, the strobe.
//
// WebGL (viz/gl.js): the beams are soft lines added up in a texture, then
// laid over the room through drifting haze (where the smoke is thicker the
// beams show brighter), a wide glow, and the crowd's shapes in front.

(() => {
  const PATTERNS = ['fan', 'chase', 'cross', 'tunnel', 'bars'];
  const PALETTES = {
    rgb: [[1, 0.1, 0.1], [0.1, 1, 0.2], [0.2, 0.35, 1]],
    green: [[0.15, 1, 0.25], [0.3, 1, 0.4], [0.1, 0.9, 0.2]],
    rainbow: null,
    ice: [[0.3, 0.9, 1], [0.85, 0.9, 1], [0.6, 0.3, 1]],
  };

  const SHOW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D beams, glow;
    uniform vec2 res;
    uniform float time, jump, hands, crowd, strobe, haze;
    uniform vec3 stage;
    out vec4 o;
    void main() {
      float asp = res.x / res.y;
      vec2 p = vec2(uv.x * asp, uv.y);
      vec3 b = texture(beams, uv).rgb;
      vec3 g = texture(glow, uv).rgb;
      // The haze: drifting smoke the beams show up in.
      float fog = 0.1 + 1.6 * pow(fbm(p * 2.2 + vec2(time * 0.05, -time * 0.03)), 1.5) * (0.55 + 0.45 * vnoise(p * 7.0 - time * 0.2));
      vec3 col = vec3(0.012, 0.008, 0.02) + b * mix(1.0, fog, haze) * 1.3 + g * (0.9 + 0.9 * haze) * (0.7 + 0.5 * fog);
      // The stage's own light behind the crowd, in the lasers' colours.
      col += stage * exp(-pow((uv.y - 0.14) * 9.0, 2.0)) * (0.5 + 0.5 * vnoise(vec2(p.x * 3.0, time * 0.3)));
      col += vec3(1.0) * strobe * 0.6;
      // The crowd: heads and shoulders, some hands up, bobbing on the beat;
      // each person a few shapes in cells across the screen (their own and
      // the neighbours', so raised arms are not cut off).
      if (crowd > 0.5) {
        const float CELLS = 15.0;
        float d = 1e3;
        float x = p.x * CELLS;
        for (int k = -1; k <= 1; k++) {
          float i = floor(x) + float(k);
          float h = hash12(vec2(i, 1.0));
          float bob = jump * (0.4 + 0.6 * hash12(vec2(i, 2.0))) * 0.25;
          vec2 c = vec2(x - i - 0.5 + (hash12(vec2(i, 5.0)) - 0.5) * 0.3, (uv.y - 0.11) * CELLS - h * 0.5 - bob);
          float head = length(c * vec2(1.0, 0.9)) - 0.3;
          vec2 b = abs(c - vec2(0.0, -1.05)) - vec2(0.42, 0.72);
          float body = length(max(b, 0.0)) + min(max(b.x, b.y), 0.0) - 0.22;
          d = min(d, min(head, body));
          if (hash12(vec2(i, 3.0)) < 0.45 * hands + 0.1) {
            float side = hash12(vec2(i, 4.0)) > 0.5 ? 1.0 : -1.0;
            vec2 a0 = vec2(side * 0.38, -0.5);
            vec2 a1 = vec2(side * (0.55 + 0.15 * sin(time * 2.5 + i)), 1.2 + 0.5 * h);
            vec2 pa = c - a0, ba = a1 - a0;
            float arm = length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - 0.12;
            d = min(d, min(arm, length(c - a1) - 0.16));
          }
        }
        d = min(d, (uv.y - 0.03) * CELLS);
        float m = smoothstep(0.05, -0.05, d);
        // A rim of the light on their edges.
        float rim = smoothstep(0.25, 0.0, abs(d)) * (1.0 - m);
        col = mix(col, vec3(0.004), m) + (g * 0.8 + b * 0.3 + stage) * rim * 0.5;
      }
      col = 1.0 - exp(-col * 1.4);
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

  class LaserShow {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.lines = VizGL.lines(gl, 40000);
      this.age = 0;
      this.ph = 0;
      this.beatN = 0;
      this.pattern = 'fan';
      this.flash = 0;
      this.strobe = 0;
      this.lastIntensity = 0;
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
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    _color(i, n) {
      const pal = PALETTES[this.palette];
      if (!pal) return hsv((i / Math.max(1, n) + this.age * 0.05) % 1, 0.9, 1);
      return pal[((i % pal.length) + Math.floor(this.beatN / 4)) % pal.length];
    }

    /** One beam from (x, y) at angle (0 straight up, radians), fading along its length. */
    _beam(x, y, angle, rgb, bright) {
      const l = this.lines;
      const len = this.h * 1.4;
      const dx = Math.sin(angle);
      const dy = -Math.cos(angle);
      const parts = 6;
      const core = Math.max(1, this.h / 900);
      for (let k = 0; k < parts; k += 1) {
        const a0 = (k / parts) * len;
        const a1 = ((k + 1) / parts) * len;
        const fade = (1 - k / parts) ** 1.3;
        l.seg(x + dx * a0, y + dy * a0, x + dx * a1, y + dy * a1, core * 1.2, [1, 1, 1], 0.35 * bright * fade);
        l.seg(x + dx * a0, y + dy * a0, x + dx * a1, y + dy * a1, core * 3, rgb, 0.8 * bright * fade);
        l.seg(x + dx * a0, y + dy * a0, x + dx * a1, y + dy * a1, core * 14, rgb, 0.16 * bright * fade);
      }
      l.dot(x, y, core * 6, rgb, bright);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      this.palette = set('lsColors');

      // The beat: the tempo's, or a steady 120 without one; paused, all still.
      let tick = false;
      if (a.playing) {
        if (a.sure >= 0.35 && a.bpm) {
          tick = a.tick;
          this.ph = a.phase;
        } else {
          this.ph += dt * 2;
          tick = this.ph >= 1;
          if (tick) this.ph -= 1;
        }
      }
      if (tick) {
        this.beatN += 1;
        if (this.beatN % 8 === 0) {
          const others = PATTERNS.filter((p) => p !== this.pattern);
          this.pattern = others[Math.floor(Math.random() * others.length)];
        }
      }
      // A drop: the tunnel, and the strobe if wanted.
      if (a.playing && a.intensity > 0.85 && this.lastIntensity <= 0.85) {
        this.pattern = 'tunnel';
        if (set('lsStrobe')) this.strobe = 1.5;
      }
      this.lastIntensity = a.intensity;
      if (a.playing && a.onset) this.flash = Math.max(this.flash, a.onsetPower);
      this.flash *= Math.exp(-dt * 7);
      this.strobe = Math.max(0, this.strobe - dt);
      const strobeOn = this.strobe > 0 && Math.floor(this.age * 16) % 2 === 0 ? 1 : 0;

      const W = this.w;
      const H = this.h;
      const y0 = H * 0.8;
      const t = this.beatN + this.ph;                 // beats, smoothly
      const bar = (t / 4) * Math.PI * 2;              // a full turn a bar
      const swing = Math.sin(t * Math.PI);            // there and back each two beats
      const bright = (a.playing ? 0.55 + 0.45 * a.level : 0.25) * (1 + this.flash * 0.8);

      const p = this.pattern;
      if (p === 'fan') {
        // A fan from the middle opening and closing with the bar, leaning with the beat.
        const n = 11;
        const open = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(bar));
        for (let i = 0; i < n; i += 1) {
          const k = i / (n - 1) - 0.5;
          this._beam(W / 2, y0, k * open * 2 + swing * 0.25, this._color(i, n), bright);
        }
      } else if (p === 'chase') {
        // Six lasers along the stage, swinging; lit one after another on the eighths.
        const n = 6;
        const lit = Math.floor(t * 2) % n;
        for (let i = 0; i < n; i += 1) {
          const x = W * (0.15 + (0.7 * i) / (n - 1));
          const on = i === lit || i === (lit + 3) % n ? 1 : 0.18;
          this._beam(x, y0, Math.sin(t * Math.PI * 0.5 + i * 0.9) * 0.6, this._color(i, n), bright * on);
        }
      } else if (p === 'cross') {
        // Two fans from the sides, crossing, sweeping against each other.
        for (const side of [-1, 1]) {
          const x = W / 2 + side * W * 0.32;
          for (let i = 0; i < 6; i += 1) {
            const k = i / 5 - 0.5;
            this._beam(x, y0, -side * (0.35 + 0.25 * swing) + k * 0.5, this._color(i + (side > 0 ? 3 : 0), 12), bright);
          }
        }
      } else if (p === 'tunnel') {
        // A ring of beams from the middle all round, turning, gaps in it chasing.
        const n = 36;
        const turn = t * 0.4;
        for (let i = 0; i < n; i += 1) {
          const ang = (i / n) * Math.PI * 2 + turn;
          const gap = 0.5 + 0.5 * Math.sin(ang * 3 - t * Math.PI);
          if (gap < 0.35) continue;
          this._beam(W / 2, H * 0.45, ang, this._color(i, n), bright * 0.6 * gap * (0.7 + 0.6 * a.bass));
        }
      } else {
        // A row of beams, each leaning with its part of the spectrum.
        const n = 14;
        for (let i = 0; i < n; i += 1) {
          const from = Math.floor((i / n) * a.BANDS * 0.9);
          const to = Math.floor(((i + 1) / n) * a.BANDS * 0.9);
          let v = 0;
          for (let k = from; k < to; k += 1) v = Math.max(v, a.dynamic[k]);
          const x = W * (0.08 + (0.84 * i) / (n - 1));
          const lean = (i % 2 ? 1 : -1) * (0.1 + 0.7 * v);
          this._beam(x, y0, lean, this._color(i, n), bright * (0.4 + 0.8 * v));
        }
      }

      VizGL.into(gl, this.t);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.lines.draw(W, H);
      gl.disable(gl.BLEND);
      VizGL.blur(gl, this.t, this.b1, this.b2, 1);
      VizGL.blur(gl, this.b2, this.b1, this.b2, 2);

      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      const u = this.show.u;
      VizGL.bind(gl, u.beams, this.t.tex, 0);
      VizGL.bind(gl, u.glow, this.b2.tex, 1);
      gl.uniform2f(u.res, W, H);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.jump, a.playing ? Math.abs(Math.cos(this.ph * Math.PI)) * (0.5 + a.throb) : 0);
      gl.uniform1f(u.hands, a.playing ? Math.min(1, 0.4 + a.intensity) : 0.3);
      gl.uniform1f(u.crowd, set('lsCrowd') ? 1 : 0);
      gl.uniform1f(u.strobe, strobeOn);
      gl.uniform1f(u.haze, 0.8);
      const st = this._color(0, 3);
      const sl = a.playing ? 0.12 + 0.25 * a.throb : 0.06;
      gl.uniform3f(u.stage, st[0] * sl, st[1] * sl, st[2] * sl);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'lasershow',
    name: 'Laser Show',
    desc: 'Concert lasers cutting through the haze over a crowd: fans, chases, crossings and tunnels swinging with the beat',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 20L4 3M12 20L9 3M12 20l3-17M12 20l8-17"/><path d="M3 21h18"/></svg>',
    gl: true,
    create: (canvas) => new LaserShow(canvas),
    options: [
      { type: 'choice', key: 'lsColors', label: 'Colours', choices: [['rgb', 'Red, green, blue'], ['green', 'Green'], ['rainbow', 'Rainbow'], ['ice', 'Ice']] },
      { type: 'check', key: 'lsCrowd', label: 'Crowd' },
      { type: 'check', key: 'lsStrobe', label: 'Strobe on the drops' },
    ],
  });
})();
