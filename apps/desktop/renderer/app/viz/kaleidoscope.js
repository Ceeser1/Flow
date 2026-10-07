'use strict';

// Kaleidoscope (called Nebula until 2026-10-07): in the manner of Milkdrop.
// Every frame starts from the last one, zoomed, turned, swirled and faded a
// little, its colours drifting, and the music is drawn into it again (the
// waveform, the spectrum as rays, rings on the beats), so what was drawn
// flows away in trails. The kicks push the zoom.
//
// It has several looks (LOOKS: how it zooms, turns and swirls, what it draws
// and whether it is seen through a kaleidoscope). Auto moves on to another
// every so often, on a beat, gliding from one to the next; a click moves on
// at once. Its cogwheel: the look (Kaleidoscope by default, or Auto), how
// often Auto moves on, and how long the trails are.
//
// Two more looks are visualizers of their own (SOLO), with only Trails in
// their cogwheels: Liquid and Mandala.
//
// WebGL (viz/gl.js): two half-float textures drawn into in turn (the frame
// before and the new one), then the new one onto the screen.

(() => {
  const MAX_VERTS = 24000;
  const WAVE_POINTS = 384;
  const GLIDE_S = 4;      // from one look to the next

  // Numbers glide; draw and kaleido are faded across.
  //   zoom      per frame at 60 fps (>1 flows outwards)
  //   kickZoom  more of it on a full kick
  //   rot       turn per frame (radians), twist: more towards the middle
  //   swirl     how far the noise field pushes, swirlScale its size
  //   drift     the whole picture flowing (x, y per frame)
  //   decay     how much of the last frame stays (at Trails 100%)
  //   hue       colour drift per frame, base: the looks' own colour
  //   wave      0 a line across, 1 a ring, 2 rays (the spectrum), 3 dots
  //   size      how large it is drawn
  //   kaleido   mirrored slices seen through (0: none)
  const LOOKS = [
    { id: 'kaleido', name: 'Kaleidoscope', zoom: 1.01, kickZoom: 0.025, rot: 0.004, twist: 0.0, swirl: 0.006, swirlScale: 1.6, drift: [0, 0], decay: 0.96, hue: 0.002, base: 0.85, wave: 0, size: 0.18, kaleido: 6 },
    { id: 'vortex', name: 'Vortex', zoom: 1.012, kickZoom: 0.03, rot: 0.006, twist: 0.012, swirl: 0.004, swirlScale: 2.2, drift: [0, 0], decay: 0.965, hue: 0.0015, base: 0.62, wave: 1, size: 0.22, kaleido: 0 },
    { id: 'tunnel', name: 'Tunnel', zoom: 1.035, kickZoom: 0.05, rot: 0.0, twist: 0.0, swirl: 0.0015, swirlScale: 3.0, drift: [0, 0], decay: 0.95, hue: 0.003, base: 0.05, wave: 1, size: 0.12, kaleido: 0 },
    { id: 'starburst', name: 'Starburst', zoom: 1.05, kickZoom: 0.06, rot: -0.002, twist: 0.0, swirl: 0.001, swirlScale: 4.0, drift: [0, 0], decay: 0.91, hue: 0.004, base: 0.1, wave: 2, size: 0.1, kaleido: 0 },
  ];
  // The visualizers of their own, by their ids.
  const SOLO = {
    liquid: { id: 'liquid', name: 'Liquid', zoom: 1.002, kickZoom: 0.02, rot: 0.001, twist: 0.004, swirl: 0.012, swirlScale: 2.8, drift: [0, 0], decay: 0.972, hue: 0.0012, base: 0.75, wave: 3, size: 0.3, kaleido: 0 },
    mandala: { id: 'mandala', name: 'Mandala', zoom: 0.992, kickZoom: -0.02, rot: -0.005, twist: 0.006, swirl: 0.003, swirlScale: 2.0, drift: [0, 0], decay: 0.962, hue: 0.0025, base: 0.95, wave: 2, size: 0.16, kaleido: 8 },
  };
  const NUMBERS = ['zoom', 'kickZoom', 'rot', 'twist', 'swirl', 'swirlScale', 'decay', 'hue', 'size'];

  const WARP_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D prev;
    uniform float aspect, zoom, rot, twist, swirl, swirlScale, decay, hue, time, step;
    uniform vec2 drift;
    out vec4 o;

    vec3 turnHue(vec3 c, float a) {
      // About the grey axis.
      const vec3 k = vec3(0.57735);
      float cs = cos(a);
      return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
    }

    void main() {
      vec2 p = uv - 0.5;
      p.x *= aspect;
      float r = length(p);
      // Each frame's motion scaled to how long the frame was (step: 60 fps = 1).
      p /= pow(zoom, step);
      float a = (rot + twist * max(0.0, 0.8 - r)) * step;
      p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
      vec2 n = vec2(vnoise(p * swirlScale + vec2(time * 0.07, 0.0)), vnoise(p * swirlScale + vec2(7.3, -time * 0.06))) - 0.5;
      p += n * swirl * step;
      p -= drift * step;
      p.x /= aspect;
      vec2 q = p + 0.5;
      // A little softened as it flows, so it stays smoke rather than grain.
      vec2 t = 0.5 / vec2(textureSize(prev, 0));
      vec3 c = 0.25 * (texture(prev, q + vec2(t.x, t.y)).rgb + texture(prev, q - vec2(t.x, t.y)).rgb
        + texture(prev, q + vec2(t.x, -t.y)).rgb + texture(prev, q + vec2(-t.x, t.y)).rgb);
      c = turnHue(c, hue * 6.2831853 * step);
      c = max(c * pow(decay, step) - 0.0015 * step, 0.0);
      o = vec4(c, 1.0);
    }`;

  const OUT_FS = `
    in vec2 uv;
    uniform sampler2D src;
    uniform float aspect, segA, segB, mixB, spin;
    out vec4 o;

    vec2 kaleido(vec2 q, float segs) {
      if (segs < 1.0) return q;
      vec2 p = q - 0.5;
      p.x *= aspect;
      float r = length(p);
      float slice = 6.2831853 / segs;
      float a = atan(p.y, p.x) + spin;
      a = mod(a, slice);
      a = abs(a - slice * 0.5);
      p = vec2(cos(a), sin(a)) * r;
      p.x /= aspect;
      return p + 0.5;
    }

    void main() {
      vec3 c = mix(texture(src, kaleido(uv, segA)).rgb, texture(src, kaleido(uv, segB)).rgb, mixB);
      vec2 v = uv - 0.5;
      v.x *= aspect;
      c *= 1.0 - 0.35 * smoothstep(0.4, 1.1, length(v));
      c = 1.0 - exp(-c * 1.15);
      o = vec4(c, 1.0);
    }`;

  function hsv(h, s, v) {
    const f = (n) => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }

  class Kaleidoscope {
    /** solo: { look: one of SOLO, trails: its Trails setting }, shown on its own. */
    constructor(canvas, solo = null) {
      this.solo = solo;
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.warp = VizGL.program(gl, VizGL.SCREEN_VS, WARP_FS);
      this.out = VizGL.program(gl, VizGL.SCREEN_VS, OUT_FS);
      this.lines = VizGL.lines(gl, MAX_VERTS);
      this.age = 0;
      this.spin = 0;
      this.hue = Math.random();
      this.from = null;       // the look it glides from, and since when
      this.fromAt = 0;
      this.look = solo ? solo.look : this._choose(null);
      this.since = 0;         // how long this look has shown
      this.p = { ...this.look };
      this.wave = new Float32Array(WAVE_POINTS);
      this.rings = [];
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      const old = [this.a, this.b];
      const opts = { wrap: gl.MIRRORED_REPEAT };
      this.a = VizGL.target(gl, w, h, opts);
      this.b = VizGL.target(gl, w, h, opts);
      for (const t of old) VizGL.freeTarget(gl, t);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    /** The look set in its cogwheel, or for Auto one other than `not`. */
    _choose(not) {
      const set = Visualizer.setting('ksLook');
      if (set !== 'auto') return LOOKS.find((l) => l.id === set) || LOOKS[0];
      const pool = LOOKS.filter((l) => l !== not);
      return pool[Math.floor(Math.random() * pool.length)];
    }

    /** On to `look`, gliding there. */
    _go(look) {
      if (look === this.look) return;
      this.from = { ...this.p, wave: this.look.wave, kaleido: this.look.kaleido };
      this.fromAt = this.age;
      this.look = look;
      this.since = 0;
    }

    next() {
      const set = Visualizer.setting('ksLook');
      if (set === 'auto') this._go(this._choose(this.look));
      else {
        // A chosen look: the click goes on to the next one and keeps it.
        const i = LOOKS.findIndex((l) => l.id === set);
        const look = LOOKS[(i + 1) % LOOKS.length];
        Store.saveSettings({ ksLook: look.id });
        this._go(look);
      }
    }

    frame(a, dt) {
      this.age += dt;
      this.since += dt;
      if (!this.solo) this._auto(a);

      // Gliding from the last look to this one.
      const g = this.from ? Math.min(1, (this.age - this.fromAt) / GLIDE_S) : 1;
      const e = g * g * (3 - 2 * g);
      const p = this.p;
      for (const k of NUMBERS) p[k] = this.from ? this.from[k] + (this.look[k] - this.from[k]) * e : this.look[k];
      const drift = this.from ? [0, 1].map((i) => this.from.drift[i] + (this.look.drift[i] - this.from.drift[i]) * e) : this.look.drift;
      p.drift = drift;
      if (g >= 1) this.from = null;

      const trails = Visualizer.setting(this.solo ? this.solo.trails : 'ksTrails') / 100;
      // Trails: the share that fades each frame shrinks or grows.
      const decay = 1 - (1 - p.decay) / Math.max(0.2, trails);
      const step = dt * 60;
      // What is drawn each frame is as much less as the frames come faster.
      this.step = Math.min(2, step);
      this.hue = (this.hue + p.hue * step + (a.onset ? 0.02 * a.onsetPower : 0)) % 1;
      this.spin += dt * (0.05 + 0.25 * a.mid);

      const gl = this.gl;
      // 1. The last frame, moved on, into the other texture.
      gl.disable(gl.BLEND);
      gl.useProgram(this.warp.p);
      VizGL.into(gl, this.b);
      const u = this.warp.u;
      VizGL.bind(gl, u.prev, this.a.tex, 0);
      gl.uniform1f(u.aspect, this.w / this.h);
      gl.uniform1f(u.zoom, p.zoom + p.kickZoom * a.throb);
      gl.uniform1f(u.rot, p.rot * (1 + a.mid));
      gl.uniform1f(u.twist, p.twist);
      gl.uniform1f(u.swirl, p.swirl * (0.6 + a.level));
      gl.uniform1f(u.swirlScale, p.swirlScale);
      gl.uniform1f(u.decay, Math.min(0.995, Math.max(0.5, decay)));
      gl.uniform1f(u.hue, p.hue * 0.6);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.step, step);
      gl.uniform2f(u.drift, drift[0], drift[1]);
      VizGL.screen(gl);

      // 2. The music drawn into it: this look's shape, and the last one's fading out.
      if (this.from && this.from.wave !== this.look.wave) {
        this._shape(a, this.from.wave, 1 - e);
        this._shape(a, this.look.wave, e);
      } else {
        this._shape(a, this.look.wave, 1);
      }
      this._rings(a, dt);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.lines.draw(this.w, this.h);
      gl.disable(gl.BLEND);

      // 3. Onto the screen, through the kaleidoscope if the look has one.
      VizGL.into(gl, null);
      gl.useProgram(this.out.p);
      const o = this.out.u;
      VizGL.bind(gl, o.src, this.b.tex, 0);
      gl.uniform1f(o.aspect, this.w / this.h);
      const segA = this.from ? this.from.kaleido : this.look.kaleido;
      gl.uniform1f(o.segA, segA);
      gl.uniform1f(o.segB, this.look.kaleido);
      gl.uniform1f(o.mixB, this.from ? e : 1);
      gl.uniform1f(o.spin, this.spin);
      VizGL.screen(gl);

      [this.a, this.b] = [this.b, this.a];
    }

    /** The look set in the cogwheel followed, and Auto moving on. */
    _auto(a) {
      const set = Visualizer.setting('ksLook');
      if (set !== 'auto' && set !== this.look.id) this._go(this._choose(null));
      // Auto: once its time is up, on the next phrase (the first of eight
      // beats) while the beat is clear, else on the next strong kick (or a
      // few seconds later anyway).
      const every = Visualizer.setting('ksEvery');
      const cue = a.lock > 0.5 ? a.tick && a.beats % 8 === 0 : a.onset && a.beat > 0.7;
      if (set === 'auto' && this.since > every && (cue || this.since > every + 5)) this._go(this._choose(this.look));
    }

    _shape(a, kind, fade) {
      if (fade <= 0.01) return;
      const w = this.w;
      const h = this.h;
      const cx = w / 2;
      const cy = h / 2;
      const size = this.p.size * h;
      const loud = Math.min(1, 0.25 + a.level * 1.6);
      const alpha = fade * loud * 0.42 * this.step;
      const lw = (h / 1080) * (1.4 + 1.2 * a.bass);
      const col = (t) => hsv((this.hue + this.look.base + t) % 1, 0.75, 1);
      if (kind === 0 || kind === 1) {
        const wave = a.lowWave(WAVE_POINTS);
        const n = wave.length;
        let px = 0;
        let py = 0;
        for (let i = 0; i < n; i += 1) {
          let x;
          let y;
          if (kind === 0) {
            x = (i / (n - 1)) * w * 0.9 + w * 0.05;
            y = h * (this.look.y || 0.5) + wave[i] * size * 1.2;
          } else {
            const ang = (i / n) * Math.PI * 2;
            const r = size * (1 + 0.35 * a.kick) + wave[i] * size * 0.6;
            x = cx + Math.cos(ang) * r;
            y = cy + Math.sin(ang) * r;
          }
          if (i) this.lines.seg(px, py, x, y, lw, col(i / n * 0.3), alpha);
          px = x;
          py = y;
        }
        if (kind === 1) {
          // Closed.
          const r = size * (1 + 0.35 * a.kick) + wave[0] * size * 0.6;
          this.lines.seg(px, py, cx + r, cy, lw, col(0), alpha);
        }
      } else if (kind === 2) {
        // The spectrum as rays from the middle, both halves the same.
        const bands = a.smooth;
        const n = bands.length;
        for (let i = 0; i < n; i += 1) {
          const v = bands[i];
          if (v < 0.05) continue;
          for (const side of [1, -1]) {
            const ang = Math.PI / 2 + side * ((i + 0.5) / n) * Math.PI;
            const r0 = size * 0.6;
            const r1 = r0 + v * v * h * 0.45;
            this.lines.seg(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0, cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1,
              lw * 1.2, col(i / n * 0.5), fade * (0.05 + 0.16 * v) * v * this.step);
          }
        }
      } else {
        // Dots: the waveform's points scattered round a slowly turning ring.
        const wave = a.lowWave(WAVE_POINTS);
        const n = wave.length;
        for (let i = 0; i < n; i += 3) {
          const ang = (i / n) * Math.PI * 2 + this.age * 0.3;
          const r = size * (0.5 + 0.6 * Math.abs(wave[i])) * (1 + 0.4 * a.kick);
          const x = cx + Math.cos(ang) * r;
          const y = cy + Math.sin(ang) * r;
          const d = lw * 1.5;
          this.lines.seg(x - d, y, x + d, y, d * 1.4, col(i / n), alpha * 1.4);
        }
      }
    }

    /** A ring on each strong beat, swelling from the middle and dropped into the flow. */
    _rings(a, dt) {
      if (a.onset && a.onsetPower > 0.35) this.rings.push({ r: this.p.size * this.h * 0.3, life: 1, hue: this.hue + 0.5 });
      const cx = this.w / 2;
      const cy = this.h / 2;
      for (const ring of this.rings) {
        ring.r += dt * this.h * 0.9;
        ring.life -= dt * 3;
        const rgb = hsv(ring.hue % 1, 0.6, 1);
        const n = 72;
        for (let i = 0; i < n; i += 1) {
          const a0 = (i / n) * Math.PI * 2;
          const a1 = ((i + 1) / n) * Math.PI * 2;
          this.lines.seg(cx + Math.cos(a0) * ring.r, cy + Math.sin(a0) * ring.r, cx + Math.cos(a1) * ring.r, cy + Math.sin(a1) * ring.r,
            (this.h / 1080) * 2, rgb, Math.max(0, ring.life) * 0.25 * this.step);
        }
      }
      this.rings = this.rings.filter((r) => r.life > 0);
    }
  }

  Visualizer.add({
    id: 'kaleidoscope',
    name: 'Kaleidoscope',
    desc: 'In the manner of Milkdrop: the music drawn into a picture that flows on, zooming, swirling and changing colour',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 12m-2 0a2 2 0 1 0 4 0a4 4 0 1 0-8 0a6 6 0 1 0 12 0a8 8 0 1 0-16 0"/></svg>',
    gl: true,
    hint: 'Click for the next look',
    create: (canvas) => new Kaleidoscope(canvas),
    click: (scene) => scene.next(),
    options: [
      { type: 'choice', key: 'ksLook', label: 'Look', choices: [['auto', 'Auto'], ...LOOKS.map((l) => [l.id, l.name])] },
      { type: 'slider', key: 'ksEvery', label: 'Auto changes every', min: 10, max: 120, step: 5, unit: ' s', when: (s) => s.ksLook === 'auto' },
      { type: 'slider', key: 'ksTrails', label: 'Trails', min: 25, max: 200, step: 5 },
    ],
  });

  /** One of SOLO as a visualizer of its own: `trails` its Trails setting. */
  function solo(look, { trails, desc, glyph }) {
    Visualizer.add({
      id: look.id,
      name: look.name,
      desc,
      glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
        + `stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`,
      gl: true,
      create: (canvas) => new Kaleidoscope(canvas, { look, trails }),
      options: [{ type: 'slider', key: trails, label: 'Trails', min: 25, max: 200, step: 5 }],
    });
  }

  solo(SOLO.liquid, {
    trails: 'lqTrails',
    desc: 'The waveform scattered round a turning ring and melting away in swirls',
    glyph: '<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/>',
  });
  solo(SOLO.mandala, {
    trails: 'mdTrails',
    desc: 'The spectrum as rays, seen through an eightfold kaleidoscope, flowing inwards',
    glyph: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3"/>',
  });
})();
