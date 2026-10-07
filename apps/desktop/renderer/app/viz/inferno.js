'use strict';

// Inferno: the spectrum on fire, and a forest burning on the hill behind it.
// Along the bottom each band feeds the flames above it with heat as loud as it
// is (the bass in the middle and the highs out to the sides, or low to high
// across), the kicks make them flare, and the heat rises, sways and cools into
// tongues of flame. Behind them a hillside rises to its ridge, rows of firs on
// it smaller the further up they stand, every crown on fire with the band
// below it; smoke drifts up into the night, lit from below; sparks of every
// size fly up off the fire and the trees.
//
// Its cogwheel: the flame's colour (fire, blue gas, toxic green, purple, or
// a rainbow across), its height, the layout, the sparks, the forest.
//
// WebGL (viz/gl.js): the forest is drawn once for the screen's size into a
// texture (how much of each pixel a tree covers, how near that tree is, how
// much of it is crown that burns). The heat is a texture at a quarter of the
// screen's size worked on 120 times a second whatever the screen's rate (each
// step: the heat below risen, swayed by noise, spread and cooled, the crowns'
// and the bands' heat added); it carries how near its fire is, so the flames
// up the hill rise slower, whirl finer and die sooner, and nearer trees stand
// dark in front of them. Then all of it is put together on the screen, and
// the sparks drawn over it as soft round dots drawn out along their flight.

(() => {
  const STEP_S = 1 / 120;
  // The flames' height at 100%: the cooling each step allows for (twice what
  // was 100% before ifFlameHeight).
  const TALL = 2;
  const PALETTES = {
    // Each channel comes in from lo to hi heat.
    fire: [[0.02, 0.32, 0.75], [0.55, 1.0, 1.4]],
    blue: [[0.75, 0.32, 0.02], [1.4, 1.0, 0.55]],
    green: [[0.5, 0.02, 0.8], [1.1, 0.55, 1.4]],
    purple: [[0.12, 0.75, 0.02], [0.7, 1.35, 0.6]],
  };
  // The forest: rows of trees from the bottom of the screen up to the ridge,
  // the front row's trees TREE_H of the screen's height, each row further back
  // smaller by 1 / (1 + FAR * depth).
  const ROWS = 18;
  const TREE_H = 0.26;
  const FAR = 5;
  // How strongly the crowns burn, against the bands' flames.
  const BURN = 0.5;
  const MAX_SPARKS = 1400;
  // A spark's quad as two triangles: its corners along and across its flight.
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];

  // The hill's ridge, as a height on the screen (0 bottom, 1 top) across it;
  // the same in the shaders and for the sparks.
  const RIDGE = `
    float ridge(float x) {
      return 0.75 + 0.045 * sin(x * 5.1 + 1.3) + 0.027 * sin(x * 11.7 + 0.4) + 0.01 * sin(x * 27.0 + 2.0);
    }
    // Where a row at depth d (0 front, 1 the ridge) stands: rows near the
    // front far apart on the screen, the far ones crowded under the ridge.
    float groundAt(float x, float d) {
      return ridge(x) * (1.0 - (1.0 - d) * (1.0 - d)) - 0.04 * (1.0 - d);
    }`;
  const ridge = (x) => 0.75 + 0.045 * Math.sin(x * 5.1 + 1.3) + 0.027 * Math.sin(x * 11.7 + 0.4) + 0.01 * Math.sin(x * 27.0 + 2.0);
  const groundAt = (x, d) => ridge(x) * (1 - (1 - d) * (1 - d)) - 0.04 * (1 - d);

  const FOREST_FS = VizGL.NOISE + RIDGE + `
    in vec2 uv;
    uniform float aspect, px;
    out vec4 o;
    const int ROWS = ${ROWS};
    // A fir, at q in its own heights from its foot: how much of the pixel it
    // covers, and how much of that is crown. Some are dead snags, thin and
    // with their tops broken off. The big ones near the front get their
    // detail: drooping layers of branches with gaps between them, a ragged
    // fringe of needles, holes burnt through, rough bark.
    vec2 tree(vec2 q, float seed, float pxu) {
      float u = q.x, v = q.y;
      if (v < -0.1 || v > 1.05 || abs(u) > 0.34) return vec2(0.0);
      float au = abs(u);
      float detail = smoothstep(0.006, 0.002, pxu);
      float dead = step(0.78, fract(seed * 7.13));
      float top = 1.0 - dead * (0.12 + 0.22 * fract(seed * 3.7));
      float trunkW = (0.014 + 0.012 * (1.0 - v)) * (1.0 + 0.3 * detail * (vnoise(vec2(v * 70.0, seed)) - 0.5));
      float trunk = clamp((trunkW - au) / pxu + 0.5, 0.0, 1.0) * step(v, top);
      float tiers = 5.0 + floor(fract(seed * 11.3) * 4.0);
      // The branches droop: further out, the same tier lower down.
      float droop = 0.55 * detail;
      float saw = fract(v * tiers + au * droop * tiers + seed);
      float side = vnoise(vec2(sign(u) * 13.0 + seed * 50.0, v * 22.0));
      float hw = 0.2 * pow(max(1.0 - v / top, 0.0), 0.9) * (0.6 + 0.4 * (1.0 - saw)) * (0.72 + 0.56 * side);
      hw *= mix(1.0, 0.6 * step(0.45, vnoise(vec2(seed * 31.0, v * 14.0))), dead);
      float crown = 0.0;
      if (detail > 0.0) {
        // Needles: the edge ragged at two sizes.
        float fringe = (vnoise(vec2(v * 150.0 + seed * 9.0, sign(u) * 5.0 + au * 40.0)) - 0.5) * 0.3
          + (vnoise(vec2(v * 480.0, sign(u) * 3.0 + au * 120.0 + seed)) - 0.5) * 0.16;
        hw *= 1.0 + fringe * detail;
        crown = clamp((hw - au) / pxu + 0.5, 0.0, 1.0) * step(0.1, v);
        // Each tier in three layers of branches, open between them out
        // towards the tips.
        float layer = fract(v * tiers * 3.0 + au * droop * tiers * 3.0 + seed * 2.0);
        float out_ = smoothstep(0.35, 0.8, au / max(hw, 1e-4));
        float gap = out_ * smoothstep(0.55, 0.85, layer) * (1.0 - smoothstep(0.92, 1.0, layer));
        // Holes burnt through, more in the dead ones.
        float holes = smoothstep(0.6, 0.7, fbm(q * vec2(16.0, 11.0) + seed * 3.0)) * (0.6 + 0.4 * dead);
        crown *= 1.0 - detail * clamp(gap * 0.95 + holes * 0.85, 0.0, 1.0);
      } else {
        crown = clamp((hw - au) / pxu + 0.5, 0.0, 1.0) * step(0.1, v);
      }
      return vec2(max(trunk, crown), crown);
    }
    void main() {
      float X = uv.x * aspect, Y = uv.y;
      // Back to front: coverage, nearness (1 front, less up the hill), crown.
      vec3 acc = vec3(0.0);
      for (int i = ROWS - 1; i >= 0; i--) {
        float fi = float(i);
        float d = fi / float(ROWS - 1);
        float s = 1.0 / (1.0 + ${FAR}.0 * d);
        float H = ${TREE_H} * s;
        float cell = 0.085 * s;
        float g0 = groundAt(uv.x, d);
        float spacing = ridge(uv.x) * 2.0 * (1.0 - d) / float(ROWS - 1) + 0.004;
        if (Y > g0 + H * 1.75 + spacing * 0.5 + 0.01 || Y < g0 - spacing * 0.5 - H * 0.12 - 0.01) continue;
        float c = floor(X / cell);
        float rowCov = 0.0, rowCrown = 0.0;
        for (int k = -2; k <= 2; k++) {
          float id = c + float(k);
          float h = hash12(vec2(id, fi * 7.31 + 0.5));
          if (h > mix(0.42, 0.7, d)) continue;
          float tx = (id + 0.15 + 0.7 * hash12(vec2(id * 1.7, fi + 3.1))) * cell;
          float big = hash12(vec2(id * 3.3, fi + 9.2));
          float th = H * (0.75 + 0.45 * big + 0.5 * pow(big, 8.0));
          float ty = groundAt(tx / aspect, d) + (hash12(vec2(id * 5.1, fi + 1.7)) - 0.5) * spacing * 0.9;
          vec2 t = tree(vec2(X - tx, Y - ty) / th, h * 91.7 + fi, px / th);
          // How much this one burns: some ablaze, many only smouldering.
          float burns = hash12(vec2(id * 2.9, fi + 4.4));
          burns = burns < 0.3 ? 0.08 : pow(burns, 1.6);
          rowCov = max(rowCov, t.x);
          rowCrown = max(rowCrown, t.y * burns);
        }
        acc = mix(acc, vec3(1.0, s, rowCrown), rowCov);
      }
      o = vec4(acc, 1.0);
    }`;

  const SIM_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D prev;
    uniform sampler2D bands;
    uniform sampler2D forest;
    uniform vec2 texel;
    uniform float time, cool, flare, centre, burn;
    out vec4 o;
    float level(float x) {
      x = centre > 0.5 ? abs(x - 0.5) * 2.0 : x;
      return texture(bands, vec2(x * 0.98 + 0.01, 0.5)).r;
    }
    void main() {
      vec2 dx = vec2(texel.x, 0.0);
      // Two fires rising side by side: the bands' flames in front (R), in the
      // chosen colour, and the trees' (B, with how near they are in G), in a
      // fire's own.
      // The bands' flames: where this heat came from, below, swayed sideways
      // by the noise; cooled unevenly into tongues of flame; fed along the
      // bottom.
      float nF = vnoise(vec2(uv.x * 22.0, uv.y * 9.0 - time * 2.6));
      float mF = vnoise(vec2(uv.x * 48.0 + 5.0, uv.y * 24.0 - time * 5.5));
      vec2 fromF = uv - vec2((nF - 0.5) * texel.x * 2.2, texel.y * 1.6);
      float flames = texture(prev, fromF).r * 0.5 + (texture(prev, fromF + dx).r + texture(prev, fromF - dx).r) * 0.25;
      flames -= cool * (0.2 + 1.8 * mF * mF);
      float base = 1.0 - smoothstep(0.0, 0.035, uv.y);
      float feed = (level(uv.x) * 1.05 + flare * 0.25) * (0.6 + 0.8 * mF) * base;
      flames = max(flames, feed);
      // The trees' fire. How near it is (1 in front, down to 1/6 on the
      // ridge): the further, the slower it rises, the finer it whirls, the
      // sooner it cools. Read just below, where the heat coming in is from.
      float s = clamp(texture(prev, uv - vec2(0.0, texel.y)).g, 0.15, 1.0);
      float n = mix(vnoise(vec2(uv.x * 80.0 + 3.0, uv.y * 34.0 - time * 4.0)), nF, s);
      float m = mix(vnoise(vec2(uv.x * 150.0 + 5.0, uv.y * 75.0 - time * 7.0)), mF, s);
      float rise = mix(0.3, 1.0, s);
      vec2 from = uv - vec2((n - 0.5) * texel.x * mix(2.6, 2.2, s), texel.y * 1.6 * rise);
      vec4 c = texture(prev, from);
      vec4 r = texture(prev, from + dx);
      vec4 l = texture(prev, from - dx);
      float heat = c.b * 0.5 + (r.b + l.b) * 0.25;
      // The cold air counts as near, so heat rising into it is not held back.
      float near = mix(1.0, (c.g * c.b * 0.5 + (r.g * r.b + l.g * l.b) * 0.25) / max(heat, 1e-4), smoothstep(0.0, 0.02, heat));
      heat -= cool * (0.2 + 1.8 * m * m) / rise;
      // The crowns on fire, each with the band below it, flickering.
      vec4 f = textureLod(forest, uv, 2.0);
      float flick = vnoise(vec2(uv.x * 90.0, time * 1.3));
      float crowns = f.b * burn * (0.25 + 0.9 * level(uv.x)) * (0.5 + 0.9 * m) * (0.5 + flick);
      if (crowns > heat) {
        heat = crowns;
        near = clamp(f.g / max(f.r, 1e-3), 0.15, 1.0);
      }
      o = vec4(max(flames, 0.0), near, max(heat, 0.0), 1.0);
    }`;

  const OUT_FS = VizGL.NOISE + RIDGE + `
    in vec2 uv;
    uniform sampler2D heat;
    uniform sampler2D forest;
    uniform vec3 lo, hi;
    uniform float rainbow, time, aspect, blaze, trees;
    out vec4 o;
    vec3 colour(float t) {
      if (rainbow > 0.5) {
        vec3 c = hsv2rgb(vec3(fract(uv.x * 0.8 + time * 0.05), 1.0 - smoothstep(0.6, 1.2, t), smoothstep(0.0, 0.55, t)));
        return c;
      }
      return smoothstep(lo, hi, vec3(t));
    }
    // The scene behind burns in a fire's own colours whatever the flames in
    // front are, but for the rainbow, all of it in rainbow (and without the
    // forest the sky follows the flames).
    vec3 real(float t) {
      return smoothstep(vec3(${PALETTES.fire[0].join(', ')}), vec3(${PALETTES.fire[1].join(', ')}), vec3(t));
    }
    vec3 burning(float t) {
      return trees > 0.5 && rainbow < 0.5 ? real(t) : colour(t);
    }
    // The bands' flames: the chosen colour where they are hot, turning to a
    // fire's red as they cool towards their tips (the rainbow stays rainbow).
    vec3 flame(float t) {
      return rainbow > 0.5 ? colour(t) : mix(real(t), colour(t), smoothstep(0.15, 0.6, t));
    }
    // How far up the hill (0 front, 1 the ridge) the ground at height y is.
    float depthAt(float y, float r) {
      return 1.0 - sqrt(1.0 - clamp((y + 0.04) / (r + 0.04), 0.0, 1.0));
    }
    void main() {
      vec2 p = uv;
      float r = ridge(p.x);
      float above = p.y - r;
      // The fire's light on everything: broad, from the heat far below.
      vec4 w4 = textureLod(heat, vec2(p.x, max(p.y - 0.12, 0.0)), 6.0);
      float wide = w4.r + w4.b;
      vec3 ember = burning(0.42);
      // The night, glowing red over the ridge.
      vec3 col = vec3(0.010, 0.007, 0.010) + ember * (0.07 + 0.14 * blaze) * exp(-max(above, 0.0) * 3.5) * (0.4 + 0.6 * trees);
      // Smoke rising, lit from below.
      vec2 sp = vec2(p.x * aspect * 1.5 + time * 0.012, p.y * 2.2 - time * 0.045);
      float smoke = fbm(sp + 0.6 * vec2(fbm(sp * 0.7 + time * 0.02), 0.0));
      float dense = smoothstep(0.42, 0.85, smoke) * (0.35 + 0.65 * smoothstep(-0.25, 0.25, above));
      // Lit from below: bright low down, dark higher up.
      float under = exp(-max(above, 0.0) * 3.0);
      vec3 lit = mix(vec3(0.03, 0.026, 0.026), ember, 0.55) * (0.04 + (2.2 * wide + 0.3 * blaze) * under);
      col = mix(col, lit, dense * 0.85);
      // The hillside: burnt ground, hazier up the hill, with fires smouldering in it.
      vec3 haze = mix(vec3(0.03, 0.024, 0.024), ember, 0.4) * (0.25 + 0.5 * blaze);
      if (trees > 0.5 && above < 0.0) {
        float d = depthAt(p.y, r);
        float s = 1.0 / (1.0 + ${FAR}.0 * d);
        float edge = smoothstep(0.0, 0.0015, -above);
        vec3 ground = mix(vec3(0.016, 0.010, 0.007), haze, 0.1 + 0.45 * d);
        vec2 gp = vec2(p.x * aspect, p.y * 1.8) / (0.2 * s);
        float burns = smoothstep(0.6, 0.8, fbm(gp)) * (0.55 + 0.45 * vnoise(gp * 2.0 + vec2(0.0, -time * 0.8)));
        ground += burning(0.45 + 0.35 * burns) * burns * 0.22 * (1.0 - 0.5 * d);
        col = mix(col, ground, edge);
      }
      // The trees, dark against the fire, lit at their edges by it, embers
      // glowing in their crowns; hazier up the hill.
      vec4 f = texture(forest, uv);
      float cov = f.r * trees;
      float ts = clamp(f.g / max(f.r, 1e-3), 0.15, 1.0);
      float td = (1.0 / ts - 1.0) / ${FAR}.0;
      vec3 bark = mix(vec3(0.012, 0.008, 0.006), haze, 0.7 * td);
      vec4 lg = textureLod(heat, uv, 3.0);
      bark += (flame(min(lg.r, 0.7)) + burning(min(lg.b, 0.7))) * 0.16;
      vec2 cp = gl_FragCoord.xy / (5.0 + 16.0 * ts) + vec2(0.0, -time * 0.4);
      float speck = smoothstep(0.55, 0.85, fbm(cp)) * (0.6 + 0.4 * vnoise(cp * 1.7 + time * 1.2));
      bark += burning(0.45 + 0.4 * speck) * speck * f.b * 0.7;
      col = mix(col, bark, cov);
      // Smoke between here and the back of the hill: the further, the more
      // it greys out, drifting thicker and thinner.
      vec3 veilCol = mix(vec3(0.11, 0.105, 0.105), ember * 0.5, 0.1) * (0.55 + 0.6 * blaze + 0.9 * wide);
      float drift = 0.65 + 0.7 * smoke;
      float far = trees * (above < 0.0 ? depthAt(p.y, r) : 1.0 - smoothstep(0.0, 0.12, above) * 0.6);
      far = mix(far, td, cov);
      float veil = smoothstep(0.1, 1.0, far) * 0.8 * drift;
      col = mix(col, veilCol, clamp(veil, 0.0, 0.9));
      // The fire, hidden where a tree stands in front of it, fainter up the hill.
      vec4 h = texture(heat, uv);
      float hd = (1.0 / clamp(h.g, 0.15, 1.0) - 1.0) / ${FAR}.0;
      // A tree in front of a fire hides most of it, one burning hides its
      // own flames in part, so it stands dark among them. The bands' flames
      // are as near as the front row.
      float hidden = cov * (1.0 - smoothstep(0.0, 0.3, h.g - ts)) * mix(0.75, 0.92, smoothstep(-0.1, 0.15, ts - h.g));
      float hiddenF = cov * (1.0 - smoothstep(0.0, 0.3, 1.0 - ts)) * mix(0.75, 0.92, smoothstep(-0.1, 0.15, ts - 1.0));
      vec3 trees_ = burning(h.b) * (1.0 - 0.85 * hidden) * mix(1.0, 0.7, hd) * (1.0 - clamp(smoothstep(0.1, 1.0, hd) * 0.6 * drift * trees, 0.0, 0.85));
      vec3 flames = flame(h.r) * (1.0 - 0.85 * hiddenF);
      // The trees' fire behind the flames, mostly lost in them where they burn bright.
      vec3 fire = flames + trees_ * (1.0 - 0.6 * smoothstep(0.1, 0.7, h.r));
      // A faint glow of the fire on the air above it.
      vec4 ag = textureLod(heat, uv - vec2(0.0, 0.02), 3.0);
      col += fire + (flame(min(ag.r, 0.6)) + burning(min(ag.b, 0.6))) * 0.25;
      // Faint smoke rising off the flames in front, over their tips.
      vec2 fp = vec2(p.x * aspect * 2.2 + time * 0.03, p.y * 3.0 - time * 0.22);
      float plume = smoothstep(0.45, 0.8, fbm(fp + 0.8 * vec2(vnoise(fp * 0.6 + time * 0.1), 0.0)));
      float fed = smoothstep(0.05, 0.45, textureLod(heat, vec2(p.x, max(p.y - 0.1, 0.0)), 5.0).r);
      vec3 fume = vec3(0.06, 0.055, 0.055) + ember * 0.3 * wide;
      col = mix(col, fume, plume * fed * 0.4);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  // The sparks: a quad each, a round soft dot drawn out along its flight.
  const SPARK_VS = `
    layout(location = 0) in vec2 pos;
    layout(location = 1) in vec2 loc;
    layout(location = 2) in vec2 seg;
    layout(location = 3) in vec4 color;
    uniform vec2 res;
    out vec2 l;
    out vec2 sg;
    out vec4 c;
    void main() {
      l = loc;
      sg = seg;
      c = color;
      gl_Position = vec4(pos.x / res.x * 2.0 - 1.0, 1.0 - pos.y / res.y * 2.0, 0.0, 1.0);
    }`;
  const SPARK_FS = `
    in vec2 l;
    in vec2 sg;
    in vec4 c;
    out vec4 o;
    void main() {
      // sg: half the streak's length and the dot's radius, in pixels.
      float dx = max(abs(l.x) - sg.x, 0.0);
      float r2 = (dx * dx + l.y * l.y) / (sg.y * sg.y);
      float f = exp(-r2 * 1.6) + 0.1 * exp(-sqrt(r2) * 1.1);
      o = vec4(c.rgb * c.a * f, 0.0);
    }`;

  class Inferno {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.sim = VizGL.program(gl, VizGL.SCREEN_VS, SIM_FS);
      this.out = VizGL.program(gl, VizGL.SCREEN_VS, OUT_FS);
      this.trees = VizGL.program(gl, VizGL.SCREEN_VS, FOREST_FS);
      this.spark = VizGL.program(gl, SPARK_VS, SPARK_FS);
      this.sparkBuf = VizGL.stream(gl, [[0, 2], [1, 2], [2, 2], [3, 4]], MAX_SPARKS * 6);
      this.bandTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.bandBytes = null;
      this.owed = 0;
      this.age = 0;
      this.sparks = [];
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.a, this.b, this.forest]) VizGL.freeTarget(gl, t);
      const sw = Math.max(64, Math.round(w / 4));
      const sh = Math.max(36, Math.round(h / 4));
      // Mipmapped for the glow, so not clamped to the edge's texel only.
      this.a = VizGL.target(gl, sw, sh);
      this.b = VizGL.target(gl, sw, sh);
      // The forest, drawn once; mipmapped for the heat to read at its size.
      this.forest = VizGL.target(gl, w, h, { half: false });
      gl.disable(gl.BLEND);
      VizGL.into(gl, this.forest);
      gl.useProgram(this.trees.p);
      gl.uniform1f(this.trees.u.aspect, w / h);
      gl.uniform1f(this.trees.u.px, 1 / h);
      VizGL.screen(gl);
      gl.bindTexture(gl.TEXTURE_2D, this.forest.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      this.age += dt;
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      const forest = set('ifForest') ? 1 : 0;

      // The bands, as a row of bytes: louder and jumpier than the bars, mixed.
      const n = a.BANDS;
      if (!this.bandBytes) this.bandBytes = new Uint8Array(n);
      let sum = 0;
      for (let i = 0; i < n; i += 1) {
        const v = 0.55 * a.smooth[i] + 0.6 * a.dynamic[i] * a.smooth[i] ** 0.5;
        this.bandBytes[i] = Math.max(0, Math.min(255, Math.round(v * 220)));
        sum += a.smooth[i];
      }
      // How big the fire is overall, for the glow on the sky and the smoke.
      this.blaze = (this.blaze || 0) + (Math.min(1, (sum / n) * 2.2) - (this.blaze || 0)) * Math.min(1, dt * 3);
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, n, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this.bandBytes);

      // The fire, 120 steps a second: rising and swaying twice as fast as it
      // first did (each step lifts the heat as far and cools it as much as
      // before, so the flames stand as tall; the sway's noise runs twice as
      // fast).
      const height = (set('ifFlameHeight') / 100) * TALL;
      // With the forest behind, the flames a little lower, to leave it in sight.
      const cool = (0.02 / height) * (forest ? 1.3 : 1);
      this.owed = Math.min(8, this.owed + dt / STEP_S);
      gl.disable(gl.BLEND);
      gl.useProgram(this.sim.p);
      const u = this.sim.u;
      while (this.owed >= 1) {
        this.owed -= 1;
        VizGL.into(gl, this.b);
        VizGL.bind(gl, u.prev, this.a.tex, 0);
        VizGL.bind(gl, u.bands, this.bandTex, 1);
        VizGL.bind(gl, u.forest, this.forest.tex, 2);
        gl.uniform2f(u.texel, 1 / this.a.w, 1 / this.a.h);
        gl.uniform1f(u.time, this.age * 2);
        gl.uniform1f(u.cool, cool);
        gl.uniform1f(u.flare, a.kick);
        gl.uniform1f(u.centre, set('ifLayout') === 'centre' ? 1 : 0);
        gl.uniform1f(u.burn, BURN * forest);
        VizGL.screen(gl);
        [this.a, this.b] = [this.b, this.a];
      }
      gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);

      // Onto the screen.
      VizGL.into(gl, null);
      gl.useProgram(this.out.p);
      const o = this.out.u;
      VizGL.bind(gl, o.heat, this.a.tex, 0);
      VizGL.bind(gl, o.forest, this.forest.tex, 1);
      const palette = set('ifColor');
      const p = PALETTES[palette] || PALETTES.fire;
      gl.uniform3f(o.lo, ...p[0]);
      gl.uniform3f(o.hi, ...p[1]);
      gl.uniform1f(o.rainbow, palette === 'rainbow' ? 1 : 0);
      gl.uniform1f(o.time, this.age);
      gl.uniform1f(o.aspect, this.w / this.h);
      gl.uniform1f(o.blaze, this.blaze);
      gl.uniform1f(o.trees, forest);
      VizGL.screen(gl);
      gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

      if (set('ifEmbers')) this._sparks(a, dt, palette, p, forest);
    }

    /**
     * Sparks flying up off the loudest bands and off the burning trees, more
     * on the kicks: most of them tiny and quick to die, some bright, a few
     * big embers drifting up slowly; white-hot at first, cooling to red.
     */
    _sparks(a, dt, palette, p, forest) {
      const { w, h } = this;
      const unit = h / 1080;
      const centre = Visualizer.setting('ifLayout') === 'centre';
      const born = a.playing ? (120 + 320 * a.kick + (a.onset ? 150 * a.onsetPower : 0)) * dt : 0;
      this._owedSparks = Math.min(12, (this._owedSparks || 0) + born);
      // Where along the screen the fire is: a band picked by how loud it is.
      const loudX = () => {
        let i = 0;
        for (let k = 0; k < 6; k += 1) {
          const j = Math.floor(Math.random() * a.BANDS);
          if (a.smooth[j] > a.smooth[i]) i = j;
        }
        const x = i / a.BANDS;
        return [centre ? 0.5 + (Math.random() < 0.5 ? -1 : 1) * x * 0.5 : x, a.smooth[i]];
      };
      while (this._owedSparks >= 1 && this.sparks.length < MAX_SPARKS) {
        this._owedSparks -= 1;
        const [x, loud] = loudX();
        // Off the trees up the hill (nearer rows less often, there are fewer
        // of them) or off the flames in front.
        let d = 0;
        let y = h * (0.94 - Math.random() * 0.3 * loud);
        if (forest && Math.random() < 0.55) {
          d = Math.random() ** 0.7;
          const s = 1 / (1 + FAR * d);
          y = h * (1 - groundAt(x, d) - TREE_H * s * (0.3 + 0.8 * Math.random()));
        }
        const s = 1 / (1 + FAR * d);
        const kind = Math.random();
        const big = kind > 0.94;
        // Mostly tiny; the odd one bright; the big embers few.
        const size = (big ? 2.4 + 2.6 * Math.random() : 0.6 + 2.2 * Math.random() ** 2.5) * unit * s ** 0.8;
        const speed = (big ? 40 + 60 * Math.random() : 140 + 320 * Math.random()) * unit * s * (0.6 + loud);
        const angle = (Math.random() - 0.5) * 0.9;
        this.sparks.push({
          x: x * w + (Math.random() - 0.5) * 30 * unit * s, y,
          vx: Math.sin(angle) * speed, vy: -Math.cos(angle) * speed,
          life: 1, fade: big ? 0.18 + 0.15 * Math.random() : 0.45 + 0.9 * Math.random(),
          size, s, big, tree: d > 0, seed: Math.random() * 100, wob: 1 + 3 * Math.random(),
        });
      }
      // The trees' sparks in a fire's own colours, the flames' in theirs;
      // with the rainbow, all of them in rainbow.
      // The flames' sparks too turn red as they cool.
      const smooth = (a, b, x) => {
        const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
        return k * k * (3 - 2 * k);
      };
      const heatColour = (t, tree) => {
        if (palette === 'rainbow') return [1, 0.9 - 0.4 * (1 - t), 0.6 - 0.5 * (1 - t)];
        const real = [0, 1, 2].map((c) => smooth(PALETTES.fire[0][c], PALETTES.fire[1][c], t));
        if (tree) return real;
        const k = smooth(0.55, 0.95, t);
        return [0, 1, 2].map((c) => real[c] + (smooth(p[0][c], p[1][c], t) - real[c]) * k);
      };
      const d = this.sparkBuf.data;
      let count = 0;
      const wind = 18 * unit * Math.sin(this.age * 0.13);
      for (const e of this.sparks) {
        e.life -= dt * e.fade;
        // Rising on the hot air, slowed by the air, swirled about.
        const drag = Math.exp(-dt * (e.big ? 0.6 : 1.4));
        e.vx = e.vx * drag + (Math.sin(this.age * e.wob + e.seed) * 90 + wind) * unit * e.s * dt;
        e.vy = e.vy * drag - 70 * unit * e.s * dt;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        if (e.life <= 0 || count >= MAX_SPARKS) continue;
        // White-hot and bright at first, cooling to red; flickering, the big
        // ones as they tumble.
        const temp = e.life ** 0.8;
        const flicker = e.big ? 0.55 + 0.45 * Math.sin(this.age * (5 + e.wob * 2) + e.seed) ** 2 : 0.75 + 0.25 * Math.sin(this.age * 31 + e.seed);
        const col = heatColour(0.45 + 0.75 * temp, e.tree);
        // Under a pixel and a bit, a dot is drawn that size and dimmer, so it
        // stays round instead of a hard little square.
        const r = Math.max(e.size, 0.8);
        let alpha = Math.min(1, temp * 1.6) * flicker * (e.size / r) ** 2 * (e.big ? 1.2 : 1.8);
        // Drawn out along its flight by how far it goes in a 60th of a second.
        const speed = Math.hypot(e.vx, e.vy) || 1;
        const half = Math.min(16 * unit, (speed / 60) * 0.5);
        alpha *= r / (r + half * 0.4);
        const ux = e.vx / speed;
        const uy = e.vy / speed;
        const along = half + r * 4.5;
        const across = r * 4.5;
        let k = count * 60;
        for (const [sa, sc] of CORNERS) {
          d[k] = e.x + ux * along * sa - uy * across * sc;
          d[k + 1] = e.y + uy * along * sa + ux * across * sc;
          d[k + 2] = along * sa;
          d[k + 3] = across * sc;
          d[k + 4] = half;
          d[k + 5] = r;
          d[k + 6] = col[0];
          d[k + 7] = col[1];
          d[k + 8] = col[2];
          d[k + 9] = alpha;
          k += 10;
        }
        count += 1;
      }
      this.sparks = this.sparks.filter((e) => e.life > 0 && e.y > -40 && e.x > -40 && e.x < w + 40);
      if (!count) return;
      const gl = this.gl;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.spark.p);
      gl.uniform2f(this.spark.u.res, w, h);
      this.sparkBuf.put(count * 6);
      gl.drawArrays(gl.TRIANGLES, 0, count * 6);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
  }

  Visualizer.add({
    id: 'inferno',
    name: 'Inferno',
    desc: 'The spectrum on fire in front of a burning forest: every band feeds the flames above it, the kicks make them flare, sparks fly',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c4 0 7-3 7-7 0-5-4-7-5-12-2 3-2 5-1 7-2-1-3-3-3-5-3 3-5 6-5 10 0 4 3 7 7 7z"/></svg>',
    gl: true,
    create: (canvas) => new Inferno(canvas),
    options: [
      { type: 'choice', key: 'ifColor', label: 'Flames', choices: [['fire', 'Fire'], ['blue', 'Blue'], ['green', 'Toxic'], ['purple', 'Purple'], ['rainbow', 'Rainbow']] },
      { type: 'slider', key: 'ifFlameHeight', label: 'Height', min: 25, max: 150, step: 5 },
      { type: 'choice', key: 'ifLayout', label: 'Bass', choices: [['centre', 'In the middle'], ['across', 'On the left']] },
      { type: 'check', key: 'ifEmbers', label: 'Sparks' },
      { type: 'check', key: 'ifForest', label: 'Forest' },
    ],
  });
})();
