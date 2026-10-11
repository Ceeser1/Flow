'use strict';

// Aurora: the northern lights over dark mountains and a still lake. Three
// curtains of light hang across the sky, rippling and drifting, made of fine
// rays. Each listens to its own part of the music, low to high from left to
// right on a log axis (CURTAINS): the lowest the bass (to 400 Hz), the middle
// one the mids (to 2 kHz), the highest the highs. Where its part is loud the
// curtain glows brighter, and where it is louder than it just was its lower
// edge lifts a little (quieter: dips), easing back as it settles. The
// music's intensity sets how restless they are, and the kicks make them
// flare. Fir trees stand scattered over the hills, and the lake
// mirrors it all, broken by small waves; without it, a meadow with a few
// rocks lies there, their tops and the grass catching the aurora's light.
//
// Its cogwheel: the colours (green, the rarer red and violet, rainbow), how
// restless, how high the curtains shine (Glare), the lake, the stars (faint and bright ones, each twinkling in its
// own time, the brightest with a glare flashing a little with the bass).
//
// WebGL (viz/gl.js): what stands still is drawn once a size (the shore's and
// the mountains' line across, LAND_FS; the trees, TREES_FS, once as they
// stand and once as the lake mirrors them, lighter; the meadow, MEADOW_FS),
// the curtains' lower
// edges once a frame a column (EDGES_FS), their light at half the screen's
// pixels (CURTAINS_FS), the stars ahead (VizGL.starLayer), then one pass
// over the screen putting it together; below the horizon each pixel reads
// the sky where it would be mirrored.

(() => {
  // Each curtain's part of the music, lowest curtain first (Hz; VizAudio's
  // bands start at 30 Hz and end at 16 kHz).
  const CURTAINS = [[30, 400], [400, 2000], [2000, 16000]];
  const ACROSS = 64;       // levels across each curtain
  const LIFT = 0.02;       // the most the edge moves up or down, of the screen (the curtains are 0.08 apart)
  const LIFT_GAIN = 5;     // a level this many times its rise over its average
  const SETTLE_S = 1.2;    // the average each place is measured against
  const SHINE = 0.67;      // how high the curtains shine at Glare 100% (of what they first did)
  const CURTAIN_SCALE = 0.5;   // the curtains' light is drawn at this much of the screen's pixels (soft, so it shows no difference)
  const CURTAINS_FROM = 0.27;  // and from this far up the screen (under the lowest shore)
  const MEADOW_TOP = 0.32;     // the meadow, without the lake, reaches up to the shore, under this

  const PALETTES = {
    // low edge, top
    green: [[0.15, 1.0, 0.45], [0.55, 0.2, 0.9]],
    red: [[1.0, 0.25, 0.35], [0.5, 0.1, 0.8]],
    violet: [[0.55, 0.45, 1.0], [1.0, 0.3, 0.75]],
    rainbow: [[0.2, 1.0, 0.6], [1.0, 0.3, 0.5]],
  };

  // The land's lines across the screen (x 0..1 across it; ridge's x in
  // screen heights), shared by the passes drawing it once.
  const LAND = `
    const float HORIZON = 0.3;

    float ridge(float x) {
      return HORIZON + 0.012 + 0.09 * max(0.0, fbm(vec2(x * 1.4 + 2.0, 1.3)) - 0.3) + 0.012 * vnoise(vec2(x * 11.0, 4.0));
    }

    // Where the water meets the land across the screen (x 0..1): not
    // straight but gently rising and falling, as a real shore does (low on
    // the left, up to around 40%, down past 60% to around 70%, a little
    // rise near 80%, down again to the right), with a little unevenness.
    float shore(float x) {
      float xs[6] = float[](0.0, 0.4, 0.6, 0.7, 0.78, 1.0);
      float ys[6] = float[](-0.6, 0.8, 0.0, -0.5, -0.2, -0.8);
      float y = ys[0];
      for (int i = 0; i < 5; i++) {
        float t = clamp((x - xs[i]) / (xs[i + 1] - xs[i]), 0.0, 1.0);
        if (x >= xs[i]) y = mix(ys[i], ys[i + 1], t * t * (3.0 - 2.0 * t));
      }
      return HORIZON + 0.012 * y + 0.003 * (vnoise(vec2(x * 25.0, 2.0)) - 0.5) + 0.0012 * (vnoise(vec2(x * 110.0, 5.0)) - 0.5);
    }

    // The column this pixel (gl_FragCoord.x) of a pass across the screen
    // works out, on it (0..1): its passes reach margin pixels past each edge,
    // where the lake's waves look.
    uniform float margin;
    float column(vec2 res) {
      return (gl_FragCoord.x - margin) / res.x;
    }`;

  // Once a size, a pixel a column: the shore and the mountains' ridge, above
  // the horizon (kept small, so a half float holds them to a fraction of a
  // pixel).
  const LAND_FS = VizGL.NOISE + LAND + `
    uniform vec2 res;
    out vec4 o;
    void main() {
      float x = column(res);
      o = vec4(shore(x) - HORIZON, ridge(x * res.x / res.y) - HORIZON, 0.0, 1.0);
    }`;

  // Each frame, a pixel a column: each curtain's lower edge as it folds and
  // waves across the sky (from where it hangs; the music's lift is added on
  // the screen).
  const EDGES_FS = VizGL.NOISE + LAND + `
    uniform vec2 res;
    uniform float drift;
    out vec4 o;
    void main() {
      float x = column(res) * res.x / res.y;
      vec3 e;
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        e[i] = 0.07 * sin(x * (1.3 + fi * 0.4) + drift * (0.5 + fi * 0.2) + fi * 2.0)
          + 0.14 * (fbm(vec2(x * 0.7 + fi * 3.7 + drift * 0.4, fi + drift * 0.1)) - 0.5);
      }
      o = vec4(e, 1.0);
    }`;

  // Once a size: the trees (forest()) over the band of the screen they can
  // reach, from y0 (pixels) up; ink as they stand (1) or mirrored (0.65).
  // Each pixel what they make of what lies under them, col: col * a + rgb.
  const TREES_FS = VizGL.NOISE + LAND + `
    uniform vec2 res;
    uniform float y0, ink;
    out vec4 o;

    // The fir trees on the hills, x across (screen heights) and y above the
    // shore; top: the hill's height here, above the shore.
    // Seen from across the lake: DEPTHS rows going back, each smaller and
    // hazier and standing on its own band of the hill's height (the front
    // row the lowest third, mostly on a narrow bank by the water, the back
    // row the highest), every tree anywhere in its band, so they cover the
    // hillside from the water to the top. In clusters
    // with clearings between, each its own size (a few larger all round, up
    // to three times the rest by the water, less so further back), in tiers
    // narrowing to the tip, on a stem. Drawn from the back.
    const int DEPTHS = 3;   // few rows of fair-sized trees rather than thousands of tiny ones
    // Value noise along a line, for the clusters (cheaper than vnoise).
    float noise1(float x) {
      float i = floor(x);
      float f = fract(x);
      return mix(hash12(vec2(i, 7.0)), hash12(vec2(i + 1.0, 7.0)), f * f * (3.0 - 2.0 * f));
    }
    // ink: how much they cover (the water mirrors them lighter). Returns
    // what they make of what lies under them, col: col * a + rgb.
    vec4 forest(float x, float y, float top) {
      vec4 r = vec4(0.0, 0.0, 0.0, 1.0);
      if (y < 0.0 || y > top + 0.08) return r;
      float edge = 1.2 / res.y;
      const float FAR = 1.0 / (1.0 + 0.125 * float(DEPTHS - 1));
      for (int row = DEPTHS - 1; row >= 0; row--) {
        float fr = float(row);
        float scale = 1.0 / (1.0 + 0.125 * fr);      // 1, 0.89, 0.8
        float back = (1.0 - scale) / (1.0 - FAR);      // 0 at the water, 1 the farthest
        // This row's band of the hillside, each tree somewhere in it: the
        // front row the lowest third, the middle one the middle, the back
        // row the top third, up to the top.
        float lo = top * 0.325 * fr;
        float hi = top * min(1.0, 0.35 + 0.325 * fr);
        // Dark brownish green, the stems browner; hazier further back.
        vec3 haze = vec3(0.013, 0.017, 0.028);
        vec3 shade = mix(vec3(0.009, 0.0075, 0.0045), haze, 0.7 * back);
        vec3 wood = mix(vec3(0.022, 0.012, 0.005), haze, 0.7 * back);
        float tallest = 0.026 * scale;
        float w = 0.45 * tallest;
        float cell = floor(x / w);
        float cover = 0.0;
        float bark = 0.0;
        float most = 3.0 - 1.6 * back;                 // the largest a tree here grows
        // Each tree's crown lifted onto a stem in the middle of it, by row
        // (screen pixels): the front 9 high and 3 wide, the middle 6 by 2,
        // the back 3 by 1.
        float px = 1.0 / res.y;
        float lift = (9.0 - 3.0 * fr) * px;
        float stem = lift / 3.0;
        // Nothing of this row reaches here.
        if (y < lo || y > hi + lift + most * tallest) continue;
        for (int k = -2; k <= 2; k++) {
          // The cheap tests first: most trees do not reach this point.
          float c = cell + float(k);
          vec2 id = vec2(c, fr * 17.0);
          float cx = (c + 0.5 + 0.4 * (hash12(id + 8.2) - 0.5)) * w;
          // Most about the same, a few larger all round.
          float grow = 1.0 + (most - 1.0) * pow(hash12(id + 6.4), 6.0);
          float h = tallest * (0.55 + 0.45 * hash12(id + 5.1)) * grow;
          if (abs(x - cx) > max(h * 0.27, stem) + edge) continue;
          // Anywhere in its band; most of the front row on a narrow bank
          // just above the water.
          float up = hash12(id + 2.6);
          float at = row == 0 && hash12(id + 4.7) < 0.55 ? 0.002 + 0.004 * up : mix(max(lo, 0.006), hi, up);
          if (y < at || y > at + lift + h || at > top) continue;
          // In a clearing, or not there anyway.
          float dense = smoothstep(0.2, 0.5, noise1((c + 0.5) * w * 6.0 + fr * 5.3));
          if (hash12(id + 3.3) > dense * (0.92 - 0.15 * back)) continue;   // a little sparser further back
          if (y < at + lift) {
            // The stem, whole pixels wide.
            bark = max(bark, clamp((stem * 0.5 - abs(x - cx)) / px + 0.5, 0.0, 1.0));
            continue;
          }
          float t = (y - at - lift) / h;
          float tiers = 4.0 + floor(3.0 * hash12(id + 9.9));
          float wide = h * 0.26 * (1.0 - t) * (0.62 + 0.38 * fract((1.0 - t) * tiers));
          cover = max(cover, smoothstep(-edge, edge, wide - abs(x - cx)) * smoothstep(-edge, edge, h - (y - at - lift)));
        }
        // The stems, then the crowns over them.
        float a = bark * ink;
        r = vec4(r.rgb * (1.0 - a) + wood * a, r.a * (1.0 - a));
        a = cover * ink;
        r = vec4(r.rgb * (1.0 - a) + shade * a, r.a * (1.0 - a));
      }
      return r;
    }

    void main() {
      float x = column(res);
      float y = (gl_FragCoord.y + y0) / res.y;
      float H = shore(x);
      o = forest(x * res.x / res.y, y - H, ridge(x * res.x / res.y) - HORIZON);
    }`;

  // Once a size, from the bottom of the screen up to the shore (MEADOW_TOP of
  // it): the meadow lying there when the lake is off, seen across towards
  // the hills. Dark grass in patches, its blades finer further off and
  // fading into the haze at the foot of the hills, and a few rocks, the
  // nearer ones larger, sunk a little into the grass, a shadow round their
  // feet. rgb its colour; a how much of the aurora's light it gives back
  // (the rocks' tops most, the grass's tips a little), which the screen adds
  // as the curtains glow.
  const MEADOW_FS = VizGL.NOISE + LAND + `
    uniform vec2 res;
    out vec4 o;
    const int ROCKS = 7;

    void main() {
      float aspect = res.x / res.y;
      vec2 p = gl_FragCoord.xy / res;
      float px = 1.0 / res.y;
      float H = shore(p.x);
      // 0 at the foot of the hills, 1 at the bottom of the screen, and how far off.
      float t = clamp((H - p.y) / H, 0.0, 1.0);
      float z = 1.0 / (t + 0.04);
      vec2 g = vec2((p.x - 0.5) * aspect * z, z);
      // Patches, darker and lighter (a little yellow), blades in them.
      float patches = fbm(g * vec2(1.6, 0.7) + 3.0);
      vec3 grass = mix(vec3(0.007, 0.013, 0.008), vec3(0.017, 0.023, 0.010), smoothstep(0.3, 0.75, patches));
      // The blades upright, about 4 by 25 pixels at 1440, seen only near.
      float near = smoothstep(0.05, 0.5, t);
      vec2 b = vec2(p.x * aspect, p.y) * 360.0;
      float blades = vnoise(b * vec2(1.0, 0.16)) * 0.65 + vnoise(b * vec2(0.37, 0.06) + 7.0) * 0.35;
      grass *= mix(1.0, 0.55 + 0.9 * blades, near);
      float sheen = 0.25 * pow(blades, 3.0) * near;
      // Into the haze at the foot of the hills.
      float far = smoothstep(0.0, 0.12, t);
      grass = mix(vec3(0.011, 0.015, 0.024), grass, far);
      sheen *= far;
      vec3 col = grass;
      // The rocks, from the farthest.
      for (int i = 0; i < ROCKS; i++) {
        float fi = float(i);
        float cx = mix(0.06, 0.94, hash12(vec2(fi, 3.1)));
        float at = mix(0.2, 0.95, (fi + hash12(vec2(fi, 5.7))) / float(ROCKS));
        float foot = shore(cx) * (1.0 - at);
        float s = (0.025 + 0.035 * hash12(vec2(fi, 8.3))) * (at + 0.04);
        float wide = 1.0 + 0.7 * hash12(vec2(fi, 1.9));
        float tall = 0.55 + 0.3 * hash12(vec2(fi, 6.2));
        vec2 q = vec2((p.x - cx) * aspect / wide, (p.y - foot) / tall) / s;
        // Leaning to one side, its outline lumpy, its foot hidden in the grass.
        q.x += (hash12(vec2(fi, 4.4)) - 0.5) * 0.6 * q.y;
        float a = atan(q.y, q.x);
        float r = length(q) + 0.16 * (vnoise(vec2(a * 2.0 + fi * 7.0, fi)) - 0.5) + 0.06 * (vnoise(vec2(a * 7.0 + fi * 3.0, fi + 9.0)) - 0.5);
        float edge = px / (s * tall);
        float inside = smoothstep(1.0 + edge, 1.0 - edge, r) * smoothstep(-edge, edge, q.y - 0.25 * blades * near);
        // A shadow round its foot on what lies behind it.
        vec2 f = q * vec2(0.75, 3.0);
        float shadow = 1.0 - 0.6 * exp(-dot(f, f));
        // Round on top, its upper side catching the light, cracks and lichen.
        float up = sqrt(max(0.0, 1.0 - r * r));
        vec3 n = normalize(vec3(q, up + 0.2));
        float grain = vnoise(q * 9.0 + fi * 3.3);
        vec3 stone = mix(vec3(0.007, 0.008, 0.010), vec3(0.016, 0.017, 0.020), grain) * (0.35 + 0.75 * smoothstep(-0.2, 0.9, n.y));
        float lit = 0.1 + 0.9 * smoothstep(0.2, 0.9, n.y);
        col = mix(col * shadow, stone, inside);
        sheen = mix(sheen * shadow, lit * (0.6 + 0.4 * grain), inside);
      }
      o = vec4(col, sheen);
    }`;

  // Each frame, at CURTAIN_SCALE of the screen's pixels: the curtains' light
  // over the sky, from just under the lowest shore up (the lake mirrors no
  // lower), a little past the edges where its waves look.
  const CURTAINS_FS = VizGL.NOISE + `
    uniform sampler2D bands, edges;
    uniform vec2 res;
    uniform vec4 from;   // where this pixel is on the screen (0..1): gl_FragCoord.xy * from.xy + from.zw
    uniform float margin, drift, flare, rainbow, lift, shine;
    uniform vec3 low, high;
    out vec4 o;

    // vnoise along x on the line at row (a whole number): the same, for half the work.
    float vnoise1(float x, float row) {
      float i = floor(x);
      float f = fract(x);
      return mix(hash12(vec2(i, row)), hash12(vec2(i + 1.0, row)), f * f * (3.0 - 2.0 * f));
    }

    void main() {
      vec2 p = gl_FragCoord.xy * from.xy + from.zw;
      float x = p.x * res.x / res.y;
      vec3 col = vec3(0.0);
      // Where each curtain's lower edge folds and waves to here (EDGES_FS).
      vec3 edge = texture(edges, vec2((p.x * res.x + margin) / (res.x + 2.0 * margin), 0.5)).rgb;
      // Three curtains, one behind the other.
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        // Its part of the music here (a row each, low to high across): how
        // loud (r), and how much louder or quieter than it just was (g, 0.5
        // as before).
        vec2 heard = texture(bands, vec2(clamp(p.x, 0.0, 1.0), (fi + 0.5) / 3.0)).rg;
        float level = heard.r;
        // The curtain's lower edge, lifted where its part of the music rises
        // (the lowest clear of the mountains but for rare dips: at 1440
        // pixels high, behind them 0.5% of the time, 157 above them typically).
        float base = 0.47 + fi * 0.08 + edge[i] + lift * (heard.g - 0.5) * 2.0;
        float d = p.y - base;
        float tall = (0.2 + 0.08 * fi) * shine;
        float profile = smoothstep(-0.02, 0.012, d) * exp(-max(d, 0.0) / (tall * 0.35));
        // Below its edge and high above it, too little to see: no rays worked out.
        if (profile > 1.0 / 4096.0) {
          // Fine rays, drifting along, leaning a little as they rise.
          float rx = x + d * 0.25;
          float rays = vnoise1(rx * 70.0 + fi * 13.0 + drift * 3.0, fi) * 0.6 + vnoise1(rx * 23.0 - drift * 1.3, fi + 5.0) * 0.6;
          rays = pow(rays, 1.8);
          float glow = profile * (0.2 + rays) * (0.15 + 1.4 * level + 0.6 * flare) * (1.0 - fi * 0.25);
          vec3 c = mix(low, high, smoothstep(0.0, tall, d));
          if (rainbow > 0.5) c = hsv2rgb(vec3(fract(x * 0.12 + drift * 0.03 + fi * 0.2), 0.7, 1.0));
          col += c * glow * 0.75;
        }
        // Its light on the air below the curtain's edge.
        col += low * exp(min(d, 0.0) * 30.0) * 0.04 * (0.3 + level) * step(d, 0.0);
      }
      o = vec4(col, 1.0);
    }`;

  const FS = VizGL.NOISE + VizGL.STAR_SKY + `
    in vec2 uv;
    uniform sampler2D land, curtains, trees, treesLake, meadow, bands;
    uniform vec2 res;
    uniform vec3 treeBand;   // where the trees' band starts and how high it is (pixels), their margin
    uniform vec4 curtainsAt;   // where a place on the screen is in curtains: p * curtainsAt.xy + curtainsAt.zw
    uniform float time, lake, stars, meadowTop;
    uniform vec3 low;
    out vec4 o;

    const float HORIZON = 0.3;

    // A column's place in the passes across the screen (x 0..1 on it).
    float column(float x) {
      return (x * res.x + treeBand.z) / (res.x + 2.0 * treeBand.z);
    }

    // The shore and the ridge above the horizon at x (LAND_FS).
    vec2 landAt(float x) {
      return texture(land, vec2(column(x), 0.5)).rg;
    }

    vec3 sky(vec2 p) {
      vec3 col = mix(vec3(0.01, 0.02, 0.05), vec3(0.0, 0.004, 0.02), smoothstep(HORIZON, 1.0, p.y));
      if (stars > 0.0) col += starField(p * res) * smoothstep(HORIZON, HORIZON + 0.2, p.y);
      return col + texture(curtains, p * curtainsAt.xy + curtainsAt.zw).rgb;
    }

    void main() {
      float aspect = res.x / res.y;
      vec2 p = uv;
      vec2 here = landAt(p.x);
      float H = HORIZON + here.x;
      vec3 col;
      float wave = 0.0;
      if (lake < 0.5 && p.y < H) {
        // The meadow instead (MEADOW_FS), the rocks' tops and the grass
        // catching the aurora's light as the curtains above glow.
        vec4 g = texture(meadow, vec2(p.x, p.y / meadowTop));
        float x = clamp(p.x, 0.0, 1.0);
        float glow = 0.25 + 0.25 * (texture(bands, vec2(x, 1.0 / 6.0)).r + texture(bands, vec2(x, 0.5)).r + texture(bands, vec2(x, 5.0 / 6.0)).r);
        col = g.rgb + low * g.a * 0.12 * glow;
      } else if (p.y >= H) {
        col = sky(p);
      } else {
        // The lake: the sky mirrored, broken by small waves, darker.
        float depth = (H - p.y) / H;
        wave = (vnoise(vec2(p.x * aspect * 40.0, p.y * 260.0 - time * 0.8)) - 0.5) * 0.012 * (0.3 + depth);
        vec2 m = vec2(p.x + wave, 2.0 * H - p.y + wave * 0.5);
        col = sky(m) * (0.55 - 0.25 * depth);
        col += vec3(0.0, 0.01, 0.02);
      }
      // The mountains, dark against the sky (a little hazy, being far), a
      // little of the aurora's light on their snow.
      float top = H + here.y;
      // The land where the waves move the mirror to (the shore and ridge there).
      vec2 there = landAt(p.x + wave);
      if (p.y < top && p.y > H) {
        float snow = smoothstep(top - 0.03, top, p.y) * 0.5;
        col = vec3(0.013, 0.017, 0.028) + low * snow * 0.04;
      } else if (lake > 0.5 && p.y < H && H - p.y + wave * 0.5 < there.y) {
        // The land mirrored softly, broken by the waves like the rest (the
        // trees on it stand on its reflection), a little more so at the
        // water's edge.
        col = mix(col, vec3(0.008, 0.011, 0.019), mix(0.7, 0.45, smoothstep(0.0, 0.007, H - p.y)));
      }
      // The trees in front (TREES_FS, drawn once), and mirrored in the lake,
      // broken by its waves: read where the mirror shows, as high above
      // the shore there as this pixel is below it here.
      if (p.y >= H) {
        vec4 t = texture(trees, vec2(column(p.x), (p.y * res.y - treeBand.x) / treeBand.y));
        col = col * t.a + t.rgb;
      } else if (lake > 0.5) {
        float y = HORIZON + there.x + H - p.y + wave * 0.5;
        vec4 t = texture(treesLake, vec2(column(p.x + wave), (y * res.y - treeBand.x) / treeBand.y));
        col = col * t.a + t.rgb;
      }
      // A thin glint along the water's edge, where the calm water catches
      // the sky (nothing to see a few pixels off it).
      if (lake > 0.5 && abs(p.y - H) * res.y < 16.0) col += low * 0.035 * (0.5 + 0.5 * vnoise(vec2(p.x * aspect * 90.0, time * 0.3))) * exp(-abs(p.y - H) * res.y / 1.3);
      col = 1.0 - exp(-col * 1.4);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Aurora {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.landProg = VizGL.program(gl, VizGL.SCREEN_VS, LAND_FS);
      this.edgesProg = VizGL.program(gl, VizGL.SCREEN_VS, EDGES_FS);
      this.treesProg = VizGL.program(gl, VizGL.SCREEN_VS, TREES_FS);
      this.curtainsProg = VizGL.program(gl, VizGL.SCREEN_VS, CURTAINS_FS);
      this.meadowProg = VizGL.program(gl, VizGL.SCREEN_VS, MEADOW_FS);
      this.baked = null;   // what stands still, drawn for this size (_bake)
      this.stars = VizGL.starLayer(gl);
      this.bandTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.levels = new Float32Array(3 * ACROSS);
      this.settled = new Float32Array(3 * ACROSS);   // each place's level, averaged over SETTLE_S
      this.bytes = new Uint8Array(3 * ACROSS * 2);    // level, rise
      this.raw = new Float32Array(ACROSS);
      this.drift = Math.random() * 50;
      this.age = 0;
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
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      this._listen(a, dt);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, ACROSS, 3, 0, gl.RG, gl.UNSIGNED_BYTE, this.bytes);

      const restless = set('auActivity') / 100;
      this.drift += dt * restless * (0.08 + 0.5 * a.intensity + 0.3 * a.level) * (a.playing ? 1 : 0.4);
      const pal = PALETTES[set('auColors')] || PALETTES.green;
      const b = this._bake();
      // The curtains' lower edges across, as they fold and wave now.
      gl.disable(gl.BLEND);
      VizGL.into(gl, b.edges);
      gl.useProgram(this.edgesProg.p);
      gl.uniform2f(this.edgesProg.u.res, this.w, this.h);
      gl.uniform1f(this.edgesProg.u.margin, b.margin);
      gl.uniform1f(this.edgesProg.u.drift, this.drift);
      VizGL.screen(gl);
      // The curtains' light, at CURTAIN_SCALE.
      VizGL.into(gl, b.curtains);
      gl.useProgram(this.curtainsProg.p);
      const cu = this.curtainsProg.u;
      VizGL.bind(gl, cu.bands, this.bandTex, 0);
      VizGL.bind(gl, cu.edges, b.edges.tex, 1);
      gl.uniform2f(cu.res, this.w, this.h);
      gl.uniform4f(cu.from, ...b.curtainsFrom);
      gl.uniform1f(cu.margin, b.margin);
      gl.uniform1f(cu.drift, this.drift);
      gl.uniform1f(cu.flare, a.kick);
      gl.uniform1f(cu.lift, LIFT);
      gl.uniform1f(cu.shine, SHINE * (set('auGlare') / 100));
      gl.uniform1f(cu.rainbow, set('auColors') === 'rainbow' ? 1 : 0);
      gl.uniform3f(cu.low, ...pal[0]);
      gl.uniform3f(cu.high, ...pal[1]);
      VizGL.screen(gl);
      // The sky's stars from just under the horizon up (mirrored in the
      // lake too), and a little past the edges where its waves reach.
      const stars = set('auStars');
      const below = Math.floor(this.h * 0.28);
      if (stars) this.stars.draw(-24, below, this.w + 48, this.h - below + 24, this.age, a.kick);
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.curtains, b.curtains.tex, 0);
      VizGL.bind(gl, u.land, b.land.tex, 2);
      VizGL.bind(gl, u.trees, b.trees.tex, 3);
      VizGL.bind(gl, u.treesLake, b.treesLake.tex, 4);
      VizGL.bind(gl, u.meadow, b.meadow.tex, 5);
      VizGL.bind(gl, u.bands, this.bandTex, 6);
      gl.uniform1f(u.meadowTop, b.meadow.h / this.h);
      gl.uniform3f(u.treeBand, b.y0, b.band, b.margin);
      gl.uniform4f(u.curtainsAt, ...b.curtainsAt);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.time, this.age);
      this.stars.use(u, 1);
      gl.uniform1f(u.lake, set('auLake') ? 1 : 0);
      gl.uniform1f(u.stars, stars ? 1 : 0);
      gl.uniform3f(u.low, ...pal[0]);
      VizGL.screen(gl);
    }

    /**
     * What stands still, drawn once for this size (again when it changes):
     * the shore and the ridge a column (land), the trees as they stand and
     * as the lake mirrors them (trees, treesLake: their band, y0 up, band
     * high), all reaching margin pixels past the edges for the waves; the
     * meadow lying where the lake is when it is off (meadow); and
     * the targets the curtains' edges (edges) and their light (curtains) are
     * drawn into each frame, with where a pixel of curtains is on the
     * screen (curtainsFrom) and where a place on the screen is in it
     * (curtainsAt), as CURTAINS_FS and FS take them.
     */
    _bake() {
      const gl = this.gl;
      const { w, h } = this;
      let b = this.baked;
      if (b && b.w === w && b.h === h) return b;
      if (b) for (const t of [b.land, b.edges, b.curtains, b.trees, b.treesLake, b.meadow]) VizGL.freeTarget(gl, t);
      // The waves move the mirror under 0.8% of the width; the trees reach
      // from under the lowest shore (0.29 of the height) to under 0.48.
      const margin = Math.ceil(w * 0.01) + 1;
      const y0 = Math.floor(h * 0.27);
      const band = Math.ceil(h * 0.5) - y0;
      const cols = w + 2 * margin;
      // The curtains: across inner pixels and past the edges by theirs.
      const inner = Math.max(1, Math.round(w * CURTAIN_SCALE));
      const past = Math.ceil(margin * CURTAIN_SCALE);
      const high = Math.max(1, Math.round(h * (1 - CURTAINS_FROM) * CURTAIN_SCALE));
      const across = inner + 2 * past;
      b = this.baked = {
        w, h, margin, y0, band,
        curtainsFrom: [1 / inner, (1 - CURTAINS_FROM) / high, -past / inner, CURTAINS_FROM],
        curtainsAt: [inner / across, 1 / (1 - CURTAINS_FROM), past / across, -CURTAINS_FROM / (1 - CURTAINS_FROM)],
        land: VizGL.target(gl, cols, 1),
        edges: VizGL.target(gl, cols, 1),
        curtains: VizGL.target(gl, across, high),
        trees: VizGL.target(gl, cols, band),
        treesLake: VizGL.target(gl, cols, band),
        meadow: VizGL.target(gl, w, Math.ceil(h * MEADOW_TOP)),
      };
      gl.disable(gl.BLEND);
      VizGL.into(gl, b.land);
      gl.useProgram(this.landProg.p);
      gl.uniform2f(this.landProg.u.res, w, h);
      gl.uniform1f(this.landProg.u.margin, margin);
      VizGL.screen(gl);
      VizGL.into(gl, b.meadow);
      gl.useProgram(this.meadowProg.p);
      gl.uniform2f(this.meadowProg.u.res, w, h);
      VizGL.screen(gl);
      const tp = this.treesProg;
      gl.useProgram(tp.p);
      gl.uniform2f(tp.u.res, w, h);
      gl.uniform1f(tp.u.margin, margin);
      gl.uniform1f(tp.u.y0, y0);
      for (const [t, ink] of [[b.trees, 1], [b.treesLake, 0.65]]) {
        VizGL.into(gl, t);
        gl.uniform1f(tp.u.ink, ink);
        VizGL.screen(gl);
      }
      return b;
    }

    /** Each curtain's levels across, from its part of VizAudio's bands, and their rises, into this.bytes. */
    _listen(a, dt) {
      const n = a.BANDS;
      const span = Math.log(a.MAX_HZ / a.MIN_HZ);
      const raw = this.raw;
      // Up fast, down slowly: light that lingers, an edge that sinks back.
      const up = Math.min(1, dt * 12);
      const down = Math.min(1, dt * 1.5);
      const settle = 1 - Math.exp(-dt / SETTLE_S);
      CURTAINS.forEach(([lo, hi], c) => {
        for (let k = 0; k < ACROSS; k += 1) {
          // The band (fractional) at this frequency: bands sit at
          // MIN_HZ * (MAX_HZ / MIN_HZ) ** ((i + 0.5) / n).
          const hz = lo * (hi / lo) ** ((k + 0.5) / ACROSS);
          const f = Math.max(0, Math.min(n - 1, (Math.log(hz / a.MIN_HZ) / span) * n - 0.5));
          const i = Math.min(n - 2, Math.floor(f));
          const t = f - i;
          const at = (j) => 0.5 * a.smooth[j] + 0.5 * a.dynamic[j];
          raw[k] = at(i) * (1 - t) + at(i + 1) * t;
        }
        for (let k = 0; k < ACROSS; k += 1) {
          // A little of the neighbours, so the edge billows rather than jags.
          const v = 0.25 * raw[Math.max(0, k - 1)] + 0.5 * raw[k] + 0.25 * raw[Math.min(ACROSS - 1, k + 1)];
          const j = c * ACROSS + k;
          const level = (this.levels[j] += (v - this.levels[j]) * (v > this.levels[j] ? up : down));
          const was = (this.settled[j] += (level - this.settled[j]) * settle);
          const rise = Math.max(-1, Math.min(1, (level - was) * LIFT_GAIN));
          this.bytes[j * 2] = Math.round(Math.min(1, level) * 255);
          this.bytes[j * 2 + 1] = Math.round((0.5 + 0.5 * rise) * 255);
        }
      });
    }
  }

  Visualizer.add({
    id: 'aurora',
    name: 'Aurora',
    desc: 'The northern lights over mountains and a still lake, each curtain rising and glowing with its own part of the music: bass, mids and highs',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 10c3-4 6 2 9-2s6 1 9-3M3 14c3-3 6 2 9-1s6 1 9-2"/><path d="M2 21l5-5 3 3 4-5 8 7"/></svg>',
    gl: true,
    create: (canvas) => new Aurora(canvas),
    options: [
      { type: 'choice', key: 'auColors', label: 'Colors', choices: [['green', 'Green'], ['red', 'Red'], ['violet', 'Violet'], ['rainbow', 'Rainbow']] },
      { type: 'slider', key: 'auActivity', label: 'Restless', min: 25, max: 300, step: 5 },
      { type: 'slider', key: 'auGlare', label: 'Glare', min: 50, max: 150, step: 5 },
      { type: 'check', key: 'auLake', label: 'Lake' },
      { type: 'check', key: 'auStars', label: 'Stars' },
    ],
  });
})();
