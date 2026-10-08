'use strict';

// Deep Sea: glowing jellyfish drifting up past a reef. On the left a coral
// reef runs out gently, then drops away steeply (big orange anemones
// swaying, their tips glowing with the music, brain corals, staghorn, tube
// sponges, corals growing out of its wall, two sea fans low on it); on the
// right, further off, an underwater cliff falls away in ledges, small living
// corals along its top, a few dead corals bleached on its upper ledges; far
// below, barely there, the bottom with its rocks and a wreck. Now and then a
// fish or a school crosses in the distance, flashing silver as a strong beat
// ripples through it, passing behind the cliff or the reef.
//
// Each jellyfish's bell contracts on the beat (some every beat, some every
// other, some on the off beat) and the push carries it up a little, its
// tentacles and frilled arms trailing behind, swaying; each glows with its
// own part of the spectrum. Light comes down from the surface in shafts that
// brighten with the music and throws caustics on the reef and the cliff;
// specks drift in it, and the kicks set plankton flashing. Without a clear
// beat they pulse at their own calm pace.
//
// Its cogwheel: their colours, how many, the light from above, the fish.
//
// WebGL (viz/gl.js): the scenery is drawn once for the screen's size (its
// shaders compiled in the background, so a first start does not hang) into
// textures, far (the bottom, its rocks, the wreck), middle (the cliff), near
// (the reef) and where the light falls on them (for the caustics); the fish
// are quads shaped in their shader, drawn into a texture for each of their
// two depths; the orange anemones round tubes drawn each frame into a
// texture of their own; the jellyfish and the anemones' glowing tips soft
// lines added up in a texture, blurred small for the glow. One pass over
// the screen lays it all over the water, with its light and specks.

(() => {
  const MAX = 16;
  const TENTACLES = 10;
  const LINKS = 16;
  const ARMS = 4;
  const ARM_LINKS = 10;
  const MAX_FISH = 256;
  const MAX_CAPS = 2048;
  const PALETTES = {
    aurora: [0.5, 0.55, 0.78, 0.86, 0.95],
    ember: [0.0, 0.04, 0.08, 0.93, 0.97],
    ice: [0.52, 0.56, 0.6, 0.62, 0.66],
    rainbow: null,
  };

  // The reef's top (screen heights up) at x (screen heights from the left):
  // gently down, then steeply. The same in the shaders and here, where the
  // anemones sit.
  const reefTop = (x) => 0.44 - 0.11 * x - 4 * Math.max(x - 0.4, 0) ** 1.3
    + 0.008 * Math.sin(x * 23 + 1) + 0.006 * Math.sin(x * 51 + 2) + 0.004 * Math.sin(x * 97);

  // Where the anemone low on the reef's face sits (screen heights, as reefTop).
  const FACE_ANEMONE = [0.16, reefTop(0.16) - 0.17];

  const COMMON = `
    // The water's own colour, brighter towards the surface.
    vec3 waterAt(vec2 uv) {
      return mix(vec3(0.0, 0.016, 0.04), vec3(0.03, 0.2, 0.29), pow(uv.y, 1.6));
    }
    float seg(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a, ba = b - a;
      return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
    }
    const vec2 FACE_ANEMONE = vec2(${FACE_ANEMONE[0]}, ${FACE_ANEMONE[1]});
    float reefTop(float x) {
      return 0.44 - 0.11 * x - 4.0 * pow(max(x - 0.4, 0.0), 1.3)
        + 0.008 * sin(x * 23.0 + 1.0) + 0.006 * sin(x * 51.0 + 2.0) + 0.004 * sin(x * 97.0);
    }`;

  // The scenery, one layer to a shader (layer: 0 far, 1 middle, 2 near, 3
  // where the light falls), as premultiplied colour over the water, already
  // fogged by its distance. Places are in screen heights (p), the reef from
  // the left edge, the cliff from the right. One shader for all of it took
  // Direct3D's compiler some 16 seconds; four smaller ones, a fraction.
  const sceneFs = (layer) => `#define LAYER ${layer}
` + VizGL.NOISE + COMMON + `
    in vec2 uv;
    uniform vec2 res;
    // 1: the loops' counts are multiplied by it, so the compiler cannot
    // unroll them (Direct3D's would, copying every coral's code into each
    // pass round them, and take many seconds over it the first time).
    uniform int loops;
    out vec4 o;

    // fbm, its loop kept a loop (see loops).
    float fbmL(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5 * loops; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 3.7); a *= 0.5; }
      return v;
    }

    float px;
    vec4 acc;

    float cover(float d) { return clamp(-d / px + 0.5, 0.0, 1.0); }

    // Lays colour c over what is there, covering cov of the pixel, fog of
    // the way to the water's colour.
    void lay(vec3 c, float cov, float fog) {
      if (cov <= 0.0) return;
      c = mix(c, waterAt(uv), fog);
      acc = acc * (1.0 - cov) + vec4(c * cov, cov);
    }

    const vec3 CORAL[6] = vec3[6](vec3(0.85, 0.38, 0.5), vec3(0.95, 0.55, 0.25), vec3(0.6, 0.38, 0.85),
      vec3(0.3, 0.72, 0.75), vec3(0.88, 0.8, 0.38), vec3(0.78, 0.26, 0.28));
    vec3 coralColour(float h) { return CORAL[int(h * 5.999)]; }

    // A branching coral from b, growing at angle a (0 up, positive to the
    // right), s its size: a trunk, three branches, two twigs on each. Its
    // distance; tipD: how far the nearest twig's end is.
    float branches(vec2 p, vec2 b, float a, float s, float seed, float th, out float tipD) {
      tipD = 1e3;
      if (length(p - b) > s * 1.9) return 1e3;
      vec2 dir = vec2(sin(a), cos(a));
      vec2 e = b + dir * s * 0.55;
      float best = seg(p, b - dir * 0.012, e) - th;
      for (int i = 0; i < 3 * loops; i++) {
        float fi = float(i);
        float ang = a + (fi - 1.0) * 0.75 + 0.4 * (hash12(vec2(seed, fi)) - 0.5);
        vec2 bs = i == 1 ? e : mix(b, e, 0.45 + 0.4 * hash12(vec2(fi, seed + 1.0)));
        vec2 be = bs + vec2(sin(ang), cos(ang)) * s * (0.42 + 0.2 * hash12(vec2(seed + 2.0, fi)));
        best = min(best, seg(p, bs, be) - th * 0.75);
        for (int k = 0; k < 2 * loops; k++) {
          float fk = float(k);
          float ta = ang + (fk - 0.5) * 1.0 + 0.35 * (hash12(vec2(seed + fi, fk + 3.0)) - 0.5);
          vec2 ts = mix(bs, be, 0.5 + 0.5 * fk);
          vec2 te = ts + vec2(sin(ta), cos(ta)) * s * (0.24 + 0.16 * hash12(vec2(fk + fi, seed + 5.0)));
          best = min(best, seg(p, ts, te) - th * 0.55);
          tipD = min(tipD, length(p - te));
        }
      }
      return best;
    }

    // A brain coral: a dome on b, r wide, h high, its grooves meandering.
    void brain(vec2 p, vec2 b, float r, float h, vec3 c, float seed, float fog) {
      vec2 q = (p - b) / vec2(r, h);
      if (q.y < -0.3 || abs(q.x) > 1.2 || q.y > 1.2) return;
      float d = (length(q) - 1.0 - 0.06 * (vnoise(q * 6.0 + seed) - 0.5)) * min(r, h);
      float grooves = sin(fbmL(q * 2.5 + seed) * 34.0);
      float sh = (0.5 + 0.5 * q.y) * (0.68 + 0.32 * smoothstep(-0.4, 0.5, grooves));
      lay(c * sh, cover(d), fog);
    }

    // A sea fan on b, R across, leaning lean: a lace of veins and cross
    // links on a short stalk, the water showing through.
    void fan(vec2 p, vec2 b, float R, float lean, vec3 c, float seed, float fog) {
      vec2 dir = vec2(sin(lean), cos(lean));
      vec2 o0 = b + dir * R * 0.15;
      vec2 q = p - o0;
      float dist = length(q);
      float stalk = seg(p, b - dir * 0.006, o0) - R * 0.03;
      if (dist > R * 1.15 && stalk > px) return;
      float ang = atan(q.x, q.y) - lean;
      ang = mod(ang + 3.14159, 6.28318) - 3.14159;
      float edge = R * (0.82 + 0.18 * vnoise(vec2(ang * 5.0, seed)));
      float inside = max(dist - edge, (abs(ang) - 1.05) * dist);
      float body = cover(inside);
      vec2 g = vec2(ang * dist, dist) / R * 13.0;
      g += 0.5 * vec2(vnoise(g * 0.7 + seed), vnoise(g * 0.7 - seed));
      vec2 fg = abs(fract(g) - 0.5);
      float net = smoothstep(0.36, 0.46, max(fg.x, fg.y));
      float rim = smoothstep(-R * 0.04, 0.0, inside);
      float a = max(body * max(0.2, max(net, rim)), cover(stalk));
      lay(c * (0.55 + 0.45 * max(net, rim)) * (0.7 + 0.4 * dist / R), a, fog);
    }

    // Tube sponges on b, s high: three tubes, open at the top.
    void tubes(vec2 p, vec2 b, float s, vec3 c, float seed, float fog) {
      if (abs(p.x - b.x) > s * 0.9 || p.y > b.y + s * 1.4) return;
      for (int i = 0; i < 3 * loops; i++) {
        float fi = float(i);
        float hgt = s * (0.55 + 0.65 * hash12(vec2(seed, fi)));
        float w = s * (0.12 + 0.06 * hash12(vec2(fi, seed)));
        float x0 = b.x + (fi - 1.0) * s * 0.3;
        vec2 top = vec2(x0 + (fi - 1.0) * 0.18 * hgt, b.y + hgt);
        float d = seg(p, vec2(x0, b.y - 0.01), top) - w;
        float cov = cover(d);
        if (cov <= 0.0) continue;
        float across = clamp((p.x - mix(x0, top.x, clamp((p.y - b.y) / hgt, 0.0, 1.0))) / w, -1.0, 1.0);
        float sh = (0.55 + 0.4 * (1.0 - across * across) - 0.15 * across) * (0.8 + 0.3 * vnoise(p * 400.0));
        float hole = 1.0 - smoothstep(0.75, 1.0, length((p - top) / vec2(w * 0.8, w * 0.35)));
        lay(mix(c * sh, c * 0.12, hole), cov, fog);
      }
    }

    // ---- Far: the bottom, barely there. ----

    float floorAt(float x) {
      return 0.14 + 0.09 * (fbmL(vec2(x * 1.1, 7.0)) - 0.5) + 0.004 * vnoise(vec2(x * 30.0, 2.0));
    }

    float deckAt(float u) { return 0.1 + 0.06 * pow(max(u, 0.0), 2.0); }

    // The wreck: a hull lying a little bow up, sunk into the sand, her deck
    // caved in amidships, the wheelhouse aft, one mast snapped and leaning
    // back with a rope hanging from it, the other leaning far forward.
    void wreck(vec2 p, float fog) {
      float asp = res.x / res.y;
      float L = 0.2;
      vec2 base = vec2(0.5 * asp, floorAt(0.5 * asp) + 0.012);
      float r = 0.07;
      vec2 d = p - base;
      vec2 q = vec2(cos(r) * d.x + sin(r) * d.y, -sin(r) * d.x + cos(r) * d.y) / L;
      if (abs(q.x) > 1.4 || q.y < -0.4 || q.y > 0.8) return;
      float u = q.x, v = q.y;
      float keel = -0.1 + 0.27 * pow(max(u - 0.25, 0.0) / 0.75, 2.0) + 0.06 * pow(max(-u - 0.65, 0.0) / 0.35, 2.0);
      float deck = deckAt(u);
      float hull = max(max(keel - v, v - deck), max(u - 1.0, -0.97 - u));
      float cave = max(abs(u - 0.15) - 0.07 - 0.02 * vnoise(vec2(v * 30.0, 1.0)), deck - 0.06 - 0.03 * vnoise(vec2(u * 25.0, 3.0)) - v);
      hull = max(hull, -cave);
      float house = max(max(abs(u + 0.5) - 0.17, deck - 0.01 - v), v - deck - 0.13);
      float dd = min(hull, house);
      dd = min(dd, seg(q, vec2(-0.05, deck), vec2(-0.17, deck + 0.48)) - 0.014);
      dd = min(dd, seg(q, vec2(0.6, deckAt(0.6)), vec2(0.88, deckAt(0.6) + 0.3)) - 0.012);
      dd = min(dd, seg(q, vec2(0.66, 0.31), vec2(0.86, 0.17)) - 0.008);
      dd = min(dd, seg(q, vec2(0.97, deckAt(0.97)), vec2(1.25, deckAt(0.97) + 0.08)) - 0.01);
      dd = min(dd, seg(q, vec2(-0.14, deck + 0.42), vec2(-0.3, deckAt(-0.3) + 0.01)) - 0.005);
      float cov = clamp(-dd * L / px + 0.5, 0.0, 1.0);
      vec3 c = vec3(0.17, 0.14, 0.11) * (0.7 + 0.5 * fbmL(q * 9.0));
      c *= 0.85 + 0.15 * step(0.12, fract(v * 18.0));
      float win = step(abs(fract((u + 0.5) * 10.0) - 0.5), 0.2) * step(abs(v - deck - 0.075), 0.025) * step(abs(u + 0.5), 0.14);
      c *= 1.0 - 0.7 * win;
      c *= 1.0 - 0.6 * smoothstep(0.62, 0.7, vnoise(q * 7.0)) * step(hull, 0.0);
      lay(c, cov, fog);
    }

    void rocks(vec2 p, float fog) {
      float cell = 0.07;
      float c0 = floor(p.x / cell);
      for (int k = -1; k <= loops; k++) {
        float id = c0 + float(k);
        if (hash12(vec2(id, 4.0)) > 0.45) continue;
        float rx = (id + 0.5 + 0.35 * (hash12(vec2(id, 5.0)) - 0.5)) * cell;
        float r = 0.008 + 0.022 * pow(hash12(vec2(id, 6.0)), 2.0);
        vec2 q = (p - vec2(rx, floorAt(rx) - r * 0.25)) / vec2(r * 1.3, r);
        float d = (length(q) - 1.0 - 0.15 * (vnoise(q * 3.0 + id) - 0.5)) * r;
        lay(vec3(0.2, 0.2, 0.19) * (0.6 + 0.4 * q.y) * (0.8 + 0.4 * vnoise(q * 5.0)), cover(d), fog);
      }
    }

    void farLayer(vec2 p) {
      // Hills further off still, hardly there.
      float hill = 0.3 + 0.12 * (fbmL(vec2(p.x * 0.9, 2.0)) - 0.5);
      lay(vec3(0.07, 0.12, 0.15), cover(p.y - hill), 0.85);
      wreck(p, 0.62);
      // The sand, rippled, over her keel.
      float fl = floorAt(p.x);
      float sand = 0.75 + 0.25 * fbmL(p * vec2(8.0, 30.0)) + 0.06 * sin(p.x * 140.0 + 6.0 * fbmL(p * 4.0));
      lay(vec3(0.4, 0.42, 0.37) * sand * (0.75 + 0.25 * smoothstep(fl - 0.05, fl, p.y)), cover(p.y - fl), 0.68 + 0.24 * smoothstep(0.0, 1.0, p.y / fl));
      rocks(p, 0.66);
    }

    // ---- Middle: the cliff on the right. ----

    // Its face, how far in from the right edge at height y: in ledges that
    // jut out at their tops, receding below.
    float faceR(float y) {
      float yw = y + 0.03 * sin(y * 9.0 + 1.0);
      float f = fract(yw * 4.2);
      float amp = 0.03 + 0.05 * hash12(vec2(floor(yw * 4.2), 8.0));
      return 0.3 + 0.14 * (fbmL(vec2(y * 3.0, 3.0)) - 0.5) + 0.05 * (fbmL(vec2(y * 12.0, 9.0)) - 0.5) + 0.07 * (1.0 - y) + amp * pow(f, 3.0) + 0.01 * vnoise(vec2(y * 45.0, 1.0));
    }
    float cliffTop(float r) { return 0.8 + 0.22 * max(0.36 - r, 0.0) + 0.02 * (fbmL(vec2(r * 9.0, 6.0)) - 0.5); }

    // A dead coral: bleached, bare.
    void deadCoral(vec2 p, vec2 b, float a, float s, float seed, float fog) {
      float tipD;
      float d = branches(p, b, a, s, seed, 0.0028, tipD);
      lay(vec3(0.62, 0.6, 0.54) * (0.7 + 0.3 * smoothstep(0.0, 0.015, tipD)) * (0.85 + 0.2 * vnoise(p * 300.0)), cover(d), fog);
    }

    void midLayer(vec2 p) {
      float asp = res.x / res.y;
      float r = asp - p.x;
      float fr = faceR(p.y);
      float top = cliffTop(r);
      float cov = cover(max(r - fr, p.y - top));
      if (cov > 0.0) {
        // The ledges' lines wander across its face (not at its edge, where the outline has them straight).
        float yw = p.y + 0.03 * sin(p.y * 9.0 + 1.0);
        yw += 0.035 * (fbmL(vec2(p.x * 5.0, floor(yw * 4.2) * 3.0)) - 0.5) * smoothstep(0.0, 0.1, fr - r);
        float f = fract(yw * 4.2);
        float n = fbmL(p * vec2(7.0, 16.0) + 2.0);
        float sh = (0.5 + 0.7 * n) * (0.85 + 0.15 * sin(yw * 70.0 + n * 5.0));
        // Blotches and cracks running down it.
        sh *= 0.75 + 0.4 * fbmL(p * 3.0 + 11.0);
        sh *= 1.0 - 0.45 * smoothstep(0.035, 0.0, abs(fbmL(vec2(p.x * 14.0, p.y * 3.0) + 4.0) - 0.5));
        float edge = smoothstep(0.1, 0.0, fr - r);
        float band = floor(yw * 4.2);
        sh *= 0.7 + 0.45 * smoothstep(0.035, 0.0, fr - r);
        // The ledges, across its face: lit on top, their undersides in
        // shadow, the rock between lighter towards the top; finer layers.
        sh *= 0.8 + 0.25 * f;
        sh *= 1.0 - 0.4 * smoothstep(0.55, 0.85, f) * (1.0 - smoothstep(0.91, 0.95, f)) * (0.5 + 0.5 * edge);
        sh += 0.5 * smoothstep(0.94, 0.995, f) * max(edge, smoothstep(0.4, 0.75, vnoise(vec2(p.x * 9.0, band * 3.0))));
        sh *= 1.0 - 0.2 * smoothstep(0.6, 0.9, vnoise(vec2(p.x * 3.0, yw * 40.0)));
        sh += 0.3 * smoothstep(top - 0.025, top, p.y);
        sh *= 0.5 + 0.5 * smoothstep(0.0, 0.8, p.y);
        lay(vec3(0.36, 0.39, 0.42) * sh, cov, 0.45 + 0.2 * (1.0 - p.y));
      }
      // Living corals along its top, small with the distance.
      if (p.y > 0.74 && r < 0.42) {
        float cell = 0.02;
        float c0 = floor(r / cell);
        for (int k = -2; k <= 2 * loops; k++) {
          float id = c0 + float(k);
          float hh = hash12(vec2(id, 70.0));
          if (hh > 0.9) continue;
          float cr = (id + 0.2 + 0.6 * hash12(vec2(id, 71.0))) * cell;
          if (cr < 0.012 || cr > faceR(0.8) - 0.012) continue;
          vec2 b = vec2(asp - cr, cliffTop(cr) - 0.003);
          vec3 c = coralColour(hash12(vec2(id, 72.0)));
          float sz = 0.7 + 0.5 * hash12(vec2(id, 73.0));
          float t = hh / 0.9;
          if (t < 0.35) brain(p, b, 0.014 * sz, 0.01 * sz, mix(c, vec3(0.7, 0.65, 0.45), 0.55), id, 0.42);
          else if (t < 0.65) {
            float tipD;
            float d = branches(p, b, 0.6 * (hash12(vec2(id, 74.0)) - 0.5), 0.02 * sz, id + 90.0, 0.0022, tipD);
            lay(mix(c * 0.6, mix(c, vec3(1.0), 0.35), smoothstep(0.006, 0.0, tipD)), cover(d), 0.42);
          }
          else tubes(p, b, 0.022 * sz, c, id, 0.42);
        }
      }
      // A few dead corals on its upper ledges, one out of its face.
      for (int k = 1; k < 3 * loops; k++) {
        float fk = float(k);
        float yb = (fk + 1.0) / 4.2;
        float y = yb;
        for (int i = 0; i < 4; i++) y = yb - 0.03 * sin(y * 9.0 + 1.0);
        float rr = faceR(y - 0.004) - 0.012 - 0.03 * hash12(vec2(fk, 32.0));
        deadCoral(p, vec2(asp - rr, y + 0.009), -0.3 + 0.6 * hash12(vec2(fk, 34.0)), 0.022 + 0.01 * hash12(vec2(fk, 33.0)), fk * 7.3, 0.5);
      }
      deadCoral(p, vec2(asp - faceR(0.6) + 0.005, 0.6), -1.15, 0.024, 21.7, 0.5);
    }

    // ---- Near: the reef on the left. ----

    // Where the reef's steep wall is at height y.
    float wallX(float y) {
      float lo = 0.38, hi = 0.8;
      for (int i = 0; i < 14 * loops; i++) {
        float m = 0.5 * (lo + hi);
        if (reefTop(m) > y) lo = m; else hi = m;
      }
      float x = 0.5 * (lo + hi);
      return x - 0.03 * (fbmL(vec2(y * 7.0, 5.0)) - 0.5) * smoothstep(0.36, 0.46, x);
    }

    // The corals along its top, a row behind (row 0, smaller, hazier) and one in front.
    void coral(vec2 p, float id, float row) {
      float cell = 0.045;
      float hh = hash12(vec2(id, 17.0 + row * 3.0));
      if (hh > 0.85) return;
      float x = (id + 0.2 + 0.6 * hash12(vec2(id, 18.0 + row))) * cell;
      if (x < -0.05 || x > 0.47) return;
      float by = reefTop(x) - 0.006 + (1.0 - row) * 0.01;
      if (abs(p.x - x) > 0.13 || p.y < by - 0.03 || p.y > by + 0.16) return;
      float sz = (0.75 + 0.5 * hash12(vec2(id, 19.0 + row))) * (row < 0.5 ? 0.75 : 1.0);
      float fog = row < 0.5 ? 0.25 : 0.12;
      vec3 c = coralColour(hash12(vec2(id, 20.0 + row)));
      vec2 b = vec2(x, by);
      float t = hh / 0.85;
      float lean = hash12(vec2(id, 21.0 + row)) - 0.5;
      if (t < 0.33) brain(p, b, 0.042 * sz, 0.03 * sz, mix(c, vec3(0.7, 0.65, 0.45), 0.55), id, fog);
      else if (t < 0.7) {
        float tipD;
        float d = branches(p, b, 0.4 * lean, 0.055 * sz, id + row * 50.0, 0.005 * sz, tipD);
        vec3 cc = mix(c * 0.6, mix(c, vec3(1.0), 0.35), smoothstep(0.015, 0.0, tipD)) * (0.85 + 0.25 * vnoise(p * 250.0));
        lay(cc, cover(d), fog);
      }
      else tubes(p, b, 0.06 * sz, c, id, fog);
    }

    // Smaller corals all over the reef's face below its top, hazier deeper down.
    void face(vec2 p, float top) {
      float cell = 0.055;
      vec2 c0 = floor(p / cell);
      for (int j = -2; j <= 2 * loops; j++) {
        for (int i = -2; i <= 2 * loops; i++) {
          vec2 id = c0 + vec2(float(i), float(j));
          float hh = hash12(id + 60.0);
          if (hh > 0.36) continue;
          vec2 b = (id + 0.2 + 0.6 * vec2(hash12(id + 61.0), hash12(id + 62.0))) * cell;
          // Out from behind the anemone there: up and to the left.
          if (length(b - FACE_ANEMONE) < 0.05) b += vec2(-0.035, 0.025);
          float bt = reefTop(b.x + 0.03 * (fbmL(vec2(b.y * 7.0, 5.0)) - 0.5) * smoothstep(0.36, 0.46, b.x));
          if (b.y > bt - 0.04 || b.x > 0.6) continue;
          float fog = 0.25 + 0.5 * (1.0 - smoothstep(0.0, 0.4, b.y));
          vec3 c = mix(coralColour(hash12(id + 63.0)), vec3(0.4, 0.36, 0.32), 0.35) * (0.5 + 0.5 * smoothstep(0.0, 0.4, b.y));
          float sz = 0.6 + 0.4 * hash12(id + 64.0);
          float t = hh / 0.36;
          if (t < 0.5) brain(p, b, 0.03 * sz, 0.022 * sz, mix(c, vec3(0.7, 0.65, 0.45), 0.55), id.x + id.y * 7.0, fog);
          else {
            float tipD;
            float d = branches(p, b, 0.5 * (hash12(id + 65.0) - 0.5), 0.04 * sz, id.x * 3.0 + id.y, 0.004 * sz, tipD);
            lay(mix(c * 0.6, mix(c, vec3(1.0), 0.35), smoothstep(0.012, 0.0, tipD)), cover(d), fog);
          }
        }
      }
    }

    // A branching coral growing out of the wall, reaching up and out; id (of
    // 0.075-high steps up the wall) picks its height and looks, dx moves it,
    // turn turns it (towards upright, negative).
    void wallCoral(vec2 p, float id, float dx, float turn) {
      float hh = hash12(vec2(id, 40.0));
      float y = (id + 0.3 + 0.4 * hash12(vec2(id, 41.0))) * 0.075;
      float wx = wallX(y) + dx;
      if (abs(p.y - y) > 0.12 || p.x < wx - 0.08 || p.x > wx + 0.14) return;
      vec3 c = coralColour(hash12(vec2(id, 42.0)));
      float tipD;
      float d = branches(p, vec2(wx - 0.004, y), 0.6 + 0.4 * hash12(vec2(id, 44.0)) + turn, 0.035 + 0.015 * hh, id + 80.0, 0.0045, tipD);
      lay(mix(c * 0.6, mix(c, vec3(1.0), 0.35), smoothstep(0.015, 0.0, tipD)), cover(d), 0.2);
    }

    // Two of them, one low down and one near the top (left of the tube
    // sponges), the rest of the wall left to the anemone and the sea fans.
    void wall(vec2 p) {
      if (p.x < 0.25 || p.y > 0.47) return;
      wallCoral(p, 0.0, 0.0, 0.0);
      wallCoral(p, 4.0, -0.05, -0.5);
    }

    void nearLayer(vec2 p) {
      float rx = p.x + 0.03 * (fbmL(vec2(p.y * 7.0, 5.0)) - 0.5) * smoothstep(0.36, 0.46, p.x);
      float top = reefTop(rx);
      // Steep, the height overstates how far the edge is.
      float cov = cover((p.y - top) * mix(1.0, 0.3, smoothstep(0.38, 0.5, p.x)));
      if (cov > 0.0) {
        float sh = 0.45 + 0.6 * fbmL(p * 22.0) + 0.15 * vnoise(p * 70.0);
        sh *= 0.65 + 0.6 * smoothstep(top - 0.06, top, p.y);
        sh *= 0.4 + 0.6 * smoothstep(-0.05, 0.42, p.y);
        vec3 c = mix(vec3(0.36, 0.27, 0.27), vec3(0.28, 0.34, 0.2), smoothstep(0.45, 0.65, fbmL(p * 8.0 + 3.0)));
        // Crevices winding through it.
        c *= 1.0 - 0.35 * smoothstep(0.02, 0.0, abs(fbmL(p * 9.0 + 1.0) - 0.5));
        // Little things grown onto it: encrusting corals, sponges.
        vec2 g = floor(p / 0.02);
        if (hash12(g + 51.0) < 0.12 && p.y > top - 0.12) {
          vec2 cc = (g + 0.25 + 0.5 * vec2(hash12(g + 52.0), hash12(g + 53.0))) * 0.02;
          float r = 0.003 + 0.005 * hash12(g + 54.0);
          float blob = cover(length((p - cc) * vec2(1.0, 1.3)) - r);
          c = mix(c, mix(coralColour(hash12(g + 55.0)), c, 0.4) * (0.55 + 0.4 * smoothstep(-r, r, p.y - cc.y)), blob * 0.8);
        }
        lay(c * sh, cov, 0.1 + 0.4 * (1.0 - smoothstep(0.0, 0.45, p.y)));
      }
      if (p.y > 0.62 || p.x > 0.75) return;
      face(p, top);
      float c0 = floor(p.x / 0.045);
      for (int k = -3; k <= 3 * loops; k++) coral(p, c0 + float(k), 0.0);
      wall(p);
      // Two sea fans on the steep slope, low down.
      if (p.x > 0.4 && p.y < 0.3) {
        fan(p, vec2(wallX(0.1) - 0.005, 0.1), 0.065, 1.2, CORAL[5], 3.0, 0.2);
        fan(p, vec2(wallX(0.18) - 0.005, 0.18), 0.06, 1.1, CORAL[2], 7.0, 0.2);
      }
      for (int k = -3; k <= 3 * loops; k++) coral(p, c0 + float(k), 1.0);
    }

    // Where the light from above falls (for the caustics): the reef's top,
    // the cliff's ledges and top; R near, G middle.
    vec4 lit(vec2 p) {
      float asp = res.x / res.y;
      float top = reefTop(p.x);
      float near = 0.2 + 0.8 * smoothstep(top - 0.07, top + 0.01, p.y) * (1.0 - smoothstep(0.38, 0.48, p.x));
      float r = asp - p.x;
      float fr = faceR(p.y);
      float f = fract((p.y + 0.03 * sin(p.y * 9.0 + 1.0)) * 4.2);
      float mid = 0.1 + 0.9 * max(smoothstep(0.88, 0.99, f) * smoothstep(0.09, 0.0, fr - r), smoothstep(cliffTop(r) - 0.04, cliffTop(r), p.y));
      return vec4(near, mid, 0.0, 1.0);
    }

    void main() {
      px = 1.0 / res.y;
      acc = vec4(0.0);
      vec2 p = vec2(uv.x * res.x / res.y, uv.y);
#if LAYER == 0
      farLayer(p);
#elif LAYER == 1
      midLayer(p);
#elif LAYER == 2
      nearLayer(p);
#else
      acc = lit(p);
#endif
      o = acc;
    }`;

  // A fish, side on, on a quad of its own: at = x, y (pixels), half its
  // length (pixels), its tilt; look = which way it faces (1 right, -1 left),
  // its tail's swing, its silver sheen, its shade.
  const FISH_VS = `
    layout(location = 0) in vec4 at;
    layout(location = 1) in vec4 look;
    uniform vec2 res;
    uniform float scale;
    out vec2 q;
    out vec4 lk;
    out float pxu;
    void main() {
      vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
      q = c * vec2(1.3, 0.6);
      lk = look;
      pxu = scale / max(at.z, 1.0);
      vec2 f = vec2(look.x * cos(at.w), sin(at.w));
      vec2 up = look.x * vec2(f.y, -f.x);
      vec2 w = at.xy + (f * q.x + up * q.y) * at.z;
      gl_Position = vec4(w.x / res.x * 2.0 - 1.0, 1.0 - w.y / res.y * 2.0, 0.0, 1.0);
    }`;
  const FISH_FS = `
    in vec2 q;
    in vec4 lk;
    in float pxu;
    out vec4 o;
    void main() {
      float u = q.x, v = q.y, swing = lk.y;
      // Its body: plump behind the head, narrowing to the tail, bending a little with it.
      float t = clamp((u + 0.72) / 1.72, 0.0, 1.0);
      float vc = 0.05 * swing * (1.0 - t) * (1.0 - t);
      float hb = 0.25 * pow(sin(3.14159 * pow(t, 1.1)), 0.8) + 0.035;
      float body = max(abs(v - vc) - hb, max(u - 1.0, -0.72 - u));
      // The dorsal fin.
      float fin = max(max(v - vc - hb - 0.13 * smoothstep(-0.05, 0.12, u) * (1.0 - smoothstep(0.12, 0.4, u)), vc - v), max(-0.05 - u, u - 0.4));
      // The tail, forked, foreshortened as it swings.
      float s = (-0.62 - u) / 0.43;
      float tc = vc + 0.06 * swing;
      float tv = abs(v - tc);
      float tail = max(tv - (0.04 + 0.3 * s * (1.0 - 0.3 * abs(swing))), max(-1.05 - u, u + 0.62));
      tail = max(tail, (s - 0.6) * 0.7 - tv);
      float d = min(body, min(fin, tail));
      float cov = clamp(-d / pxu + 0.5, 0.0, 1.0);
      if (cov <= 0.0) discard;
      vec3 back = vec3(0.04, 0.08, 0.11);
      vec3 belly = vec3(0.3, 0.4, 0.44);
      vec3 col = mix(belly, back, smoothstep(-0.12, 0.14, v - vc)) * lk.w;
      float inBody = clamp(-body / pxu + 0.5, 0.0, 1.0);
      col += vec3(0.55, 0.7, 0.75) * lk.z * (0.35 + 0.65 * exp(-pow((v - vc + 0.02) / 0.07, 2.0)) * inBody);
      // Its eye, when it is big enough to see.
      float eye = length(vec2(u - 0.74, v - vc - 0.05)) - 0.05;
      col *= 1.0 - 0.8 * clamp(-eye / pxu + 0.5, 0.0, 1.0) * step(pxu, 0.12);
      float a = cov * mix(0.75, 1.0, inBody);
      o = vec4(col * a, a);
    }`;

  // Round tubes from a to b, their radius going from ra to rb, their colour
  // from ca to cb, lit from above and lighter down their middle: the orange
  // anemones' tentacles and columns, drawn each frame as they sway.
  const CAPS_VS = `
    layout(location = 0) in vec4 ends;
    layout(location = 1) in vec2 radii;
    layout(location = 2) in vec3 colA;
    layout(location = 3) in vec3 colB;
    uniform vec2 res;
    out vec2 w;
    flat out vec4 e;
    flat out vec2 r;
    flat out vec3 ca;
    flat out vec3 cb;
    void main() {
      vec2 a = ends.xy, b = ends.zw;
      vec2 d = b - a;
      float len = length(d);
      vec2 t = len > 0.0 ? d / len : vec2(1.0, 0.0);
      vec2 n = vec2(-t.y, t.x);
      float m = max(radii.x, radii.y) + 1.5;
      vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
      w = mix(a - t * m, b + t * m, c.x) + n * m * (c.y * 2.0 - 1.0);
      e = ends;
      r = radii;
      ca = colA;
      cb = colB;
      gl_Position = vec4(w.x / res.x * 2.0 - 1.0, 1.0 - w.y / res.y * 2.0, 0.0, 1.0);
    }`;
  const CAPS_FS = `
    in vec2 w;
    flat in vec4 e;
    flat in vec2 r;
    flat in vec3 ca;
    flat in vec3 cb;
    out vec4 o;
    void main() {
      vec2 a = e.xy, ba = e.zw - e.xy;
      float h = clamp(dot(w - a, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
      float rad = max(mix(r.x, r.y, h), 0.5);
      vec2 off = w - a - ba * h;
      float cov = clamp(0.5 - (length(off) - rad), 0.0, 1.0);
      if (cov <= 0.0) discard;
      // Shaded by the distance from its axis (not from its ends), so where
      // one tube runs on into the next no seam shows.
      vec2 dir = normalize(ba + vec2(1e-5, 0.0));
      vec2 nrm = vec2(-dir.y, dir.x) * dot(w - a, vec2(-dir.y, dir.x)) / rad;
      float x = min(length(nrm), 1.0);
      float sh = 0.5 + 0.45 * sqrt(1.0 - x * x) + 0.2 * clamp(-nrm.y, 0.0, 1.0);
      o = vec4(mix(ca, cb, h) * sh * cov, cov);
    }`;

  // The water, the scenery and fish laid over it in their order, the light,
  // the specks and the glowing things.
  const WATER_FS = VizGL.NOISE + COMMON + `
    in vec2 uv;
    uniform sampler2D far, mid, near, lit, life, fishFar, fishMid, jelly, glow;
    uniform vec2 res;
    uniform float time, light, flash, shafts, scenery;
    out vec4 o;

    // The web of light the waves above focus onto the reef and the rock.
    float web(vec2 p, float t) {
      vec2 g = floor(p);
      float f1 = 9.0, f2 = 9.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 c = g + vec2(float(i), float(j));
          vec2 h = vec2(hash12(c), hash12(c + 19.7));
          vec2 pt = c + 0.5 + 0.4 * sin(t * (0.6 + 0.5 * h) + h * 6.2831);
          float d = length(p - pt);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
      }
      return 1.0 - smoothstep(0.0, 0.09, f2 - f1);
    }

    vec3 over(vec3 col, vec4 layer) { return col * (1.0 - layer.a) + layer.rgb; }

    void main() {
      float asp = res.x / res.y;
      vec2 p = vec2(uv.x * asp, uv.y);
      vec3 water = waterAt(uv);
      vec3 col = water;
      // Shafts of light from the surface, slanting, waving: some of it
      // behind everything, more in front of what is nearer.
      float x = p.x + (1.0 - uv.y) * 0.35;
      float s = fbm(vec2(x * 2.6 + time * 0.03, time * 0.07));
      float beams = pow(smoothstep(0.35, 0.85, s), 2.0) * pow(uv.y, 1.4) * shafts * light;
      vec3 beam = vec3(0.25, 0.55, 0.65) * beams * 0.55;
      col += beam * 0.5;
      col = over(col, texture(far, uv) * scenery);
      vec4 ff = texture(fishFar, uv);
      col = over(col, vec4(mix(ff.rgb, water * ff.a, 0.55), ff.a));
      vec4 m = texture(mid, uv) * scenery;
      vec4 n = texture(near, uv) * scenery;
      vec4 lf = texture(life, uv);
      if (m.a + n.a + lf.a > 0.0) {
        vec2 cp = p * vec2(1.0, 0.75) * 24.0;
        cp += 0.6 * vec2(vnoise(cp * 0.3 + time * 0.2), vnoise(cp * 0.3 - time * 0.17 + 5.0));
        float cs = 0.6 * web(cp, time * 0.9) + 0.4 * web(cp * 1.3 + 7.0, time * 1.2);
        cs *= (0.35 + 0.65 * shafts) * light * smoothstep(-0.1, 0.6, uv.y);
        vec2 lt = texture(lit, uv).rg;
        m.rgb *= 1.0 + 0.8 * cs * lt.g;
        n.rgb *= 1.0 + 1.0 * cs * lt.r;
        lf.rgb *= 1.0 + 0.3 * cs * lt.r;
      }
      col = over(col, m);
      vec4 fm = texture(fishMid, uv);
      col = over(col, vec4(mix(fm.rgb, water * fm.a, 0.3), fm.a));
      col += beam * 0.3;
      col = over(col, n);
      col = over(col, lf);
      col += beam * 0.2;
      // The surface's shimmer at the very top.
      col += vec3(0.2, 0.45, 0.5) * pow(uv.y, 12.0) * (0.6 + 0.4 * vnoise(vec2(p.x * 20.0, time))) * shafts;
      // Marine snow: specks in three depths, sinking slowly, a few flashing on the kicks.
      for (int k = 0; k < 3; k++) {
        float fk = float(k);
        float sc = 70.0 - fk * 18.0;
        vec2 sp = p * sc + vec2(sin(time * 0.1 + fk) * 0.5, time * (0.25 + fk * 0.12));
        vec2 cell = floor(sp);
        vec2 f = fract(sp) - vec2(hash12(cell), hash12(cell + 7.0));
        float h = hash12(cell + 13.0 + fk * 5.0);
        float d = length(f);
        float speck = smoothstep(0.06 + fk * 0.02, 0.0, d) * step(0.55, h) * (0.15 + 0.15 * fk);
        float glowk = step(0.97, h) * flash;
        col += vec3(0.5, 0.75, 0.8) * speck * (0.6 + 0.6 * beams) + vec3(0.3, 1.0, 0.9) * glowk * smoothstep(0.15, 0.0, d);
      }
      col += texture(jelly, uv).rgb + texture(glow, uv).rgb * 1.1;
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
      // The scenery's shaders compile in the background (the first time,
      // before the browser has them cached, that takes a while): the water
      // and what moves in it start at once, the scenery fades in when ready.
      this.sceneProgs = [0, 1, 2, 3].map((i) => VizGL.programLater(gl, VizGL.SCREEN_VS, sceneFs(i)));
      this.water = VizGL.program(gl, VizGL.SCREEN_VS, WATER_FS);
      this.fish = VizGL.program(gl, FISH_VS, FISH_FS);
      // One quad per fish: its two vec4s step once per instance.
      this.fishBuf = VizGL.stream(gl, [[0, 4], [1, 4]], MAX_FISH);
      gl.bindVertexArray(this.fishBuf.vao);
      gl.vertexAttribDivisor(0, 1);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);
      this.caps = VizGL.program(gl, CAPS_VS, CAPS_FS);
      this.capBuf = VizGL.stream(gl, [[0, 4], [1, 2], [2, 3], [3, 3]], MAX_CAPS);
      gl.bindVertexArray(this.capBuf.vao);
      for (let i = 0; i < 4; i += 1) gl.vertexAttribDivisor(i, 1);
      gl.bindVertexArray(null);
      this.lines = VizGL.lines(gl, 60000);
      this.jellies = [];
      this.orange = [];
      this.schools = [];
      this.tips = [];
      this.nextSchool = 0;
      this.age = 0;
      this.ph = 0;
      this.beatN = 0;
      this.flash = 0;
      this.flinch = 0;
      this.palette = null;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.t, this.b1, this.b2, this.fishFar, this.fishMid, this.life, ...(this.layers || [])]) VizGL.freeTarget(gl, t);
      this.t = VizGL.target(gl, w, h);
      const sw = Math.max(1, Math.round(w / 4));
      const sh = Math.max(1, Math.round(h / 4));
      this.b1 = VizGL.target(gl, sw, sh);
      this.b2 = VizGL.target(gl, sw, sh);
      // The far fish at half the size: softer, as far things are.
      this.fishFar = VizGL.target(gl, Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)), { half: false });
      this.fishMid = VizGL.target(gl, w, h, { half: false });
      this.life = VizGL.target(gl, w, h, { half: false });
      // The scenery, once for this size (empty until its shaders are ready).
      this.layers = [0, 1, 2, 3].map(() => VizGL.target(gl, w, h, { half: false }));
      for (const t of this.layers) {
        VizGL.into(gl, t);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      this.baked = false;
      this.sizedAt = this.age;
      // Ready already (cached, or a new size): there at once, no fading in.
      if (this.sceneProgs.every((sp) => sp.ready())) this._bake(true);
      this.jellies = [];
      this.schools = [];
      this.orange = this._orange();
      this.nextSchool = 4 + Math.random() * 6;
      this.fresh = true;
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    /** Draws the scenery into its layers; at once: without fading it in. */
    _bake(atOnce) {
      const gl = this.gl;
      gl.disable(gl.BLEND);
      this.sceneProgs.forEach((sp, i) => {
        const { p, u } = sp.done();
        gl.useProgram(p);
        gl.uniform2f(u.res, this.w, this.h);
        gl.uniform1i(u.loops, 1);
        VizGL.into(gl, this.layers[i]);
        VizGL.screen(gl);
      });
      this.baked = true;
      this.bakedAt = atOnce ? -1e3 : this.age;
    }

    /** A jellyfish, somewhere below (or anywhere, at the start). */
    _jelly(anywhere) {
      const z = 0.35 + Math.random() * 0.65;
      const R = this.h * (0.035 + 0.04 * z) * (0.8 + Math.random() * 0.4);
      const j = {
        z,
        R,
        x: Math.random() * this.w,
        y: anywhere ? Math.random() * this.h * 1.1 : this.h + R * 2 + Math.random() * this.h * 0.3,
        vx: 0,
        vy: 0,
        tilt: (Math.random() - 0.5) * 0.4,
        hue: this._hue(),
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

    _hue() {
      const hues = PALETTES[this.palette];
      return hues ? hues[Math.floor(Math.random() * hues.length)] : Math.random();
    }

    /**
     * The big orange anemones: two on the reef's top, one on its wall,
     * one lower down its face (smaller, hazier). Each a column, its
     * tentacles crowding up out of the disc on top, the back ones darker.
     */
    _orange() {
      const wallX = (y) => {
        let lo = 0.38;
        let hi = 0.8;
        for (let i = 0; i < 14; i += 1) {
          const m = (lo + hi) / 2;
          if (reefTop(m) > y) lo = m;
          else hi = m;
        }
        return (lo + hi) / 2;
      };
      const spots = [[0.1, 0.004], [0.34, 0.035]].map(([x, down]) => (
        { x, y: reefTop(x) - down, H: 0.08 + Math.random() * 0.025, fog: 0.06, lean: (Math.random() - 0.5) * 0.25 }
      ));
      const wy = 0.26 + Math.random() * 0.05;
      spots.push({ x: wallX(wy) - 0.012, y: wy, H: 0.06, fog: 0.2, lean: 0.6 });
      spots.push({ x: FACE_ANEMONE[0], y: FACE_ANEMONE[1], H: 0.05, fog: 0.35, lean: (Math.random() - 0.5) * 0.3 });
      return spots.map((s) => ({
        ...s,
        band: Math.floor(Math.random() * 3),
        ph: Math.random() * 10,
        tentacles: Array.from({ length: 30 }, () => {
          const u = Math.random() * 2 - 1;
          return { u, z: Math.random(), len: 0.8 + Math.random() * 0.35, spread: u * 0.75 + (Math.random() - 0.5) * 0.3, ph: Math.random() * 6.28 };
        }).sort((p, q) => p.z - q.z),
      }));
    }

    /** The orange anemones, swaying in the current, their tips brighter with the music. */
    _drawOrange(a) {
      const gl = this.gl;
      const h = this.h;
      const d = this.capBuf.data;
      let n = 0;
      const cap = (ax, ay, bx, by, ra, rb, ca, cb) => {
        if (n >= MAX_CAPS) return;
        d.set([ax, ay, bx, by, ra, rb, ca[0], ca[1], ca[2], cb[0], cb[1], cb[2]], n * 12);
        n += 1;
      };
      // The water's colour at a height (screen heights up), as the shaders have it.
      const water = (y) => {
        const k = Math.max(0, Math.min(1, y)) ** 1.6;
        return [0.03 * k, 0.016 + 0.184 * k, 0.04 + 0.25 * k];
      };
      const mixc = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
      const sway = a.playing ? 0.07 + 0.06 * a.intensity : 0.05;
      this.tips = [];
      for (const an of this.orange) {
        const H = an.H * h;
        const bx = an.x * h;
        const by = (1 - an.y) * h;
        const ux = Math.sin(an.lean);
        const uy = -Math.cos(an.lean);
        const rx = -uy;
        const ry = ux;
        const deep = 0.55 + 0.45 * Math.min(1, Math.max(0, an.y / 0.4));
        const wc = water(an.y + an.H * 0.5);
        const fog = (c) => mixc(scale(c, deep), wc, an.fog);
        const lv = a.playing ? this._band(a, an.band) : 0;
        const tip = fog(scale([1.0, 0.78, 0.42], 1.0 + 0.3 * lv));
        const body = fog([1.0, 0.36, 0.04]);
        const Hc = H * 0.36;
        const tx = bx + ux * Hc;
        const ty = by + uy * Hc;
        const rTop = H * 0.15;
        const link = (H * 0.66 * (1 - 0.15 * this.flinch)) / 5;
        const tentacle = (t) => {
          const shade = 0.5 + 0.5 * t.z;
          const c0 = scale(body, shade);
          const c1 = scale(tip, 0.75 + 0.25 * shade);
          let x = tx + rx * t.u * rTop * 0.9 - ux * H * 0.02;
          let y = ty + ry * t.u * rTop * 0.9 - uy * H * 0.02;
          let ang = an.lean + t.spread;
          for (let k = 0; k < 5; k += 1) {
            ang += t.spread * 0.12 + sway * Math.sin(this.age * 1.1 + t.ph - k * 0.55) * ((k + 1) / 5) + 0.04 * Math.sin(this.age * 0.4 + an.ph);
            const nx = x + Math.sin(ang) * link * t.len;
            const ny = y - Math.cos(ang) * link * t.len;
            const ra = H * 0.05 * (1 - 0.1 * (k / 5));
            const rb = H * 0.05 * (1 - 0.1 * ((k + 1) / 5));
            cap(x, y, nx, ny, ra, rb, mixc(c0, c1, (k / 5) ** 4), mixc(c0, c1, ((k + 1) / 5) ** 4));
            x = nx;
            y = ny;
          }
          if (t.z >= 0.45) this.tips.push([x, y, H * 0.05, lv * (1 - an.fog)]);
        };
        an.tentacles.filter((t) => t.z < 0.45).forEach(tentacle);
        // Its column: deeper red, flaring a little to the disc.
        cap(bx - ux * H * 0.03, by - uy * H * 0.03, tx, ty, H * 0.11, rTop, fog([0.5, 0.12, 0.06]), fog([0.78, 0.22, 0.08]));
        an.tentacles.filter((t) => t.z >= 0.45).forEach(tentacle);
      }
      VizGL.into(gl, this.life);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!n) return;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.caps.p);
      gl.uniform2f(this.caps.u.res, this.w, this.h);
      this.capBuf.put(n);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    /**
     * A school of fish (or one or two alone) crossing, far off or nearer;
     * entering from a side, or anywhere on its way (at the start).
     */
    _school(anywhere) {
      const h = this.h;
      const far = Math.random() < 0.55;
      const solo = Math.random() < 0.3;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const n = solo ? 1 + (Math.random() < 0.35 ? 1 : 0) : 14 + Math.floor(Math.random() * 30);
      const len = h * (far ? 0.009 : 0.016) * (solo ? 2.2 : 1) * (0.85 + Math.random() * 0.3);
      const speed = h * (far ? 0.045 : 0.07) * (solo ? 0.75 : 1) * (0.85 + Math.random() * 0.3);
      const spreadX = solo ? len * 5 : len * Math.sqrt(n) * 2.4;
      const spreadY = spreadX * 0.4;
      const members = Array.from({ length: n }, () => {
        const r = Math.sqrt(Math.random());
        const an = Math.random() * Math.PI * 2;
        return {
          ox: Math.cos(an) * r * spreadX,
          oy: Math.sin(an) * r * spreadY,
          ph: Math.random() * Math.PI * 2,
          wag: Math.random() * Math.PI * 2,
          wagF: (solo ? 1.6 : 3) + Math.random() * 1.5,
          sz: 0.85 + Math.random() * 0.3,
          shade: 0.85 + Math.random() * 0.3,
        };
      });
      const edge = spreadX + len * 3;
      return {
        far,
        dir,
        len,
        speed,
        members,
        spreadX,
        edge,
        x: anywhere ? this.w * (0.25 + Math.random() * 0.5) : (dir > 0 ? -edge : this.w + edge),
        y0: h * (far ? 0.3 + Math.random() * 0.4 : 0.22 + Math.random() * 0.36),
        seed: Math.random() * 100,
        t: 0,
        flashT: 9,
        turn: Math.random() < 0.5 ? 1 : -1,
      };
    }

    /** The school's path's height a while (t) into its crossing. */
    _pathY(g, t) {
      return g.y0 + this.h * (0.04 * Math.sin(t * 0.23 + g.seed) + 0.025 * Math.sin(t * 0.13 + g.seed * 2));
    }

    _fish(a, dt) {
      const gl = this.gl;
      const on = Visualizer.setting('dsFish');
      if (!on) this.schools = [];
      else {
        this.nextSchool -= dt;
        if (this.fresh && Math.random() < 0.6) this.schools.push(this._school(true));
        if (this.nextSchool <= 0 && this.schools.length < 3) {
          this.schools.push(this._school(false));
          this.nextSchool = 8 + Math.random() * 14;
        }
      }
      const pace = a.playing ? 1 + 0.25 * a.intensity : 0.6;
      const strong = a.playing && a.onset && a.onsetPower > 0.5;
      const data = this.fishBuf.data;
      const counts = [0, 0];
      const batches = [[], []];
      for (const g of this.schools) {
        g.t += dt * pace;
        g.x += g.dir * g.speed * pace * dt;
        g.flashT += dt;
        // A strong beat ripples through a school: its fish turn, catching the light.
        if (strong && g.flashT > 1.5 && g.members.length > 2 && Math.random() < 0.6) {
          g.flashT = 0;
          g.turn = -g.turn;
        }
        batches[g.far ? 0 : 1].push(g);
      }
      this.schools = this.schools.filter((g) => (g.dir > 0 ? g.x - g.edge < this.w : g.x + g.edge > 0));

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.fish.p);
      gl.uniform2f(this.fish.u.res, this.w, this.h);
      [this.fishFar, this.fishMid].forEach((target, depth) => {
        VizGL.into(gl, target);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        let k = 0;
        for (const g of batches[depth]) {
          for (const m of g.members) {
            if (counts[depth] >= MAX_FISH) break;
            // Each follows the path where the leader was (or will be).
            const lag = (-m.ox * g.dir) / g.speed;
            const tt = g.t - lag;
            const y = this._pathY(g, tt) + m.oy + Math.cos(g.t * 0.37 + m.ph * 1.3) * g.len * 0.5;
            const x = g.x + m.ox + Math.sin(g.t * 0.5 + m.ph) * g.len * 0.8;
            const vy = (this._pathY(g, tt + 0.1) - this._pathY(g, tt)) / 0.1;
            const e = g.flashT - (m.ox / g.spreadX * 0.5 + 0.5) * 0.35;
            const sheen = (e >= 0 ? Math.exp(-e * 4) : 0) + 0.12 * Math.max(0, Math.sin(g.t * 1.3 + m.ph)) ** 8;
            const tilt = Math.atan2(vy, g.speed) + 0.35 * sheen * g.turn + 0.05 * Math.sin(m.wag * 0.5);
            m.wag += dt * m.wagF * Math.PI * 2 * pace;
            data[k] = x;
            data[k + 1] = y;
            data[k + 2] = g.len * m.sz;
            data[k + 3] = tilt;
            data[k + 4] = g.dir;
            data[k + 5] = Math.sin(m.wag);
            data[k + 6] = Math.min(1, sheen);
            data[k + 7] = m.shade;
            k += 8;
            counts[depth] += 1;
          }
        }
        if (!counts[depth]) return;
        gl.uniform1f(this.fish.u.scale, this.w / target.w);
        this.fishBuf.put(counts[depth]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, counts[depth]);
        gl.bindVertexArray(null);
      });
      gl.disable(gl.BLEND);
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

    /** How loud part `band` (of 6) of the spectrum is. */
    _band(a, band) {
      const from = Math.floor((band / 6) * a.BANDS * 0.9);
      const to = Math.floor(((band + 1) / 6) * a.BANDS * 0.9);
      let lv = 0;
      for (let k = from; k < to; k += 1) lv += a.dynamic[k];
      return lv / (to - from);
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
      if (this.jellies.length > count) this.jellies.length = count;

      // The beat: the tempo's when it is clear.
      const sure = a.playing && a.sure >= 0.35 && a.bpm;
      if (sure) {
        if (a.tick) this.beatN += 1;
        this.ph = a.phase;
      }
      if (a.playing && a.onset) this.flash = Math.max(this.flash, a.onsetPower);
      this.flash *= Math.exp(-dt * 5);
      if (a.playing && a.onset && a.onsetPower > 0.6) this.flinch = Math.max(this.flinch, a.onsetPower);
      this.flinch *= Math.exp(-dt * 2.5);

      // Ready within a moment of starting (cached, or warmed ahead): no fading in either.
      if (!this.baked && this.sceneProgs.every((sp) => sp.ready())) this._bake(this.age - this.sizedAt < 0.3);
      this._fish(a, dt);
      this._drawOrange(a);
      this.fresh = false;

      const l = this.lines;
      // The orange anemones' tips glowing with their part of the spectrum.
      for (const [x, y, r, lv] of this.tips) {
        if (lv > 0.05) l.dot(x, y, r * 1.6, [1, 0.7, 0.35], 0.35 * lv);
      }

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
        const lv = this._band(a, j.band);
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
      VizGL.bind(gl, u.far, this.layers[0].tex, 0);
      VizGL.bind(gl, u.mid, this.layers[1].tex, 1);
      VizGL.bind(gl, u.near, this.layers[2].tex, 2);
      VizGL.bind(gl, u.lit, this.layers[3].tex, 3);
      VizGL.bind(gl, u.fishFar, this.fishFar.tex, 4);
      VizGL.bind(gl, u.fishMid, this.fishMid.tex, 5);
      VizGL.bind(gl, u.jelly, this.t.tex, 6);
      VizGL.bind(gl, u.glow, this.b2.tex, 7);
      VizGL.bind(gl, u.life, this.life.tex, 8);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.light, a.playing ? 0.6 + 0.6 * a.level + 0.3 * a.intensity : 0.5);
      gl.uniform1f(u.flash, this.flash);
      gl.uniform1f(u.shafts, set('dsLight') ? 1 : 0);
      gl.uniform1f(u.scenery, this.baked ? Math.min(1, (this.age - this.bakedAt) / 0.8) : 0);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'deepsea',
    name: 'Deep Sea',
    desc: 'Glowing jellyfish drifting up past a coral reef and an underwater cliff, a wreck far below, fish crossing now and then, all beating with the music',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a8 8 0 0 1 16 0z"/><path d="M7 11c0 3-1 5 0 9M10 11c0 3 1 6 0 10M14 11c0 3-1 6 0 10M17 11c0 3 1 5 0 9"/></svg>',
    gl: true,
    create: (canvas) => new DeepSea(canvas),
    options: [
      { type: 'choice', key: 'dsColors', label: 'Colours', choices: [['aurora', 'Aurora'], ['ember', 'Ember'], ['ice', 'Ice'], ['rainbow', 'Rainbow']] },
      { type: 'slider', key: 'dsCount', label: 'Jellyfish', min: 3, max: MAX, step: 1, unit: '' },
      { type: 'check', key: 'dsLight', label: 'Light from above' },
      { type: 'check', key: 'dsFish', label: 'Fish' },
    ],
  });
})();
