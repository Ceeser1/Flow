'use strict';

// Stained Glass: the song's cover as a church window, cut into panes of
// coloured glass held in lead, the light behind it moving with the music.
// The panes glow brighter with the music and each with its part of the
// spectrum, a brighter light sweeps across them on the beat, a few flare up
// on the hits; shafts of coloured light fall from the window into the dusty
// dark, motes drifting in them, and lie on the stone floor below. A song
// without a cover gets a pattern of its own colour.
//
// Its cogwheel: a pointed arch, a rose window or glass over the whole
// screen; how many panes; the shafts of light.
//
// WebGL (viz/gl.js): the panes are the cells of a Voronoi pattern (in the
// rose window's, folded twelve times round its middle), each pane the
// cover's colour where it lies, a little stronger; the glass's light is
// drawn small, smeared away from the window for the shafts (each pixel
// gathering what lies between it and the window), and laid on the floor.

(() => {
  const COMMON = VizGL.NOISE + `
    uniform sampler2D cover;
    uniform vec2 res;
    uniform int shape;          // 0 arch, 1 rose, 2 the whole screen
    uniform float panes, time, light, sweep, flash, flashSeed, seed;
    uniform float bands[8];
    const float PI = 3.14159265;

    // Window space: the window's middle at 0, its height about 1.6.
    vec2 winSpace(vec2 uv) {
      vec2 p = (uv - vec2(0.5, 0.53)) * vec2(res.x / res.y, 1.0);
      return p / 0.4;
    }

    // Inside the window (0..1, soft over a pixel), and how far into it.
    float inside(vec2 p, out float depth) {
      float px = 2.5 / res.y;
      if (shape == 2) { depth = 1.0; return 1.0; }
      if (shape == 1) {
        float r = length(p);
        depth = 1.0 - r;
        return 1.0 - smoothstep(1.0 - px, 1.0 + px, r);
      }
      // A pointed (equilateral) arch on straight sides: half as wide as high.
      float a = 0.5;
      float yb = -0.95, ys = 0.1;
      float d;
      if (p.y < ys) d = max(abs(p.x) - a, yb - p.y);
      else d = max(length(p - vec2(-a, ys)) - 2.0 * a, length(p - vec2(a, ys)) - 2.0 * a);
      depth = -d;
      return 1.0 - smoothstep(-px, px, d);
    }

    // The panes: Voronoi cells. x: distance to the nearest edge (cell units),
    // yz: the cell's point (pattern space), w: its id.
    vec4 voronoi(vec2 q) {
      vec2 g = floor(q), f = fract(q);
      float d1 = 8.0, d2 = 8.0;
      vec2 best = vec2(0.0), bestId = vec2(0.0);
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 id = g + o;
        vec2 pt = o + 0.15 + 0.7 * vec2(hash12(id + seed), hash12(id + seed + 41.7));
        float d = length(pt - f);
        if (d < d1) { d2 = d1; d1 = d; best = id + pt - o; bestId = id; }
        else if (d < d2) d2 = d;
      }
      // The edge distance, better than d2 - d1: a second pass to the
      // bisectors of the nearest cell and its neighbours.
      float edge = 8.0;
      vec2 mr = best - g;
      for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 id = g + o;
        if (id == bestId) continue;
        vec2 pt = o + 0.15 + 0.7 * vec2(hash12(id + seed), hash12(id + seed + 41.7));
        vec2 mid = 0.5 * (mr + pt);
        vec2 n = normalize(pt - mr);
        edge = min(edge, dot(mid - f, n));
      }
      return vec4(edge, best, hash12(bestId + seed * 3.0));
    }

    // The pattern's coordinates for a point of the window, and where on the
    // cover it lies (0..1 each way).
    vec2 pattern(vec2 p, out vec2 coverUv) {
      if (shape == 1) {
        // Folded twelve times round the middle, mirrored, for the rose.
        float r = length(p);
        float an = atan(p.y, p.x);
        float seg = 2.0 * PI / 12.0;
        float fa = abs(mod(an + seg * 0.5, seg) - seg * 0.5);
        vec2 f = vec2(cos(fa), sin(fa)) * r;
        coverUv = vec2(0.5) + f * 0.5;
        return vec2(r * panes * 0.55, fa * r * panes * 0.55 * 1.2);
      }
      if (shape == 2) {
        vec2 c = (p * 0.4) / vec2(res.x / res.y, 1.0);
        coverUv = vec2(0.5) + c * vec2(res.x / res.y, 1.0) / max(res.x / res.y, 1.0);
        return p * panes * 0.25;
      }
      coverUv = vec2(0.5 + p.x * 0.62, 0.5 + p.y * 0.52);
      return p * panes * 0.6;
    }

    // The glass where p is: its colour as the light comes through, and the lead (0..1).
    vec3 glass(vec2 p, out float lead) {
      vec2 cuv;
      vec2 q = pattern(p, cuv);
      vec4 v = voronoi(q);
      // The pane's colour: the cover's, read blurred at the pane's point.
      vec2 pc;
      if (shape == 1) {
        float r = v.y / (panes * 0.55);
        float fa = v.z / max(r * panes * 0.55 * 1.2, 1e-3);
        pc = vec2(0.5) + vec2(cos(fa), sin(fa)) * r * 0.5;
      } else if (shape == 2) {
        vec2 pp = vec2(v.y, v.z) / (panes * 0.25);
        vec2 c = (pp * 0.4) / vec2(res.x / res.y, 1.0);
        pc = vec2(0.5) + c * vec2(res.x / res.y, 1.0) / max(res.x / res.y, 1.0);
      } else {
        vec2 pp = vec2(v.y, v.z) / (panes * 0.6);
        pc = vec2(0.5 + pp.x * 0.62, 0.5 + pp.y * 0.52);
      }
      vec3 c = textureLod(cover, vec2(pc.x, 1.0 - pc.y), 3.0).rgb;
      // Stronger, as glass: more colourful, the dark ones not black.
      float l = dot(c, vec3(0.3, 0.55, 0.15));
      c = mix(vec3(l), c, 1.6);
      c = clamp(c, 0.0, 1.0);
      c = pow(c, vec3(0.85)) * 0.85 + 0.06;
      // Each pane its own thickness; mottled; a few bubbles; darker by the lead.
      float id = v.w;
      c *= 0.85 + 0.3 * id;
      c *= 0.9 + 0.2 * vnoise(q * 9.0 + id * 17.0);
      float lw = 0.055;
      lead = 1.0 - smoothstep(lw * 0.7, lw, v.x);
      c *= smoothstep(0.0, 0.25, v.x) * 0.35 + 0.65;
      // The light: brighter with the music, each pane with its part of the
      // spectrum, a sweep across on the beat, a few flaring on the hits.
      float band = bands[int(id * 7.99)];
      float s = sweep - (p.x * 0.35 + p.y * 0.5);
      float sw = exp(-s * s * 6.0) * 0.6;
      float fl = step(hash12(vec2(id * 91.0, flashSeed)), 0.12) * flash;
      return c * (light * (0.95 + 0.6 * band) + sw + fl * 1.2) * 1.25;
    }`;

  // The glass's light alone, small: for the shafts and the floor.
  const EMIT_FS = COMMON + `
    in vec2 uv;
    out vec4 o;
    void main() {
      vec2 p = winSpace(uv);
      float depth;
      float m = inside(p, depth);
      float lead;
      vec3 c = m > 0.0 ? glass(p, lead) * (1.0 - lead) : vec3(0.0);
      o = vec4(c * m, 1.0);
    }`;

  // The shafts: each pixel gathers the light lying between it and the window's middle.
  const RAYS_FS = `
    in vec2 uv;
    uniform sampler2D emit;
    uniform vec2 src;
    uniform float strength;
    out vec4 o;
    void main() {
      vec2 d = (uv - src);
      vec3 sum = vec3(0.0);
      float w = 1.0;
      vec2 step = d / 48.0;
      vec2 p = uv;
      for (int i = 0; i < 48; i++) {
        p -= step;
        sum += texture(emit, p).rgb * w;
        w *= 0.965;
      }
      // Falling from the window, not rising up the wall.
      float down = smoothstep(-0.1, 0.5, -d.y / max(length(d), 1e-3));
      o = vec4(sum / 48.0 * strength * (0.25 + 0.75 * down), 1.0);
    }`;

  const SHOW_FS = COMMON + `
    in vec2 uv;
    uniform sampler2D emit, rays;
    uniform bool shafts;
    out vec4 o;
    void main() {
      vec2 p = winSpace(uv);
      float depth;
      float m = inside(p, depth);
      float px = 2.5 / res.y;
      vec3 col;
      float floorY = 0.1;
      if (shape == 2) {
        float lead;
        vec3 g = glass(p, lead);
        col = mix(g, vec3(0.03, 0.03, 0.035) + 0.04 * (1.0 - abs(fract(p.y * 40.0) - 0.5)), lead);
      } else {
        // The wall: dark stone blocks, the floor below.
        vec2 sp = uv * vec2(res.x / res.y, 1.0) * 9.0;
        float row = floor(sp.y);
        sp.x += mod(row, 2.0) * 0.5;
        vec2 bf = fract(sp);
        float mortar = smoothstep(0.0, 0.05, bf.x) * smoothstep(1.0, 0.95, bf.x) * smoothstep(0.0, 0.08, bf.y) * smoothstep(1.0, 0.92, bf.y);
        float stone = 0.03 + 0.012 * hash12(floor(sp) + 3.0) + 0.008 * vnoise(sp * 6.0);
        col = vec3(stone * 1.05, stone, stone * 0.95) * (0.55 + 0.45 * mortar);
        if (uv.y < floorY) {
          // Flagstones going away, the window's light lying on them.
          float depthF = floorY / max(uv.y, 0.002);
          vec2 fp = vec2((uv.x - 0.5) * depthF * 3.0, depthF * 2.0);
          vec2 ff = fract(fp);
          float seam = smoothstep(0.0, 0.03, ff.x) * smoothstep(0.0, 0.05, ff.y);
          col = vec3(0.025, 0.023, 0.022) * (0.6 + 0.4 * seam) * (0.6 + 0.4 * uv.y / floorY);
          vec2 wuv = vec2(0.5 + (uv.x - 0.5) * 0.7 / (0.4 + 0.6 * (1.0 - uv.y / floorY)), 0.25 + 0.55 * (uv.y / floorY));
          col += texture(emit, wuv).rgb * 0.45 * smoothstep(0.0, 0.03, uv.y);
        }
        // The stone frame round the window.
        if (shape == 0 || shape == 1) {
          float fd = -depth;
          if (fd > 0.0 && fd < 0.09) col = vec3(0.11, 0.1, 0.09) * (0.55 + 0.45 * smoothstep(0.09, 0.0, fd)) * (0.8 + 0.2 * vnoise(p * 40.0));
        }
        if (m > 0.0) {
          float lead;
          vec3 g = glass(p, lead);
          vec3 l = vec3(0.025, 0.025, 0.028);
          // Tracery: the rose's spokes and inner ring, the arch's mullion and iron bars.
          float bar = 0.0;
          if (shape == 1) {
            float r = length(p);
            float an = atan(p.y, p.x);
            float seg = 2.0 * PI / 12.0;
            float fa = abs(mod(an + seg * 0.5, seg) - seg * 0.5);
            bar = max(step(r, 0.95) * step(0.24, r) * (1.0 - smoothstep(0.014, 0.022, fa * r)), 1.0 - smoothstep(0.015, 0.025, abs(r - 0.24)));
          } else {
            bar = max(1.0 - smoothstep(0.018, 0.028, abs(p.x)) * 1.0, 0.0) * step(p.y, 0.55);
            float ib = smoothstep(0.488, 0.494, abs(fract((p.y + 1.0) * 2.6) - 0.5));
            lead = max(lead, ib * 0.9);
          }
          col = mix(col, mix(g, l, lead), m);
          col = mix(col, vec3(0.07, 0.065, 0.06), bar * m);
        }
      }
      if (shafts) {
        vec3 r = texture(rays, uv).rgb;
        col += r * (1.0 - m * 0.9);
        // Dust in the light.
        vec2 dp = uv * res / 9.0 + vec2(time * 0.6, -time * 0.9);
        vec2 cell = floor(dp);
        vec2 mote = vec2(hash12(cell + 1.3), hash12(cell + 7.9));
        float dd = length(fract(dp) - mote);
        float twinkle = 0.5 + 0.5 * sin(time * 2.0 + hash12(cell) * 30.0);
        col += r * 4.0 * smoothstep(0.08, 0.0, dd) * step(0.85, hash12(cell + 5.0)) * twinkle * (1.0 - m);
      }
      col = 1.0 - exp(-col * 1.3);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class StainedGlass {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.emitP = VizGL.program(gl, VizGL.SCREEN_VS, EMIT_FS);
      this.raysP = VizGL.program(gl, VizGL.SCREEN_VS, RAYS_FS);
      this.showP = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.cover = new VizCover(gl, { standIn: 'pattern' });
      this.age = 0;
      this.seed = Math.random() * 100;
      this.sweep = -3;
      this.flash = 0;
      this.flashSeed = 0;
      this.light = 0.5;
      this.bands = new Float32Array(8);
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      VizGL.freeTarget(gl, this.emit);
      VizGL.freeTarget(gl, this.rays);
      const sw = Math.max(1, Math.round(w / 3));
      const sh = Math.max(1, Math.round(h / 3));
      this.emit = VizGL.target(gl, sw, sh);
      this.rays = VizGL.target(gl, sw, sh);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    _common(u, shape, panes) {
      const gl = this.gl;
      VizGL.bind(gl, u.cover, this.cover.tex, 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1i(u.shape, shape);
      gl.uniform1f(u.panes, panes);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.light, this.light);
      gl.uniform1f(u.sweep, this.sweep);
      gl.uniform1f(u.flash, this.flash);
      gl.uniform1f(u.flashSeed, this.flashSeed);
      gl.uniform1f(u.seed, this.seed);
      gl.uniform1fv(u.bands, this.bands);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      // A new song: new panes.
      if (this.cover.update()) this.seed = Math.random() * 100;
      const shape = { arch: 0, rose: 1, full: 2 }[set('sgWindow')] ?? 0;
      const panes = Number(set('sgPanes'));
      const target = a.playing ? 0.55 + 0.6 * a.level + 0.25 * a.intensity : 0.4;
      this.light += (target - this.light) * Math.min(1, dt * 4);
      for (let i = 0; i < 8; i += 1) {
        const from = Math.floor((i / 8) * a.BANDS * 0.9);
        const to = Math.floor(((i + 1) / 8) * a.BANDS * 0.9);
        let v = 0;
        for (let j = from; j < to; j += 1) v += a.dynamic[j];
        v /= to - from;
        this.bands[i] += (v - this.bands[i]) * Math.min(1, dt * 10);
      }
      // A sweep of light across on the beat (or a kick, without one).
      if (a.playing && (a.lock > 0.5 ? a.tick : a.onset)) this.sweep = -1.6;
      this.sweep += dt * 3.2;
      if (a.playing && a.hit && a.hitPower > 0.5) {
        this.flash = Math.max(this.flash, a.hitPower);
        this.flashSeed = Math.random() * 100;
      }
      this.flash *= Math.exp(-dt * 6);

      gl.disable(gl.BLEND);
      VizGL.into(gl, this.emit);
      gl.useProgram(this.emitP.p);
      this._common(this.emitP.u, shape, panes);
      VizGL.screen(gl);

      const shafts = !!set('sgRays') && shape !== 2;
      if (shafts) {
        VizGL.into(gl, this.rays);
        gl.useProgram(this.raysP.p);
        VizGL.bind(gl, this.raysP.u.emit, this.emit.tex, 0);
        gl.uniform2f(this.raysP.u.src, 0.5, 0.62);
        gl.uniform1f(this.raysP.u.strength, 0.8 + 0.7 * a.bass);
        VizGL.screen(gl);
      }

      VizGL.into(gl, null);
      gl.useProgram(this.showP.p);
      const u = this.showP.u;
      this._common(u, shape, panes);
      VizGL.bind(gl, u.emit, this.emit.tex, 1);
      VizGL.bind(gl, u.rays, this.rays.tex, 2);
      gl.uniform1i(u.shafts, shafts ? 1 : 0);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'stainedglass',
    name: 'Stained Glass',
    desc: "The song's cover as a church window of coloured glass in lead, the light behind it moving with the music and falling in shafts into the dark",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M5 22V10a7 7 0 0 1 14 0v12z"/><path d="M5 15l5-3 4 4 5-4M12 3v9M8 22l2-10M16 22l-2-6"/></svg>',
    gl: true,
    create: (canvas) => new StainedGlass(canvas),
    options: [
      { type: 'choice', key: 'sgWindow', label: 'Window', choices: [['arch', 'Arch'], ['rose', 'Rose'], ['full', 'Whole screen']] },
      { type: 'slider', key: 'sgPanes', label: 'Panes', min: 6, max: 24, step: 1, unit: '' },
      { type: 'check', key: 'sgRays', label: 'Shafts of light', when: (s) => s.sgWindow !== 'full' },
    ],
  });
})();
