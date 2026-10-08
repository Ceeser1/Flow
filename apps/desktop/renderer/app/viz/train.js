'use strict';

// Night Train: looking out of a train's window at night. The land rushes by
// in layers, each the slower the further: clouds (the higher the faster),
// mountains under the moon, hills with villages' lights and small trees on
// their tops, fields with a farmhouse now and then and bigger trees (alone,
// a few together, now and then a wood), trees close by, and the telegraph
// poles, so fast they blur, timed to pass one on each beat (the wires
// between them dipping and rising). The moon, its seas and craters on it,
// shows a new phase each time it opens. The train's speed follows the
// tempo; it rocks a little, and jolts on the beat. Now and then
// a level crossing goes by, its red lights flashing in turn with the beat,
// or a station, its lamps lighting up the compartment. On the table by the
// window a cup of tea ripples with every beat.
//
// Its cogwheel: the weather (clear, rain on the glass, snow), the cup.
//
// WebGL (viz/gl.js): one pass. The land is drawn in window space, each
// layer's x shifted by how far the train has gone times its own share; the
// near ones are smeared along the way they move (a few taps), as a camera
// would see them; the compartment, the window's frame and the cup round it.

(() => {
  const POLES = 1.6;          // between two poles, in screen heights
  const WEATHER = { clear: 0, rain: 1, snow: 2 };

  const FS = VizGL.NOISE + VizGL.STARS + `
    in vec2 uv;
    uniform vec2 res;
    uniform float time, dist, speed, bob, beat, ripple, rain, snow, cup, beats;
    uniform vec2 moon;          // its phase: the line between day and night (-1 full, 1 new), the lit side
    out vec4 o;

    const float HOR = 0.46;     // the horizon, in window space
    const float WY = 0.72;      // the window's height, in screen heights

    float ridge(float x, float seed, float scale) {
      return vnoise(vec2(x * scale, seed)) * 0.6 + vnoise(vec2(x * scale * 2.3, seed + 7.0)) * 0.28 + vnoise(vec2(x * scale * 6.1, seed + 3.0)) * 0.12;
    }

    // A station's share where x (the stations' layer) is, 0 or 1 along its platform.
    float stationAt(float x) {
      float cell = floor(x / 30.0);
      if (hash12(vec2(cell, 91.0)) > 0.35) return 0.0;
      float u = x - (cell + 0.5) * 30.0;
      return 1.0 - smoothstep(3.6, 4.2, abs(u));
    }

    // The trees close by: their top above the embankment at x, 0 where there is none.
    float treeTop(float x) {
      float cell = floor(x / 0.22);
      float h = hash12(vec2(cell, 5.0));
      float u = (x - (cell + 0.5) * 0.22) / 0.11;
      float height = 0.07 + 0.2 * hash12(vec2(cell, 9.0));
      if (h < 0.3) return 0.0;
      if (h < 0.65) return height * max(0.0, 1.0 - abs(u) * (0.9 + 0.3 * hash12(vec2(cell, 2.0))));
      return height * sqrt(max(0.0, 1.0 - u * u)) * 0.85;
    }

    // A layer's ground at x: g = its base, its hills' height, their seed and scale.
    float groundAt(float x, vec4 g) {
      return g.x + g.y * ridge(x, g.z, g.w);
    }

    // One tree's cover at q (from its foot, in screen heights), h its height:
    // a spruce in tiers, a round leafy one or a slim poplar, by kind.
    float tree(vec2 q, float h, float kind, float seed, float px) {
      if (q.y < -0.01 || q.y > h * 1.05 || abs(q.x) > h * 0.45) return 0.0;
      float t = q.y / h;
      if (kind < 0.5) {
        float tiers = 4.0 + floor(seed * 3.0);
        float tt = (t - 0.1) / 0.9;
        float hw = h * 0.3 * (1.0 - tt) * (0.62 + 0.38 * (1.0 - fract(tt * tiers)));
        hw *= 0.85 + 0.3 * vnoise(vec2(q.y / h * 40.0, seed * 50.0));
        float body = smoothstep(px, -px, abs(q.x) - hw) * step(0.1, t);
        float trunk = smoothstep(px, -px, abs(q.x) - max(h * 0.025, px * 0.7)) * step(t, 0.15);
        return max(body, trunk);
      }
      float slim = kind < 0.85 ? 1.0 : 0.45;
      vec2 r = vec2(h * 0.3 * slim, h * (kind < 0.85 ? 0.32 : 0.42));
      vec2 c = vec2(0.0, h - r.y);
      vec2 d = (q - c) / r;
      float lump = (vnoise(d * 2.5 + seed * 40.0) - 0.5) * 0.45 + (vnoise(d * 6.0 + seed * 70.0) - 0.5) * 0.2;
      float crown = smoothstep(1.0 + px / r.x, 1.0 - px / r.x, length(d) + lump);
      float trunk = smoothstep(px, -px, abs(q.x) - max(h * 0.035, px * 0.7)) * step(q.y, c.y);
      return max(crown, trunk);
    }

    // The trees on a layer: alone, a few together, now and then a wood
    // (a second row behind, taller, a little paler with the distance).
    // x along the layer, y up (window space), g its ground, slot the trees'
    // spacing and size their height (screen heights). Gives the front and
    // the back row's cover.
    vec2 treeRow(float x, float y, vec4 g, float slot, float size, float seed) {
      float px = 1.0 / res.y;
      vec2 cover = vec2(0.0);
      float i0 = floor(x / slot);
      for (int k = -2; k <= 2; k++) {
        float i = i0 + float(k);
        float gc = floor(i / 12.0);
        float j = i - gc * 12.0;
        float r = hash12(vec2(gc, seed));
        float m = hash12(vec2(gc, seed + 1.0));
        float n = r < 0.42 ? 0.0 : r < 0.76 ? 1.0 : r < 0.93 ? 2.0 + floor(m * 3.0) : 7.0 + floor(m * 5.0);
        float s0 = floor(hash12(vec2(gc, seed + 2.0)) * (13.0 - n));
        if (j < s0 || j >= s0 + n) continue;
        bool wood = n > 6.0;
        if (!wood && n > 1.0 && hash12(vec2(i, seed + 3.0)) < 0.15) continue;
        for (int row = 0; row < 2; row++) {
          if (row == 1 && !wood) break;
          float o = float(row) * 0.5;
          float hs = hash12(vec2(i + o, seed + 4.0));
          float cx = (i + 0.5 + o + (hash12(vec2(i + o, seed + 5.0)) - 0.5) * 0.5) * slot;
          float h = size * (0.6 + 0.5 * hs) * (row == 1 ? 1.2 : 1.0);
          float base = groundAt(cx, g) - 0.006;
          float kind = hash12(vec2(i + o, seed + 6.0)) * (wood ? 0.7 : 1.0);
          float c = tree(vec2(x - cx, (y - base) * WY), h, kind, hs, px);
          if (row == 0) cover.x = max(cover.x, c); else cover.y = max(cover.y, c);
        }
      }
      return cover;
    }

    // The land through the window at w (window space: x along, y up from its bottom 0 to its top 1).
    vec3 land(vec2 w) {
      vec3 col;
      float snowy = snow;
      // The sky: dark blue, the stars, the moon.
      float up = w.y - HOR;
      col = mix(vec3(0.07, 0.08, 0.13), vec3(0.012, 0.016, 0.045), smoothstep(0.0, 0.5, up)) * (1.0 - 0.45 * rain);
      col += starField(w * res.y * vec2(1.0, 1.0) + vec2(dist * 2.0, 0.0), time, 0.0) * smoothstep(0.0, 0.15, up) * (1.0 - 0.8 * rain);
      // The moon (round in screen heights, not window space): solid, its
      // dark part almost black against the sky, grey seas on it; how much of
      // it is lit is new each time it opens, its glow as bright as that.
      vec2 mq = (w - vec2(-0.32, 0.8)) * vec2(1.0, WY);
      float md = length(mq);
      float shine = 0.25 + 0.75 * (1.0 - moon.x) * 0.5;
      col += vec3(0.4, 0.5, 0.7) * exp(-md * 9.0) * 0.12 * shine * (1.0 - 0.6 * rain);
      {
        const float R = 0.042;
        float px = 1.5 / res.y;
        float disc = smoothstep(R, R - px, md);
        if (disc > 0.0) {
          vec2 mp = mq / R;
          // The line between day and night an ellipse.
          float term = moon.x * sqrt(max(0.0, 1.0 - mp.y * mp.y));
          float lit = smoothstep(term - 0.08, term + 0.08, mp.x * moon.y);
          float seas = smoothstep(0.42, 0.62, fbm(mp * 1.5 + vec2(3.1, 7.4)));
          float pits = 0.0;
          for (int i = 0; i < 2; i++) {
            vec2 cp = mp * (i == 0 ? 3.0 : 5.0) + float(i) * 11.0;
            vec2 cg = floor(cp);
            vec2 cf = fract(cp) - 0.5 - (vec2(hash12(cg), hash12(cg + 5.0)) - 0.5) * 0.4;
            float cr = 0.12 + 0.12 * hash12(cg + 9.0);
            pits += smoothstep(cr, cr * 0.6, length(cf)) * step(0.6, hash12(cg + 2.0)) * (0.7 - 0.3 * float(i));
          }
          float limb = sqrt(max(0.0, 1.0 - dot(mp, mp)));
          vec3 face = vec3(1.0, 0.96, 0.86) * (1.0 - 0.38 * seas) * (1.0 - 0.18 * pits) * (0.72 + 0.28 * limb);
          face *= 0.9 + 0.1 * vnoise(mp * 14.0);
          vec3 night = vec3(0.006, 0.007, 0.011) * (1.0 - 0.3 * seas);
          col = mix(col, mix(night, face * (1.0 - 0.6 * rain), lit), disc);
        }
      }
      // A few clouds sliding by, the higher ones (nearer) the faster and
      // bigger: a row of puffs on a flat bottom, frayed at the edges.
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float cw = 0.8 + fi * 0.35;
        float cxw = w.x + dist * (0.005 + fi * 0.01) + time * (0.004 + fi * 0.004) + fi * 37.0;
        float c = floor(cxw / cw);
        float cover = 0.35 + 0.45 * max(rain, snow * 0.45);
        if (hash12(vec2(c, 41.0 + fi)) > cover) continue;
        float rw = cw * (0.2 + 0.14 * hash12(vec2(c, 43.0 + fi)));
        float pr = rw * (0.3 + 0.1 * hash12(vec2(c, 47.0 + fi)));
        float yb = (0.62 + fi * 0.12 + 0.05 * (hash12(vec2(c, 49.0 + fi)) - 0.5)) * WY;
        vec2 p = vec2(cxw - (c + 0.5 + 0.2 * (hash12(vec2(c, 45.0 + fi)) - 0.5)) * cw, w.y * WY - yb);
        if (abs(p.x) > rw * 1.6 || p.y < -pr || p.y > pr * 2.5) continue;
        float d = 1e3;
        for (int k = 0; k < 5; k++) {
          float fk = float(k) / 4.0 * 2.0 - 1.0;
          float h = hash12(vec2(c * 7.0 + float(k), 51.0 + fi));
          float r = pr * (0.55 + 0.6 * h) * (1.0 - 0.45 * fk * fk);
          vec2 pc = vec2(rw * fk + (h - 0.5) * pr * 0.6, r * 0.45);
          d = min(d, length(p - pc) - r);
        }
        d = max(d, -p.y - pr * 0.08);
        float n = fbm(vec2(cxw, w.y * WY) * (11.0 - fi * 3.0) + vec2(c * 3.7, fi * 19.0));
        d += (n - 0.5) * pr * 0.9;
        float dens = smoothstep(pr * 0.04, -pr * 0.18, d);
        if (dens > 0.0) {
          // Moonlit from above, darker underneath, a silver edge where it is thin near the moon.
          float lift = clamp(p.y / (pr * 1.6), 0.0, 1.0);
          vec3 cl = mix(vec3(0.03, 0.033, 0.05), vec3(0.1, 0.105, 0.135), lift) * (0.75 + 0.5 * n) * (1.0 - 0.4 * rain);
          cl += vec3(0.55, 0.55, 0.6) * exp(-md * 6.0) * (1.0 - dens * 0.7) * 0.5 * shine;
          col = mix(col, cl, dens * 0.94);
        }
      }
      // The mountains, far off, their tops in the moonlight.
      float mx = w.x + dist * 0.012;
      float mh = HOR + 0.03 + 0.17 * ridge(mx, 1.0, 1.4);
      if (w.y < mh) {
        col = mix(vec3(0.035, 0.042, 0.07), vec3(0.11, 0.12, 0.16), smoothstep(mh - 0.05, mh, w.y) * (0.3 + 0.7 * snowy));
      }
      // The hills, the villages' lights on them.
      float hx = w.x + dist * 0.05;
      float hh = HOR + 0.01 + 0.07 * ridge(hx, 4.0, 2.2);
      if (w.y < hh) {
        col = mix(vec3(0.018, 0.024, 0.036), vec3(0.08, 0.085, 0.11), snowy * smoothstep(hh - 0.08, hh, w.y));
        float vc = floor(hx / 0.9);
        if (hash12(vec2(vc, 13.0)) < 0.55) {
          float vx = (vc + 0.25 + 0.5 * hash12(vec2(vc, 17.0))) * 0.9;
          vec2 g = floor(vec2(hx, w.y) / 0.012);
          float near = 1.0 - smoothstep(0.08, 0.16, abs(hx - vx));
          float l = step(0.86, hash12(g + vc)) * near * smoothstep(hh - 0.005, hh - 0.04, w.y) * smoothstep(HOR - 0.03, HOR, w.y);
          vec2 f = fract(vec2(hx, w.y) / 0.012) - 0.5;
          col += vec3(1.0, 0.75, 0.4) * l * smoothstep(0.35, 0.1, length(f)) * (0.6 + 0.4 * hash12(g + 3.0));
        }
      }
      // Small trees along the hills' tops, behind the villages.
      if (w.y > HOR - 0.01 && w.y < HOR + 0.14) {
        vec2 tc = treeRow(hx, w.y, vec4(HOR + 0.01, 0.07, 4.0, 2.2), 0.013, 0.03, 71.0);
        vec3 tcol = vec3(0.014, 0.019, 0.028) + vec3(0.05, 0.055, 0.07) * snowy * 0.6 * vnoise(vec2(hx, w.y) * 400.0);
        col = mix(col, tcol * 1.5 + vec3(0.006, 0.008, 0.014), tc.y);
        col = mix(col, tcol, tc.x);
      }
      // The fields: farmhouses with lit windows, trees alone, together, in woods.
      float fx = w.x + dist * 0.18;
      float fh = HOR - 0.02 + 0.012 * ridge(fx, 8.0, 3.0);
      if (w.y < fh) {
        col = mix(vec3(0.016, 0.021, 0.024), vec3(0.1, 0.105, 0.13), snowy * 0.8);
        // Furrows running away, in the moonlight.
        col *= 0.75 + 0.25 * sin((fx * 3.0 - (fh - w.y) * 2.0) * 120.0 / (1.0 + (fh - w.y) * 30.0)) * smoothstep(0.0, 0.1, fh - w.y) * (1.0 - snowy);
        col *= 0.6 + 0.4 * smoothstep(0.0, fh, w.y);
      }
      // The bigger trees out on the fields, in front of the hills.
      if (w.y > HOR - 0.05 && w.y < HOR + 0.22) {
        vec2 tc = treeRow(fx, w.y, vec4(HOR - 0.02, 0.012, 8.0, 3.0), 0.04, 0.095, 23.0);
        vec3 tcol = vec3(0.006, 0.008, 0.009) + vec3(0.06, 0.065, 0.08) * snowy * 0.7 * vnoise(vec2(fx, w.y) * 250.0);
        col = mix(col, tcol * 1.6 + vec3(0.008, 0.01, 0.016), tc.y);
        col = mix(col, tcol, tc.x);
      }
      {
        float c = floor(fx / 0.7);
        float k = hash12(vec2(c, 21.0));
        float u = fx - (c + 0.5) * 0.7;
        if (k < 0.35) {
          // A farmhouse: walls, a roof, two windows.
          vec2 q = vec2(u, w.y - fh);
          float wall = step(abs(q.x), 0.06) * step(0.0, q.y + 0.01) * step(q.y, 0.045);
          float roof = step(0.045, q.y) * step(q.y, 0.045 + 0.04 * (1.0 - abs(q.x) / 0.07)) * step(abs(q.x), 0.07);
          if (wall + roof > 0.0) col = vec3(0.01, 0.011, 0.014) + vec3(0.05, 0.055, 0.07) * roof * snowy;
          float win = wall * step(abs(abs(q.x) - 0.028), 0.011) * step(abs(q.y - 0.022), 0.009) * step(0.4, hash12(vec2(c, sign(q.x) + 30.0)));
          col = mix(col, vec3(1.0, 0.72, 0.35) * 0.9, win);
          col += vec3(1.0, 0.7, 0.35) * 0.04 * exp(-length(q - vec2(0.0, 0.02)) * 30.0) * step(0.2, k);
        }
      }
      // The level crossings: red lights flashing in turn on the beat, the barrier down.
      float cx = w.x + dist * 0.7;
      {
        float c = floor(cx / 9.0);
        if (hash12(vec2(c, 61.0)) < 0.4) {
          float u = cx - (c + 0.5) * 9.0;
          vec2 q = vec2(u, w.y - 0.22);
          float post = step(abs(abs(q.x) - 0.12), 0.006) * step(0.0, q.y) * step(q.y, 0.2);
          float arm = step(abs(q.y - 0.09), 0.006) * step(abs(q.x), 0.4) * step(0.13, abs(q.x));
          float stripe = step(0.5, fract(q.x * 12.0));
          if (post > 0.0) col = vec3(0.02);
          if (arm > 0.0) col = mix(vec3(0.5, 0.05, 0.04), vec3(0.6), stripe) * 0.25;
          float side = mod(beats, 2.0) < 1.0 ? 1.0 : -1.0;
          vec2 lq = q - vec2(0.12 * side, 0.2);
          vec2 lo = q - vec2(-0.12 * side, 0.2);
          col += vec3(1.0, 0.08, 0.04) * (exp(-dot(lq, lq) * 4000.0) * 3.0 + exp(-length(lq) * 18.0) * 0.5) * (0.6 + 0.4 * beat);
          col += vec3(0.3, 0.02, 0.01) * exp(-dot(lo, lo) * 4000.0);
          // The road crossing, lit red.
          col += vec3(0.25, 0.02, 0.01) * exp(-length(q - vec2(0.0, 0.0)) * 6.0) * step(q.y, 0.0) * (0.6 + 0.4 * beat);
        }
      }
      // A station: the platform, its lamps, the building behind.
      {
        float c = floor(cx / 30.0);
        if (hash12(vec2(c, 91.0)) < 0.35) {
          float u = cx - (c + 0.5) * 30.0;
          if (abs(u) < 4.2) {
            // The building, its lit windows.
            if (abs(u) < 2.4 && w.y < 0.5 && w.y > 0.2) {
              col = vec3(0.025, 0.022, 0.02);
              vec2 g = vec2(fract(u / 0.3), fract((w.y - 0.25) / 0.1));
              float win = step(abs(g.x - 0.5), 0.2) * step(abs(g.y - 0.5), 0.25) * step(w.y, 0.45);
              col = mix(col, vec3(1.0, 0.8, 0.5) * 0.7, win * step(0.3, hash12(floor(vec2(u / 0.3, w.y / 0.1)) + c)));
            }
            // The roof's edge.
            if (abs(u) < 2.6 && abs(w.y - 0.5) < 0.012) col = vec3(0.04, 0.035, 0.03);
            // The platform.
            if (w.y < 0.2) col = vec3(0.12, 0.11, 0.1) * (0.5 + 0.5 * smoothstep(0.0, 0.2, w.y)) + vec3(0.25, 0.2, 0.1) * step(abs(w.y - 0.19), 0.006);
            // Lamps along it, and their pools of light.
            float lu = u - (floor(u / 0.8) + 0.5) * 0.8;
            vec2 lq = vec2(lu, w.y - 0.62);
            if (abs(lu) < 0.008 && w.y < 0.62 && w.y > 0.18) col = vec3(0.03);
            col += vec3(1.0, 0.85, 0.55) * (exp(-dot(lq, lq) * 3000.0) * 3.0 + exp(-length(lq) * 9.0) * 0.35);
            col += vec3(1.0, 0.8, 0.5) * 0.12 * exp(-abs(lu) * 6.0) * step(w.y, 0.2);
          }
        }
      }
      // The trees close by, smeared by the speed.
      {
        float ground = 0.1;
        float tx = w.x + dist * 0.55;
        float smear = speed * 0.55 / 60.0;
        float cover = 0.0;
        float jit = hash12(gl_FragCoord.xy + fract(time) * 50.0);
        for (int i = 0; i < 6; i++) {
          float x = tx + smear * ((float(i) + jit) / 6.0 - 0.5);
          float top = ground + treeTop(x);
          cover += step(w.y, top) / 6.0;
        }
        // None in front of a station's platform.
        cover *= 1.0 - stationAt(cx);
        cover = max(cover, step(w.y, ground + 0.015 * vnoise(vec2(tx * 20.0, 1.0))));
        col = mix(col, vec3(0.004, 0.006, 0.006) + vec3(0.04, 0.045, 0.06) * snowy * smoothstep(0.1, 0.3, w.y), cover);
      }
      // The poles and their wires, fastest of all.
      {
        float px = w.x + dist;
        float smear = speed / 60.0;
        float f = fract(px / ${POLES.toFixed(1)});
        float u = (f - 0.5) * ${POLES.toFixed(1)};
        // The nearest pole's distance, smeared: as wide as it travels in a frame.
        float d = abs(abs(u) - ${(POLES / 2).toFixed(1)});
        float width = 0.012 + smear;
        float pole = smoothstep(width, width - 0.003, d) * min(1.0, 0.03 / width);
        pole *= step(w.y, 0.93);
        float armY = 0.88;
        float arm = step(abs(w.y - armY), 0.006) * smoothstep(0.09 + smear, 0.08, d) * min(1.0, 0.1 / (0.1 + smear));
        col = mix(col, vec3(0.006, 0.006, 0.007), max(pole, arm));
        // The wires: hanging lowest half way between the poles.
        for (int i = 0; i < 3; i++) {
          float hy = armY + 0.004 - float(i) * 0.025 + (i == 2 ? 0.0 : 0.0);
          float sag = 0.06 + float(i) * 0.01;
          float wy = hy - sag * 4.0 * f * (1.0 - f) - 0.0;
          float wd = abs(w.y - wy);
          col = mix(col, vec3(0.008), smoothstep(0.0025, 0.0005, wd) * 0.8);
          // Catching a little moonlight.
          col += vec3(0.08, 0.09, 0.12) * smoothstep(0.0015, 0.0, wd) * 0.3;
        }
      }
      // Now and then a big tree (or two) right by the line, taller than the
      // window, as fast as the poles and smeared as they are.
      {
        float lx = w.x + dist;
        float c0 = floor(lx / 5.0);
        float r = hash12(vec2(c0, 131.0));
        if (r < 0.3) {
          float smear = speed / 60.0;
          float jit = hash12(gl_FragCoord.xy + fract(time) * 50.0 + 7.0);
          float pxs = 1.0 / res.y;
          float cover = 0.0;
          for (int t = 0; t < 2; t++) {
            if (t == 1 && r < 0.22) break;
            float ft = float(t);
            float hs = hash12(vec2(c0 + ft * 0.37, 133.0));
            float tx = (c0 + 0.3 + 0.3 * hash12(vec2(c0, 137.0))) * 5.0 + ft * (0.5 + 0.3 * hs);
            float h = 1.0 + 0.4 * hs;
            float kind = hash12(vec2(c0 + ft, 139.0));
            for (int i = 0; i < 6; i++) {
              float x = lx + smear * ((float(i) + jit) / 6.0 - 0.5);
              cover += tree(vec2(x - tx, (w.y + 0.15) * WY), h, kind, hs, pxs) / 6.0;
            }
          }
          // None in front of a station's platform.
          cover = min(cover, 1.0) * (1.0 - stationAt(cx));
          col = mix(col, vec3(0.004, 0.005, 0.006) + vec3(0.04, 0.045, 0.06) * snowy * vnoise(vec2(lx, w.y) * 60.0), cover);
        }
      }
      // Snow flakes streaming past.
      if (snow > 0.0) {
        for (int i = 0; i < 2; i++) {
          float sc = i == 0 ? 50.0 : 90.0;
          vec2 sp = vec2(w.x + dist * (i == 0 ? 0.8 : 0.4), w.y + time * (i == 0 ? 0.25 : 0.15)) * sc;
          vec2 g = floor(sp);
          vec2 fq = fract(sp) - vec2(hash12(g), hash12(g + 3.0));
          float stretch = 1.0 + speed * (i == 0 ? 0.8 : 0.4) * 0.4;
          float fl = exp(-(fq.x * fq.x / (stretch * stretch) + fq.y * fq.y) * 300.0) * step(0.7, hash12(g + 9.0));
          col += vec3(0.6, 0.65, 0.75) * fl * snow * (i == 0 ? 0.7 : 0.4);
        }
      }
      return col;
    }

    void main() {
      float aspect = res.x / res.y;
      vec2 s = vec2((uv.x - 0.5) * aspect, uv.y);
      // The window: a rounded opening in the compartment's wall.
      float hw = min(0.74, aspect * 0.5 - 0.1);
      vec2 wc = vec2(0.0, 0.54);
      vec2 wh = vec2(hw, 0.36);
      vec2 dq = abs(s - wc) - (wh - 0.07);
      float wd = length(max(dq, 0.0)) + min(max(dq.x, dq.y), 0.0) - 0.07;
      // Window space: x in screen heights from the middle, y 0 at its bottom, 1 at its top; the train rocking.
      vec2 w = vec2(s.x, (s.y - (wc.y - wh.y)) / (2.0 * wh.y));
      w.y += bob;
      float station = max(stationAt(dist * 0.7 - 0.6), stationAt(dist * 0.7 + 0.6));

      vec3 col;
      if (wd < 0.0) {
        col = land(w);
        // The glass: the compartment faintly mirrored in it.
        col += vec3(0.05, 0.035, 0.02) * smoothstep(0.6, 0.0, length(s - vec2(0.3, 0.95))) * 0.5;
        col += vec3(0.02, 0.018, 0.015) * smoothstep(0.02, 0.0, abs(s.x - s.y * 0.6 + 0.2)) * 0.6;
        // Rain on it: drops slid back by the wind of the speed, and their trails.
        if (rain > 0.0) {
          vec2 rp = vec2(s.x * 11.0 + time * (0.6 + speed * 0.25), s.y * 8.0 + time * 0.4);
          vec2 g = floor(rp);
          vec2 f = fract(rp) - 0.5;
          vec2 c = vec2(hash12(g + 1.0), hash12(g + 2.0)) - 0.5;
          float r = 0.08 + 0.12 * hash12(g + 4.0);
          float drop = smoothstep(r, r * 0.6, length((f - c * 0.6) * vec2(1.0, 1.3))) * step(0.45, hash12(g + 7.0));
          float trail = smoothstep(0.03, 0.0, abs(f.y - c.y * 0.6)) * step(f.x, c.x * 0.6) * step(0.45, hash12(g + 7.0)) * 0.4;
          // Each drop a little lens: the land in it upside down, a glint, a dark rim.
          vec2 dq = (f - c * 0.6) * vec2(1.0, 1.3) / r;
          float rim = smoothstep(0.6, 1.0, length(dq)) * drop;
          float glint = exp(-dot(dq - vec2(-0.3, 0.35), dq - vec2(-0.3, 0.35)) * 25.0) * drop;
          col = mix(col, land(w - dq * 0.05) * 1.4 + vec3(0.03, 0.035, 0.045), drop * rain * 0.85) * (1.0 - 0.5 * rim * rain);
          col += (vec3(0.04, 0.045, 0.06) * trail + vec3(0.8, 0.85, 0.9) * glint) * rain;
        }
        // The edge of the glass a little darker.
        col *= 0.75 + 0.25 * smoothstep(0.0, 0.04, -wd);
      } else {
        // The compartment: panelled wood, a lamp's warm light from above,
        // brighter as a station goes by.
        vec3 wood = vec3(0.18, 0.1, 0.05) * (0.8 + 0.2 * vnoise(vec2(s.x * 3.0, s.y * 60.0)));
        float light = 0.12 + 0.18 * smoothstep(0.0, 1.0, s.y) + 0.35 * station;
        col = wood * light;
        // The frame round the glass, its rim catching the light.
        if (wd < 0.035) {
          col = vec3(0.06, 0.055, 0.05) * (0.6 + 0.6 * smoothstep(0.035, 0.0, wd)) * (1.0 + station);
          col += vec3(0.18, 0.15, 0.1) * smoothstep(0.004, 0.0, abs(wd - 0.03)) * (0.5 + station);
        }
        // The table under the window.
        float tableTop = wc.y - wh.y - 0.06;
        if (s.y < tableTop) {
          col = vec3(0.12, 0.07, 0.04) * (0.35 + 0.25 * smoothstep(tableTop - 0.15, tableTop, s.y) + 0.4 * station);
          col += vec3(0.25, 0.18, 0.1) * smoothstep(0.004, 0.0, abs(s.y - tableTop + 0.004)) * (0.4 + station);
        }
      }
      // Curtains each side, tied back half way, hung on rings from a dull
      // silver rod across the top (as dim as the rest): a ring on each fold that faces out, the cloth
      // sagging a little between them.
      {
        const float TOP = 0.955;     // the cloth's top at a ring
        const float ROD = 0.961;     // the rod's middle
        const float RR = 0.004;      // its radius
        const float RING = 0.0075;    // a ring's radius (to the middle of its wire)
        const float WIRE = 0.002;    // half its wire's thickness
        float px = 1.0 / res.y;
        float side = abs(s.x) - (hw + 0.05);
        float y = s.y - 0.5;
        float width = 0.075 - 0.04 * exp(-y * y / 0.004);
        float u = (side + width) / width;
        float sag = 0.006 * (0.5 - 0.5 * cos(u * 18.0 + 1.9));
        if (side > -width && s.y > 0.12 && s.y < TOP - sag) {
          float folds = 0.6 + 0.4 * cos(u * 18.0 + s.y * 2.0);
          vec3 cloth = vec3(0.24, 0.045, 0.05) * (0.75 + 0.25 * folds) * (0.2 + 0.18 * s.y + 0.4 * station);
          // The tie.
          cloth = mix(cloth, vec3(0.5, 0.4, 0.15) * (0.3 + 0.4 * station), step(abs(y), 0.012));
          col = mix(col, cloth, smoothstep(-width, -width + 0.004, side) * smoothstep(0.0, px, TOP - sag - s.y));
        }
        // The rod, the whole way across: round, a bright line along its top.
        float rd = (s.y - ROD) / RR;
        if (abs(rd) < 1.3) {
          float lit = 0.3 + 0.5 * station;
          vec3 steel = vec3(0.17, 0.175, 0.19) * (0.35 + 0.65 * sqrt(max(0.0, 1.0 - rd * rd))) * lit;
          steel += vec3(0.3, 0.3, 0.32) * exp(-(rd - 0.45) * (rd - 0.45) * 30.0) * lit * 0.5;
          col = mix(col, steel, smoothstep(RR + px, RR - px, abs(s.y - ROD)));
        }
        // The rings, round the rod, their bottoms through the cloth's top.
        float k = floor((u * 18.0 + 1.9) / 6.2832 + 0.5);
        float uk = (6.2832 * k - 1.9) / 18.0;
        if (k >= 1.0) {
          // Where the ring hangs: its inner edge resting on the rod's top.
          vec2 rq = vec2((u - uk) * 0.075, s.y - (ROD + RR + WIRE - RING));
          // An oval, 30 % narrower than tall; its distance scaled back by the
          // stretch so the wire stays as thick all round.
          const float SX = 1.0 / 0.7;
          vec2 eq = rq * vec2(SX, 1.0);
          float e = length(eq);
          float rdist = abs(e - RING) * e / max(length(vec2(eq.x * SX, eq.y)), 1e-5);
          float ring = smoothstep(WIRE + px, WIRE - px, rdist);
          // Its right side passes behind the rod.
          ring *= 1.0 - smoothstep(RR + px, RR - px, abs(s.y - ROD)) * smoothstep(-px, px, rq.x);
          if (ring > 0.0) {
            float lit = 0.3 + 0.5 * station;
            float a = atan(rq.y, rq.x);
            vec3 metal = vec3(0.16, 0.165, 0.18) * (0.45 + 0.55 * (0.5 + 0.5 * sin(a))) * lit;
            metal += vec3(0.28, 0.28, 0.3) * smoothstep(WIRE, 0.0, rdist) * 0.25 * lit;
            col = mix(col, metal, ring);
          }
        }
      }
      // The cup of tea on the table, its tea rippling with every beat.
      if (cup > 0.0) {
        float tableTop = wc.y - wh.y - 0.06;
        vec2 cq = s - vec2(min(0.5, hw - 0.12), tableTop - 0.035);
        // The saucer.
        float saucer = length(cq * vec2(1.0, 4.0)) - 0.09;
        // The cup: wider at the top.
        float t = clamp(cq.y / 0.11, 0.0, 1.0);
        float body = max(abs(cq.x) - mix(0.045, 0.06, t), max(-cq.y, cq.y - 0.11));
        float handle = abs(length((cq - vec2(0.068, 0.06)) * vec2(1.0, 0.8)) - 0.026) - 0.006;
        float lit = 0.35 + 0.4 * station;
        if (saucer < 0.0) col = vec3(0.75, 0.72, 0.68) * lit * (0.6 + 0.4 * smoothstep(-0.03, 0.0, cq.y));
        if (handle < 0.0 && cq.x > 0.06) col = vec3(0.7, 0.67, 0.63) * lit * 0.8;
        if (body < 0.0) col = vec3(0.8, 0.77, 0.72) * lit * (0.55 + 0.45 * cos(cq.x / 0.06 * 1.3));
        // The tea's surface, seen from a little above: rings spreading on the beat.
        vec2 tq = (cq - vec2(0.0, 0.11)) / vec2(0.058, 0.014);
        float tr = length(tq);
        if (tr < 1.0) {
          float ring = sin(tr * 18.0 - ripple * 30.0) * exp(-ripple * 3.0) * smoothstep(1.0, 0.2, abs(tr - ripple * 1.5));
          col = vec3(0.22, 0.1, 0.03) * lit * (1.0 + 0.6 * ring) + vec3(0.3, 0.25, 0.2) * max(ring, 0.0) * 0.3 * lit;
        }
        // Steam.
        vec2 sq = cq - vec2(0.0, 0.13);
        if (sq.y > 0.0 && sq.y < 0.2) {
          float n = fbm(vec2(sq.x * 20.0 + sin(sq.y * 15.0 - time) * 0.6, sq.y * 6.0 - time * 0.8));
          col += vec3(0.08, 0.075, 0.07) * smoothstep(0.55, 0.85, n) * smoothstep(0.05, 0.0, abs(sq.x)) * smoothstep(0.2, 0.0, sq.y) * cup;
        }
      }
      // The red of a crossing and the station's light reach in a little.
      col = 1.0 - exp(-col * 1.6);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class NightTrain {
    constructor(canvas) {
      this.starShift = VizGL.starShift();
      // A new moon each time: from a thin crescent to nearly full, waxing or waning.
      this.moon = [-0.85 + Math.random() * 1.55, Math.random() < 0.5 ? 1 : -1];
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.age = 0;
      this.dist = Math.random() * 1000;
      this.speed = 0;
      this.bob = 0;
      this.jolt = 0;
      this.ripple = 5;
      this.rain = 0;
      this.snow = 0;
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
      // A pole on each beat while the beat is clear; otherwise by the music's push.
      const speed = a.playing
        ? (a.lock > 0.5 && a.bpm ? (POLES * a.bpm) / 60 : POLES * 2 * (0.8 + 0.4 * a.intensity)) * (a.lock > 0.5 ? 1 : a.motion(0.15, 0.4))
        : 0.3;
      this.speed += (speed - this.speed) * Math.min(1, dt * 1.2);
      this.dist += this.speed * dt;
      // Rocking, and a jolt on the beat (the rails' joints).
      if (a.playing && (a.lock > 0.5 ? a.tick : a.onset)) {
        this.jolt = 1;
        this.ripple = 0;
      }
      this.jolt *= Math.exp(-dt * 9);
      this.ripple += dt;
      const bob = 0.004 * Math.sin(this.age * 1.7) + 0.002 * Math.sin(this.age * 4.3) + 0.006 * this.jolt * Math.sin(this.age * 40);
      this.bob = bob * Math.min(1, this.speed / 2);
      const weather = WEATHER[set('ntWeather')] ?? 0;
      this.rain += ((weather === 1 ? 1 : 0) - this.rain) * Math.min(1, dt);
      this.snow += ((weather === 2 ? 1 : 0) - this.snow) * Math.min(1, dt);

      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform2f(u.starShift, ...this.starShift);
      gl.uniform2f(u.moon, ...this.moon);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.dist, this.dist);
      gl.uniform1f(u.speed, this.speed);
      gl.uniform1f(u.bob, this.bob);
      gl.uniform1f(u.beat, a.playing ? a.throb : 0);
      gl.uniform1f(u.beats, a.playing ? a.beats + (a.lock > 0.5 ? 0 : Math.floor(this.age * 2)) : Math.floor(this.age));
      gl.uniform1f(u.ripple, this.ripple);
      gl.uniform1f(u.rain, this.rain);
      gl.uniform1f(u.snow, this.snow);
      gl.uniform1f(u.cup, set('ntCup') ? 1 : 0);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'train',
    name: 'Night Train',
    desc: 'Looking out of a train at night: the land rushing by in layers with the tempo, a telegraph pole on every beat, crossings flashing and stations passing, a cup of tea rippling on the table',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="3"/><path d="M3 13l5-4 4 3 4-5 5 4M7 21h3M14 21h3"/></svg>',
    gl: true,
    create: (canvas) => new NightTrain(canvas),
    options: [
      { type: 'choice', key: 'ntWeather', label: 'Weather', choices: [['clear', 'Clear'], ['rain', 'Rain'], ['snow', 'Snow']] },
      { type: 'check', key: 'ntCup', label: 'A cup of tea' },
    ],
  });
})();
