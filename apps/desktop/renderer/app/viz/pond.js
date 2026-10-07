'use strict';

// Rainy Pond: a garden pond seen from above. The music falls into it: each kick
// drops a big ring of ripples somewhere, the hits smaller ones, the highs a
// light rain; the rings spread, cross and bounce off the banks. Through the
// water a pebbly bottom with the sun's caustic light dancing over it, the
// ripples bending both; koi swim under lily pads that ride the waves, faster
// with the tempo. Or the same pond at night, the ripples catching the moon,
// or the one fading into the other and back.
//
// Its cogwheel: alternating, day or night, how many drops fall (the kicks',
// the hits' and the rain's), the koi, the lily pads, the rain.
//
// WebGL (viz/gl.js): the water's surface is a wave simulation in a float
// texture at half the screen's size, stepped 120 times a second (each
// point pulled by its neighbours, damped), the drops added as bumps; the
// picture is one pass reading its slopes to bend the bottom, the fish and
// the light, and to shine.

(() => {
  const FISH = 6;
  const PADS = 7;
  const DROPS = 8;
  const RATE = 120;
  // The treble rain's drops a second at full treble (at 100%).
  const RAIN = 9.3;

  const SIM_FS = `
    in vec2 uv;
    uniform sampler2D state;
    uniform vec2 res;
    uniform vec4 drops[${DROPS}];   // x, y (pixels of the simulation), radius, strength
    uniform int count;
    out vec4 o;
    void main() {
      vec2 t = 1.0 / res;
      vec4 c = texture(state, uv);
      float n = (texture(state, uv + vec2(t.x, 0.0)).r + texture(state, uv - vec2(t.x, 0.0)).r
        + texture(state, uv + vec2(0.0, t.y)).r + texture(state, uv - vec2(0.0, t.y)).r) * 0.5 - c.g;
      n *= 0.992;
      vec2 px = uv * res;
      for (int i = 0; i < ${DROPS}; i++) {
        if (i >= count) break;
        vec4 d = drops[i];
        vec2 v = px - d.xy;
        n += d.w * exp(-dot(v, v) / (d.z * d.z));
      }
      o = vec4(n, c.r, 0.0, 1.0);
    }`;

  const SHOW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D state;
    uniform vec2 res, simRes;
    uniform float time, light, night;   // night: 0 day .. 1 night
    uniform vec4 fish[${FISH}];     // x, y (0..1), heading, tail phase
    uniform vec4 pads[${PADS}];     // x, y, radius, notch angle
    uniform float showFish, showPads;
    out vec4 o;
    const float TAU = 6.2831853;

    float caustic(vec2 p, float t) {
      vec2 q = mod(p * TAU, TAU) - 250.0;
      vec2 i = q;
      float c = 1.0;
      float inten = 0.005;
      for (int n = 0; n < 5; n++) {
        float t2 = t * (1.0 - (3.5 / float(n + 1)));
        i = q + vec2(cos(t2 - i.x) + sin(t2 + i.y), sin(t2 - i.y) + cos(t2 + i.x));
        c += 1.0 / length(vec2(q.x / (sin(i.x + t2) / inten), q.y / (cos(i.y + t2) / inten)));
      }
      c /= 5.0;
      c = 1.17 - pow(c, 1.4);
      return pow(abs(c), 8.0);
    }

    // The bottom: pebbles in sand.
    vec3 bottom(vec2 p) {
      vec2 q = p * 24.0;
      vec2 g = floor(q), f = fract(q);
      float d1 = 8.0, d2 = 8.0;
      vec2 id = vec2(0.0);
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 pt = o + 0.5 + 0.38 * (vec2(hash12(g + o), hash12(g + o + 9.1)) - 0.5);
        float d = length(pt - f);
        if (d < d1) { d2 = d1; d1 = d; id = g + o; }
        else if (d < d2) d2 = d;
      }
      float h = hash12(id + 3.3);
      vec3 stone = mix(vec3(0.33, 0.3, 0.26), vec3(0.52, 0.48, 0.4), h) * (0.75 + 0.35 * hash12(id + 7.7));
      if (h > 0.85) stone = vec3(0.24, 0.26, 0.22);
      // Round pebbles, each its own size, in sand; lit from one side.
      float r = 0.28 + 0.16 * hash12(id + 5.1);
      float in_ = smoothstep(r + 0.04, r - 0.04, d1) * smoothstep(0.0, 0.08, d2 - d1);
      vec3 sand = vec3(0.42, 0.37, 0.27) * (0.85 + 0.15 * vnoise(p * 300.0));
      return mix(sand * (1.0 - 0.25 * smoothstep(r + 0.12, r, d1)), stone * (0.75 + 0.35 * (1.0 - d1 / r)), in_);
    }

    // A koi: its body along its heading, its tail swinging; rgb and coverage.
    vec4 koi(vec2 p, vec4 f, float k) {
      vec2 d = p - f.xy;
      float c = cos(f.z), s = sin(f.z);
      vec2 l = vec2(dot(d, vec2(c, s)), dot(d, vec2(-s, c))) / 0.075;   // x forward, in body lengths
      float sw = sin(f.w - l.x * 2.5) * 0.14 * smoothstep(0.4, -1.0, l.x);
      l.y -= sw;
      float body = length(vec2(l.x / 1.0, l.y / (0.3 * (1.0 - 0.6 * smoothstep(0.2, -0.95, l.x)) * (0.55 + 0.45 * smoothstep(1.05, 0.55, l.x)) + 0.001)));
      float cover = smoothstep(1.05, 0.9, body) * step(-0.95, l.x);
      // The tail fin and two side fins.
      float tail = smoothstep(0.02, 0.0, abs(l.y) - (-l.x - 0.85) * 0.5) * step(l.x, -0.85) * step(-1.35, l.x);
      float fins = smoothstep(0.08, 0.0, length(vec2(l.x - 0.25, abs(l.y) - 0.3)) - 0.08);
      float a = max(cover, max(tail * 0.8, fins * 0.6));
      // Orange and white, a few with black.
      float spots = vnoise(l * 2.2 + k * 13.0);
      vec3 col = spots > 0.55 ? vec3(0.95, 0.93, 0.88) : vec3(0.98, 0.42, 0.1);
      if (k > 0.66 && vnoise(l * 3.0 + 7.0) > 0.68) col = vec3(0.08);
      return vec4(col * (0.85 + 0.15 * (1.0 - abs(l.y) * 2.0)), a);
    }

    void main() {
      vec2 asp = vec2(res.x / res.y, 1.0);
      vec2 e = 1.0 / simRes;
      float hc = texture(state, uv).r;
      float hl = texture(state, uv - vec2(e.x, 0.0)).r;
      float hr = texture(state, uv + vec2(e.x, 0.0)).r;
      float hd = texture(state, uv - vec2(0.0, e.y)).r;
      float hu = texture(state, uv + vec2(0.0, e.y)).r;
      vec3 n = normalize(vec3(hl - hr, hd - hu, 0.35));
      float lap = hl + hr + hu + hd - 4.0 * hc;

      // Under the water, bent by its slope.
      vec2 ruv = uv + n.xy * 0.035;
      vec2 p = ruv * asp;
      vec3 bed = bottom(p);
      float caus = caustic(p * 1.6, time * 0.5) * 0.9 + caustic(p * 2.3 + 3.0, time * 0.37) * 0.5;
      caus += clamp(-lap * 6.0, 0.0, 1.5);
      vec3 sun = mix(vec3(1.0, 0.95, 0.8), vec3(0.25, 0.35, 0.55), night);
      vec3 col = bed * (0.45 + caus * light * 0.9) * sun;
      // The fish, between the bottom and the surface: their shadows first.
      if (showFish > 0.5) {
        for (int i = 0; i < ${FISH}; i++) {
          vec4 sh = koi(p + vec2(-0.02, 0.02), fish[i], float(i) / float(${FISH}));
          col *= 1.0 - sh.a * 0.45;
        }
        for (int i = 0; i < ${FISH}; i++) {
          vec4 k = koi(p, fish[i], float(i) / float(${FISH}));
          col = mix(col, k.rgb * (0.55 + 0.6 * caus * light) * sun, k.a * 0.92);
        }
      }
      // The water itself: greener and darker the deeper it looks.
      vec3 water = mix(vec3(0.05, 0.22, 0.2), vec3(0.01, 0.03, 0.06), night);
      col = mix(col, water, mix(0.35, 0.55, night));

      // The lily pads float on the water, each as one piece: a ripple passing
      // under one only nudges and tilts it a little (the water's height round
      // its rim, so it follows the swell, not every small wave). Their
      // shadows lie on the bottom, under the surface.
      vec2 padOff[${PADS}];
      vec2 padTilt[${PADS}];
      if (showPads > 0.5) {
        for (int i = 0; i < ${PADS}; i++) {
          vec4 pd = pads[i];
          padOff[i] = vec2(0.0);
          padTilt[i] = vec2(0.0);
          if (length(uv * asp - pd.xy) > pd.z * 1.15 + 0.03) continue;
          vec2 c = pd.xy / asp;
          vec2 tilt = vec2(0.0);
          for (int k = 0; k < 8; k++) {
            float a = float(k) * TAU / 8.0;
            vec2 dir = vec2(cos(a), sin(a));
            tilt -= dir * texture(state, c + dir * pd.z * 0.6 / asp).r;
          }
          tilt = clamp(tilt * 0.25, -1.0, 1.0);
          padTilt[i] = tilt;
          padOff[i] = tilt * 0.003;
          vec2 qs = uv * asp - pd.xy - padOff[i] - vec2(0.015, -0.015);
          col *= 1.0 - 0.35 * smoothstep(pd.z, pd.z * 0.9, length(qs));
        }
      }

      // The surface: the sky (or the moon) in its slopes, a glint where it faces the light.
      vec3 v = vec3(0.0, 0.0, 1.0);
      vec3 ldir = normalize(vec3(-0.5, 0.6, 0.8));
      float spec = pow(max(0.0, dot(reflect(-ldir, n), v)), mix(180.0, 400.0, night));
      float fres = pow(1.0 - n.z, 3.0);
      vec3 sky = mix(vec3(0.75, 0.9, 1.0), vec3(0.4, 0.55, 0.9), night);
      col += sky * fres * mix(2.5, 6.0, night) + vec3(1.0) * spec * mix(1.2, 2.5, night);
      // At night the ripples glint with the moon all over.
      col += vec3(0.5, 0.65, 1.0) * clamp(abs(lap) * 9.0, 0.0, 1.0) * 0.5 * night;

      // The pads on top of it all, lit by how they tilt.
      if (showPads > 0.5) {
        for (int i = 0; i < ${PADS}; i++) {
          vec4 pd = pads[i];
          vec2 q = uv * asp - pd.xy - padOff[i];
          float r = length(q);
          if (r > pd.z * 1.05) continue;
          float an = atan(q.y, q.x) - pd.w;
          float notch = smoothstep(0.03, 0.0, abs(mod(an + 3.14159, TAU) - 3.14159)) * step(r, pd.z);
          float pad = smoothstep(pd.z, pd.z - 0.003, r) * (1.0 - smoothstep(0.0, 1.0, notch * 4.0));
          float veins = 0.85 + 0.15 * smoothstep(0.0, 0.02, abs(sin(an * 9.0)) * r);
          float lit = 1.0 + 0.25 * dot(padTilt[i], normalize(ldir.xy));
          vec3 green = mix(vec3(0.12, 0.32, 0.1), vec3(0.25, 0.48, 0.15), r / pd.z) * veins * lit;
          green *= mix(1.0, 0.25, night);
          col = mix(col, green, pad);
          // A flower on some (by the pad, not where it drifts to).
          if (fract(float(i) * 0.618) > 0.45) {
            float pan = atan(q.y, q.x) * 6.0;
            float fr = length(q) / (pd.z * 0.42) * (1.0 - 0.25 * abs(sin(pan)));
            float flower = smoothstep(1.0, 0.92, fr);
            vec3 petal = mix(vec3(1.0, 0.85, 0.9), vec3(0.95, 0.45, 0.65), fr) * lit;
            petal *= mix(1.0, 0.45, night);
            col = mix(col, mix(petal, vec3(1.0, 0.85, 0.3), smoothstep(0.3, 0.0, fr)), flower);
          }
        }
      }
      col *= 1.0 - 0.3 * pow(length(uv - 0.5) * 1.3, 2.0);
      col = 1.0 - exp(-col * 1.4);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Pond {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.sim = VizGL.program(gl, VizGL.SCREEN_VS, SIM_FS);
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.age = 0;
      this.owed = 0;
      this.drops = [];
      this.rain = 0;
      this.kicks = 0.5;
      this.hits = 0.5;
      this.fish = Array.from({ length: FISH }, () => ({ x: Math.random(), y: Math.random(), h: Math.random() * Math.PI * 2, tail: Math.random() * 6, turn: 0, speed: 0.04 + Math.random() * 0.03 }));
      this.pads = null;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of this.state || []) VizGL.freeTarget(gl, t);
      this.sw = Math.max(1, Math.round(w / 2));
      this.sh = Math.max(1, Math.round(h / 2));
      this.state = [VizGL.target(gl, this.sw, this.sh, { filter: gl.LINEAR }), VizGL.target(gl, this.sw, this.sh, { filter: gl.LINEAR })];
      this.cur = 0;
      const asp = w / h;
      this.asp = asp;
      this.pads = Array.from({ length: PADS }, () => ({
        x: 0.08 + Math.random() * (asp - 0.16), y: 0.08 + Math.random() * 0.84, r: 0.045 + Math.random() * 0.04, notch: Math.random() * Math.PI * 2, vx: (Math.random() - 0.5) * 0.004, vy: (Math.random() - 0.5) * 0.004,
      }));
      for (const f of this.fish) f.x = Math.random() * asp;
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    _drop(power, small) {
      const r = (small ? 2.5 : 4 + power * 5) * (this.sh / 540);
      this.drops.push([Math.random() * this.sw, Math.random() * this.sh, r, (small ? 0.8 : 1.6 + power * 2.4) * (small ? 1 : 1)]);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      dt = Math.min(dt, 0.05);
      this.age += dt;
      // Day, night, or alternating: three minutes from one to the other and
      // three back, eased at each end.
      const look = set('pdLook');
      const night = look === 'night' ? 1 : look === 'alternate' ? 0.5 - 0.5 * Math.cos((this.age / 180) * Math.PI) : 0;

      // The music falling in, as many drops as the intensity says: at 50%
      // every other kick, at 150% one and two in turn (the same for the hits).
      if (a.playing) {
        const more = Number(set('pdRainAmount')) / 100;
        const fall = (owed, power, small) => {
          owed += more;
          for (; owed >= 1; owed -= 1) this._drop(power, small);
          return owed;
        };
        if (a.onset) this.kicks = fall(this.kicks, a.onsetPower, false);
        else if (a.hit) this.hits = fall(this.hits, a.hitPower, true);
        if (set('pdRain')) {
          this.rain += dt * RAIN * more * a.treble * a.treble;
          while (this.rain >= 1) {
            this.rain -= 1;
            this._drop(0, true);
          }
        }
      }

      // The fish: wandering, turning away from the banks, faster with the tempo.
      const pace = a.playing ? a.pace * (0.8 + 0.5 * a.level) : 0.4;
      for (const f of this.fish) {
        f.turn += ((Math.random() - 0.5) * 3 - f.turn) * Math.min(1, dt * 0.8);
        let h = f.h + f.turn * dt * 0.6;
        const m = 0.12;
        const want = (x, y) => Math.atan2(y - f.y, x - f.x);
        if (f.x < m || f.x > this.asp - m || f.y < m || f.y > 1 - m) {
          let d = want(this.asp / 2, 0.5) - h;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          h += d * Math.min(1, dt * 1.2);
        }
        f.h = h;
        const v = f.speed * pace * (1 + 0.8 * a.kick);
        f.x += Math.cos(h) * v * dt;
        f.y += Math.sin(h) * v * dt;
        f.tail += dt * (4 + v * 80);
      }
      for (const p of this.pads) {
        p.x = Math.min(this.asp - 0.05, Math.max(0.05, p.x + p.vx * dt));
        p.y = Math.min(0.95, Math.max(0.05, p.y + p.vy * dt));
      }

      // The water, stepped RATE times a second; the drops go in on the first step.
      this.owed += dt * RATE;
      let steps = Math.min(4, Math.floor(this.owed));
      this.owed -= steps;
      if (!steps && this.drops.length) {
        steps = 1;
        this.owed -= 1;
      }
      gl.disable(gl.BLEND);
      for (let s = 0; s < steps; s += 1) {
        const src = this.state[this.cur];
        const dst = this.state[1 - this.cur];
        VizGL.into(gl, dst);
        gl.useProgram(this.sim.p);
        const u = this.sim.u;
        VizGL.bind(gl, u.state, src.tex, 0);
        gl.uniform2f(u.res, this.sw, this.sh);
        const drops = s === 0 ? this.drops.slice(0, DROPS) : [];
        const data = new Float32Array(DROPS * 4);
        drops.forEach((d, i) => data.set(d, i * 4));
        gl.uniform4fv(u.drops, data);
        gl.uniform1i(u.count, drops.length);
        VizGL.screen(gl);
        this.cur = 1 - this.cur;
        if (s === 0) this.drops = [];
      }

      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      const u = this.show.u;
      VizGL.bind(gl, u.state, this.state[this.cur].tex, 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform2f(u.simRes, this.sw, this.sh);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.light, a.playing ? 0.7 + 0.5 * a.level : 0.6);
      gl.uniform1f(u.night, night);
      const fish = new Float32Array(FISH * 4);
      this.fish.forEach((f, i) => fish.set([f.x, 1 - f.y, -f.h, f.tail], i * 4));
      gl.uniform4fv(u.fish, fish);
      const pads = new Float32Array(PADS * 4);
      this.pads.forEach((p, i) => pads.set([p.x, p.y, p.r, p.notch], i * 4));
      gl.uniform4fv(u.pads, pads);
      gl.uniform1f(u.showFish, set('pdKoi') ? 1 : 0);
      gl.uniform1f(u.showPads, set('pdPads') ? 1 : 0);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'pond',
    name: 'Rainy Pond',
    desc: 'A garden pond seen from above: the beats falling into it as rings of ripples, koi swimming under lily pads, the sun dancing on the bottom',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10"/></svg>',
    gl: true,
    create: (canvas) => new Pond(canvas),
    options: [
      { type: 'choice', key: 'pdLook', label: '', choices: [['alternate', 'Alternate'], ['day', 'Day'], ['night', 'Night']] },
      { type: 'slider', key: 'pdRainAmount', label: 'Rain intensity', min: 50, max: 150, step: 5 },
      { type: 'check', key: 'pdKoi', label: 'Koi' },
      { type: 'check', key: 'pdPads', label: 'Lily pads' },
      { type: 'check', key: 'pdRain', label: 'Treble rain' },
    ],
  });
})();
