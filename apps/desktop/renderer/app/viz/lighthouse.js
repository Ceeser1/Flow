'use strict';

// Lighthouse: a night sea under the moon, a lighthouse on its rocks off to
// the right. The swell rises with the bass and rolls on with the tempo; the
// moon lays a glittering path across it. The lighthouse's two beams turn
// round once every four bars (with a clear beat; slowly without), reaching
// out over the sea through the haze and, as each sweeps past, flooding
// everything with light; the lantern flares on the kicks, its light trembling
// on the water. On the hits the sea breaks white on the rocks. Far off a
// ship may pass, its lights rocking.
//
// Its cogwheel: the weather (clear, cloudy, a storm with rain), the ship.
//
// WebGL (viz/gl.js): one pass. The camera sits low over the water; each
// pixel's ray either meets the sky (clouds, moon, stars) or the sea (a sum of
// waves for its slope, reflecting the sky, the moon and the lantern); the
// lighthouse and its rocks are drawn where they stand; the beams are cones
// in the air, each pixel lit by how near its ray passes their axes.

(() => {
  const WEATHER = {
    clear: { clouds: 0.18, rain: 0, swell: 0.8, haze: 0.6 },
    cloudy: { clouds: 0.5, rain: 0, swell: 1.0, haze: 0.8 },
    storm: { clouds: 0.85, rain: 1, swell: 1.7, haze: 1.3 },
  };

  const FS = VizGL.NOISE + VizGL.STARS + `
    in vec2 uv;
    uniform vec2 res;
    uniform float time, wave, swell, beamAng, lamp, splash, rain, clouds, haze, boom;
    uniform vec3 ship;          // x, how far it has rocked, shown (0..1)
    out vec4 o;

    const float F = 1.5;        // focal length
    const float CAMH = 1.6;     // the eye above the water
    const float HORIZON = 0.42; // where the horizon lies on the screen
    const vec3 LANTERN = vec3(18.0, 14.8, 60.0);
    const vec3 MOONDIR = vec3(-0.5, 0.3, 1.5) / 1.6093;

    vec3 rayFor(vec2 s) { return normalize(vec3(s, F)); }
    vec2 onScreen(vec3 p) { return vec2(p.x, p.y - CAMH) / p.z * F; }

    // The swell's height at p and its slope (x, z).
    vec3 waves(vec2 p) {
      vec3 r = vec3(0.0);
      float amp = 0.45 * swell;
      float k = 0.25;
      vec2 dir = normalize(vec2(0.35, -1.0));
      for (int i = 0; i < 9; i++) {
        float ph = dot(dir, p) * k + wave * sqrt(9.8 * k) + float(i) * 1.7;
        r.x += amp * sin(ph);
        r.yz += amp * k * cos(ph) * dir;
        amp *= 0.62;
        k *= 1.62;
        dir = mat2(0.8, -0.6, 0.6, 0.8) * dir;
      }
      return r;
    }

    // The clouds' cover at a direction up into the sky (0..1).
    float cloudAt(vec3 d) {
      vec2 c = d.xz / (d.y + 0.08) * 0.7 + vec2(time * 0.015, 0.0);
      float n = fbm(c * 1.3);
      return smoothstep(1.0 - clouds - 0.2, 1.0 - clouds + 0.25, n);
    }

    // The sky in direction d: the dark, the moon and its halo, the clouds
    // (silver near the moon), the stars at px (pixels) if asked.
    vec3 sky(vec3 d, vec2 px, bool stars) {
      float up = max(d.y, 0.0);
      vec3 c = mix(vec3(0.025, 0.035, 0.065), vec3(0.004, 0.006, 0.018), smoothstep(0.0, 0.5, up));
      float md = dot(d, MOONDIR);
      float moon = smoothstep(0.99984, 0.99989, md);
      float halo = pow(max(md, 0.0), 300.0) * 0.35 + pow(max(md, 0.0), 20.0) * 0.06;
      float cover = cloudAt(d);
      if (stars) c += starField(px, time, boom) * (1.0 - cover) * smoothstep(0.0, 0.15, up);
      // The moon's face, a little mottled.
      vec3 mface = vec3(1.0, 0.97, 0.88) * (0.85 + 0.15 * vnoise(d.xy * 900.0));
      c += (mface * moon * 1.6 + vec3(0.6, 0.7, 0.9) * halo) * (1.0 - 0.85 * cover);
      // Heavier and darker in a storm, but never one flat sheet.
      float billow = fbm(d.xz / (d.y + 0.08) * 2.2 + vec2(time * 0.03, 5.0));
      vec3 cl = mix(vec3(0.012, 0.015, 0.022), vec3(0.07, 0.075, 0.09), clamp(billow * 1.6 - 0.35 - clouds * 0.25, 0.0, 1.0));
      cl += vec3(0.5, 0.55, 0.65) * pow(max(md, 0.0), 40.0) * 0.6 * (1.0 - cover * 0.4);
      return mix(c, cl, cover * smoothstep(-0.02, 0.06, d.y));
    }

    // How much the beams light the air along the ray d up to tMax, and how
    // straight one shines at the eye.
    float beams(vec3 d, float tMax, out float facing) {
      vec3 o = vec3(0.0, CAMH, 0.0);
      float sum = 0.0;
      facing = 0.0;
      for (int k = 0; k < 2; k++) {
        float a = beamAng + float(k) * 3.14159265;
        vec3 b = normalize(vec3(cos(a), -0.012, sin(a)));
        vec3 w0 = o - LANTERN;
        float bb = dot(d, b);
        float dd = dot(d, w0);
        float e = dot(b, w0);
        float den = max(1.0 - bb * bb, 1e-4);
        float t = (bb * e - dd) / den;
        float u = (e - bb * dd) / den;
        u = max(u, 0.0);
        t = clamp(dot(LANTERN + b * u - o, d), 0.0, tMax);
        vec3 pr = o + d * t;
        vec3 pb = LANTERN + b * max(dot(pr - LANTERN, b), 0.0);
        float dist = length(pr - pb);
        float uu = max(dot(pr - LANTERN, b), 0.0);
        float r = 0.5 + uu * 0.075;
        sum += exp(-(dist * dist) / (r * r)) * exp(-uu * 0.008) * (0.35 + 0.65 * smoothstep(0.0, 6.0, uu));
        facing = max(facing, dot(b, normalize(o - LANTERN)));
      }
      return sum;
    }

    // The rocks' top at x (screen), round the lighthouse's foot.
    float rockTop(float x) {
      float base = (0.0 - CAMH) / LANTERN.z * F;
      float m = 1.0 - smoothstep(0.0, 0.17, abs(x - 0.44));
      float j = vnoise(vec2(x * 70.0, 3.0)) * 0.018 + vnoise(vec2(x * 260.0, 7.0)) * 0.005;
      return base - 0.008 + m * m * 0.06 + j * m;
    }

    void main() {
      float aspect = res.x / res.y;
      vec2 s = vec2((uv.x - 0.5) * aspect, uv.y - HORIZON);
      vec3 d = rayFor(s);
      vec2 ls = onScreen(LANTERN);
      vec3 col;
      float tMax = 1e4;
      float wet = 0.0;
      if (d.y > 0.0) {
        col = sky(d, gl_FragCoord.xy, true);
      } else {
        // The sea.
        float t = CAMH / -d.y;
        tMax = t;
        vec3 p = vec3(0.0, CAMH, 0.0) + d * t;
        vec3 w = waves(p.xz);
        float fade = 1.0 / (1.0 + t * 0.012);
        vec2 sl = w.yz * fade;
        // Ripples on top.
        for (int i = 0; i < 2; i++) {
          float sc = i == 0 ? 1.3 : 3.9;
          vec2 q = p.xz * sc + vec2(float(i) * 7.0, wave * 1.1 * sc);
          float r0 = vnoise(q);
          sl += vec2(vnoise(q + vec2(0.05, 0.0)) - r0, vnoise(q + vec2(0.0, 0.05)) - r0) * (i == 0 ? 2.4 : 1.3) * swell * fade * fade;
        }
        vec3 n = normalize(vec3(-sl.x, 1.0, -sl.y));
        vec3 rf = reflect(d, n);
        rf.y = abs(rf.y);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, -d), 0.0), 5.0);
        col = vec3(0.004, 0.009, 0.016) * (0.6 + 0.6 * w.x / max(swell, 0.1));
        col += sky(rf, vec2(0.0), false) * fres;
        // The moon's path: glints.
        col += vec3(1.0, 0.95, 0.85) * pow(max(dot(rf, MOONDIR), 0.0), 700.0) * 4.0 * (1.0 - 0.8 * cloudAt(MOONDIR));
        // The lantern's trembling light on the water.
        vec3 tl = normalize(LANTERN - p);
        col += vec3(1.0, 0.85, 0.55) * pow(max(dot(rf, tl), 0.0), 500.0) * 3.0 * lamp;
        // Whitecaps on the crests.
        float crest = w.x / max(0.5 * swell, 0.1);
        float foam = smoothstep(0.55, 0.95, crest) * smoothstep(0.35, 0.75, vnoise(p.xz * 0.9 + wave * 0.3));
        col += vec3(0.22, 0.24, 0.28) * foam * smoothstep(0.55, 1.5, swell) * fade * (0.5 + 0.5 * (1.0 - clouds));
        wet = 1.0;
      }

      // A ship far off: its hull, its lights.
      if (ship.z > 0.0) {
        vec3 sp = vec3(ship.x, 0.0, 150.0);
        vec2 ss = onScreen(sp);
        vec2 q = (s - ss) / 0.012;
        q.y -= ship.y * 0.15;
        float hull = step(abs(q.x), 1.6 - max(q.y, 0.0) * 0.6) * step(-0.25, q.y) * step(q.y, 0.25);
        float cabin = step(abs(q.x + 0.4), 0.45) * step(0.25, q.y) * step(q.y, 0.65);
        float mast = step(abs(q.x - 0.5), 0.04) * step(0.25, q.y) * step(q.y, 1.4);
        if (hull + cabin + mast > 0.0) col = mix(col, vec3(0.008, 0.009, 0.012), ship.z);
        float lights = 0.0;
        vec3 lc = vec3(0.0);
        lc += vec3(1.0, 0.85, 0.6) * exp(-dot(q - vec2(-0.6, 0.45), q - vec2(-0.6, 0.45)) * 60.0);
        lc += vec3(1.0, 0.85, 0.6) * exp(-dot(q - vec2(-0.2, 0.45), q - vec2(-0.2, 0.45)) * 60.0);
        lc += vec3(1.0, 1.0, 0.95) * exp(-dot(q - vec2(0.5, 1.4), q - vec2(0.5, 1.4)) * 40.0) * 1.5;
        lc += vec3(1.0, 0.15, 0.1) * exp(-dot(q - vec2(-1.4, 0.1), q - vec2(-1.4, 0.1)) * 50.0);
        col += lc * ship.z * 1.2;
      }

      // The rocks and the lighthouse on them.
      float px = 1.0 / res.y;
      float rt = rockTop(s.x);
      float base = (0.0 - CAMH) / LANTERN.z * F;
      if (s.y < rt && s.y > base - 0.012 && abs(s.x - 0.44) < 0.19) {
        float a = smoothstep(rt, rt - px * 1.5, s.y) * smoothstep(base - 0.012, base - 0.004, s.y);
        float sh = 0.4 + 0.6 * smoothstep(0.03, -0.03, s.x - 0.42) ;
        vec3 rc = vec3(0.03, 0.03, 0.036) * (0.5 + 0.8 * vnoise(s * 400.0)) * sh;
        // Moonlit along their top.
        rc += vec3(0.1, 0.11, 0.14) * smoothstep(rt - 0.008, rt, s.y) * (1.0 - 0.7 * clouds) * sh;
        rc += vec3(0.25, 0.2, 0.14) * lamp * 0.05 * smoothstep(rt - 0.02, rt, s.y);
        col = mix(col, rc, a);
        tMax = min(tMax, 60.0);
      }
      // The tower: tapering, banded red and white, lit by the moon from the left.
      float top = ls.y - 0.04;
      float tb = (0.0 - CAMH) / LANTERN.z * F + 0.03;
      if (s.y > tb - 0.03 && s.y < top) {
        float f = (s.y - tb) / (top - tb);
        float hw = mix(0.036, 0.022, clamp(f, 0.0, 1.0));
        float x = (s.x - ls.x) / hw;
        if (abs(x) < 1.0) {
          float band = step(0.5, fract(f * 4.0 + 0.25));
          vec3 paint = mix(vec3(0.85, 0.82, 0.78), vec3(0.6, 0.06, 0.05), band);
          float light = 0.1 + 0.5 * max(0.0, -x * 0.7 + 0.5) * (1.0 - 0.7 * clouds);
          light += lamp * 0.35 * smoothstep(0.7, 1.0, f);
          // A window or two.
          float win = step(abs(x), 0.18) * step(abs(fract(f * 4.0) - 0.62), 0.06);
          vec3 tc = paint * light * 0.25 + vec3(1.0, 0.75, 0.4) * win * 0.25;
          col = mix(col, tc, smoothstep(1.0, 1.0 - 3.0 * px / hw, abs(x)));
          tMax = min(tMax, 60.0);
        }
      }
      // The gallery, the lantern room and its roof.
      {
        vec2 q = s - ls;
        float gallery = step(abs(q.x), 0.034) * step(abs(q.y + 0.038), 0.004);
        float rail = step(abs(q.x), 0.031) * step(abs(q.y + 0.03), 0.0012);
        float glass = step(abs(q.x), 0.02) * step(abs(q.y), 0.033) * step(-0.033, q.y);
        float bar = glass * step(abs(fract(q.x / 0.01) - 0.5), 0.12);
        float roofY = q.y - 0.033;
        float roof = step(0.0, roofY) * step(roofY, 0.03) * step(abs(q.x), 0.024 * (1.0 - roofY / 0.03));
        vec3 dark = vec3(0.015, 0.016, 0.02);
        if (gallery + rail > 0.0) col = dark;
        if (glass > 0.0) col = mix(vec3(1.0, 0.85, 0.55) * (0.6 + 1.2 * lamp), dark, bar * 0.8);
        if (roof > 0.0) col = mix(dark, vec3(0.6, 0.06, 0.05) * 0.15, 0.5) + vec3(0.1, 0.08, 0.05) * lamp * 0.2;
        if (gallery + rail + glass + roof > 0.0) tMax = min(tMax, 60.0);
      }

      // Spray breaking on the rocks.
      if (splash > 0.01) {
        vec2 q = vec2((s.x - 0.44) / 0.17, (s.y - base) / 0.09);
        float sh = (1.0 - q.x * q.x) * splash;
        if (q.y > -0.1 && q.y < sh && abs(q.x) < 1.0) {
          float n = fbm(vec2(q.x * 6.0, q.y * 4.0 - time * 0.6) + 3.0);
          float a = smoothstep(0.45, 0.75, n) * smoothstep(sh, sh * 0.4, q.y) * splash;
          col = mix(col, vec3(0.35, 0.38, 0.45) * (0.5 + 0.8 * lamp * 0.3), a);
        }
      }

      // The beams in the air, and the glare when one looks at the eye.
      float facing;
      float bm = beams(d, tMax, facing);
      vec3 beamCol = vec3(1.0, 0.92, 0.75);
      col += beamCol * bm * 0.22 * haze * lamp;
      vec2 lq = s - ls;
      float face = pow(max(facing, 0.0), 12.0);
      col += beamCol * (0.0008 / (dot(lq, lq) + 0.0005)) * lamp * (0.25 + 1.6 * face);
      col += beamCol * exp(-abs(lq.y) * 300.0) * exp(-abs(lq.x) * 6.0) * face * lamp * 0.6;

      // Rain, lit where the beams cross it.
      if (rain > 0.0) {
        vec2 rp = vec2(uv.x * aspect * 160.0 + uv.y * 30.0, uv.y * 7.0 + time * 11.0);
        float cell = floor(rp.x);
        float off = hash12(vec2(cell, 3.0));
        float seg = fract(rp.y + off * 10.0);
        float drop = step(0.8, hash12(vec2(cell, floor(rp.y + off * 10.0)))) * smoothstep(0.0, 0.1, seg) * smoothstep(0.3, 0.15, seg);
        drop *= smoothstep(0.35, 0.0, abs(fract(rp.x) - 0.5));
        col += vec3(0.5, 0.55, 0.65) * drop * rain * (0.035 + bm * 0.6 * lamp + 0.3 * face * lamp);
      }

      col = 1.0 - exp(-col * 1.5);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Lighthouse {
    constructor(canvas) {
      this.starShift = VizGL.starShift();
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.age = 0;
      this.wave = Math.random() * 100;
      this.ang = Math.random() * Math.PI * 2;
      this.swell = 1;
      this.lamp = 0.8;
      this.splash = 0;
      this.weather = null;
      // The ship: where it is (x, from right to left), and a wait before the next.
      this.ship = { x: 40 + Math.random() * 60, wait: 0, on: Math.random() < 0.7 };
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
      const weather = WEATHER[set('lhWeather')] || WEATHER.cloudy;
      // Gliding from one weather to the next.
      if (!this.weather) this.weather = { ...weather };
      for (const k of Object.keys(weather)) this.weather[k] += (weather[k] - this.weather[k]) * Math.min(1, dt * 0.7);
      const w = this.weather;
      const playing = a.playing ? 1 : 0;
      this.wave += dt * 0.55 * (a.playing ? a.pace : 0.6);
      const swell = w.swell * (0.55 + 0.35 * a.intensity * playing + 0.6 * a.bass * playing);
      this.swell += (swell - this.swell) * Math.min(1, dt * 1.5);
      // Two beams: once round every four bars with a clear beat (each sweeping
      // past every other bar), about every 9 seconds without.
      const perTurn = a.playing && a.lock > 0.5 && a.bpm ? (16 * 60) / a.bpm : 9;
      this.ang += (dt * Math.PI * 2) / perTurn * (a.playing ? 1 : 0.5);
      const lamp = 0.75 + 0.5 * a.throb * playing;
      this.lamp += (lamp - this.lamp) * Math.min(1, dt * 10);
      if (a.playing && a.hit && a.hitPower > 0.45) this.splash = Math.max(this.splash, 0.4 + 0.6 * a.hitPower);
      this.splash *= Math.exp(-dt * 1.6);
      // The ship crossing slowly, rocking.
      const s = this.ship;
      if (s.on) {
        s.x -= dt * 1.1;
        if (s.x < -110) {
          s.on = false;
          s.wait = 20 + Math.random() * 40;
        }
      } else if ((s.wait -= dt) <= 0) {
        s.on = true;
        s.x = 110;
      }
      const showShip = set('lhShip') && s.on ? 1 : 0;

      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform2f(u.starShift, ...this.starShift);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.wave, this.wave);
      gl.uniform1f(u.swell, this.swell);
      gl.uniform1f(u.beamAng, this.ang);
      gl.uniform1f(u.lamp, this.lamp);
      gl.uniform1f(u.splash, this.splash);
      gl.uniform1f(u.rain, w.rain);
      gl.uniform1f(u.clouds, w.clouds);
      gl.uniform1f(u.haze, w.haze);
      gl.uniform1f(u.boom, a.kick * playing);
      gl.uniform3f(u.ship, s.x, Math.sin(this.age * 0.9) * (0.3 + 0.4 * this.swell), showShip);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'lighthouse',
    name: 'Lighthouse',
    desc: 'A lighthouse on its rocks over a night sea, its beams sweeping round with the tempo, the swell rising with the bass, the sea breaking white on the hits',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M10 21l1-12h2l1 12z"/><path d="M10 9h4M11 9V6h2v3M12 6V4"/><path d="M14 7l7-2M14 8l7 2M3 21h18"/></svg>',
    gl: true,
    create: (canvas) => new Lighthouse(canvas),
    options: [
      { type: 'choice', key: 'lhWeather', label: 'Weather', choices: [['clear', 'Clear'], ['cloudy', 'Cloudy'], ['storm', 'Storm']] },
      { type: 'check', key: 'lhShip', label: 'A ship passing' },
    ],
  });
})();
