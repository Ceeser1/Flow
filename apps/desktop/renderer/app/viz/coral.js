'use strict';

// Coral: living patterns growing over the screen as two chemicals feed on
// and eat each other (a reaction-diffusion), shaded as a relief. Each kick
// seeds a new growth somewhere, the hits smaller ones; the bass tips the
// balance so the growth swells and recedes with it; across the screen the
// balance drifts slowly between two kinds of growth (coral and cells, or
// two kinds of maze, or spots), so it never settles; it grows faster with
// the tempo and stops when the music does.
//
// Its cogwheel: the kind of growth, the colours, how fast it grows.
//
// WebGL (viz/gl.js): Gray-Scott in a float texture at a third of the
// screen's size, stepped many times a frame; the picture one pass reading it
// as heights for the light.

(() => {
  const SEEDS = 6;
  const KINDS = {
    // feed and kill at the two ends of the drift
    coral: [[0.0545, 0.062], [0.0367, 0.0649]],
    maze: [[0.029, 0.057], [0.039, 0.058]],
    spots: [[0.03, 0.0625], [0.025, 0.06]],
  };
  const PALETTES = { reef: 0, neon: 1, lichen: 2 };

  const STEP_FS = VizGL.NOISE + `
    uniform sampler2D state;
    uniform ivec2 size;
    uniform vec2 kindA, kindB;
    uniform float time, bass;
    uniform vec4 seeds[${SEEDS}];   // x, y (cells), radius, 1
    uniform int count;
    out vec4 o;
    vec2 at(ivec2 p) {
      return texelFetch(state, (p + size) % size, 0).xy;
    }
    void main() {
      ivec2 p = ivec2(gl_FragCoord.xy);
      vec2 c = at(p);
      vec2 lap = -c
        + 0.2 * (at(p + ivec2(1, 0)) + at(p - ivec2(1, 0)) + at(p + ivec2(0, 1)) + at(p - ivec2(0, 1)))
        + 0.05 * (at(p + ivec2(1, 1)) + at(p - ivec2(1, 1)) + at(p + ivec2(1, -1)) + at(p - ivec2(1, -1)));
      // The balance drifting over the screen, and with the bass.
      vec2 q = vec2(p) / vec2(size);
      float m = smoothstep(0.3, 0.7, vnoise(q * vec2(float(size.x) / float(size.y), 1.0) * 2.5 + time * 0.02));
      vec2 fk = mix(kindA, kindB, m);
      // (Loud bass eats less of the growth: it spreads; quiet, it recedes.)
      fk.y += (0.45 - bass) * 0.0012;
      float a = c.x, b = c.y;
      float r = a * b * b;
      a += 1.0 * lap.x - r + fk.x * (1.0 - a);
      b += 0.5 * lap.y + r - (fk.x + fk.y) * b;
      for (int i = 0; i < ${SEEDS}; i++) {
        if (i >= count) break;
        vec4 s = seeds[i];
        if (length(vec2(p) - s.xy) < s.z) b = max(b, 0.5);
      }
      o = vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), 0.0, 1.0);
    }`;

  const SHOW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D state;
    uniform vec2 res, simRes;
    uniform int palette;
    uniform float time, glow, flash;
    out vec4 o;
    float height(vec2 p) {
      return smoothstep(0.08, 0.32, texture(state, p).y);
    }
    void main() {
      vec2 e = 1.0 / simRes;
      float h = height(uv);
      float hx = height(uv + vec2(e.x, 0.0)) - height(uv - vec2(e.x, 0.0));
      float hy = height(uv + vec2(0.0, e.y)) - height(uv - vec2(0.0, e.y));
      vec3 n = normalize(vec3(-hx, -hy, 0.35));
      vec3 l = normalize(vec3(-0.5, 0.6, 0.7));
      float diff = max(0.0, dot(n, l));
      float spec = pow(max(0.0, dot(reflect(-l, n), vec3(0.0, 0.0, 1.0))), 30.0);
      float rim = smoothstep(0.15, 0.5, h) * (1.0 - smoothstep(0.5, 0.95, h));
      vec2 sp = uv * vec2(res.x / res.y, 1.0);
      float region = vnoise(sp * 1.5 + 4.0);
      vec3 col;
      if (palette == 1) {
        vec3 c1 = mix(vec3(1.0, 0.1, 0.7), vec3(0.1, 0.9, 1.0), region);
        col = vec3(0.01, 0.0, 0.03) + c1 * rim * (1.2 + glow + flash) + c1 * h * 0.15 + vec3(1.0) * spec * h * 0.3;
      } else if (palette == 2) {
        vec3 ground = vec3(0.06, 0.06, 0.04) * (0.8 + 0.4 * vnoise(sp * 40.0));
        vec3 c1 = mix(vec3(0.55, 0.65, 0.2), vec3(0.85, 0.7, 0.25), region);
        col = mix(ground, c1 * (0.35 + 0.75 * diff) + spec * 0.15, h) + c1 * rim * (glow + flash) * 0.35;
      } else {
        // The reef: deep water, light rippling over it; corals of a few colours.
        vec3 sea = mix(vec3(0.0, 0.05, 0.12), vec3(0.0, 0.12, 0.22), uv.y) * (0.8 + 0.3 * vnoise(sp * 6.0 + time * 0.2));
        vec3 c1 = mix(mix(vec3(1.0, 0.42, 0.45), vec3(1.0, 0.6, 0.25), smoothstep(0.3, 0.6, region)), vec3(0.65, 0.35, 0.85), smoothstep(0.6, 0.85, region));
        vec3 coral = c1 * (0.3 + 0.8 * diff) + vec3(1.0, 0.95, 0.9) * spec * 0.35;
        col = mix(sea, coral, h) + c1 * rim * (glow + flash) * 0.45;
        // A shadow beside each ridge, on the sea floor.
        float hs = height(uv + vec2(e.x, -e.y) * 2.5);
        col *= 1.0 - 0.4 * hs * (1.0 - h);
      }
      col = 1.0 - exp(-col * 1.3);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Coral {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no float textures');
      this.linear = !!gl.getExtension('OES_texture_float_linear');
      this.gl = gl;
      this.step = VizGL.program(gl, VizGL.SCREEN_VS, STEP_FS);
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.age = 0;
      this.owed = 0;
      this.seeds = [];
      this.flash = 0;
      this.w = 1;
      this.h = 1;
    }

    _target(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
      const f = this.linear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fb, w, h };
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of this.state || []) VizGL.freeTarget(gl, t);
      this.sw = Math.max(16, Math.round(w / 3));
      this.sh = Math.max(16, Math.round(h / 3));
      this.state = [this._target(this.sw, this.sh), this._target(this.sw, this.sh)];
      this.cur = 0;
      // Clear, with growths sprinkled about to start from.
      const data = new Float32Array(this.sw * this.sh * 4);
      for (let i = 0; i < this.sw * this.sh; i += 1) {
        data[i * 4] = 1;
        data[i * 4 + 3] = 1;
      }
      for (let k = 0; k < 40; k += 1) {
        const cx = Math.random() * this.sw;
        const cy = Math.random() * this.sh;
        const r = 3 + Math.random() * 5;
        for (let y = Math.floor(cy - r); y <= cy + r; y += 1) {
          for (let x = Math.floor(cx - r); x <= cx + r; x += 1) {
            if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
            const i = ((y + this.sh) % this.sh) * this.sw + ((x + this.sw) % this.sw);
            data[i * 4 + 1] = 0.5;
          }
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, this.state[0].tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.sw, this.sh, gl.RGBA, gl.FLOAT, data);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      dt = Math.min(dt, 0.05);
      this.age += dt;
      const kind = KINDS[set('crKind')] || KINDS.coral;
      if (a.playing && (a.onset || (a.hit && a.hitPower > 0.6))) {
        const big = a.onset;
        this.seeds.push([Math.random() * this.sw, Math.random() * this.sh, big ? 3 + 5 * a.onsetPower : 2, 1]);
        if (big) this.flash = Math.max(this.flash, a.onsetPower);
      }
      this.flash *= Math.exp(-dt * 4);
      // Steps a second: faster with the tempo and the growth slider; none while paused.
      // (Three times as fast at first, to cover the screen sooner.)
      const rate = a.playing ? 700 * (set('crSpeed') / 100) * a.pace * (1 + 2 * Math.exp(-this.age / 5)) : 0;
      this.owed += dt * rate;
      const steps = Math.min(40, Math.floor(this.owed));
      this.owed -= steps;

      gl.disable(gl.BLEND);
      gl.useProgram(this.step.p);
      const u = this.step.u;
      gl.uniform2i(u.size, this.sw, this.sh);
      gl.uniform2f(u.kindA, kind[0][0], kind[0][1]);
      gl.uniform2f(u.kindB, kind[1][0], kind[1][1]);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.bass, a.bass);
      for (let s = 0; s < steps; s += 1) {
        const src = this.state[this.cur];
        const dst = this.state[1 - this.cur];
        VizGL.into(gl, dst);
        VizGL.bind(gl, u.state, src.tex, 0);
        const seeds = s === 0 ? this.seeds.slice(0, SEEDS) : [];
        const data = new Float32Array(SEEDS * 4);
        seeds.forEach((d, i) => data.set(d, i * 4));
        gl.uniform4fv(u.seeds, data);
        gl.uniform1i(u.count, seeds.length);
        VizGL.screen(gl);
        this.cur = 1 - this.cur;
        if (s === 0) this.seeds = [];
      }

      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      const v = this.show.u;
      VizGL.bind(gl, v.state, this.state[this.cur].tex, 0);
      gl.uniform2f(v.res, this.w, this.h);
      gl.uniform2f(v.simRes, this.sw, this.sh);
      gl.uniform1i(v.palette, PALETTES[set('crColors')] ?? 0);
      gl.uniform1f(v.time, this.age);
      gl.uniform1f(v.glow, a.playing ? 0.3 + 0.7 * a.level : 0.2);
      gl.uniform1f(v.flash, this.flash);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'coral',
    name: 'Coral',
    desc: 'Living patterns of coral, cells or mazes growing over the screen, seeded by the kicks, swelling and receding with the bass',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-8M12 14c-3 0-5-2-5-5V5M12 14c3 0 5-2 5-5V3M7 9H4V6M17 8h3V5M12 14V9"/></svg>',
    gl: true,
    create: (canvas) => new Coral(canvas),
    options: [
      { type: 'choice', key: 'crKind', label: 'Growth', choices: [['coral', 'Coral'], ['maze', 'Maze'], ['spots', 'Spots']] },
      { type: 'choice', key: 'crColors', label: 'Colours', choices: [['reef', 'Reef'], ['neon', 'Neon'], ['lichen', 'Lichen']] },
      { type: 'slider', key: 'crSpeed', label: 'Growing', min: 25, max: 300, step: 5 },
    ],
  });
})();
