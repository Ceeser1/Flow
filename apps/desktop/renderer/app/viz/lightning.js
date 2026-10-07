'use strict';

// Lightning: a storm at night over dark hills. The beats strike: a strong
// one in an intense part brings a bolt down to the ground, branching, first
// its faint leader feeling its way down, then the bright return stroke, which
// flickers once or twice more as real lightning does; a weaker beat or a calm
// part flashes inside the clouds instead, lighting them from within, and
// snares and claps add small sparks between them. With nothing playing the
// storm rumbles on far away now and then. A strike comes down on the ground
// of one of the land's three layers, between it and the next, hidden by the
// ones in front; now and then one hits a tree, with a bigger flash, and the
// tree glows on for a few seconds, fading.
//
// Drawn with WebGL (viz/gl.js): the bolts as soft lines into a texture of
// their own (the brightest wins where they cross, so joints and branches do
// not bead), that blurred twice for their glow, and the sky, the clouds, the
// rain and the land in one pass over the whole screen, lit by where the
// bolts are. The land (three layers of hills with firs and the odd oak on
// them) is drawn once for the screen's size into a texture of its own.
//
// Its cogwheel: the bolts' colour, Screen flash (the sky lighting up, and how
// much), Rain, and Strikes (how readily it strikes).

(() => {
  const MAX_VERTS = 90000;
  const MAX_LIGHTS = 8;
  const MAX_BOLTS = 14;
  const LEADER_S = 0.055;  // the leader's way down, before the stroke
  const STROKE_S = 0.085;  // the stroke's fall
  const LINGER_S = 0.3;    // the channel's afterglow
  const TREE_CHANCE = 0.5;   // how many of the music's big peaks strike a tree
  const TREE_GAP_S = 25;     // and at least this far apart
  const GLOW_S = 3;          // how long a struck tree glows
  const PRESETS = ['#a9c4ff', '#ffffff', '#c77dff', '#ff5ec4', '#ffd166', '#6bff8f', '#ff4d4d'];

  const BOLT_VS = `
    layout(location = 0) in vec2 pos;
    layout(location = 1) in float alpha;
    layout(location = 2) in float across;
    uniform vec2 res;
    out float a;
    out float x;
    out float depth;
    void main() {
      // alpha carries how near the bolt is in its tens.
      depth = floor(alpha / 10.0);
      a = alpha - depth * 10.0;
      x = across;
      gl_Position = vec4(pos.x / res.x * 2.0 - 1.0, 1.0 - pos.y / res.y * 2.0, 0.0, 1.0);
    }`;
  const BOLT_FS = `
    in float a;
    in float x;
    in float depth;
    out vec4 o;
    void main() {
      float f = max(0.0, 1.0 - x * x);
      // Into the channel for how near it is: the clouds, or the layer it strikes.
      o = a * f * f * vec4(depth < 0.5, abs(depth - 1.0) < 0.5, abs(depth - 2.0) < 0.5, depth > 2.5);
    }`;


  // The layers, far to near: how wide their hills are (xs), how high (h),
  // how rough, their firs' height (of the screen's) and how many oaks. The
  // same in the shaders and here, where a strike is aimed.
  const LAYERS = [
    { xs: 1.0, seed: 3, h: 0.245, rough: 0.012, treeH: 0.03, oaks: 0 },
    { xs: 0.9, seed: 7, h: 0.185, rough: 0.016, treeH: 0.052, oaks: 0.012 },
    { xs: 0.8, seed: 11, h: 0.15, rough: 0.02, treeH: 0.088, oaks: 0.03 },
  ];
  const glsl = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

  // The hills and the trees' shapes, for the land and for the struck tree.
  const TREES = `
    float hills(float x, float seed, float h, float rough) {
      return h + 0.2 * (fbm(vec2(x * 1.8 + seed, seed)) - 0.45) + rough * vnoise(vec2(x * 9.0, seed + 4.0));
    }

    // A fir, at q in its own heights from its foot.
    float pine(vec2 q, float seed, float pxu) {
      float u = q.x, v = q.y;
      if (v < -0.5 || v > 1.02 || abs(u) > 0.32) return 0.0;
      float trunk = clamp((0.02 - abs(u)) / pxu + 0.5, 0.0, 1.0) * step(v, 0.3);
      float tiers = 4.0 + floor(fract(seed * 11.3) * 4.0);
      float saw = fract(v * tiers + abs(u) * 1.5 + seed);
      float side = vnoise(vec2(sign(u) * 13.0 + seed * 50.0, v * 20.0));
      float hw = 0.23 * pow(max(1.0 - v, 0.0), 0.95) * (0.62 + 0.38 * (1.0 - saw)) * (0.75 + 0.5 * side);
      // Needles: the edge ragged.
      hw *= 1.0 + 0.3 * (vnoise(vec2(v * 90.0 + seed * 7.0, sign(u) * 3.0 + abs(u) * 30.0)) - 0.5);
      float crown = clamp((hw - abs(u)) / pxu + 0.5, 0.0, 1.0) * step(0.1, v);
      return max(trunk, crown);
    }

    float segment(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a, ba = b - a;
      return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
    }

    // An oak: a thick trunk forking into a broad, lumpy, leafy crown.
    float oak(vec2 q, float seed, float pxu) {
      if (q.y < -0.5 || q.y > 1.1 || abs(q.x) > 0.7) return 0.0;
      float bend = 0.025 * sin(q.y * 6.0 + seed);
      float tw = 0.04 + 0.035 * smoothstep(0.12, 0.0, q.y);
      float wood = clamp((tw - abs(q.x - bend)) / pxu + 0.5, 0.0, 1.0) * step(q.y, 0.5);
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        vec2 a = vec2(bend, 0.32 + 0.06 * fi);
        vec2 b = vec2((fi - 1.0) * 0.32 + 0.08 * (hash12(vec2(seed, fi)) - 0.5), 0.62 + 0.08 * hash12(vec2(fi, seed)));
        wood = max(wood, clamp((0.022 - segment(q, a, b)) / pxu + 0.5, 0.0, 1.0));
      }
      float d = 1e3;
      for (int i = 0; i < 8; i++) {
        float fi = float(i);
        vec2 c = vec2((hash12(vec2(seed, fi + 2.0)) - 0.5) * 0.85, 0.6 + 0.3 * hash12(vec2(fi + 5.0, seed)));
        float r = 0.15 + 0.11 * hash12(vec2(seed + fi, 3.1));
        d = min(d, length((q - c) * vec2(1.0, 1.2)) - r);
      }
      // Leaves: the crown's edge lumpy and frayed, a few holes through it.
      d += 0.05 * (fbm(q * 16.0 + seed) - 0.5);
      float crown = clamp(-d / pxu + 0.5, 0.0, 1.0);
      crown *= 1.0 - smoothstep(0.66, 0.72, fbm(q * 9.0 + seed * 1.7)) * smoothstep(-0.02, -0.08, d);
      return max(wood, crown);
    }

`;

  // The land: three layers of hills, far, middle and near, each with firs
  // along it (smaller the further back, in stretches of forest and open
  // ground, some standing lower down the slope) and now and then a broad oak.
  // Drawn once for the screen's size: how much of each pixel each layer
  // covers, in R (far), G (middle), B (near).
  const LAND_FS = VizGL.NOISE + TREES + `
    in vec2 uv;
    uniform vec2 res;
    out vec4 o;


    // One layer: its hill and its trees. xs: how wide its hills are; h: how
    // high; treeH: its firs' height (of the screen's); oaks: how many oaks.
    float layer(vec2 p, float xs, float seed, float h, float rough, float treeH, float oaks) {
      float px = 1.0 / res.y;
      float cov = clamp((hills(p.x * xs, seed, h, rough) - p.y) / px + 0.5, 0.0, 1.0);
      if (p.y > h + 0.12 + treeH * 1.8) return cov;
      float cell = treeH * 0.33;
      float c = floor(p.x / cell);
      for (int k = -3; k <= 3; k++) {
        float id = c + float(k);
        float hh = hash12(vec2(id, seed));
        // Stretches of forest and open ground.
        float stand = smoothstep(0.25, 0.55, vnoise(vec2(id * cell * 2.2, seed * 3.0)));
        if (hh > 0.92 * stand) continue;
        float tx = (id + 0.2 + 0.6 * hash12(vec2(id * 1.7, seed + 3.1))) * cell;
        float big = hash12(vec2(id * 3.3, seed + 9.2));
        bool isOak = hash12(vec2(id * 3.7, seed + 2.0)) < oaks;
        float th = treeH * (isOak ? 1.05 + 0.2 * big : 0.7 + 0.5 * big + 0.4 * pow(big, 6.0));
        // Some stand a little down the slope, showing less of themselves.
        float ty = hills(tx * xs, seed, h, rough) - th * 0.35 * hash12(vec2(id * 5.1, seed + 1.7)) - px * 2.0;
        vec2 q = vec2(p.x - tx, p.y - ty) / th;
        cov = max(cov, isOak ? oak(q, hh * 91.7, px / th) : pine(q, hh * 91.7, px / th));
      }
      return cov;
    }

    void main() {
      vec2 p = vec2(uv.x * res.x / res.y, uv.y);
${LAYERS.map((l, i) => `      float l${i} = layer(p, ${glsl(l.xs)}, ${glsl(l.seed)}, ${glsl(l.h)}, ${glsl(l.rough)}, ${glsl(l.treeH)}, ${glsl(l.oaks)});`).join('\n')}
      o = vec4(l0, l1, l2, 1.0);
    }`;

  const SKY_FS = VizGL.NOISE + TREES + `
    in vec2 uv;
    uniform sampler2D core;
    uniform sampler2D glowA;
    uniform sampler2D glowB;
    uniform sampler2D land;
    uniform vec4 struck;
    uniform vec4 struckBy;
    uniform vec2 res;
    uniform float time;
    uniform float flash;
    uniform float rain;
    uniform vec3 color;
    uniform vec4 lights[${MAX_LIGHTS}];
    out vec4 o;

    float rainLayer(vec2 p, float scale, float speed, float seed) {
      p.x += p.y * 0.18;
      vec2 g = vec2(p.x * scale, p.y * scale * 0.04 + time * speed);
      vec2 cell = floor(g);
      vec2 f = fract(g);
      float r = hash12(cell + seed);
      if (r < 0.55) return 0.0;
      float x = abs(f.x - 0.2 - 0.6 * hash12(cell + seed + 7.0));
      float streak = smoothstep(0.06, 0.0, x) * smoothstep(0.0, 0.3, f.y) * smoothstep(1.0, 0.5, f.y);
      return streak * (r - 0.55) * 2.2;
    }

    void main() {
      float aspect = res.x / res.y;
      vec2 p = vec2(uv.x * aspect, uv.y);

      // The light of the bolts and flashes, falling off from each.
      float lit = 0.0;
      for (int i = 0; i < ${MAX_LIGHTS}; i++) {
        vec4 l = lights[i];
        if (l.w <= 0.0) continue;
        vec2 d = (uv - l.xy) * vec2(aspect, 1.6);
        lit += l.w * exp(-dot(d, d) / (l.z * l.z));
      }

      // The sky: near black, a little lighter low down where the far city glows.
      vec3 col = mix(vec3(0.028, 0.03, 0.045), vec3(0.012, 0.014, 0.024), smoothstep(0.1, 0.9, uv.y));

      // The clouds, rolling slowly, thick above and thinning towards the hills.
      vec2 q = p * vec2(1.6, 2.6) + vec2(time * 0.018, 0.0);
      float warp = fbm(q * 0.7 + vec2(0.0, time * 0.01));
      float d = fbm(q + warp * 1.8 + vec2(time * 0.012, -time * 0.004));
      float band = smoothstep(0.2, 0.75, uv.y);
      float dens = smoothstep(0.32, 0.78, d) * (0.25 + 0.75 * band);
      float shade = 0.55 + 0.9 * fbm(q * 2.1 - warp);
      col += vec3(0.05, 0.055, 0.075) * dens * shade;
      // Lit from within: thick cloud catches the light, the gaps less.
      vec3 tint = mix(color, vec3(1.0), 0.55);
      col += tint * lit * (0.06 + 1.25 * dens * shade);
      // The whole sky lighting up.
      col += tint * flash * (0.05 + 0.5 * dens * shade + 0.12 * band);

      // The land's layers here (far, middle, near).
      vec3 cov = texture(land, uv).rgb;
      // The bolts, white hot in the middle, their colour in the glow; each
      // hidden by the layers in front of where it strikes, those in the
      // clouds by all of them.
      vec4 seen = vec4(1.0 - max(cov.r, max(cov.g, cov.b)), 1.0 - max(cov.g, cov.b), 1.0 - cov.b, 1.0);
      float c = dot(texture(core, uv), seen);
      float g = dot(texture(glowA, uv), seen) * 1.3 + dot(texture(glowB, uv), seen) * 2.0;
      vec3 bolt = color * g + mix(color, vec3(1.0), 0.7) * c * 1.4;

      // Rain, lit by the flashes, in three depths: the smallest drops far
      // off behind the far hills, the middling ones behind the middle hills,
      // the big ones in front of everything.
      vec3 drops = vec3(0.5, 0.55, 0.65) * rain * (0.035 + 0.5 * flash + 0.6 * lit);
      vec3 rainSmall = rain > 0.0 ? drops * rainLayer(p, 60.0, 2.3, 1.0) * 0.6 : vec3(0.0);
      vec3 rainMid = rain > 0.0 ? drops * rainLayer(p, 34.0, 1.6, 5.0) * 0.8 : vec3(0.0);
      vec3 rainBig = rain > 0.0 ? drops * rainLayer(p, 18.0, 1.1, 9.0) : vec3(0.0);
      col += rainSmall;

      // The land, three layers with their trees: the far one dim against the
      // flashes, the nearer ones darker, the near one black; their top edges
      // catch the light; they stand in front of the bolts.
      vec2 up = vec2(0.0, 1.0 / res.y);
      vec3 over = (texture(land, uv + up * 2.0).rgb + texture(land, uv + up * 5.0).rgb) * 0.5;
      vec3 rim = cov * (1.0 - over);
      float shine = flash + lit * 0.6;
      col = mix(col, vec3(0.02, 0.022, 0.032) + tint * (flash * 0.1 + lit * 0.05 + rim.r * shine * 0.1), cov.r * 0.92);
      col += rainMid;
      col = mix(col, vec3(0.01, 0.011, 0.017) + tint * (flash * 0.05 + lit * 0.025 + rim.g * shine * 0.11), cov.g * 0.96);
      col = mix(col, vec3(0.003, 0.003, 0.005) + tint * rim.b * shine * 0.12, cov.b);
      // A tree the lightning struck, glowing: white hot at first, then
      // embers, fading; hidden by the layers in front of it.
      if (struck.w > 0.0) {
        vec2 q = (p - struck.xy) / struck.z;
        float pxu = 1.0 / (res.y * struck.z);
        float tree = struckBy.y > 0.5 ? oak(q, struckBy.z, pxu) : pine(q, struckBy.z, pxu);
        tree *= 1.0 - (struckBy.x < 0.5 ? max(cov.g, cov.b) : struckBy.x < 1.5 ? cov.b : 0.0);
        float a = struck.w;
        vec3 hot = mix(vec3(1.0, 0.42, 0.1), mix(color, vec3(1.0), 0.7) * 2.5, smoothstep(0.85, 1.0, a));
        float flick = 0.7 + 0.3 * vnoise(q * 14.0 + vec2(0.0, -time * 5.0));
        col += hot * tree * a * a * 1.3 * flick;
        vec2 hq = (q - vec2(0.0, 0.45)) * vec2(1.5, 1.0);
        col += hot * exp(-dot(hq, hq) * 2.5) * a * a * 0.22;
      }
      col += bolt;
      col += rainBig;

      // Softly into white, and a little noise against banding in the dark.
      col = 1.0 - exp(-col * 1.25);
      col += (hash12(gl_FragCoord.xy + fract(time) * 100.0) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  // The shaders' noise in JS, to know where their hills and trees are.
  const fract = (v) => v - Math.floor(v);
  const smooth = (e0, e1, v) => {
    const k = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
    return k * k * (3 - 2 * k);
  };
  function hash12(x, y) {
    let a = fract(x * 0.1031);
    let b = fract(y * 0.1031);
    let c = a;
    const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
    a += d;
    b += d;
    c += d;
    return fract((a + b) * c);
  }
  function vnoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const lo = hash12(ix, iy) + (hash12(ix + 1, iy) - hash12(ix, iy)) * ux;
    const hi = hash12(ix, iy + 1) + (hash12(ix + 1, iy + 1) - hash12(ix, iy + 1)) * ux;
    return lo + (hi - lo) * uy;
  }
  function fbm(x, y) {
    let v = 0;
    let a = 0.5;
    for (let i = 0; i < 5; i += 1) {
      v += a * vnoise(x, y);
      x = x * 2.03 + 17.1;
      y = y * 2.03 + 3.7;
      a *= 0.5;
    }
    return v;
  }
  /** A layer's hilltop at x (in screen heights from the left), 0..1 up. */
  function hillAt(l, x) {
    return l.h + 0.2 * (fbm(x * l.xs * 1.8 + l.seed, l.seed) - 0.45) + l.rough * vnoise(x * l.xs * 9, l.seed + 4);
  }
  /** The tree in a layer's cell, if one stands there: its foot, height, kind. */
  function treeIn(l, id, px) {
    const cell = l.treeH * 0.33;
    const hh = hash12(id, l.seed);
    const stand = smooth(0.25, 0.55, vnoise(id * cell * 2.2, l.seed * 3));
    if (hh > 0.92 * stand) return null;
    const tx = (id + 0.2 + 0.6 * hash12(id * 1.7, l.seed + 3.1)) * cell;
    const big = hash12(id * 3.3, l.seed + 9.2);
    const oak = hash12(id * 3.7, l.seed + 2) < l.oaks;
    const th = l.treeH * (oak ? 1.05 + 0.2 * big : 0.7 + 0.5 * big + 0.4 * big ** 6);
    const ty = hillAt(l, tx) - th * 0.35 * hash12(id * 5.1, l.seed + 1.7) - px * 2;
    return { tx, ty, th, oak, seed: hh * 91.7 };
  }

  /** A seeded random 0..1. */
  function random(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** How long a path is, in pixels. */
  function length(pts) {
    let len = 0;
    for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    return len;
  }

  class Storm {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.bolt = VizGL.program(gl, BOLT_VS, BOLT_FS);
      this.sky = VizGL.program(gl, VizGL.SCREEN_VS, SKY_FS);
      this.land = VizGL.program(gl, VizGL.SCREEN_VS, LAND_FS);
      this.verts = VizGL.stream(gl, [[0, 2], [1, 1], [2, 1]], MAX_VERTS);
      this.bolts = [];
      this.rand = random(Date.now());
      this.age = 0;           // seconds since it opened
      this.lastStrike = -10;  // when the last bolt struck the ground
      this.nextRumble = 2;    // when it rumbles in the distance next, idle
      this.lights = new Float32Array(MAX_LIGHTS * 4);
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.core, this.qa, this.qb, this.ea, this.eb, this.landT]) VizGL.freeTarget(gl, t);
      // The land, drawn once for this size.
      this.landT = VizGL.target(gl, w, h, { half: false });
      gl.disable(gl.BLEND);
      VizGL.into(gl, this.landT);
      gl.useProgram(this.land.p);
      gl.uniform2f(this.land.u.res, w, h);
      VizGL.screen(gl);
      this.core = VizGL.target(gl, w, h, { half: false });
      const qw = Math.max(1, Math.round(w / 4));
      const qh = Math.max(1, Math.round(h / 4));
      this.qa = VizGL.target(gl, qw, qh);
      this.qb = VizGL.target(gl, qw, qh);
      const ew = Math.max(1, Math.round(w / 12));
      const eh = Math.max(1, Math.round(h / 12));
      this.ea = VizGL.target(gl, ew, eh);
      this.eb = VizGL.target(gl, ew, eh);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    // ---- the bolts ----

    /**
     * A jagged path from (x, y), stepping on towards (tx, ty) (or, without a
     * target, in the direction `angle`, 0 straight down) for `len` pixels.
     */
    _walk(x, y, { tx = null, ty = null, angle = 0, len, step, jag }) {
      const r = this.rand;
      const pts = [x, y];
      let went = 0;
      let dir = angle;
      while (went < len) {
        if (tx !== null) dir = Math.atan2(tx - x, ty - y);
        const a = dir + (r() - 0.5) * 2 * jag;
        const s = step * (0.45 + r() * 1.1);
        // Each step kinked once more in its middle, finer.
        const k = (r() - 0.5) * s * 0.35;
        pts.push(x + Math.sin(a) * s * 0.5 + Math.cos(a) * k, y + Math.cos(a) * s * 0.5 - Math.sin(a) * k);
        x += Math.sin(a) * s;
        y += Math.cos(a) * s;
        pts.push(x, y);
        went += s;
        if (ty !== null && y >= ty) break;
      }
      return pts;
    }

    /** Side branches off a path, and theirs off them, `depth` deep. */
    _branches(paths, pts, from, span, width, bright, depth, chance, down = false) {
      const r = this.rand;
      const n = pts.length / 2;
      for (let i = 2; i < n - 3; i += 1) {
        if (r() > chance * (1 - i / n)) continue;
        const x = pts[i * 2];
        const y = pts[i * 2 + 1];
        const dx = pts[i * 2 + 2] - x;
        const dy = pts[i * 2 + 3] - y;
        let dir = Math.atan2(dx, dy) + (r() < 0.5 ? -1 : 1) * (0.35 + r() * 0.6);
        // A strike's branches reach down and out, never back up.
        if (down) dir = Math.max(-1.2, Math.min(1.2, dir));
        const left = (1 - i / n) * span;
        const len = left * (0.15 + r() * 0.4);
        const sub = this._walk(x, y, { angle: dir, len, step: this.h / 70, jag: 0.55 });
        const start = from + (i / n) * span;
        paths.push({ pts: sub, from: start, span: len, width: width * 0.55, bright: bright * (0.4 + r() * 0.25), main: false });
        if (depth > 1) this._branches(paths, sub, start, len, width * 0.55, bright * 0.6, depth - 1, chance * 0.7, down);
      }
    }

    /**
     * Where a bolt to the ground comes down: on the ground of one of the
     * layers, between it and the one in front (or on the near one), or now
     * and then on a tree. { x, y } in pixels, the layer, and the tree if one.
     */
    _target(tree) {
      const r = this.rand;
      const { w, h } = this;
      const aspect = w / h;
      if (tree) {
        const hit = this._tree();
        if (hit) return hit;
      }
      for (let tries = 0; tries < 8; tries += 1) {
        const roll = r();
        const layer = roll < 0.4 ? 0 : roll < 0.75 ? 1 : 2;
        const ux = 0.08 + r() * 0.84;
        const top = hillAt(LAYERS[layer], ux * aspect);
        // Its ground is seen down to where the next layer's hills rise.
        let below = 0;
        for (let i = layer + 1; i < LAYERS.length; i += 1) below = Math.max(below, hillAt(LAYERS[i], ux * aspect));
        const gap = top - below;
        if (layer < 2 && gap < 0.012) continue;
        const y = top - (layer < 2 ? gap * (0.1 + 0.6 * r()) : top * (0.05 + 0.5 * r()));
        return { x: ux * w, y: h * (1 - y), layer, tree: null };
      }
      return { x: w * (0.1 + r() * 0.8), y: h * (1 - LAYERS[2].h * 0.6), layer: 2, tree: null };
    }

    /** A tree to strike, one standing in sight, or null. */
    _tree() {
      const r = this.rand;
      const { w, h } = this;
      const aspect = w / h;
      const gl = this.gl;
      const px = new Uint8Array(4);
      for (let tries = 0; tries < 12; tries += 1) {
        const layer = r() < 0.55 ? 2 : r() < 0.7 ? 1 : 0;
        const l = LAYERS[layer];
        const cell = l.treeH * 0.33;
        const t = treeIn(l, Math.floor(((0.1 + r() * 0.8) * aspect) / cell), 1 / h);
        if (!t) continue;
        // Its crown must be there (the land as drawn says so) and its top
        // not behind a nearer layer.
        const at = (ux, uy) => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.landT.fb);
          gl.readPixels(Math.round(ux * h), Math.round(uy * h), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return [px[0], px[1], px[2]];
        };
        const crown = at(t.tx, t.ty + t.th * 0.6);
        const tip = at(t.tx, t.ty + t.th * 0.9);
        let hidden = 0;
        for (let i = layer + 1; i < 3; i += 1) hidden = Math.max(hidden, tip[i]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (crown[layer] < 160 || hidden > 60) continue;
        return { x: t.tx * h, y: h * (1 - (t.ty + t.th * 0.97)), layer, tree: { ...t, layer } };
      }
      return null;
    }

    /** A bolt to the ground, as strong as power 0..1; at a tree if `tree` (and one is in sight). */
    _strike(power, tree = false) {
      const r = this.rand;
      const w = this.w;
      const h = this.h;
      const aim = this._target(tree);
      const struck = aim.tree;
      // A tree struck: the strongest strike there is.
      if (struck) {
        power = 1;
        this.lastTree = this.age;
      }
      const x = Math.max(w * 0.05, Math.min(w * 0.95, aim.x + (r() - 0.5) * w * 0.35));
      const y = h * (0.08 + r() * 0.14);
      const main = this._walk(x, y, { tx: aim.x, ty: aim.y, len: h * 2, step: h / 55, jag: 0.62 });
      // Right onto the mark at the end.
      main.push(aim.x, aim.y);
      const span = length(main);
      const width = (h / 1080) * (1.6 + 1.6 * power) * (struck ? 1.25 : 1);
      const paths = [{ pts: main, from: 0, span, width, bright: 1, main: true }];
      this._branches(paths, main, 0, span, width, 0.85, 2, 0.16 + 0.12 * power, true);
      this._add({
        paths, span, power: struck ? 1.6 : power, ground: true, depth: aim.layer + 1, lx: x / w, ly: 1 - y / h, radius: 0.32 + 0.12 * power + (struck ? 0.15 : 0),
        gx: aim.x / w, gy: 1 - aim.y / h, tree: struck,
      });
      this.lastStrike = this.age;
    }

    /** A bolt running along inside the clouds. */
    _spark(power) {
      const r = this.rand;
      const w = this.w;
      const h = this.h;
      const x = w * (0.05 + r() * 0.9);
      const y = h * (0.08 + r() * 0.3);
      const dir = (r() < 0.5 ? -1 : 1) * (1.15 + r() * 0.5);
      const len = h * (0.25 + 0.35 * power + r() * 0.2);
      const main = this._walk(x, y, { angle: dir, len, step: h / 60, jag: 0.7 });
      const span = length(main);
      const width = (h / 1080) * (1.1 + 0.9 * power);
      const paths = [{ pts: main, from: 0, span, width, bright: 0.75, main: true }];
      this._branches(paths, main, 0, span, width, 0.6, 1, 0.12);
      const n = main.length / 2;
      const mx = main[Math.floor(n / 2) * 2];
      const my = main[Math.floor(n / 2) * 2 + 1];
      this._add({ paths, span, power: power * 0.7, ground: false, lx: mx / w, ly: 1 - my / h, radius: 0.3 + 0.1 * power });
    }

    /** A flash inside the clouds with no bolt to be seen. */
    _sheet(power) {
      const r = this.rand;
      this._add({ paths: [], span: 1, power: power * 0.6, ground: false, lx: 0.1 + r() * 0.8, ly: 0.6 + r() * 0.35, radius: 0.3 + r() * 0.2 });
    }

    _add(bolt) {
      const r = this.rand;
      // Re-strikes: a bolt to the ground flickers once or twice more.
      bolt.again = [];
      const times = bolt.ground ? 1 + Math.floor(r() * 2.6) : Math.floor(r() * 1.6);
      let t = 0;
      for (let i = 0; i < times; i += 1) {
        t += 0.05 + r() * 0.09;
        bolt.again.push(t);
      }
      bolt.age = 0;
      bolt.leader = bolt.ground ? LEADER_S * (0.7 + r() * 0.6) : LEADER_S * 0.5;
      bolt.end = bolt.leader + t + LINGER_S * 1.6;
      if (this.bolts.length >= MAX_BOLTS) this.bolts.shift();
      this.bolts.push(bolt);
    }

    /** How bright the stroke is `t` seconds after the leader arrived. */
    _brightness(b, t) {
      if (t < 0) return 0.28;
      let v = Math.exp(-t / STROKE_S) + 0.07 * Math.exp(-t / LINGER_S);
      for (const a of b.again) if (t >= a) v += 0.85 * Math.exp(-(t - a) / (STROKE_S * 0.7));
      return Math.min(1.4, v);
    }

    // ---- each frame ----

    frame(a, dt) {
      this.age += dt;
      this._listen(a, dt);
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      const color = VizGL.rgb(set('ltColor'));

      // The bolts' lines, and the lights they cast.
      const data = this.verts.data;
      let count = 0;
      let flash = 0;
      const lights = this.lights;
      lights.fill(0);
      const lit = [];
      for (const b of this.bolts) {
        b.age += dt;
        const t = b.age - b.leader;
        const glow = this._brightness(b, t);
        // The leader feeling its way down, then all of it.
        const upTo = t >= 0 ? Infinity : (b.age / b.leader) * b.span;
        if (t >= 0) {
          flash += glow * b.power * (b.ground ? 1 : 0.55);
          lit.push([b.lx, b.ly, b.radius, glow * (0.4 + 0.6 * b.power)]);
          // A tree struck: lit where it was hit, and set glowing.
          if (b.tree) {
            lit.push([b.gx, b.gy, 0.18, glow * 1.2]);
            if (!b.lit) {
              b.lit = true;
              this.glowing = { ...b.tree, age: 0 };
            }
          }
        }
        for (const p of b.paths) {
          // Branches fade faster than the channel they hang from.
          const fade = p.main || t < 0 ? 1 : Math.exp(-t / 0.11);
          const alpha = glow * p.bright * fade * (t < 0 ? 0.6 : 1);
          if (alpha < 0.01) continue;
          count = this._line(data, count, p, upTo, alpha + (b.depth || 0) * 10);
          if (count >= MAX_VERTS - 6) break;
        }
      }
      this.bolts = this.bolts.filter((b) => b.age < b.end);
      lit.sort((x, y) => y[3] - x[3]);
      for (let i = 0; i < Math.min(MAX_LIGHTS, lit.length); i += 1) lights.set(lit[i], i * 4);

      // 1. The lines, the brightest winning where they cross.
      VizGL.into(gl, this.core);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.clearColor(0, 0, 0, 1);
      if (count) {
        gl.useProgram(this.bolt.p);
        gl.uniform2f(this.bolt.u.res, this.w, this.h);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
        this.verts.put(count);
        gl.drawArrays(gl.TRIANGLES, 0, count);
        gl.bindVertexArray(null);
        gl.blendEquation(gl.FUNC_ADD);
        gl.disable(gl.BLEND);
      }
      // 2. Their glow, near and wide.
      VizGL.blur(gl, this.core, this.qa, this.qb, 1.5);
      VizGL.blur(gl, this.qb, this.ea, this.eb, 2);

      // 3. The sky, the clouds, the rain and the hills, lit, and the bolts.
      const amount = set('ltFlash') ? set('ltFlashAmount') / 100 : 0;
      VizGL.into(gl, null);
      gl.useProgram(this.sky.p);
      const u = this.sky.u;
      VizGL.bind(gl, u.core, this.core.tex, 0);
      VizGL.bind(gl, u.glowA, this.qb.tex, 1);
      VizGL.bind(gl, u.glowB, this.eb.tex, 2);
      VizGL.bind(gl, u.land, this.landT.tex, 3);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.flash, Math.min(1.2, flash * 0.32 * amount));
      gl.uniform1f(u.rain, set('ltRain') ? 1 : 0);
      gl.uniform3f(u.color, color[0], color[1], color[2]);
      // Without Screen flash the clouds still glow around the bolts, less.
      for (let i = 0; i < MAX_LIGHTS; i += 1) lights[i * 4 + 3] *= 0.25 + 0.75 * Math.min(1, amount);
      gl.uniform4fv(u.lights, lights);
      // The struck tree, glowing for GLOW_S, fading.
      const g = this.glowing;
      if (g) {
        g.age += dt;
        if (g.age > GLOW_S) this.glowing = null;
      }
      const left = this.glowing ? 1 - g.age / GLOW_S : 0;
      gl.uniform4f(u.struck, g ? g.tx : 0, g ? g.ty : 0, g ? g.th : 1, left);
      gl.uniform4f(u.struckBy, g ? g.layer : 0, g && g.oak ? 1 : 0, g ? g.seed : 0, 0);
      VizGL.screen(gl);
    }

    /** One path's soft line into data from vertex `count`, up to `upTo` of the bolt's way down. */
    _line(data, count, p, upTo, alpha) {
      const pts = p.pts;
      const n = pts.length / 2;
      let along = p.from;
      for (let i = 0; i < n - 1 && count < MAX_VERTS - 6; i += 1) {
        const x0 = pts[i * 2];
        const y0 = pts[i * 2 + 1];
        const x1 = pts[i * 2 + 2];
        const y1 = pts[i * 2 + 3];
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        along += len;
        if (along > upTo) break;
        // Thinner towards the end, and coming out of the cloud at the start.
        const taper = 1 - 0.5 * (i / n);
        const out = p.from === 0 ? Math.min(1, (along - len) / (this.h * 0.08)) : 1;
        const a = alpha * out * out;
        const hw = p.width * taper * 2;
        const nx = (-(y1 - y0) / len) * hw;
        const ny = ((x1 - x0) / len) * hw;
        const v = [
          [x0 + nx, y0 + ny, 1], [x0 - nx, y0 - ny, -1], [x1 + nx, y1 + ny, 1],
          [x1 + nx, y1 + ny, 1], [x0 - nx, y0 - ny, -1], [x1 - nx, y1 - ny, -1],
        ];
        for (const [x, y, s] of v) {
          const k = count * 4;
          data[k] = x;
          data[k + 1] = y;
          data[k + 2] = a;
          data[k + 3] = s;
          count += 1;
        }
      }
      return count;
    }

    /** What the music says to strike now. */
    _listen(a, dt) {
      const r = this.rand;
      const rate = Visualizer.setting('ltStrikes') / 100;
      if (!a.playing) {
        // Far away, now and then.
        if (this.age > this.nextRumble) {
          this._sheet(0.25 + r() * 0.25);
          if (r() < 0.3) this._spark(0.2);
          this.nextRumble = this.age + 4 + r() * 7;
        }
        return;
      }
      const calm = 1 - a.intensity;
      // Only the music's big peaks (a full bass hit at the top of the kicks
      // lately, or a full hat or snare) strike a tree, now and then.
      const peak = (a.onset && a.onsetPower >= 0.95 && a.beat >= 0.97) || (a.hit && a.hitPower >= 1);
      if (peak) this.peaks = (this.peaks || 0) + 1;
      if (peak && !this.glowing && this.age - (this.lastTree ?? -TREE_GAP_S) >= TREE_GAP_S && r() < TREE_CHANCE) {
        this._strike(1, true);
      } else if (a.onset) {
        const strength = Math.min(1, 0.4 * a.onsetPower + 0.6 * a.beat);
        // Ground strikes take an intense part and a real beat, and a moment
        // between them, shorter the more readily it strikes.
        const gap = 0.4 / rate;
        const chance = (0.15 + 0.85 * a.intensity) * (0.35 + 0.65 * strength) * Math.min(1.5, rate);
        if (this.age - this.lastStrike > gap && r() < chance) this._strike(0.45 + 0.55 * strength);
        else if (r() < (0.45 + 0.3 * calm) * Math.min(1, rate)) this._spark(0.35 + 0.5 * strength);
        else this._sheet(0.3 + 0.6 * strength);
      } else if (a.hit && r() < 0.22 * rate * (0.3 + a.intensity)) {
        this._spark(0.25 + 0.3 * a.hitPower);
      }
      // A quiet stretch still flickers far off.
      if (this.age - this.lastStrike > 6 && r() < dt * 0.15) this._sheet(0.3);
    }
  }

  Visualizer.add({
    id: 'lightning',
    name: 'Lightning',
    desc: 'A storm at night: the beats strike, the drops bring bolts down to the ground, calm parts flash inside the clouds',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
    gl: true,
    create: (canvas) => new Storm(canvas),
    options: [
      { type: 'color', key: 'ltColor', label: 'Lightning color', presets: PRESETS },
      { type: 'check', key: 'ltFlash', label: 'Screen flash', amount: { key: 'ltFlashAmount', min: 0, max: 200, step: 5 } },
      { type: 'check', key: 'ltRain', label: 'Rain' },
      { type: 'slider', key: 'ltStrikes', label: 'Strikes', min: 25, max: 200, step: 5 },
    ],
  });
})();
