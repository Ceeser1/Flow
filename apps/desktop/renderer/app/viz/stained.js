'use strict';

// Stained Glass: the song's cover as a church window, cut into panes of
// coloured glass held in lead, the light behind it moving with the music.
// The panes glow brighter with the music and each with its part of the
// spectrum, a brighter light sweeps across them on the beat, a few flare up
// on the hits; shafts of coloured light fall from the window into the dusty
// dark, motes drifting in them, and lie on the stone floor below. A song
// without a cover gets a pattern of its own colour. Beside the rose and the
// arch: a bookshelf (left) and a bench (right), and a torch hanging on the
// wall each side, its flame flickering and lighting the stone round it.
//
// Its cogwheel: a rose window, a pointed arch or glass over the whole
// screen; the glass's colours (the cover's, or warm, cold or rainbow glass
// with the cover's light and dark); how many panes; the shafts of light;
// the torches.
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
    uniform int glassMode;      // 0 the cover's, 1 warm, 2 cold, 3 rainbow
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

    // Warm, Cold and Rainbow: the pane's glass picked by its id (Rainbow's
    // going round by where it lies, slowly drifting), its light and dark
    // still the cover's.
    vec3 tint(vec3 c, float id, vec2 pc) {
      float l = dot(c, vec3(0.3, 0.55, 0.15));
      float k = hash12(vec2(id * 53.1, 7.3));
      vec3 g;
      if (glassMode == 1) {
        // Ruby, flame, amber, gold, now and then a deep rose.
        g = k < 0.3 ? vec3(0.8, 0.06, 0.05) : k < 0.52 ? vec3(1.0, 0.35, 0.04) : k < 0.74 ? vec3(1.0, 0.6, 0.08)
          : k < 0.9 ? vec3(1.0, 0.82, 0.3) : vec3(0.5, 0.1, 0.03);
      } else if (glassMode == 2) {
        // Cobalt, sapphire, teal, ice, now and then a violet.
        g = k < 0.3 ? vec3(0.05, 0.15, 0.75) : k < 0.52 ? vec3(0.1, 0.4, 0.95) : k < 0.74 ? vec3(0.05, 0.6, 0.65)
          : k < 0.9 ? vec3(0.6, 0.85, 1.0) : vec3(0.35, 0.15, 0.75);
      } else {
        g = hsv2rgb(vec3(fract(dot(pc, vec2(0.7, 0.9)) + k * 0.12 + time * 0.02), 0.9, 1.0));
      }
      return g * (0.45 + 0.75 * l);
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
      float id = v.w;
      if (glassMode > 0) c = tint(c, id, pc);
      // Stronger, as glass: more colourful, the dark ones not black.
      float l = dot(c, vec3(0.3, 0.55, 0.15));
      c = mix(vec3(l), c, 1.6);
      c = clamp(c, 0.0, 1.0);
      c = pow(c, vec3(0.85)) * 0.85 + 0.06;
      // Each pane its own thickness; mottled; a few bubbles; darker by the lead.
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
    }

    // The tracery where p is (0..1): the rose's spokes (out to the frame)
    // and inner ring, the arch's mullion; iron: the arch's iron bars.
    float tracery(vec2 p, out float iron) {
      iron = 0.0;
      if (shape == 1) {
        float r = length(p);
        float an = atan(p.y, p.x);
        float seg = 2.0 * PI / 12.0;
        float fa = abs(mod(an + seg * 0.5, seg) - seg * 0.5);
        return max(step(0.24, r) * (1.0 - smoothstep(0.009, 0.015, fa * r)), 1.0 - smoothstep(0.01, 0.017, abs(r - 0.24)));
      }
      if (shape == 0) {
        iron = smoothstep(0.488, 0.494, abs(fract((p.y + 1.0) * 2.6) - 0.5));
        return (1.0 - smoothstep(0.009, 0.016, abs(p.x))) * step(p.y, 0.55);
      }
      return 0.0;
    }`;

  // The glass's light alone, small: for the shafts and the floor. Alpha:
  // what the tracery lets through, for the floor only (in the shafts the
  // bars' shadows would hang down as hard dark lines).
  const EMIT_FS = COMMON + `
    in vec2 uv;
    out vec4 o;
    void main() {
      vec2 p = winSpace(uv);
      float depth;
      float m = inside(p, depth);
      float lead, iron = 0.0, bar = 0.0;
      vec3 c = vec3(0.0);
      if (m > 0.0) {
        c = glass(p, lead) * (1.0 - lead);
        bar = tracery(p, iron);
      }
      o = vec4(c * m, (1.0 - bar) * (1.0 - 0.9 * iron));
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
    uniform bool shafts, torches;
    uniform vec2 flick;         // the torches' flames, left and right (about 1)
    out vec4 o;

    // Scene space (s): x from the middle, y up from the bottom, both in
    // screen heights; z out from the wall.
    const float FLOOR = 0.1;    // where the floor meets the wall
    const vec3 FIRE = vec3(1.0, 0.55, 0.25);

    float box(vec2 p, vec2 c, vec2 h) {
      vec2 d = abs(p - c) - h;
      return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
    }

    // Where a torch's cup sits (side -1 left, 1 right): halfway between the
    // window's frame and the screen's side.
    vec2 torchAt(float side) {
      float frame = shape == 1 ? 0.436 : 0.236;
      float sx = res.x / res.y * 0.5;
      return vec2(side * min((frame + sx) * 0.5, sx - 0.08), 0.58);
    }

    // The torches' light at q.
    vec3 torchLight(vec3 q) {
      if (!torches) return vec3(0.0);
      float sum = 0.0;
      for (int i = 0; i < 2; i++) {
        vec3 d = q - vec3(torchAt(i == 0 ? -1.0 : 1.0) + vec2(0.0, 0.045), 0.05);
        sum += (i == 0 ? flick.x : flick.y) * 0.02 / (dot(d, d) + 0.006) * exp(-2.2 * length(d));
      }
      return FIRE * sum;
    }

    // A surface of colour alb at q: the dark room's light and the torches'.
    vec3 lit(vec3 alb, vec3 q) {
      return alb * (0.1 + torchLight(q));
    }

    // Where the bookshelf (left) and the bench (right) stand: under the torches.
    float shelfX() { return -min(-torchAt(-1.0).x + 0.02, res.x / res.y * 0.5 - 0.17); }
    float benchX() { return min(torchAt(1.0).x, res.x / res.y * 0.5 - 0.19); }

    // Wood: its grain running along (vertical: up and down).
    vec3 wood(vec3 c, vec2 p, bool vertical) {
      vec2 g = vertical ? vec2(p.x * 260.0, p.y * 9.0) : vec2(p.x * 9.0, p.y * 260.0);
      return c * (0.78 + 0.3 * vnoise(g) + 0.1 * vnoise(g * 3.1));
    }

    // One row of books standing from x0 to x1 on yb, h high, then a few lying
    // flat: their colour and how much of the pixel they cover.
    vec4 books(vec2 p, float x0, float x1, float yb, float h, float seed) {
      const vec3 LEATHER[7] = vec3[7](vec3(0.45, 0.06, 0.05), vec3(0.08, 0.25, 0.12), vec3(0.07, 0.1, 0.3),
        vec3(0.35, 0.2, 0.08), vec3(0.55, 0.4, 0.12), vec3(0.09, 0.08, 0.07), vec3(0.3, 0.08, 0.2));
      const vec3 GOLD = vec3(0.8, 0.6, 0.22);
      float px = 1.2 / res.y;
      float fill = x0 + (x1 - x0) * (0.55 + 0.25 * hash12(vec2(seed, 3.0)));
      float x = x0;
      for (int i = 0; i < 28; i++) {
        float fi = float(i);
        float w = 0.008 + 0.011 * hash12(vec2(seed + 1.7, fi));
        if (p.x < x + w) {
          float bh = h * (0.62 + 0.34 * hash12(vec2(fi, seed + 5.0)));
          if (p.y > yb + bh) return vec4(0.0);
          float k = hash12(vec2(fi * 7.0, seed + 9.0));
          vec3 c = LEATHER[int(k * 6.99)];
          float u = (p.x - x) / w;
          // Gold bands on most, near the top and the bottom.
          if (k > 0.35 && (abs(p.y - (yb + bh - 0.012)) < 0.0016 || abs(p.y - (yb + 0.012)) < 0.0016)) c = GOLD;
          c *= 0.55 + 0.45 * sin(3.14159 * u);
          float a = smoothstep(0.0, px, p.x - x) * smoothstep(0.0, px, x + w - p.x) * smoothstep(0.0, px, yb + bh - p.y);
          return vec4(c, a);
        }
        x += w + 0.0012;
        if (x > fill) break;
      }
      // A few lying flat, one on the other.
      float y = yb;
      x += 0.008;
      for (int j = 0; j < 3; j++) {
        float fj = float(j);
        float bh = 0.011 + 0.006 * hash12(vec2(seed + 2.0, fj));
        float bw = min(0.055 + 0.022 * hash12(vec2(fj, seed + 4.0)), x1 - x - 0.004);
        float bx = x + 0.006 * (hash12(vec2(fj, seed + 6.0)) - 0.5);
        if (p.y < y + bh && p.x > bx && p.x < bx + bw && bw > 0.02) {
          vec3 c = LEATHER[int(hash12(vec2(fj * 3.0, seed + 8.0)) * 6.99)];
          c *= 0.55 + 0.45 * sin(3.14159 * (p.y - y) / bh);
          return vec4(c, 1.0);
        }
        y += bh;
      }
      return vec4(0.0);
    }

    // The bookshelf, half high, against the wall: colour, coverage.
    vec4 shelf(vec2 s) {
      vec2 p = s - vec2(shelfX(), 0.0);
      const float HW = 0.15, TOP = 0.36, BOT = 0.082, SIDE = 0.013, PLINTH = 0.022, BOARD = 0.016;
      float px = 1.5 / res.y;
      float front = box(p, vec2(0.0, (TOP + BOT) * 0.5), vec2(HW, (TOP - BOT) * 0.5));
      float lid = box(p, vec2(0.0, TOP + 0.007), vec2(HW - 0.005, 0.007));
      float a = 1.0 - smoothstep(-px, px, min(front, lid));
      if (a <= 0.0) return vec4(0.0);
      const vec3 OAK = vec3(0.42, 0.25, 0.12);
      vec3 q = vec3(s, 0.07);
      vec3 c;
      float mid = (BOT + PLINTH + TOP - BOARD) * 0.5;
      if (front > 0.0) {
        // The top, seen from above.
        c = lit(wood(OAK, p, false) * 1.2, q + vec3(0.0, 0.0, -0.03));
      } else if (abs(p.x) > HW - SIDE || p.y < BOT + PLINTH || p.y > TOP - BOARD || abs(p.y - mid) < 0.006) {
        // The frame and the board between the rows, their edges worn darker.
        bool side = abs(p.x) > HW - SIDE && p.y > BOT + PLINTH;
        c = lit(wood(OAK, p, side), q);
        c *= 0.75 + 0.25 * smoothstep(0.0, 0.004, -front);
      } else {
        // Inside: the dark back, the books, the board above shading them.
        bool upper = p.y > mid;
        float yb = upper ? mid + 0.006 : BOT + PLINTH;
        float yt = upper ? TOP - BOARD : mid - 0.006;
        c = lit(wood(OAK, p, true) * 0.3, q - vec3(0.0, 0.0, 0.05));
        vec4 b = books(p, -HW + SIDE + 0.004, HW - SIDE - 0.004, yb, yt - yb, upper ? 11.0 : 4.0);
        c = mix(c, lit(b.rgb, q), b.a);
        c *= mix(0.35, 1.0, smoothstep(yt, yt - 0.05, p.y));
      }
      return vec4(c, a);
    }

    // The bench: a thick seat on four legs, a back of slats against the wall.
    vec4 bench(vec2 s) {
      vec2 p = s - vec2(benchX(), 0.0);
      const float HW = 0.17, SEAT = 0.212, TOP = 0.345;
      float px = 1.5 / res.y;
      float lx = abs(p.x) - (HW - 0.022);
      float legs = box(vec2(lx, p.y), vec2(0.0, (SEAT + 0.082) * 0.5), vec2(0.009, (SEAT - 0.082) * 0.5));
      float posts = box(vec2(lx, p.y), vec2(0.0, (TOP + SEAT) * 0.5), vec2(0.007, (TOP - SEAT) * 0.5)) - 0.002;
      float top = box(p, vec2(0.0, SEAT + 0.006), vec2(HW - 0.003, 0.006));
      float edge = box(p, vec2(0.0, SEAT - 0.009), vec2(HW, 0.009)) - 0.002;
      float rail = box(p, vec2(0.0, TOP - 0.012), vec2(HW - 0.012, 0.011)) - 0.002;
      float low = box(p, vec2(0.0, 0.13), vec2(HW - 0.026, 0.005));
      // The slats: seven, between the seat and the rail.
      float sx = p.x / ((HW - 0.03) * 2.0 / 7.0);
      float slat = max(abs(fract(sx + 0.5) - 0.5) * ((HW - 0.03) * 2.0 / 7.0) - 0.0085, abs(p.y - (SEAT + TOP) * 0.5) - (TOP - SEAT) * 0.5);
      slat = max(slat, abs(p.x) - (HW - 0.03));
      float d = min(min(min(legs, posts), min(top, edge)), min(min(rail, low), slat));
      float a = 1.0 - smoothstep(-px, px, d);
      if (a <= 0.0) return vec4(0.0);
      const vec3 WALNUT = vec3(0.4, 0.23, 0.11);
      vec3 q = vec3(s, 0.09);
      vec3 c;
      if (edge < px) {
        c = lit(wood(WALNUT, p, false), q) * (0.75 + 0.25 * smoothstep(0.0, 0.005, -edge));
      } else if (legs < px) {
        c = lit(wood(WALNUT, p, true), q) * (0.55 + 0.45 * cos(lx / 0.009 * 1.2));
      } else if (top < px) {
        c = lit(wood(WALNUT, p, false) * 1.3, q - vec3(0.0, 0.0, 0.03));
      } else if (rail < px) {
        c = lit(wood(WALNUT, p, false) * 1.1, q - vec3(0.0, 0.0, 0.06)) * (0.75 + 0.25 * smoothstep(0.0, 0.005, -rail));
      } else if (posts < px) {
        c = lit(wood(WALNUT, p, true), q - vec3(0.0, 0.0, 0.06)) * (0.6 + 0.4 * cos(lx / 0.009 * 1.2));
      } else if (low < px) {
        c = lit(wood(WALNUT, p, false), q - vec3(0.0, 0.0, 0.02)) * 0.45;
      } else {
        // A slat, rounded, in the seat's shade low down.
        float u = fract(sx + 0.5) - 0.5;
        c = lit(wood(WALNUT, p, true) * 0.9, q - vec3(0.0, 0.0, 0.07)) * (0.6 + 0.4 * cos(u * 6.0));
        c *= mix(0.55, 1.0, smoothstep(SEAT + 0.01, SEAT + 0.05, p.y));
      }
      return vec4(c, a);
    }

    // How much the bookshelf and the bench darken the wall and floor round them.
    float nearShade(vec2 s) {
      float sh = box(s, vec2(shelfX(), 0.22), vec2(0.15, 0.15));
      float be = box(s, vec2(benchX(), 0.21), vec2(0.17, 0.13));
      float d = min(sh, be);
      float ao = mix(0.45, 1.0, smoothstep(0.0, 0.045, d));
      // Under the seat: the wall and floor in its shade.
      float under = 1.0 - (1.0 - smoothstep(-0.004, 0.004, box(s, vec2(benchX(), 0.14), vec2(0.16, 0.07)))) * 0.6;
      return ao * under;
    }

    // A torch on the wall: the iron plate, the stick, the ring, the cup.
    vec3 torch(vec3 col, vec2 s, float side, float fl) {
      vec2 q = s - torchAt(side);
      if (abs(q.x) > 0.05 || q.y < -0.2 || q.y > 0.01) return col;
      float px = 1.5 / res.y;
      // Lit from the flame above, the more the nearer.
      float k = 0.12 + fl * 1.3 * smoothstep(-0.2, 0.0, q.y);
      const vec3 IRON = vec3(0.16, 0.15, 0.15);
      float plate = box(q, vec2(0.0, -0.105), vec2(0.014, 0.034)) - 0.004;
      vec3 pc = IRON * (0.75 + 0.25 * vnoise(q * 300.0)) * k * FIRE * 1.6;
      // Rivets.
      float rv = min(length(q - vec2(0.0, -0.135)), length(q - vec2(0.0, -0.075)));
      pc *= 1.0 + 0.8 * smoothstep(0.004, 0.002, rv);
      col = mix(col, pc, 1.0 - smoothstep(-px, px, plate));
      float t = clamp((q.y + 0.17) / 0.135, 0.0, 1.0);
      float sw = mix(0.0055, 0.0085, t);
      float stick = max(abs(q.x) - sw, abs(q.y + 0.1025) - 0.0675);
      vec3 sc = wood(vec3(0.2, 0.13, 0.08), q * 2.0, true) * (0.45 + 0.55 * cos(q.x / sw * 1.3)) * k * vec3(1.6, 1.15, 0.8);
      col = mix(col, sc, 1.0 - smoothstep(-px, px, stick));
      float ring = box(q, vec2(0.0, -0.1), vec2(sw + 0.003, 0.005)) - 0.001;
      col = mix(col, IRON * (0.6 + 0.4 * cos(q.x / (sw + 0.004) * 1.3)) * k * FIRE * 1.8, 1.0 - smoothstep(-px, px, ring));
      float tc = clamp((q.y + 0.04) / 0.04, 0.0, 1.0);
      float cw = mix(0.01, 0.02, tc);
      float cup = max(abs(q.x) - cw, abs(q.y + 0.02) - 0.02);
      vec3 cc = IRON * (0.55 + 0.45 * cos(q.x / cw * 1.3)) * k * FIRE * 1.8;
      // Its rim catching the fire.
      cc += FIRE * fl * 0.5 * smoothstep(-0.006, 0.0, q.y);
      cc *= 1.0 - 0.4 * step(abs(q.y + 0.02), 0.002);
      col = mix(col, cc, 1.0 - smoothstep(-px, px, cup));
      return col;
    }

    // The flame above a torch, its glow in the air and a few sparks.
    vec3 flame(vec2 s, float side, float fl) {
      vec2 q = s - torchAt(side);
      float seed = side * 13.7 + 20.0;
      vec3 add = vec3(0.0);
      float h = 0.8 + 0.3 * fl;
      vec2 hc = q - vec2(0.0, 0.035 * h);
      add += FIRE * fl * 0.0012 / (dot(hc, hc) + 0.002);
      if (abs(q.x) > 0.08 || q.y < -0.02 || q.y > 0.3) return add;
      vec2 f = q / 0.1;
      float sway = (vnoise(vec2(time * 1.3, seed)) - 0.5) * 0.4;
      float n1 = vnoise(vec2(f.x * 3.0 + seed, f.y * 2.5 - time * 4.5)) - 0.5;
      float n2 = vnoise(vec2(f.x * 7.0 - seed, f.y * 6.0 - time * 8.0)) - 0.5;
      float yy = f.y / h;
      float x = f.x - sway * yy * yy - (n1 * 0.45 + n2 * 0.2) * max(yy, 0.0);
      float w = 0.42 * sqrt(clamp(yy + 0.1, 0.0, 1.0)) * clamp(1.0 - yy, 0.0, 1.0);
      float d = abs(x) / max(w, 1e-3);
      float body = smoothstep(1.0, 0.5, d) * smoothstep(-0.1, 0.0, yy) * smoothstep(1.0, 0.7, yy + n2 * 0.4);
      float heat = body * (1.0 - 0.7 * clamp(yy, 0.0, 1.0)) * (1.0 - 0.45 * d);
      vec3 c = mix(vec3(0.9, 0.12, 0.01), vec3(1.0, 0.5, 0.08), smoothstep(0.05, 0.4, heat));
      c = mix(c, vec3(1.0, 0.93, 0.65), smoothstep(0.45, 0.8, heat));
      add += c * body * 2.4;
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float sp = 0.45 + 0.2 * fi;
        float ph = time * sp + hash12(vec2(fi, seed));
        float life = fract(ph);
        float cyc = floor(ph);
        vec2 at = vec2((hash12(vec2(cyc, fi + seed)) - 0.5) * 0.03 + sin(life * 6.0 + fi * 2.0) * 0.012, 0.04 + life * 0.24);
        float dd = length(q - at);
        add += vec3(1.0, 0.6, 0.2) * smoothstep(0.0028, 0.0, dd) * (1.0 - life) * 2.5;
      }
      return add;
    }

    void main() {
      vec2 p = winSpace(uv);
      float depth;
      float m = inside(p, depth);
      vec3 col;
      float solid = 0.0;        // the bookshelf or the bench: less of the shafts' haze before them
      if (shape == 2) {
        float lead;
        vec3 g = glass(p, lead);
        col = mix(g, vec3(0.03, 0.03, 0.035) + 0.04 * (1.0 - abs(fract(p.y * 40.0) - 0.5)), lead);
      } else {
        vec2 s = vec2((uv.x - 0.5) * res.x / res.y, uv.y);
        // The wall: dark stone blocks, the floor below.
        vec2 sp = uv * vec2(res.x / res.y, 1.0) * 9.0;
        float row = floor(sp.y);
        sp.x += mod(row, 2.0) * 0.5;
        vec2 bf = fract(sp);
        float mortar = smoothstep(0.0, 0.05, bf.x) * smoothstep(1.0, 0.95, bf.x) * smoothstep(0.0, 0.08, bf.y) * smoothstep(1.0, 0.92, bf.y);
        float stone = 0.3 + 0.12 * hash12(floor(sp) + 3.0) + 0.08 * vnoise(sp * 6.0);
        col = lit(vec3(stone * 1.05, stone, stone * 0.95) * (0.55 + 0.45 * mortar), vec3(s, 0.0));
        if (uv.y < FLOOR) {
          // Flagstones going away, the window's light lying on them.
          float depthF = FLOOR / max(uv.y, 0.002);
          vec2 fp = vec2((uv.x - 0.5) * depthF * 3.0, depthF * 2.0);
          vec2 ff = fract(fp);
          float seam = smoothstep(0.0, 0.03, ff.x) * smoothstep(0.0, 0.05, ff.y);
          vec3 fq = vec3(s.x * depthF, FLOOR, (depthF - 1.0) * 0.15);
          col = lit(vec3(0.25, 0.23, 0.22) * (0.6 + 0.4 * seam), fq) * (0.6 + 0.4 * uv.y / FLOOR);
          // Its bottom (0.13 up the screen) lands a fifth of the way out
          // from the wall, its top furthest out; as wide as the window. The
          // tracery's shadows on it.
          float back = uv.y / FLOOR;
          vec4 e = texture(emit, vec2(uv.x, 0.13 + 0.7 * (0.8 - back)));
          col += e.rgb * e.a * 0.45 * smoothstep(0.0, 0.03, uv.y) * smoothstep(0.95, 0.8, back);
        }
        col *= nearShade(s);
        // The stone frame round the window.
        float fd = -depth;
        if (fd > 0.0 && fd < 0.09) {
          col = lit(vec3(1.1, 1.0, 0.9) * (0.55 + 0.45 * smoothstep(0.09, 0.0, fd)) * (0.8 + 0.2 * vnoise(p * 40.0)), vec3(s, 0.02));
        }
        if (m > 0.0) {
          float lead;
          vec3 g = glass(p, lead);
          vec3 l = vec3(0.025, 0.025, 0.028);
          float iron;
          float bar = tracery(p, iron);
          lead = max(lead, iron * 0.9);
          col = mix(col, mix(g, l, lead), m);
          col = mix(col, vec3(0.07, 0.065, 0.06), bar * m);
        }
        if (torches) {
          col = torch(col, s, -1.0, flick.x);
          col = torch(col, s, 1.0, flick.y);
        }
        vec4 f = shelf(s);
        col = mix(col, f.rgb, f.a);
        solid = f.a;
        f = bench(s);
        col = mix(col, f.rgb, f.a);
        solid = max(solid, f.a);
        if (torches) col += flame(s, -1.0, flick.x) + flame(s, 1.0, flick.y);
      }
      if (shafts) {
        vec3 r = texture(rays, uv).rgb;
        col += r * (1.0 - m * 0.9) * (1.0 - 0.55 * solid);
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
      // The torches' flicker: each its own phase, a jitter and the music's glow.
      this.flick = new Float32Array([1, 1]);
      this.jitter = [0, 0];
      this.phase = [Math.random() * 10, Math.random() * 10];
      this.glow = 0;
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

    _common(u, shape, panes, glass) {
      const gl = this.gl;
      VizGL.bind(gl, u.cover, this.cover.tex, 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1i(u.shape, shape);
      gl.uniform1i(u.glassMode, glass);
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
      const shape = { arch: 0, rose: 1, full: 2 }[set('sgWindow')] ?? 1;
      const panes = Number(set('sgPanes'));
      const glass = { cover: 0, warm: 1, cold: 2, rainbow: 3 }[set('sgGlass')] ?? 0;
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
      // The flames: flickering by themselves, a little higher with the music.
      this.glow += ((a.playing ? a.level : 0) - this.glow) * Math.min(1, dt * 3);
      for (let i = 0; i < 2; i += 1) {
        const t = this.age + this.phase[i];
        this.jitter[i] += ((Math.random() - 0.5) * 0.25 - this.jitter[i]) * Math.min(1, dt * 14);
        this.flick[i] = 0.9 + 0.06 * Math.sin(t * 11.3) + 0.04 * Math.sin(t * 17.9 + 1.3) + 0.04 * Math.sin(t * 5.1 + 0.4)
          + this.jitter[i] + 0.2 * this.glow;
      }

      gl.disable(gl.BLEND);
      VizGL.into(gl, this.emit);
      gl.useProgram(this.emitP.p);
      this._common(this.emitP.u, shape, panes, glass);
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
      this._common(u, shape, panes, glass);
      VizGL.bind(gl, u.emit, this.emit.tex, 1);
      VizGL.bind(gl, u.rays, this.rays.tex, 2);
      gl.uniform1i(u.shafts, shafts ? 1 : 0);
      gl.uniform1i(u.torches, set('sgTorches') && shape !== 2 ? 1 : 0);
      gl.uniform2f(u.flick, this.flick[0], this.flick[1]);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'stainedglass',
    name: 'Stained Glass',
    desc: "The song's cover as a church window of coloured glass in lead, the light behind it moving with the music and falling in shafts into the dark, torches on the walls",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M5 22V10a7 7 0 0 1 14 0v12z"/><path d="M5 15l5-3 4 4 5-4M12 3v9M8 22l2-10M16 22l-2-6"/></svg>',
    gl: true,
    create: (canvas) => new StainedGlass(canvas),
    options: [
      { type: 'choice', key: 'sgWindow', label: 'Window', choices: [['rose', 'Rose'], ['arch', 'Arch'], ['full', 'Whole screen']] },
      { type: 'choice', key: 'sgGlass', label: 'Colours', choices: [['cover', 'Cover'], ['warm', 'Warm'], ['cold', 'Cold'], ['rainbow', 'Rainbow']] },
      { type: 'slider', key: 'sgPanes', label: 'Panes', min: 6, max: 24, step: 1, unit: '' },
      { type: 'check', key: 'sgRays', label: 'Shafts of light', when: (s) => s.sgWindow !== 'full' },
      { type: 'check', key: 'sgTorches', label: 'Torches', when: (s) => s.sgWindow !== 'full' },
    ],
  });
})();
