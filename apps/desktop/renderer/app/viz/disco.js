'use strict';

// Disco: a dance hall. A mirror ball turns under the ceiling, scattering its
// spots of light over the room; moving heads on a truss sweep coloured beams
// through the haze, swinging with the beat and changing colour every bar;
// the floor is a grid of LED tiles playing a pattern to the music (a chequer
// flipping on the beat, rings running out from the middle on the kicks, the
// spectrum, a sparkle), another every few bars. Behind it a stage of dark
// wood: the DJ at the desk (its front a strip of LEDs playing the spectrum),
// a red curtain with golden edges lit from below, a speaker stack each side
// with rings of light round its cones, and a strobe each side behind the DJ,
// flashing on the beat in the loud parts, railings
// along its sides. Pillars down the sides carry more speakers, turned in
// towards the floor. Beside the stage: the bar on the left (bottles lit from
// behind, lamps over the counter, a neon cocktail glass on the wall), a door
// under an EXIT sign and a velvet bench with a plant on the right.
//
// Its cogwheel: the colours, the beams, the strobes (how much they light the
// room), how fast the ball turns, whether the camera swivels and how fast
// (still, the room's tracing is kept and done once), the render scale.
//
// WebGL (viz/gl.js): one pass over the screen tracing each pixel's ray into
// the room (planes, boxes, some of them turned, the ball a sphere of facets,
// the DJ marched as a few rounded shapes, each beam a cone the ray passes
// through), into a texture; that blurred small for the glow. The lamps beside
// the stage never change, so their light is baked once when it opens (BAKE_FS:
// shadowed, shaped by their shades) into maps on the lounges' floor and walls
// and a volume for what stands there, and only read from those.

(() => {
  const HEADS = 5;
  const PALETTES = {
    disco: ['#ff2a55', '#ffd22a', '#2ae8ff', '#c02aff'],
    warm: ['#ff2a6e', '#ff8a2a', '#ffd23a', '#ff2ad2'],
    cool: ['#2a6eff', '#2affd8', '#8a2aff', '#2ad2ff'],
  };

  // The room (as in the shader): the pillars' x and z, the stage's height,
  // where the strobes stand.
  const PIL_X = 7.55;
  const PIL_Z = [2.4, 8.9];
  const STAGE_H = 0.6;
  const SPEAKERS = 6; // two on the stage, one on each pillar
  const STROBE_HOLD = 0.03; // s at full, then fading over STROBE_FADE
  const STROBE_FADE = 0.06;
  // The baked side lights: each map's texels (square), the volume's (both
  // sides across, up, back), and how many samples are taken over each lamp.
  const BAKE_MAP = 256;
  const VOL = [128, 36, 80];
  const BAKE_NS = { map: 16, vol: 6 };

  // What the room's shader and the bake (BAKE_FS) share: the uniforms, the
  // room's sizes, tracing a ray through it.
  const ROOM_GL = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform float time, swivel, spin, beatPh, beatN, beatT, pulse, haze, sparkle, kick, pump, ringGlow, throb;
    uniform int pattern;
    uniform float kicks[4];
    uniform float levels[16];
    uniform vec3 pal[4];
    uniform vec3 headPos[${HEADS}];
    uniform vec3 headDir[${HEADS}];
    uniform vec3 headCol[${HEADS}];
    uniform float beams;
    uniform vec3 spkPos[${SPEAKERS}];
    uniform mat3 spkRot[${SPEAKERS}];
    uniform vec3 spkHalf[${SPEAKERS}];
    uniform vec3 ringCol, upCol, floorAvg;
    uniform vec3 stbPos[2];
    uniform mat3 stbRot[2];
    uniform float stb[2];
    uniform float stbRoom;      // how much the strobes light the room (Room lightup)
    uniform float djBob, djArm, neonOn;
    uniform int zero;   // 0: in a loop's bound, so the compiler keeps it a loop

    const vec3 BALL = vec3(0.0, 5.0, 2.4);
    const float BALL_R = 0.65;
    const vec3 ROOM = vec3(15.0, 7.4, 15.6);   // half width, height, back wall z
    const float LED_X = 7.0, LED_Z = 10.0;     // the LED floor: |x| < 7, z < 10
    const float STAGE_Z = 10.0, STAGE_X = 7.6, STAGE_H = ${STAGE_H.toFixed(2)};
    const float CURT_Z = 14.7, CURT_X = 6.4;
    const vec3 DESK_C = vec3(0.0, STAGE_H + 0.55, 11.6), DESK_H = vec3(1.7, 0.55, 0.42);
    const vec3 TOP_C = vec3(0.75, STAGE_H + 1.24, 11.86), TOP_H = vec3(0.19, 0.13, 0.008);
    const vec3 TRUSS_C = vec3(0.0, 7.0, 4.0), TRUSS_H = vec3(6.6, 0.16, 0.16);
    const float PIL_X = ${PIL_X.toFixed(2)}, PIL_R = 0.45;
    const float DJ_Z = 12.4;
    const float PI = 3.14159265;

    vec3 rotY(vec3 p, float a) {
      float c = cos(a), s = sin(a);
      return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
    }

    float sphere(vec3 ro, vec3 rd, vec3 c, float r) {
      vec3 oc = ro - c;
      float b = dot(oc, rd);
      float h = b * b - dot(oc, oc) + r * r;
      if (h < 0.0) return -1.0;
      return -b - sqrt(h);
    }

    // What the ray meets first: how far, what (id, and which of them k), its
    // normal and the point in the thing's own frame (q, for boxes).
    struct Hit { float t; int id; int k; vec3 n; vec3 q; };

    // A box centred at c, half its size h, turned by m (world = m * local).
    void box(vec3 ro, vec3 rd, vec3 c, mat3 m, vec3 h, int id, int k, inout Hit H) {
      vec3 o = (ro - c) * m;
      vec3 d = rd * m;
      d = mix(d, vec3(1e-6), lessThan(abs(d), vec3(1e-6)));
      vec3 t1 = (-h - o) / d, t2 = (h - o) / d;
      vec3 tn = min(t1, t2), tf = max(t1, t2);
      float a = max(max(tn.x, tn.y), tn.z), b = min(min(tf.x, tf.y), tf.z);
      if (a > b || a < 0.0 || a >= H.t) return;
      // Exactly on an edge two of these are set: normalized, or a glint off it overflows.
      vec3 nl = -sign(d) * step(tn.yzx, tn.xyz) * step(tn.zxy, tn.xyz);
      H.t = a; H.id = id; H.k = k; H.n = normalize(m * nl); H.q = o + d * a;
    }

    // The ids.
    const int FLOOR = 1, CEIL = 2, SIDE = 3, BACK = 4, STAGE = 5, DESK = 6, TOP = 7, PILLAR = 8,
      SPEAKER = 9, STROBE = 10, STAND = 11, CURTAIN = 12, VALANCE = 13, TRUSS = 14,
      COUNTER = 15, SHELF = 16, STOOL = 17, LAMP = 18, BENCH = 19, POT = 20, SCONCE = 21, EXIT = 22, RAIL = 23, PLANT = 24;

    // Beside the stage: the bar (left) and the bench (right), in the back
    // corners past the rear pillars; the railings along the stage's sides.
    const float BAR_X = -13.2, BAR_Z = 13.3, BENCH_X = 13.0, RAIL_X = 7.8, RAIL_Z = ${(PIL_Z[1] + 0.45).toFixed(2)};
    const vec3 POT_C = vec3(14.3, 0.0, 14.9);
    const vec3 NEON_C = vec3(-9.0, 3.7, 15.6);
    const vec3 DOOR_C = vec3(8.95, 0.0, 15.6);
    // The pendants' shades over the bar: their bottoms (seen from the camera
    // between two of the shelves' boards behind) and tops.
    const float LAMP_Y0 = 2.4, LAMP_Y1 = 2.55;
    const vec3 NEON_PINK = vec3(1.0, 0.18, 0.55), NEON_GREEN = vec3(0.35, 1.0, 0.3), EXIT_GREEN = vec3(0.1, 1.0, 0.35);

    // The side lights, baked (BAKE_FS): maps of the lounges' floor, back wall
    // and side wall (|x| from BK_X to the side wall, z from BK_Z to the back),
    // and a volume over both, up to VOL_H, for all that stands there.
    const float BK_X = 7.0, BK_Z = 5.6, VOL_H = 4.5;
    const float VOL_NX = ${VOL[0] / 2}.0, VOL_NY = ${VOL[1]}.0, VOL_NZ = ${VOL[2]}.0;  // its texels: each side, up, back

    // A standing cylinder (its axis at c, from y0 to y1, radius r), its side and the cap facing the ray.
    void cyl(vec3 ro, vec3 rd, vec2 c, float y0, float y1, float r, int id, int k, inout Hit H) {
      vec2 o = ro.xz - c;
      float a = dot(rd.xz, rd.xz);
      float b = dot(o, rd.xz);
      float h = b * b - a * (dot(o, o) - r * r);
      if (h >= 0.0 && a > 1e-8) {
        float t = (-b - sqrt(h)) / a;
        float y = ro.y + rd.y * t;
        if (t > 0.0 && t < H.t && y > y0 && y < y1) {
          vec2 e = (o + rd.xz * t) / r;
          H.t = t; H.id = id; H.k = k; H.n = vec3(e.x, 0.0, e.y); H.q = vec3(e.x, y - y0, e.y);
        }
      }
      float yc = ro.y > y1 ? y1 : y0;
      float t = (yc - ro.y) / rd.y;
      vec2 e = o + rd.xz * t;
      if (t > 0.0 && t < H.t && dot(e, e) < r * r) { H.t = t; H.id = id; H.k = k; H.n = vec3(0.0, sign(ro.y - yc), 0.0); H.q = vec3(e.x / r, yc - y0, e.y / r); }
    }

    // Whether the ray passes through the box lo..hi before tMax.
    bool near(vec3 ro, vec3 rd, vec3 lo, vec3 hi, float tMax) {
      vec3 t1 = (lo - ro) / rd, t2 = (hi - ro) / rd;
      vec3 tn = min(t1, t2), tf = max(t1, t2);
      float a = max(max(tn.x, tn.y), tn.z), b = min(min(tf.x, tf.y), tf.z);
      return b > max(a, 0.0) && a < tMax;
    }

    // The truss: its rails along the edges, braced across (how much is metal at q).
    float truss(vec3 q) {
      vec3 h = TRUSS_H;
      // Across the face it was met on: its rails at both edges, a zig-zag between.
      float v = abs(q.z) > h.z - 1e-3 ? q.y : q.z;
      float side = h.y - abs(v);
      float rail = smoothstep(0.03, 0.022, side);
      float tri = abs(fract(q.x / (2.0 * h.y)) * 2.0 - 1.0);
      float diag = smoothstep(0.1, 0.06, abs(tri - (v / h.y * 0.5 + 0.5)));
      return max(rail, diag);
    }

    Hit trace(vec3 ro, vec3 rd) {
      Hit H = Hit(1e9, 0, 0, vec3(0.0), vec3(0.0));
      if (rd.y < 0.0) { float tt = -ro.y / rd.y; if (tt < H.t) { H.t = tt; H.id = FLOOR; H.n = vec3(0.0, 1.0, 0.0); } }
      if (rd.y > 0.0) { float tt = (ROOM.y - ro.y) / rd.y; if (tt < H.t) { H.t = tt; H.id = CEIL; H.n = vec3(0.0, -1.0, 0.0); } }
      if (abs(rd.x) > 1e-4) { float tt = (sign(rd.x) * ROOM.x - ro.x) / rd.x; if (tt > 0.0 && tt < H.t) { H.t = tt; H.id = SIDE; H.n = vec3(-sign(rd.x), 0.0, 0.0); } }
      if (rd.z > 0.0) { float tt = (ROOM.z - ro.z) / rd.z; if (tt < H.t) { H.t = tt; H.id = BACK; H.n = vec3(0.0, 0.0, -1.0); } }
      // The curtain, straight across behind the DJ (its folds are in the shading).
      if (rd.z > 0.0) {
        float tt = (CURT_Z - ro.z) / rd.z;
        vec3 p = ro + rd * tt;
        if (tt < H.t && abs(p.x) < CURT_X && p.y > STAGE_H && p.y < ROOM.y) { H.t = tt; H.id = CURTAIN; H.n = vec3(0.0, 0.0, -1.0); H.q = p; }
      }
      mat3 I = mat3(1.0);
      box(ro, rd, vec3(0.0, STAGE_H * 0.5, (STAGE_Z + ROOM.z) * 0.5), I, vec3(STAGE_X, STAGE_H * 0.5, (ROOM.z - STAGE_Z) * 0.5), STAGE, 0, H);
      box(ro, rd, vec3(0.0, ROOM.y - 0.42, CURT_Z - 0.16), I, vec3(CURT_X + 0.2, 0.42, 0.07), VALANCE, 0, H);
      for (int k = 0; k < 4 + zero; k++) {
        vec3 c = vec3(k < 2 ? -PIL_X : PIL_X, ROOM.y * 0.5, k % 2 == 0 ? ${PIL_Z[0].toFixed(2)} : ${PIL_Z[1].toFixed(2)});
        box(ro, rd, c, I, vec3(PIL_R, ROOM.y * 0.5, PIL_R), PILLAR, k, H);
      }
      for (int k = 0; k < ${SPEAKERS} + zero; k++) box(ro, rd, spkPos[k], spkRot[k], spkHalf[k], SPEAKER, k, H);
      for (int k = 0; k < 2 + zero; k++) {
        box(ro, rd, stbPos[k], stbRot[k], vec3(0.42, 0.21, 0.13), STROBE, k, H);
        float top = stbPos[k].y - 0.2;
        box(ro, rd, vec3(stbPos[k].x, (STAGE_H + top) * 0.5, stbPos[k].z + 0.05), I, vec3(0.025, (top - STAGE_H) * 0.5, 0.025), STAND, k, H);
      }
      box(ro, rd, DESK_C, I, DESK_H, DESK, 0, H);
      float c = cos(0.25), s = sin(0.25);
      box(ro, rd, TOP_C, mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c), TOP_H, TOP, 0, H);
      // The bar: its counter, the shelves behind on the back wall, stools, lamps hanging over it.
      if (near(ro, rd, vec3(-ROOM.x, 0.0, BAR_Z - 0.8), vec3(BAR_X + 1.7, ROOM.y, ROOM.z), H.t)) {
        box(ro, rd, vec3(BAR_X, 0.53, BAR_Z), I, vec3(1.5, 0.53, 0.28), COUNTER, 0, H);
        box(ro, rd, vec3(BAR_X, 1.09, BAR_Z - 0.04), I, vec3(1.56, 0.03, 0.36), COUNTER, 1, H);
        box(ro, rd, vec3(BAR_X, 1.95, ROOM.z - 0.14), I, vec3(1.5, 0.85, 0.14), SHELF, 0, H);
        box(ro, rd, vec3(BAR_X, 0.5, ROOM.z - 0.25), I, vec3(1.5, 0.5, 0.25), SHELF, 1, H);
        for (int i = 0; i < 4 + zero; i++) {
          vec2 c = vec2(BAR_X + 1.2 - float(i) * 0.8, BAR_Z - 0.72);
          cyl(ro, rd, c, 0.72, 0.79, 0.19, STOOL, 0, H);
          cyl(ro, rd, c, 0.0, 0.72, 0.025, STOOL, 1, H);
          cyl(ro, rd, c, 0.0, 0.03, 0.17, STOOL, 1, H);
        }
        for (int i = 0; i < 3 + zero; i++) {
          vec2 c = vec2(BAR_X - 1.0 + float(i), BAR_Z);
          cyl(ro, rd, c, LAMP_Y0, LAMP_Y1, 0.14, LAMP, 0, H);
          cyl(ro, rd, c, LAMP_Y1, ROOM.y, 0.006, LAMP, 1, H);
        }
      }
      // The bench against the back wall, its wall lights, the plant's pot.
      if (near(ro, rd, vec3(BENCH_X - 1.1, 0.0, 14.5), vec3(ROOM.x, 2.3, ROOM.z), H.t)) {
        box(ro, rd, vec3(BENCH_X, 0.2, ROOM.z - 0.32), I, vec3(1.0, 0.2, 0.3), BENCH, 0, H);
        box(ro, rd, vec3(BENCH_X, 0.46, ROOM.z - 0.34), I, vec3(0.96, 0.07, 0.3), BENCH, 1, H);
        box(ro, rd, vec3(BENCH_X, 0.88, ROOM.z - 0.1), I, vec3(1.0, 0.38, 0.09), BENCH, 2, H);
        box(ro, rd, vec3(BENCH_X - 0.6, 2.0, ROOM.z - 0.04), I, vec3(0.1, 0.14, 0.04), SCONCE, 0, H);
        box(ro, rd, vec3(BENCH_X + 0.6, 2.0, ROOM.z - 0.04), I, vec3(0.1, 0.14, 0.04), SCONCE, 1, H);
        cyl(ro, rd, POT_C.xz, 0.0, 0.62, 0.27, POT, 0, H);
      }
      // The EXIT sign over the door.
      box(ro, rd, vec3(DOOR_C.x, 2.55, ROOM.z - 0.04), I, vec3(0.34, 0.13, 0.04), EXIT, 0, H);
      // The railings: a post every so often, a rail on top and one halfway.
      for (int k = 0; k < 2 + zero; k++) {
        float x = k == 0 ? -RAIL_X : RAIL_X;
        float len = ROOM.z - RAIL_Z;
        if (!near(ro, rd, vec3(x - 0.03, 0.0, RAIL_Z), vec3(x + 0.03, 1.1, ROOM.z), H.t)) continue;
        box(ro, rd, vec3(x, 1.05, RAIL_Z + len * 0.5), I, vec3(0.025, 0.025, len * 0.5), RAIL, 0, H);
        box(ro, rd, vec3(x, 0.55, RAIL_Z + len * 0.5), I, vec3(0.014, 0.014, len * 0.5), RAIL, 0, H);
        for (int i = 0; i < 6 + zero; i++) box(ro, rd, vec3(x, 0.525, RAIL_Z + 0.06 + float(i) * (len - 0.12) / 5.0), I, vec3(0.022, 0.525, 0.022), RAIL, 1, H);
      }
      Hit T = H;
      box(ro, rd, TRUSS_C, I, TRUSS_H, TRUSS, 0, T);
      if (T.id == TRUSS && truss(T.q) > 0.0) H = T;
      return H;
    }

    // The potted plant: broad leaves on long stalks, rising and bending out.
    float ellipsoid(vec3 p, vec3 r) {
      float k0 = length(p / r);
      float k1 = length(p / (r * r));
      return k0 * (k0 - 1.0) / k1;
    }
    float plant(vec3 p) {
      vec3 q = p - (POT_C + vec3(0.0, 0.58, 0.0));
      float d = 1e9;
      for (int i = 0; i < 9 + zero; i++) {
        float fi = float(i);
        float a = fi * 2.4 + 0.5;
        vec3 f = normalize(vec3(cos(a), 1.7 - fi * 0.13, sin(a)));
        vec3 sd = normalize(vec3(-sin(a), 0.0, cos(a)));
        vec3 up = cross(f, sd);
        float len = 0.42 + 0.16 * fract(fi * 0.618);
        vec3 l = vec3(dot(q, f), dot(q, up), dot(q, sd));
        // Bending away and down further out.
        l.y -= 0.55 * l.x * l.x;
        // The stalk, then the leaf.
        d = min(d, length(vec2(l.y, l.z)) - 0.008 + max(0.0, l.x - len * 0.9) * 10.0 + max(0.0, -l.x) * 10.0);
        d = min(d, ellipsoid(l - vec3(len * 1.35, 0.0, 0.0), vec3(len * 0.6, 0.012, 0.13)));
      }
      return d;
    }
    float plantHit(vec3 ro, vec3 rd, float tMax) {
      vec3 lo = POT_C + vec3(-1.0, 0.5, -1.0), hi = vec3(ROOM.x, 2.2, ROOM.z);
      vec3 t1 = (lo - ro) / rd, t2 = (hi - ro) / rd;
      vec3 tn = min(t1, t2), tf = max(t1, t2);
      float a = max(max(max(tn.x, tn.y), tn.z), 0.0), b = min(min(min(tf.x, tf.y), tf.z), tMax);
      if (a >= b) return -1.0;
      float t = a;
      for (int i = 0; i < 64 + zero; i++) {
        float d = plant(ro + rd * t);
        if (d < 0.002) return t;
        t += d * 0.7;
        if (t > b) break;
      }
      return -1.0;
    }
  `;

  const SCENE_FS = ROOM_GL + `
    out vec4 o;
    uniform highp sampler2DArray bakeMap;
    uniform highp sampler3D bakeVol0, bakeVol1;
    // A still camera: what each pixel's ray meets kept (keep: written, 1 its
    // first texture, 2 its second; kept: read from gb0 and gb1).
    uniform int keep, kept;
    uniform highp sampler2D gb0, gb1;

    // The ball's spots where the direction from the ball, turned with it,
    // falls near one of its facets' reflections.
    float spots(vec3 p) {
      vec3 d = normalize(p - BALL);
      vec3 q = rotY(d, -spin);
      float lon = atan(q.z, q.x) / (2.0 * PI) + 0.5;
      float lat = asin(clamp(q.y, -1.0, 1.0)) / PI + 0.5;
      vec2 cell = vec2(lon * 40.0, lat * 20.0);
      vec2 id = floor(cell);
      vec2 f = fract(cell) - 0.5;
      f.x *= max(0.15, cos((lat - 0.5) * PI));
      // Not round the poles (where the rod holds it and the facets crowd).
      float keep = step(0.45, hash12(id + 3.1)) * smoothstep(0.82, 0.7, abs(q.y));
      float r = length(f);
      float dist = length(p - BALL);
      return keep * exp(-r * r * 90.0) * 16.0 / (dist * dist + 4.0);
    }

    // The floor's tile (i, j) and how it shines.
    vec3 tile(vec2 ij) {
      float n = beatN;
      vec3 c = vec3(0.0);
      if (pattern == 0) {
        float on = mod(ij.x + ij.y + n, 2.0);
        c = pal[int(mod(floor(n / 2.0), 4.0))] * on * (0.3 + 0.7 * pulse);
      } else if (pattern == 1) {
        float d = length(ij + 0.5 - vec2(0.0, 3.5));
        for (int k = 0; k < 4 + zero; k++) {
          float age = kicks[k];
          float ring = exp(-pow(d - age * 7.0, 2.0) * 0.7) * exp(-age * 1.4);
          c += pal[int(mod(float(k) + floor(d * 0.5), 4.0))] * ring;
        }
      } else if (pattern == 2) {
        int col = int(clamp((ij.x + 7.0) / 14.0 * 16.0, 0.0, 15.0));
        float lv = levels[col];
        float row = (ij.y + 4.0) / 14.0;
        float on = step(row, lv);
        c = mix(pal[2], pal[0], row) * on * (0.55 + 0.45 * lv);
      } else {
        float h = hash12(ij + floor(n) * 7.13);
        float on = step(h, 0.3);
        c = pal[int(mod(h * 37.0, 4.0))] * on * exp(-beatPh * 2.5);
      }
      return c;
    }

    // The light the LED floor throws on what stands near it (three of its
    // tiles nearest the point, the way the surface faces).
    vec3 floorGlow(vec3 p, vec3 n) {
      vec3 s = vec3(0.0);
      vec2 side = vec2(n.z, -n.x);
      if (dot(side, side) < 0.01) side = vec2(1.0, 0.0);
      side = normalize(side);
      for (int i = 0; i < 3 + zero; i++) {
        vec2 q = p.xz + n.xz * 0.9 + side * (float(i) - 1.0) * 1.1;
        q = clamp(q, vec2(-LED_X + 0.01, -30.0), vec2(LED_X - 0.01, LED_Z - 0.01));
        vec3 v = vec3(q.x, 0.0, q.y) - p;
        float d = length(v);
        s += tile(floor(q)) * (0.25 + 0.75 * max(0.0, dot(n, v / d))) / (1.0 + d * d * 0.7);
      }
      return s * 0.5;
    }

    // The beams' pools where they land.
    vec3 pools(vec3 p) {
      vec3 sum = vec3(0.0);
      for (int i = 0; i < ${HEADS} + zero; i++) {
        vec3 v = p - headPos[i];
        float al = dot(v, headDir[i]);
        if (al > 0.0) {
          float off = length(v - headDir[i] * al) / (0.05 + al * 0.075);
          sum += headCol[i] * exp(-off * off * 1.5) * 0.9 * beams;
        }
      }
      return sum;
    }

    // How much of the beams' light the ray picks up on its way to tHit.
    vec3 beamHaze(vec3 ro, vec3 rd, float tHit) {
      vec3 sum = vec3(0.0);
      for (int i = 0; i < ${HEADS} + zero; i++) {
        vec3 s = headPos[i];
        vec3 d = headDir[i];
        // Closest approach between the ray and the beam's axis.
        vec3 w = ro - s;
        float b = dot(rd, d);
        float den = 1.0 - b * b;
        float t = den > 1e-4 ? (b * dot(d, w) - dot(rd, w)) / den : 0.0;
        t = clamp(t, 0.0, tHit);
        vec3 p = ro + rd * t;
        float along = dot(p - s, d);
        if (along > 0.0) {
          float dist = length(p - s - d * along);
          float width = 0.05 + along * 0.075;
          float g = exp(-pow(dist / width, 2.0));
          // The fog's noise only where the beam shows: most pixels are far from most beams.
          if (g > 0.002) {
            float fog = 0.6 + 0.4 * fbm(p.xz * 0.6 + vec2(time * 0.15, 0.0));
            sum += headCol[i] * g * (0.05 / width) * fog * haze * beams;
          }
        }
      }
      return sum;
    }

    // The strobes' light on a surface: wide cones towards the floor.
    vec3 strobeLight(vec3 p, vec3 n) {
      vec3 s = vec3(0.0);
      for (int i = 0; i < 2 + zero; i++) {
        if (stb[i] < 0.002) continue;
        vec3 v = stbPos[i] - p;
        float d = length(v);
        vec3 l = v / d;
        float cone = 0.06 + 0.94 * smoothstep(-0.1, 0.6, dot(-l, stbRot[i] * vec3(0.0, 0.0, -1.0)));
        s += vec3(1.0, 0.98, 0.95) * stb[i] * 16.0 * max(0.0, dot(n, l)) * cone / (1.0 + d * d * 0.06);
      }
      return s * stbRoom;
    }

    // The uplights at the pillars' feet, in front of them, washing up their
    // fronts (and the speakers on them).
    vec3 pillarWash(vec3 p, vec3 n) {
      float px = sign(p.x) * PIL_X;
      float pz = abs(p.z - ${PIL_Z[0].toFixed(2)}) < abs(p.z - ${PIL_Z[1].toFixed(2)}) ? ${PIL_Z[0].toFixed(2)} : ${PIL_Z[1].toFixed(2)};
      vec3 l = vec3(px, 0.15, pz - PIL_R - 0.35) - p;
      float d = length(l);
      float across = exp(-pow((p.x - px) / (0.35 + p.y * 0.12), 2.0));
      return upCol * 5.0 * across * (0.6 + 0.4 * max(0.0, dot(n, l / d))) / (1.0 + d * 0.35);
    }

    // The side lights, baked: read from the maps on the lounges' floor and
    // walls, or for what stands there from the volume (its light from the
    // way the most of it comes, the rest from all round).
    vec3 bakedLight(vec3 p, vec3 n) {
      float ax = abs(p.x);
      if (ax < BK_X || p.z < BK_Z) return vec3(0.0);
      float side = p.x < 0.0 ? 0.0 : 1.0;
      float u = (ax - BK_X) / (ROOM.x - BK_X), w = (p.z - BK_Z) / (ROOM.z - BK_Z);
      vec4 a;
      if (p.y < 0.003 && n.y > 0.9) {
        a = texture(bakeMap, vec3(u, w, side * 3.0));
      } else if (p.z > ROOM.z - 0.003 && n.z < -0.9) {
        a = texture(bakeMap, vec3(u, p.y / ROOM.y, side * 3.0 + 1.0));
      } else if (ax > ROOM.x - 0.003 && abs(n.x) > 0.9) {
        a = texture(bakeMap, vec3(w, p.y / ROOM.y, side * 3.0 + 2.0));
      } else {
        // Half a texel out from the surface, so it is not lit from inside the thing.
        vec3 q = p + n * 0.07;
        float lx = clamp((abs(q.x) - BK_X) / (ROOM.x - BK_X), 0.5 / VOL_NX, 1.0 - 0.5 / VOL_NX);
        vec3 t = vec3((side + lx) * 0.5, q.y / VOL_H, (q.z - BK_Z) / (ROOM.z - BK_Z));
        vec4 c = texture(bakeVol0, t);
        vec3 dir = texture(bakeVol1, t).xyz;
        float k = min(1.0, length(dir));
        a = c * (k * max(0.0, dot(n, dir / max(k, 1e-4))) + (1.0 - k) * 0.5) * smoothstep(VOL_H, VOL_H - 0.5, q.y);
      }
      return (a.rgb + NEON_PINK * a.a * neonOn) * smoothstep(BK_X, BK_X + 0.6, ax) * smoothstep(BK_Z, BK_Z + 0.8, p.z);
    }

    // All the light falling on p (facing n), but the curtain's own.
    vec3 lightAt(vec3 p, vec3 n, float fg, float sk) {
      float toBall = clamp(dot(n, normalize(BALL - p)) * 3.0 + 0.3, 0.0, 1.0);
      // A little of the floor's light everywhere, most on what faces down or the floor.
      vec3 fill = vec3(0.035, 0.032, 0.042) + floorAvg * (0.35 - 0.25 * n.y) * clamp(1.4 - p.y * 0.12, 0.3, 1.0);
      vec3 l = fill + vec3(0.95, 0.92, 1.0) * spots(p) * toBall + pools(p) + strobeLight(p, n) * sk + bakedLight(p, n);
      if (fg > 0.0) l += floorGlow(p, n) * fg;
      return l;
    }

    vec3 ballColor(vec3 ro, vec3 rd, float t) {
      vec3 p = ro + rd * t;
      vec3 n = normalize(p - BALL);
      vec3 q = rotY(n, -spin);
      float lon = atan(q.z, q.x) / (2.0 * PI) + 0.5;
      float lat = asin(clamp(q.y, -1.0, 1.0)) / PI + 0.5;
      vec2 cell = vec2(lon * 40.0, lat * 20.0);
      vec2 id = floor(cell);
      vec2 f = fract(cell);
      float grout = smoothstep(0.0, 0.12, f.x) * smoothstep(1.0, 0.88, f.x) * smoothstep(0.0, 0.12, f.y) * smoothstep(1.0, 0.88, f.y);
      // Each facet a little mirror: the room it sees, with a glint now and then.
      vec3 fn = rotY(vec3(cos((id.y + 0.5) / 20.0 * PI - PI / 2.0) * cos(((id.x + 0.5) / 40.0 - 0.5) * 2.0 * PI), sin((id.y + 0.5) / 20.0 * PI - PI / 2.0),
        cos((id.y + 0.5) / 20.0 * PI - PI / 2.0) * sin(((id.x + 0.5) / 40.0 - 0.5) * 2.0 * PI)), spin);
      vec3 r = reflect(rd, normalize(mix(n, fn, 0.8)));
      float h = hash12(id + 17.0);
      vec3 env = vec3(0.05, 0.05, 0.07) + pal[int(mod(h * 13.0, 4.0))] * 0.25 * max(0.0, r.y + 0.3);
      // Facing the stage: the curtain's red and the strobes.
      env += vec3(0.25, 0.02, 0.03) * smoothstep(0.3, 0.9, r.z) + vec3(1.0) * (stb[0] + stb[1]) * smoothstep(0.6, 0.95, r.z) * 2.0;
      float glint = pow(max(0.0, dot(r, normalize(vec3(-0.4, 0.5, -0.8)))), 60.0) * 4.0;
      float twinkle = step(0.97 - sparkle * 0.05, hash12(id + floor(time * 8.0))) * 2.5;
      return (env + vec3(1.0) * (glint + twinkle * (0.3 + kick))) * grout + vec3(0.02) * (1.0 - grout);
    }

    // A cone of a speaker at d from its middle (radius R): its own shade, and
    // the ring of light round it (ring: 0 none, else which way it runs).
    vec3 driver(vec2 d, float R, float ring, inout vec3 em) {
      float r = length(d) / R;
      float a = atan(d.y, d.x) / (2.0 * PI) + 0.5;
      if (ring != 0.0 && r > 1.0 && r < 1.3) {
        // LEDs round the rim, a bright run chasing round with the beat.
        float led = smoothstep(0.5, 0.2, abs(fract(a * 36.0) - 0.5)) * smoothstep(1.0, 1.04, r) * smoothstep(1.13, 1.08, r);
        float chase = 0.35 + 0.65 * pow(fract(a * 2.0 * ring - beatT * 0.5 * ring), 3.0);
        em += ringCol * ringGlow * (led * chase * 3.0 + exp(-pow((r - 1.08) * 9.0, 2.0)) * 0.6);
      }
      if (r > 1.0) return vec3(-1.0);
      vec2 dir = d / max(length(d), 1e-4);
      float lit = 0.5 + 0.5 * dot(dir, normalize(vec2(-0.5, 0.8)));
      if (r > 0.86) return vec3(0.03 + 0.05 * lit * smoothstep(0.86, 0.93, r) * smoothstep(1.0, 0.93, r));
      if (r < 0.3) {
        float dome = 1.0 - (r / 0.3) * (r / 0.3);
        return vec3(0.05 + 0.1 * dome * (0.6 + 0.4 * lit) + 0.25 * exp(-dot(d / R - vec2(-0.07, 0.09), d / R - vec2(-0.07, 0.09)) * 600.0));
      }
      // The cone: pushed out and drawn in by the bass, a band of light on it moving with it.
      float band = exp(-pow((r - 0.55 - 0.18 * pump) * 7.0, 2.0)) * (0.5 + 0.5 * lit);
      // The ring's light caught on the cone's outer part.
      if (ring != 0.0) em += ringCol * ringGlow * 0.12 * smoothstep(0.45, 0.86, r);
      return vec3(0.035 + 0.025 * (1.0 - r) + 0.07 * band);
    }

    // The DJ: a few rounded shapes, nodding with the beat, one hand in the air now and then.
    float capsule(vec3 p, vec3 a, vec3 b, float r) {
      vec3 pa = p - a, ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * h) - r;
    }
    float smin(float a, float b, float k) {
      float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
      return mix(b, a, h) - k * h * (1.0 - h);
    }
    float dj(vec3 p) {
      vec3 q = p - vec3(0.0, STAGE_H, DJ_Z);
      float sh = 1.38 + djBob * 0.4;
      vec3 tq = vec3(q.x, q.y, q.z * 1.7);
      float d = capsule(tq, vec3(0.0, 0.5, 0.0), vec3(0.0, sh - 0.08, 0.0), 0.22) / 1.7;
      d = smin(d, capsule(q, vec3(-0.2, sh, 0.0), vec3(0.2, sh, 0.0), 0.09), 0.1);
      vec3 hc = vec3(0.0, sh + 0.27 + djBob * 0.6, -0.03 - djBob * 0.5);
      d = smin(d, capsule(q, vec3(0.0, sh, 0.0), hc, 0.06), 0.05);
      d = min(d, length((q - hc) * vec3(1.0, 0.92, 1.0)) - 0.12);
      // Headphones: a cup each side.
      d = min(d, length(q - hc - vec3(0.125, -0.01, 0.0)) - 0.055);
      d = min(d, length(q - hc + vec3(0.125, 0.01, 0.0)) - 0.055);
      // The right hand on the deck, the left on the mixer or up.
      vec3 rs = vec3(0.26, sh - 0.02, 0.0);
      d = smin(d, capsule(q, rs, vec3(0.36, sh - 0.33, -0.28), 0.055), 0.04);
      d = min(d, capsule(q, vec3(0.36, sh - 0.33, -0.28), vec3(0.42, 1.14, -0.66), 0.045));
      vec3 ls = vec3(-0.26, sh - 0.02, 0.0);
      vec3 le = mix(vec3(-0.34, sh - 0.33, -0.3), vec3(-0.42, sh + 0.25, -0.12), djArm);
      vec3 lh = mix(vec3(-0.28, 1.14, -0.66), vec3(-0.46, sh + 0.68, -0.22), djArm);
      d = smin(d, capsule(q, ls, le, 0.055), 0.04);
      d = min(d, capsule(q, le, lh, 0.045));
      return d;
    }
    // A shape's normal from four samples round p (in a loop: one copy of the shape's code).
    vec3 tetra(int i) {
      return i == 0 ? vec3(1.0, -1.0, -1.0) : i == 1 ? vec3(-1.0, -1.0, 1.0) : i == 2 ? vec3(-1.0, 1.0, -1.0) : vec3(1.0);
    }
    vec3 djNormal(vec3 p) {
      vec3 n = vec3(0.0);
      for (int i = 0; i < 4 + zero; i++) n += tetra(i) * dj(p + tetra(i) * 0.004);
      return normalize(n);
    }
    // How far along the ray the DJ is (or -1), before tMax.
    float djHit(vec3 ro, vec3 rd, float tMax) {
      vec3 lo = vec3(-0.85, STAGE_H + 0.4, DJ_Z - 0.85), hi = vec3(0.85, STAGE_H + 2.5, DJ_Z + 0.35);
      vec3 t1 = (lo - ro) / rd, t2 = (hi - ro) / rd;
      vec3 tn = min(t1, t2), tf = max(t1, t2);
      float a = max(max(max(tn.x, tn.y), tn.z), 0.0), b = min(min(min(tf.x, tf.y), tf.z), tMax);
      if (a >= b) return -1.0;
      float t = a;
      for (int i = 0; i < 48 + zero; i++) {
        float d = dj(ro + rd * t);
        if (d < 0.002) return t;
        t += d;
        if (t > b) break;
      }
      return -1.0;
    }


    float seg(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a, ba = b - a;
      return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
    }

    // The neon sign on the back wall: a cocktail glass with an olive on a
    // pick. u in metres from its middle; its light (tubes and their glow on the wall).
    vec3 neon(vec2 u) {
      u /= 1.3;
      float glass = min(min(seg(u, vec2(-0.5, 0.5), vec2(0.5, 0.5)), seg(u, vec2(-0.5, 0.5), vec2(0.0, -0.1))), seg(u, vec2(0.5, 0.5), vec2(0.0, -0.1)));
      glass = min(min(glass, seg(u, vec2(0.0, -0.1), vec2(0.0, -0.6))), seg(u, vec2(-0.3, -0.6), vec2(0.3, -0.6)));
      float olive = abs(length(u - vec2(0.1, 0.24)) - 0.07);
      float pick = min(seg(u, vec2(-0.02, 0.12), vec2(0.36, 0.66)), olive);
      vec3 c = vec3(0.0);
      for (int i = 0; i < 2 + zero; i++) {
        float d = (i == 0 ? glass : pick) * 1.3;
        vec3 tint = i == 0 ? NEON_PINK : NEON_GREEN;
        float core = smoothstep(0.03, 0.012, d);
        c += (tint * (core * 3.0 + exp(-d * 28.0) * 0.6 + exp(-d * 5.0) * 0.12) + vec3(1.0) * core * 0.8) * neonOn;
      }
      return c;
    }

    // EXIT in light letters, u from the left of the E (each letter 0.1 wide, 0.16 high).
    float exitText(vec2 u) {
      vec2 l = vec2(0.1, 0.08);
      float d = 1e9;
      vec2 o = u;
      d = min(d, seg(o, vec2(0.0, -l.y), vec2(0.0, l.y)));
      d = min(d, seg(o, vec2(0.0, l.y), vec2(l.x, l.y)));
      d = min(d, seg(o, vec2(0.0, 0.0), vec2(l.x * 0.8, 0.0)));
      d = min(d, seg(o, vec2(0.0, -l.y), vec2(l.x, -l.y)));
      o.x -= 0.15;
      d = min(d, seg(o, vec2(0.0, -l.y), vec2(l.x, l.y)));
      d = min(d, seg(o, vec2(0.0, l.y), vec2(l.x, -l.y)));
      o.x -= 0.15;
      d = min(d, seg(o, vec2(l.x * 0.5, -l.y), vec2(l.x * 0.5, l.y)));
      o.x -= 0.15;
      d = min(d, seg(o, vec2(0.0, l.y), vec2(l.x, l.y)));
      d = min(d, seg(o, vec2(l.x * 0.5, l.y), vec2(l.x * 0.5, -l.y)));
      return d;
    }

    // The bar's shelves from the front: three rows of bottles lit from behind.
    // s in metres from the middle (half 1.5 x 0.85).
    vec3 backBar(vec2 s) {
      const float ROW = 0.5667;
      float ry = (s.y + 0.85) / ROW;
      float row = floor(ry);
      float y = fract(ry) * ROW;
      // Lit from the LED strip under the shelf above: brightest at the top.
      vec3 back = vec3(1.0, 0.72, 0.42) * (0.25 + 0.75 * smoothstep(0.05, ROW, y));
      if (y < 0.03) return vec3(0.35, 0.22, 0.12) * 0.3;
      y -= 0.03;
      float cx = (s.x + 1.5) / 0.14;
      float id = floor(cx);
      float fx = (fract(cx) - 0.5) * 0.14;
      float h = hash12(vec2(id, row));
      if (h < 0.12) return back;
      float bh = 0.2 + 0.14 * hash12(vec2(id, row + 7.0));
      float bw = 0.035 + 0.015 * hash12(vec2(id, row + 3.0));
      float w = y < bh * 0.66 ? bw : y < bh * 0.8 ? mix(bw, 0.012, (y - bh * 0.66) / (bh * 0.14)) : y < bh ? 0.012 : 0.0;
      if (abs(fx) >= w) return back;
      float g = hash12(vec2(id, row + 11.0));
      vec3 glass = g < 0.3 ? vec3(1.0, 0.55, 0.15) : g < 0.5 ? vec3(0.3, 0.8, 0.3) : g < 0.7 ? vec3(0.9, 0.92, 0.85) : g < 0.85 ? vec3(0.3, 0.5, 1.0) : vec3(0.9, 0.2, 0.25);
      float full = step(y, bh * (0.35 + 0.3 * hash12(vec2(id, row + 5.0))));
      return glass * back * (full > 0.0 ? 0.55 : 0.9) + vec3(1.0) * 0.3 * exp(-pow((fx + w * 0.45) / (w * 0.2), 2.0));
    }

    vec3 plantNormal(vec3 p) {
      vec3 n = vec3(0.0);
      for (int i = 0; i < 4 + zero; i++) n += tetra(i) * plant(p + tetra(i) * 0.003);
      return normalize(n);
    }

    // What a pixel shows, before its light is worked out (once, in main: the
    // light falling there is long to work out, and the compiler copies a
    // function in wherever it is called): how much of the light comes back
    // (alb), what it gives off itself (em), more light of its own (add), how
    // much the floor's glow (fg) and the strobes (sk) count, and gold (which
    // keeps its own colour under coloured light).
    struct Surf { vec3 p; vec3 n; vec3 alb; vec3 em; vec3 add; float fg; float sk; bool gold; };

    // One chain of ifs and a single return: returning from inside the
    // branches made the shader many times slower to compile on Windows.
    Surf shade(Hit H, vec3 ro, vec3 rd) {
      vec3 p = ro + rd * H.t;
      vec3 n = H.n;
      vec3 q = H.q;
      Surf S = Surf(p, n, vec3(0.0), vec3(0.0), vec3(0.0), 1.0, 1.0, false);
      int id = H.id;
      if (id == FLOOR) {
        if (abs(p.x) < LED_X && p.z < LED_Z) {
          vec2 ij = floor(p.xz);
          vec2 f = fract(p.xz);
          float inner = smoothstep(0.0, 0.06, f.x) * smoothstep(1.0, 0.94, f.x) * smoothstep(0.0, 0.06, f.y) * smoothstep(1.0, 0.94, f.y);
          float glow = 1.0 - length(f - 0.5) * 0.7;
          S.em = vec3(0.012, 0.012, 0.016) + tile(ij) * inner * glow * 0.95;
          // The spots, the beams' pools and a little of the strobes on it, not
          // its own glow.
          S.alb = vec3(0.45);
          S.fg = 0.0;
          S.sk = 0.13;
        } else {
          // The plain floor round it: dark, a little worn.
          S.alb = vec3(0.06, 0.058, 0.062) * (0.75 + 0.25 * vnoise(p.xz * 2.3) + 0.1 * vnoise(p.xz * 13.0));
        }
      } else if (id == CEIL) {
        S.alb = vec3(0.1);
      } else if (id == SIDE || id == BACK) {
        float panel = id == SIDE ? p.z : p.x;
        float seam = smoothstep(0.02, 0.0, abs(fract(panel * 0.5) - 0.5) - 0.48);
        S.alb = vec3(0.3, 0.28, 0.36) * (0.8 + 0.2 * vnoise(vec2(panel * 3.0, p.y * 3.0))) * (1.0 - seam * 0.5);
        vec2 u = p.xy - NEON_C.xy;
        vec2 dv = vec2(p.x - DOOR_C.x, p.y);
        if (id == BACK && abs(u.x) < 2.0 && abs(u.y) < 2.0) {
          S.em = neon(u);
        } else if (id == BACK && abs(dv.x) < 0.81 && dv.y < 2.26) {
          // The door out: two leaves in a frame, push bars across, the EXIT sign's green on it.
          if (abs(dv.x) > 0.75 || dv.y > 2.2) {
            S.alb = vec3(0.12);
          } else {
            float gap = smoothstep(0.004, 0.012, abs(dv.x));
            float bar = step(0.95, dv.y) * step(dv.y, 1.02) * step(0.08, abs(dv.x)) * step(abs(dv.x), 0.68);
            float kick = step(dv.y, 0.25);
            float edge = smoothstep(0.0, 0.03, 0.75 - abs(dv.x)) * smoothstep(0.0, 0.03, 2.2 - dv.y);
            S.alb = vec3(0.32, 0.33, 0.36) * (0.85 + 0.15 * kick) * edge * gap + bar * vec3(0.7);
            // Light from outside under it.
            S.em = vec3(1.0, 0.9, 0.75) * smoothstep(0.03, 0.0, dv.y) * step(abs(dv.x), 0.74) * 1.5;
          }
        }
      } else if (id == STAGE) {
        if (n.y > 0.5) {
          // Dark brown boards, running across.
          float row = p.z / 0.22;
          float rid = floor(row);
          float fr = fract(row);
          float along = p.x + hash12(vec2(rid, 4.0)) * 5.0;
          float seam = smoothstep(0.0, 0.05, fr) * smoothstep(1.0, 0.95, fr) * smoothstep(0.0, 0.01, abs(fract(along / 2.6) - 0.5) - 0.005 + 0.01);
          float grain = 0.75 + 0.35 * vnoise(vec2(along * 9.0, rid * 7.0 + fr * 3.0)) + 0.15 * vnoise(vec2(along * 40.0, rid * 3.0));
          S.alb = vec3(0.2, 0.1, 0.045) * grain * (0.75 + 0.35 * hash12(vec2(rid, 9.0))) * (0.35 + 0.65 * seam);
          S.add = upCol * 0.8 * exp(-(CURT_Z - p.z) * 1.2);
          // A little gloss: the curtain's glow and the strobes along the boards.
          S.em = (upCol * 0.08 * pow(max(0.0, rd.z), 8.0) + vec3(stb[0] + stb[1]) * stbRoom * 0.15 * pow(max(0.0, rd.z), 12.0)) * seam;
        } else {
          // The stage's front: black, an LED strip along its edge.
          S.alb = vec3(0.04);
          if (n.z < -0.5) {
            float strip = smoothstep(0.03, 0.015, abs(p.y - (STAGE_H - 0.05)));
            float dots = 0.5 + 0.5 * smoothstep(0.3, 0.1, abs(fract(p.x * 10.0) - 0.5));
            S.em = pal[int(mod(floor(beatN / 4.0) + 2.0, 4.0))] * strip * dots * (0.4 + 0.8 * pulse);
          }
        }
      } else if (id == PILLAR) {
        float seam = smoothstep(0.012, 0.0, abs(fract(p.y / 1.2) - 0.5) - 0.49);
        S.alb = vec3(0.22, 0.21, 0.24) * (0.8 + 0.25 * vnoise(vec2(p.x + p.z, p.y) * 4.0)) * (1.0 - seam * 0.6);
        S.add = pillarWash(p, n);
      } else if (id == SPEAKER) {
        vec3 h = spkHalf[H.k];
        bool stage = H.k < 2;
        if (!stage) S.add = pillarWash(p, n) * 1.1;
        S.alb = vec3(0.09);
        // The front: its cones (and the stage's ring lights), the one nearest worked out.
        if (abs(q.z + h.z) < 1e-3) {
          vec3 em = vec3(0.0);
          bool upper = q.y > (stage ? -0.03 : 0.2);
          vec2 at = stage ? (upper ? vec2(0.0, 0.4) : vec2(0.0, -0.52)) : (upper ? vec2(0.0, 0.43) : vec2(0.0, -0.15));
          float R = stage ? (upper ? 0.3 : 0.42) : (upper ? 0.1 : 0.3);
          vec3 c = driver(q.xy - at, R, stage ? (upper ? -1.0 : 1.0) : 0.0, em);
          if (stage) {
            // The horn on top.
            vec2 hd = (q.xy - vec2(0.0, 0.9)) / vec2(0.4, 0.13);
            float hm = max(abs(hd.x), abs(hd.y));
            if (hm < 1.0) c = vec3(0.02 + 0.05 * (1.0 - hm));
          } else {
            // A small blue light, on.
            vec2 led = q.xy - vec2(0.0, -h.y + 0.07);
            em += vec3(0.2, 0.5, 1.0) * exp(-dot(led, led) * 9000.0) * 2.0;
          }
          float edge = min(h.x - abs(q.x), h.y - abs(q.y));
          S.alb = c.x >= 0.0 ? c * 2.0 : vec3(0.05 + 0.1 * smoothstep(0.03, 0.0, edge));
          S.em = em;
        }
      } else if (id == STROBE) {
        vec3 h = vec3(0.42, 0.21, 0.13);
        S.alb = vec3(0.07);
        if (abs(q.z + h.z) < 1e-3 && abs(q.x) < h.x - 0.04 && abs(q.y) < h.y - 0.04) {
          // The lens: a grid of little LEDs.
          vec2 g = fract(q.xy / 0.04) - 0.5;
          float led = exp(-dot(g, g) * 9.0);
          S.alb = vec3(0.0);
          S.em = vec3(0.04 + 0.05 * led) + vec3(1.0, 0.98, 0.94) * stb[H.k] * (8.0 + 22.0 * led);
        }
      } else if (id == STAND) {
        S.alb = vec3(0.06);
      } else if (id == RAIL || (id == STOOL && H.k == 1)) {
        // Chrome: some of the light, and a soft room above mirrored in it.
        S.alb = vec3(0.35);
        S.em = vec3(0.07, 0.065, 0.08) * (0.4 + 0.6 * max(0.0, reflect(rd, n).y));
      } else if (id == COUNTER) {
        if (H.k == 1) {
          // Its top: dark glossy wood, the lamps shining in it.
          S.alb = vec3(0.12, 0.06, 0.03) * (0.8 + 0.3 * vnoise(vec2(p.x * 6.0, p.z * 30.0)));
          vec3 r = reflect(rd, n);
          for (int i = 0; i < 3 + zero; i++) S.em += vec3(1.0, 0.75, 0.45) * pow(max(0.0, dot(r, normalize(vec3(BAR_X - 1.0 + float(i), LAMP_Y0 - 0.05, BAR_Z) - p))), 300.0) * 2.0;
        } else {
          // Its front: dark wooden slats, an LED strip along its foot.
          S.alb = vec3(0.14, 0.07, 0.035) * (0.55 + 0.45 * smoothstep(0.0, 0.02, abs(fract(p.x / 0.12) - 0.5) - 0.02));
          if (n.z < -0.5) S.em = pal[int(mod(floor(beatN / 4.0) + 3.0, 4.0))] * smoothstep(0.03, 0.01, abs(p.y - 0.06)) * (0.5 + 0.5 * pulse);
        }
      } else if (id == SHELF) {
        if (H.k == 0 && n.z < -0.5) {
          S.alb = vec3(0.02);
          S.em = backBar(q.xy);
        } else {
          S.alb = vec3(0.08, 0.045, 0.025);
        }
      } else if (id == STOOL) {
        S.alb = vec3(0.06);
        S.em = vec3(0.04) * pow(max(0.0, n.y), 4.0);
      } else if (id == LAMP) {
        if (H.k == 1) {
          S.em = vec3(0.02);
        } else {
          // A dark shade, warm light at its rim and out of its open bottom.
          S.alb = vec3(0.05);
          S.em = vec3(1.0, 0.72, 0.4) * (smoothstep(0.03, 0.0, q.y) * 2.5 + (n.y < -0.5 ? 6.0 : 0.0));
        }
      } else if (id == BENCH) {
        if (H.k == 0) {
          S.alb = vec3(0.1, 0.05, 0.03);
        } else {
          // The cushion, and the back buttoned in diamonds: red velvet.
          float shade = 0.85 + 0.15 * smoothstep(0.0, 0.05, 0.96 - abs(p.x - BENCH_X));
          if (H.k == 2) {
            vec2 g = vec2((p.x - BENCH_X) / 0.25, (p.y - 0.88) / 0.19);
            vec2 f = fract(vec2(g.x + 0.5 * mod(floor(g.y), 2.0), g.y)) - 0.5;
            float button = exp(-dot(f, f) * 40.0);
            shade = n.z < -0.5 ? 0.6 + 0.4 * (1.0 - button) * (0.7 + 0.3 * (1.0 - length(f))) : 0.7;
          }
          float sheen = pow(1.0 - abs(dot(n, -rd)), 2.0);
          S.alb = vec3(0.5, 0.03, 0.05) * shade + vec3(0.25, 0.03, 0.04) * sheen * 0.5;
        }
      } else if (id == SCONCE) {
        S.em = n.z < -0.5 ? vec3(1.0, 0.75, 0.45) * (1.5 + 2.0 * smoothstep(0.1, 0.0, abs(q.y))) : vec3(0.4, 0.3, 0.2);
      } else if (id == POT) {
        if (n.y > 0.5) {
          S.alb = vec3(0.04, 0.025, 0.015);
        } else if (abs(q.y - 0.55) < 0.012) {
          S.alb = vec3(1.0, 0.66, 0.22);
          S.em = vec3(1.0, 0.66, 0.22) * 0.03;
          S.gold = true;
        } else {
          S.alb = vec3(0.04);
          S.em = vec3(0.06) * max(0.0, reflect(rd, n).y);
        }
      } else if (id == PLANT) {
        // Lit from below in the room's colour.
        float h = clamp((p.y - 0.6) / 1.4, 0.0, 1.0);
        S.alb = vec3(0.07, 0.2, 0.06) * (0.8 + 0.3 * vnoise(p.xz * 30.0 + p.y * 20.0));
        S.em = vec3(0.02, 0.05, 0.02) * pow(1.0 - abs(dot(n, rd)), 3.0);
        S.add = upCol * 3.0 * (1.0 - h) * (0.5 + 0.5 * max(0.0, -n.y));
      } else if (id == EXIT) {
        // Green, lit from inside, its letters white.
        if (n.z > -0.5) {
          S.alb = vec3(0.1);
        } else {
          float letter = smoothstep(0.016, 0.009, exitText(q.xy + vec2(0.275, 0.0)));
          float edge = smoothstep(0.0, 0.015, min(0.34 - abs(q.x), 0.13 - abs(q.y)));
          S.em = mix(vec3(0.05), mix(EXIT_GREEN * 1.6, vec3(1.6), letter), edge);
        }
      } else if (id == DESK) {
        vec3 h = DESK_H;
        S.alb = vec3(0.07);
        if (q.y > h.y - 0.025) S.em = vec3(0.05) * (0.5 + 0.5 * rd.y);
        // Its front: a strip of LEDs playing the spectrum.
        if (n.z < -0.5) {
          vec2 st = vec2((q.x + h.x - 0.15) / (2.0 * h.x - 0.3), (q.y + 0.32) / 0.56);
          if (st.x > 0.0 && st.x < 1.0 && st.y > 0.0 && st.y < 1.0) {
            float lv = levels[int(floor(st.x * 16.0))];
            vec2 cell = vec2(fract(st.x * 16.0), fract(st.y * 10.0));
            float on = step(floor(st.y * 10.0) / 10.0, lv - 0.05);
            float led = smoothstep(0.42, 0.3, abs(cell.x - 0.5)) * smoothstep(0.42, 0.3, abs(cell.y - 0.5));
            S.em += mix(pal[2], pal[0], st.y) * led * (0.06 + on * 1.4);
          }
          // A line of light along the top and bottom.
          S.em += pal[int(mod(floor(beatN / 4.0) + 1.0, 4.0))] * smoothstep(0.012, 0.0, abs(abs(q.y) - (h.y - 0.08))) * 0.6;
        }
      } else if (id == TOP) {
        // The laptop's lid: from behind, a soft glowing mark.
        S.alb = vec3(0.16);
        S.em = q.z < 0.0 ? vec3(0.85, 0.9, 1.0) * smoothstep(0.035, 0.028, length(q.xy - vec2(0.0, 0.01))) * 0.5 : vec3(0.3, 0.4, 0.6) * 0.4;
      } else if (id == TRUSS) {
        S.alb = vec3(0.55, 0.55, 0.6) * (0.6 + 0.4 * n.y);
        S.em = S.alb * 0.04;
      } else if (id == VALANCE && abs(n.z) < 0.5) {
        S.alb = vec3(0.24, 0.018, 0.024);
      } else if (id == CURTAIN || id == VALANCE) {
        bool val = id == VALANCE;
        vec3 at = val ? p : q;
        // Its folds: shading only, the cloth deeper in the valleys.
        float ph = at.x * (val ? 5.5 : 3.4) + sin(at.x * 0.9) * 0.8 + (val ? 0.0 : sin(at.y * 0.4 + at.x) * 0.3);
        float fold = cos(ph);
        S.n = normalize(vec3(sin(ph) * 0.6, 0.0, -1.0));
        // Lit: from the front a little, and from below by the uplights.
        S.add = vec3(1.0, 0.82, 0.7) * 0.22 * (0.7 + 0.3 * fold);
        if (!val) S.add += upCol * 2.2 * exp(-(at.y - STAGE_H) * 0.45) * (0.45 + 0.55 * fold * fold);
        // Gold braid: the curtain's edges, the valance's fringe and rope (m: the fringe's tassels).
        float edge = CURT_X - abs(at.x);
        float y = at.y - (ROOM.y - 0.84);
        float stripes = 0.0;
        float m = 1.0;
        if (val && y < 0.13) {
          float tassel = fract(at.x * 9.0);
          float fade = clamp(1.5 - fwidth(at.x * 9.0) * 3.0, 0.0, 1.0);
          m = mix(1.0, 0.45 + 0.55 * smoothstep(0.5, 0.2, abs(tassel - 0.5)) * smoothstep(0.0, 0.05, y + 0.02 - abs(tassel - 0.5) * 0.06), fade);
          stripes = at.x * 60.0;
          S.gold = true;
        } else if (val && abs(y - 0.74) < 0.045) {
          stripes = (at.x + y) * 40.0;
          S.gold = true;
        } else if (!val && (edge < 0.18 || at.y < STAGE_H + 0.16)) {
          stripes = (edge < 0.18 ? at.y : at.x) * 60.0;
          S.gold = true;
        }
        float braid = 0.9 + 0.1 * sin(stripes) * clamp(2.0 - fwidth(stripes), 0.0, 1.0);
        if (S.gold) {
          S.alb = vec3(1.0, 0.66, 0.22) * braid * m;
          S.em = vec3(1.0, 0.66, 0.22) * 0.03 * m;
        } else {
          float sheen = pow(1.0 - abs(dot(S.n, -rd)), 2.0);
          S.alb = vec3(0.5, 0.03, 0.05) * (0.725 + 0.275 * fold) + vec3(0.25, 0.03, 0.04) * sheen * 0.5;
        }
      }
      return S;
    }

    // What the ray meets first: the room traced, the plant (marched) put in as one of its things.
    Hit traceAll(vec3 ro, vec3 rd) {
      Hit H = trace(ro, rd);
      float tp = plantHit(ro, rd, H.t);
      if (tp > 0.0) {
        vec3 n = plantNormal(ro + rd * tp);
        H = Hit(tp, PLANT, 0, dot(n, rd) > 0.0 ? -n : n, vec3(0.0));
      }
      return H;
    }

    void main() {
      vec2 sc = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      vec3 ro = vec3(sin(swivel) * 0.5, 2.5, -6.6);
      vec3 ta = vec3(0.0, 2.9, 5.0);
      vec3 fw = normalize(ta - ro);
      vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
      vec3 up = cross(fw, rt);
      vec3 rd = normalize(fw + (sc.x * rt + sc.y * up) * 0.92);

      Hit H;
      if (kept == 1) {
        ivec2 at = ivec2(gl_FragCoord.xy);
        vec4 a = texelFetch(gb0, at, 0), b = texelFetch(gb1, at, 0);
        int code = int(a.y + 0.5);
        H = Hit(a.x, code / 64, code - code / 64 * 64, normalize(b.xyz), vec3(a.z, a.w, b.w));
      } else {
        H = traceAll(ro, rd);
      }
      if (keep == 1) {
        o = vec4(H.t, float(H.id * 64 + H.k), H.q.x, H.q.y);
      } else if (keep == 2) {
        o = vec4(H.n, H.q.z);
      } else {
        float t = H.t;
        Surf S = shade(H, ro, rd);

        // The DJ, dark against the curtain, its edges caught by the lights behind.
        float td = djHit(ro, rd, t);
        if (td > 0.0) {
          t = td;
          vec3 p = ro + rd * td;
          vec3 n = djNormal(p);
          float rim = pow(1.0 - max(0.0, dot(n, -rd)), 3.0);
          S = Surf(p, n, vec3(0.035), (upCol * 1.4 + vec3(stb[0] + stb[1]) * stbRoom * 2.5 + vec3(0.12, 0.05, 0.05)) * rim, vec3(0.0), 1.0, 1.0, false);
        }

        // The light where the ray ends, worked out once.
        vec3 L = lightAt(S.p, S.n, S.fg, S.sk) + S.add;
        vec3 col = S.em;
        if (S.gold) {
          L = mix(vec3(dot(L, vec3(0.3, 0.45, 0.25))), L, 0.35) + vec3(1.0, 0.85, 0.6) * 0.25;
          // The ball's spots glinting on it.
          col += vec3(1.0, 0.85, 0.5) * spots(S.p) * 1.5;
        }
        col += S.alb * L;

        // The ball and the rod it hangs from.
        float tb = sphere(ro, rd, BALL, BALL_R);
        if (tb > 0.0 && tb < t) {
          col = ballColor(ro, rd, tb);
          t = tb;
        }
        col += beamHaze(ro, rd, t);
        vec3 w = ro - vec3(BALL.x, 0.0, BALL.z);
        vec2 dxz = rd.xz;
        float tr = -dot(w.xz, dxz) / max(dot(dxz, dxz), 1e-5);
        vec3 pr = ro + rd * tr;
        if (tr > 0.0 && pr.y > BALL.y + BALL_R * 0.9 && length(pr.xz - BALL.xz) < 0.015 && (tb < 0.0 || tr < tb)) col = vec3(0.06);

        // The moving heads: small bright lenses under the truss.
        for (int i = 0; i < ${HEADS} + zero; i++) {
          vec3 v = headPos[i] - ro;
          float along = dot(v, rd);
          float off = length(v - rd * along);
          col += headCol[i] * exp(-off * off * 900.0) * 3.0 * beams;
        }
        // The strobes' flash in the haze round them.
        for (int i = 0; i < 2 + zero; i++) {
          vec3 v = stbPos[i] - ro;
          float along = dot(v, rd);
          float off = length(v - rd * along);
          col += vec3(1.0, 0.98, 0.95) * stb[i] * (0.35 / (1.0 + off * off * 2.5) + 0.06 * haze * stbRoom);
        }
        // One bad pixel (a NaN, an overflow) would be blurred by the glow into a block.
        col = dot(col, col) < 1e8 ? min(col, vec3(200.0)) : vec3(0.0);
        o = vec4(col, 1.0);
      }
    }`;

  const SHOW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D scene, glow;
    uniform float time, fade;
    out vec4 o;
    void main() {
      vec3 c = texture(scene, uv).rgb + texture(glow, uv).rgb * 0.9;
      c = 1.0 - exp(-c * 1.15);
      c *= 1.0 - 0.35 * pow(length(uv - 0.5) * 1.3, 2.0);
      c *= fade;
      c += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(c, 1.0);
    }`;

  // Bakes the side lights once, when the room opens (a few layers a frame,
  // before it is shown): at each texel of the maps or the volume the light of
  // each lamp, taken at points over its shape, each shadowed by whatever is in
  // the way (a ray traced to it). The maps hold the light on their surface
  // (rgb, and the neon's in a: it flickers, its colour is put on when shown);
  // the volume the light as on a surface facing it (vol0), and the way it
  // comes, longer the more of it from one way (vol1), each in a pass of its
  // own: a shader writing more than one texture is compiled again on Windows
  // (ANGLE) the first time it draws, holding everything up for a second.
  const BAKE_FS = ROOM_GL + `
    out vec4 o;
    uniform int bakeMode;   // 0: a layer of the maps, 1: a slice of the volume's vol0, 2: of its vol1
    uniform int bakeLayer;
    uniform int bakeNS;     // samples over each lamp

    // Sample j of n over a unit disc and over the square -1..1, turned by r.
    vec2 onDisc(int j, int n, float r) {
      float a = float(j) * 2.39996 + r * 6.2832;
      return sqrt((float(j) + 0.5) / float(n)) * vec2(cos(a), sin(a));
    }
    vec2 onRect(int j, float r) {
      return fract(vec2(0.7548777, 0.5698403) * float(j) + r) * 2.0 - 1.0;
    }

    // Lamp e of a side (0: the bar's, left; 1: the bench's and the door's,
    // right), at its sample j: where (s), which way it shines (en: most
    // straight out, nothing behind; none: all round), its colour (a: the
    // neon's) and its falloff (1 / (f.x + f.y d^2)).
    void lamp(int side, int e, int j, int n, float r, out vec3 s, out vec3 en, out vec4 c, out vec2 f) {
      vec2 dk = onDisc(j, n, r), sq = onRect(j, r);
      if (side == 0 && e < 3) {
        // The pendants: out of their shades' open bottoms only.
        s = vec3(BAR_X - 1.0 + float(e) + dk.x * 0.12, LAMP_Y0 - 0.005, BAR_Z + dk.y * 0.12);
        en = vec3(0.0, -1.0, 0.0); c = vec4(vec3(1.0, 0.7, 0.38) * 4.0, 0.0); f = vec2(1.0, 0.8);
      } else if (side == 0 && e == 3) {
        // The shelves, lit from behind.
        s = vec3(BAR_X + sq.x * 1.45, 1.95 + sq.y * 0.8, ROOM.z - 0.285);
        en = vec3(0.0, 0.0, -1.0); c = vec4(vec3(1.0, 0.72, 0.42) * 0.5, 0.0); f = vec2(1.0, 1.0);
      } else if (side == 0) {
        // The neon glass, all round.
        s = vec3(NEON_C.x + sq.x * 0.6, NEON_C.y + sq.y * 0.7, ROOM.z - 0.03);
        en = vec3(0.0); c = vec4(0.0, 0.0, 0.0, 0.5); f = vec2(0.4, 0.6);
      } else if (e < 4) {
        // The wall lights: up and down out of them, along the wall ...
        bool up = e >= 2;
        s = vec3(BENCH_X + (e % 2 == 0 ? -0.6 : 0.6) + dk.x * 0.08, up ? 2.145 : 1.855, ROOM.z - 0.04 + dk.y * 0.03);
        en = vec3(0.0, up ? 1.0 : -1.0, 0.0); c = vec4(vec3(1.0, 0.72, 0.42) * (up ? 2.0 : 3.0), 0.0); f = vec2(0.08, 1.0);
      } else if (e < 6) {
        // ... and a little through their frosted fronts.
        s = vec3(BENCH_X + (e == 4 ? -0.6 : 0.6) + sq.x * 0.09, 2.0 + sq.y * 0.13, ROOM.z - 0.085);
        en = vec3(0.0, 0.0, -1.0); c = vec4(vec3(1.0, 0.72, 0.42) * 0.8, 0.0); f = vec2(1.0, 1.0);
      } else {
        // The EXIT sign: down onto the door and the floor before it.
        s = vec3(DOOR_C.x + sq.x * 0.3, 2.4, ROOM.z - 0.3 + sq.y * 0.03);
        en = vec3(0.0, -1.0, 0.0); c = vec4(EXIT_GREEN * 1.6, 0.0); f = vec2(1.0, 0.7);
      }
    }

    void main() {
      vec2 fc = gl_FragCoord.xy;
      vec3 p, n = vec3(0.0);
      int side;
      bool onMap = bakeMode == 0;
      if (onMap) {
        // Layer: 0 floor, 1 back wall, 2 side wall; the left's, then the right's.
        side = bakeLayer / 3;
        int kind = bakeLayer - side * 3;
        float sg = side == 0 ? -1.0 : 1.0;
        vec2 t = fc / ${BAKE_MAP}.0;
        float x = sg * mix(BK_X, ROOM.x, t.x);
        if (kind == 0) { p = vec3(x, 0.0, mix(BK_Z, ROOM.z, t.y)); n = vec3(0.0, 1.0, 0.0); }
        else if (kind == 1) { p = vec3(x, t.y * ROOM.y, ROOM.z); n = vec3(0.0, 0.0, -1.0); }
        else { p = vec3(sg * ROOM.x, t.y * ROOM.y, mix(BK_Z, ROOM.z, t.x)); n = vec3(-sg, 0.0, 0.0); }
      } else {
        // Across: the left's texels, then the right's.
        side = fc.x < VOL_NX ? 0 : 1;
        float lx = (fc.x - float(side) * VOL_NX) / VOL_NX;
        p = vec3((side == 0 ? -1.0 : 1.0) * mix(BK_X, ROOM.x, lx), fc.y / VOL_NY * VOL_H, mix(BK_Z, ROOM.z, (float(bakeLayer) + 0.5) / VOL_NZ));
      }
      vec3 from = p + n * 0.004;
      float r = hash12(fc + float(bakeLayer) * 17.3);
      vec4 sum = vec4(0.0);
      vec3 dir = vec3(0.0);
      float weight = 0.0;
      int lamps = side == 0 ? 5 : 7;
      for (int e = 0; e < lamps + zero; e++) {
        for (int j = 0; j < bakeNS + zero; j++) {
          vec3 s, en;
          vec4 c;
          vec2 f;
          lamp(side, e, j, bakeNS, r, s, en, c, f);
          vec3 v = s - from;
          float d = length(v);
          vec3 l = v / d;
          float lobe = dot(en, en) < 0.5 ? 1.0 : max(0.0, -dot(en, l));
          float k = lobe / (f.x + f.y * d * d) * (onMap ? max(0.0, dot(n, l)) : 1.0);
          if (k < 1e-5) continue;
          Hit H = trace(from, l);
          if (H.t < d - 0.01) continue;
          if (side == 1 && plantHit(from, l, d - 0.01) > 0.0) continue;
          sum += c * k;
          // How bright, the neon's pink counted as it shows.
          float lum = (dot(c.rgb, vec3(0.3, 0.5, 0.2)) + c.a * 0.4) * k;
          dir += l * lum;
          weight += lum;
        }
      }
      o = bakeMode == 2 ? vec4(weight > 0.0 ? dir / weight : vec3(0.0), 1.0) : sum / float(bakeNS);
    }`;

  // The render scale chosen, as a fraction.
  const renderScale = () => (Number(Visualizer.setting('dcScale')) || 100) / 100;

  // A turn (column-major, for uniformMatrix3fv) whose -z faces f.
  const facing = (f) => {
    const len = Math.hypot(...f);
    const b = f.map((v) => -v / len); // local +z: the back
    let r = [b[2], 0, -b[0]]; // up x back
    const rl = Math.hypot(...r) || 1;
    r = r.map((v) => v / rl);
    const u = [b[1] * r[2] - b[2] * r[1], b[2] * r[0] - b[0] * r[2], b[0] * r[1] - b[1] * r[0]];
    return [...r, ...u, ...b];
  };

  class Disco {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      // The room's shader compiles in the background (the first time, before
      // the browser has it cached, that takes a few seconds): black until it
      // is ready and the side lights are baked, then the room fades in.
      this.sceneLater = VizGL.programLater(gl, VizGL.SCREEN_VS, SCENE_FS);
      this.bakeLater = VizGL.programLater(gl, VizGL.SCREEN_VS, BAKE_FS);
      this.bake = null;
      this.scene = null;
      this.fadeFrom = -1;
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.age = 0;
      this.spin = 0;
      this.swivel = 0;
      this.beatN = 0;
      this.beamT = 0;
      this.beatAt = 0;
      this.ph = 0;
      this.kicks = [9, 9, 9, 9];
      this.pattern = 0;
      this.levels = new Float32Array(16);
      this.pump = 0;
      this.arm = 0;
      this.armUntil = 0;
      this.strobeAge = [9, 9];
      this.neonOff = 0;
      this.sinceStrobe = 9;
      this.w = 1;
      this.h = 1;

      // The speakers: two stacks on the stage, turned in a little, and one on
      // the front of each pillar, high up, turned in and down towards the floor.
      this.spkPos = new Float32Array(SPEAKERS * 3);
      this.spkRot = new Float32Array(SPEAKERS * 9);
      this.spkHalf = new Float32Array(SPEAKERS * 3);
      const put = (i, pos, f, half) => {
        this.spkPos.set(pos, i * 3);
        this.spkRot.set(facing(f), i * 9);
        this.spkHalf.set(half, i * 3);
      };
      for (const s of [-1, 1]) {
        const i = s < 0 ? 0 : 1;
        put(i, [s * 5.5, STAGE_H + 1.1, 11.0], [-s * 0.14, 0, -1], [0.6, 1.1, 0.45]);
      }
      let i = 2;
      for (const s of [-1, 1]) {
        for (const z of PIL_Z) {
          const pos = [s * (PIL_X - 0.15), 4.9, z - 0.45 - 0.5];
          put(i, pos, [-s * 0.6, -0.42, -1], [0.42, 0.65, 0.35]);
          i += 1;
        }
      }
      this.stbPos = new Float32Array([-3.1, STAGE_H + 2.35, 13.7, 3.1, STAGE_H + 2.35, 13.7]);
      this.stbRot = new Float32Array([...facing([0.12, -0.22, -1]), ...facing([-0.12, -0.22, -1])]);
    }

    size(w, h) {
      this.fullW = w;
      this.fullH = h;
      this.targets();
    }

    // The room is drawn at the render scale (dcScale, percent) and shown
    // stretched to the screen; the glow at a quarter of that.
    targets() {
      const gl = this.gl;
      this.scale = renderScale();
      const w = Math.max(1, Math.round(this.fullW * this.scale));
      const h = Math.max(1, Math.round(this.fullH * this.scale));
      this.w = w;
      this.h = h;
      for (const t of [this.t, this.b1, this.b2]) VizGL.freeTarget(gl, t);
      this.t = VizGL.target(gl, w, h);
      const sw = Math.max(1, Math.round(w / 4));
      const sh = Math.max(1, Math.round(h / 4));
      this.b1 = VizGL.target(gl, sw, sh);
      this.b2 = VizGL.target(gl, sw, sh);
      this.dropHits();
    }

    // A still camera (Camera moves off): what each pixel's ray meets, traced
    // once at this size and kept (SCENE_FS: keep), so each frame only works
    // out the light and what moves. Two textures: its distance, what it is
    // and the point in its frame (32-bit, the patterns drawn by it), and its
    // normal (16-bit). Without float targets nothing is kept (traced each frame).
    keepHits(u) {
      const gl = this.gl;
      if (!gl.getExtension('EXT_color_buffer_float')) return;
      const make = (format) => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, format, this.w, this.h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return { tex, fb, w: this.w, h: this.h };
      };
      // Not read while written: their samplers on units of their own, those
      // empty. (Left on unit 0, as they are before the first frame sets them,
      // they would read the texture being drawn, and that draw is refused.)
      gl.activeTexture(gl.TEXTURE0);
      this.hits = [make(gl.RGBA32F), make(gl.RGBA16F)];
      [u.gb0, u.gb1].forEach((loc, k) => {
        gl.activeTexture(gl.TEXTURE5 + k);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.uniform1i(loc, 5 + k);
      });
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(u.kept, 0);
      this.hits.forEach((t, k) => {
        VizGL.into(gl, t);
        gl.uniform1i(u.keep, k + 1);
        VizGL.screen(gl);
      });
      gl.uniform1i(u.keep, 0);
    }

    dropHits() {
      for (const t of this.hits || []) VizGL.freeTarget(this.gl, t);
      this.hits = null;
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    // Bakes the next part of the side lights (BAKE_FS): a layer of the maps
    // a frame, or half the volume's slices (both its textures). Returns whether all is done.
    // Without float targets (EXT_color_buffer_float) nothing is baked and
    // the lounges are lit by the room's other lights only.
    bakeStep() {
      const gl = this.gl;
      if (!this.bake) {
        const tex = (target, w, h, d) => {
          const t = gl.createTexture();
          gl.bindTexture(target, t);
          gl.texStorage3D(target, 1, gl.RGBA16F, w, h, d);
          gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(target, k, gl.CLAMP_TO_EDGE);
          return t;
        };
        this.bake = {
          map: tex(gl.TEXTURE_2D_ARRAY, BAKE_MAP, BAKE_MAP, 6),
          vol0: tex(gl.TEXTURE_3D, ...VOL),
          vol1: tex(gl.TEXTURE_3D, ...VOL),
          fb: gl.createFramebuffer(),
          next: 0,
          done: !gl.getExtension('EXT_color_buffer_float'),
        };
      }
      const b = this.bake;
      if (b.done) return true;
      if (!this.bakeLater.ready()) return false;
      const { p, u } = this.bakeLater.done();
      gl.useProgram(p);
      gl.uniform1i(u.zero, 0);
      gl.uniform3fv(u.spkPos, this.spkPos);
      gl.uniformMatrix3fv(u.spkRot, false, this.spkRot);
      gl.uniform3fv(u.spkHalf, this.spkHalf);
      gl.uniform3fv(u.stbPos, this.stbPos);
      gl.uniformMatrix3fv(u.stbRot, false, this.stbRot);
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
      gl.disable(gl.BLEND);
      if (b.next < 6) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, b.map, 0, b.next);
        gl.viewport(0, 0, BAKE_MAP, BAKE_MAP);
        gl.uniform1i(u.bakeMode, 0);
        gl.uniform1i(u.bakeLayer, b.next);
        gl.uniform1i(u.bakeNS, BAKE_NS.map);
        VizGL.screen(gl);
        b.next += 1;
      } else {
        gl.viewport(0, 0, VOL[0], VOL[1]);
        gl.uniform1i(u.bakeNS, BAKE_NS.vol);
        const from = (b.next - 6) * (VOL[2] / 2);
        for (let z = from; z < from + VOL[2] / 2; z += 1) {
          gl.uniform1i(u.bakeLayer, z);
          for (const [mode, t] of [[1, b.vol0], [2, b.vol1]]) {
            gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, z);
            gl.uniform1i(u.bakeMode, mode);
            VizGL.screen(gl);
          }
        }
        b.next += 1;
        b.done = b.next >= 8;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return b.done;
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      const pal = (PALETTES[set('dcColors')] || PALETTES.disco).map((c) => VizGL.rgb(c));

      // The beat: the tempo's, or a steady 120 without one.
      let tick = false;
      if (a.playing) {
        if (a.sure >= 0.35 && a.bpm) {
          tick = a.tick;
          this.ph = a.phase;
        } else {
          this.ph += dt * 2;
          tick = this.ph >= 1;
          if (tick) this.ph -= 1;
        }
      }
      if (tick) {
        this.beatN += 1;
        // Another floor pattern every four bars.
        if (this.beatN % 16 === 0) this.pattern = (this.pattern + 1 + Math.floor(Math.random() * 3)) % 4;
      }
      for (let k = 0; k < 4; k += 1) this.kicks[k] += dt;
      if (a.playing && a.onset) {
        this.kicks.pop();
        this.kicks.unshift(0);
      }
      for (let k = 0; k < 16; k += 1) {
        const from = Math.floor((k / 16) * a.BANDS * 0.9);
        const to = Math.floor(((k + 1) / 16) * a.BANDS * 0.9);
        let v = 0;
        for (let j = from; j < to; j += 1) v = Math.max(v, a.dynamic[j]);
        this.levels[k] += (v - this.levels[k]) * Math.min(1, dt * 14);
      }
      this.spin += dt * 0.35 * (set('dcSpin') / 100) * (a.playing ? a.pace : 0.3);
      // The camera's slow swing from side to side.
      const moving = set('dcCamera');
      if (moving) this.swivel += dt * 0.07 * (set('dcSwivel') / 100);
      else this.swivel = 0;
      if (renderScale() !== this.scale) this.targets();
      const bar = Math.floor(this.beatN / 4);
      const beatT = this.beatN + this.ph;
      // The beams' own clock: with the beat while it plays (a jump in it, as
      // the tempo is caught, not followed), slowly on while paused.
      const beatStep = beatT - this.beatAt;
      this.beatAt = beatT;
      this.beamT += a.playing ? Math.min(Math.max(beatStep, 0), dt * 6) : dt * 0.25;
      const beamT = this.beamT;

      // The cones pushed by the bass; the DJ's hand up for a bar or two in the loud parts.
      const push = a.playing ? Math.min(1, a.bass * 1.2 + a.kick * 0.8) : 0;
      this.pump += (push - this.pump) * Math.min(1, dt * 30);
      if (tick && this.beatN % 8 === 0 && a.intensity > 0.6 && Math.random() < 0.5) this.armUntil = this.age + (4 + Math.random() * 4) * (60 / (a.bpm || 120));
      const armTo = this.age < this.armUntil ? 1 : 0;
      this.arm += (armTo - this.arm) * Math.min(1, dt * 5);

      // The strobes: on the beat in the loud parts (on the bar both, else
      // left and right by turns), now and then on a hard hit in the others.
      const strobes = set('dcStrobes');
      this.sinceStrobe += dt;
      for (let k = 0; k < 2; k += 1) this.strobeAge[k] += dt;
      if (strobes && a.playing) {
        let fire = -1;
        if (tick && a.intensity > 0.6) fire = this.beatN % 4 === 0 ? 2 : this.beatN % 2;
        else if (a.hit && a.hitPower > 0.6 && a.intensity > 0.3 && this.sinceStrobe > 0.5) fire = Math.random() < 0.5 ? 0 : 1;
        if (fire >= 0) {
          this.sinceStrobe = 0;
          if (fire !== 1) this.strobeAge[0] = 0;
          if (fire !== 0) this.strobeAge[1] = 0;
        }
      }
      const stb = this.strobeAge.map((t) => (!strobes ? 0 : t < STROBE_HOLD ? 1 : Math.exp(-(t - STROBE_HOLD) / STROBE_FADE)));

      // The moving heads: along the truss under the ceiling, swinging with
      // the beat (a full swing over two beats; paused, over eight seconds),
      // their colours another each bar.
      const heads = new Float32Array(HEADS * 3);
      const dirs = new Float32Array(HEADS * 3);
      const cols = new Float32Array(HEADS * 3);
      for (let k = 0; k < HEADS; k += 1) {
        const x = -5 + (10 * k) / (HEADS - 1);
        heads.set([x, 6.66, 4.0], k * 3);
        const s = Math.sin(((beamT / 2) * Math.PI) + k * (k % 2 ? 1.1 : -1.1));
        const pan = s * 0.55 + (k - (HEADS - 1) / 2) * -0.12;
        // Aimed at a point on the floor: across it with the swing, and over
        // four beats from behind the camera (into it) back to near the stage.
        const zT = 1.5 + 6.5 * Math.sin(beamT * Math.PI * 0.25 + k * 1.7);
        const d = [Math.sin(pan) * 6.6, -6.66, zT - 4.0];
        const len = Math.hypot(...d);
        dirs.set(d.map((v) => v / len), k * 3);
        const c = pal[(k + bar) % 4];
        const bright = (a.playing ? 0.55 + 0.45 * a.throb : 0.25) * 1.4;
        cols.set(c.map((v) => v * bright), k * 3);
      }
      const throb = a.playing ? a.throb : 0;
      // The floor's light, about: half its tiles lit in its colour, the others a mix of all.
      const pulse = a.playing ? Math.exp(-this.ph * 3.5) : 0.2;
      const mean = [0, 1, 2].map((c) => pal.reduce((s, p) => s + p[c], 0) / 4);
      const floorAvg = this.pattern === 0
        ? pal[Math.floor(this.beatN / 2) % 4].map((v) => v * 0.5 * (0.3 + 0.7 * pulse))
        : mean.map((v) => v * (0.2 + 0.2 * throb));
      const ring = pal[(bar + 3) % 4];
      const up = pal[(bar + 1) % 4].map((v) => v * (a.playing ? 0.28 + 0.22 * throb : 0.18));

      if (!this.scene) {
        const baked = this.bakeStep();
        if (!baked || !this.sceneLater.ready()) {
          VizGL.into(gl, null);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          return;
        }
        this.scene = this.sceneLater.done();
        // Ready within a moment of opening (cached, or warmed ahead): no fading in.
        this.fadeFrom = this.age < 0.3 ? -1 : this.age;
      }

      gl.disable(gl.BLEND);
      VizGL.into(gl, this.t);
      gl.useProgram(this.scene.p);
      const u = this.scene.u;
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.spin, this.spin);
      gl.uniform1f(u.swivel, this.swivel);
      gl.uniform1f(u.beatPh, this.ph);
      gl.uniform1f(u.beatN, this.beatN);
      gl.uniform1f(u.beatT, beatT);
      gl.uniform1f(u.pulse, pulse);
      gl.uniform1f(u.haze, 0.8 + 0.6 * a.level);
      gl.uniform1f(u.sparkle, a.treble);
      gl.uniform1f(u.kick, a.kick);
      gl.uniform1f(u.pump, this.pump);
      gl.uniform1f(u.throb, throb);
      gl.uniform1f(u.ringGlow, a.playing ? 0.35 + 0.9 * throb : 0.2);
      gl.uniform1i(u.pattern, this.pattern);
      gl.uniform1fv(u.kicks, this.kicks);
      gl.uniform1fv(u.levels, this.levels);
      gl.uniform3fv(u.pal, pal.flat());
      gl.uniform3fv(u.headPos, heads);
      gl.uniform3fv(u.headDir, dirs);
      gl.uniform3fv(u.headCol, cols);
      gl.uniform1f(u.beams, set('dcBeams') ? 1 : 0);
      gl.uniform3fv(u.spkPos, this.spkPos);
      gl.uniformMatrix3fv(u.spkRot, false, this.spkRot);
      gl.uniform3fv(u.spkHalf, this.spkHalf);
      gl.uniform3fv(u.ringCol, ring);
      gl.uniform3fv(u.upCol, up);
      gl.uniform3fv(u.floorAvg, floorAvg);
      gl.uniform3fv(u.stbPos, this.stbPos);
      gl.uniformMatrix3fv(u.stbRot, false, this.stbRot);
      gl.uniform1fv(u.stb, stb);
      gl.uniform1f(u.stbRoom, set('dcStrobeRoom') / 100);
      gl.uniform1f(u.djBob, a.playing ? -0.05 * Math.exp(-this.ph * 4) * (0.4 + 0.6 * a.lock) : 0);
      gl.uniform1f(u.djArm, this.arm);
      gl.uniform1i(u.zero, 0);
      const tex = [[gl.TEXTURE_2D_ARRAY, this.bake.map, u.bakeMap], [gl.TEXTURE_3D, this.bake.vol0, u.bakeVol0], [gl.TEXTURE_3D, this.bake.vol1, u.bakeVol1]];
      tex.forEach(([target, t, loc], k) => {
        gl.activeTexture(gl.TEXTURE2 + k);
        gl.bindTexture(target, t);
        gl.uniform1i(loc, 2 + k);
      });
      gl.activeTexture(gl.TEXTURE0);
      // The neon flickers now and then, a few frames dark.
      if (this.neonOff > 0) this.neonOff -= dt;
      else if (Math.random() < dt / 25) this.neonOff = 0.05 + Math.random() * 0.25;
      const flicker = this.neonOff > 0 ? (Math.sin(this.age * 90) > 0.3 ? 0.15 : 1) : 1;
      gl.uniform1f(u.neonOn, flicker * (0.85 + 0.15 * pulse));
      if (moving) this.dropHits();
      else if (!this.hits) this.keepHits(u);
      VizGL.into(gl, this.t);
      gl.uniform1i(u.keep, 0);
      gl.uniform1i(u.kept, this.hits ? 1 : 0);
      [u.gb0, u.gb1].forEach((loc, k) => {
        gl.activeTexture(gl.TEXTURE5 + k);
        gl.bindTexture(gl.TEXTURE_2D, this.hits ? this.hits[k].tex : null);
        gl.uniform1i(loc, 5 + k);
      });
      gl.activeTexture(gl.TEXTURE0);
      VizGL.screen(gl);

      VizGL.blur(gl, this.t, this.b1, this.b2, 1);
      VizGL.blur(gl, this.b2, this.b1, this.b2, 1.5);
      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      VizGL.bind(gl, this.show.u.scene, this.t.tex, 0);
      VizGL.bind(gl, this.show.u.glow, this.b2.tex, 1);
      gl.uniform1f(this.show.u.time, this.age);
      gl.uniform1f(this.show.u.fade, this.fadeFrom < 0 ? 1 : Math.min(1, (this.age - this.fadeFrom) / 0.8));
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'disco',
    name: 'Disco',
    desc: 'A dance hall: a mirror ball scattering its spots, beams sweeping through the haze with the beat, an LED floor playing to the music, the DJ on a stage between speakers and strobes',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><circle cx="12" cy="12" r="6"/><path d="M6 12h12M12 6c-2 2-2 10 0 12M12 6c2 2 2 10 0 12"/></svg>',
    gl: true,
    create: (canvas) => new Disco(canvas),
    options: [
      { type: 'choice', key: 'dcColors', label: 'Colours', choices: [['disco', 'Disco'], ['warm', 'Warm'], ['cool', 'Cool']] },
      { type: 'check', key: 'dcBeams', label: 'Beams' },
      {
        type: 'check',
        key: 'dcStrobes',
        label: 'Strobes',
        group: [{ type: 'slider', key: 'dcStrobeRoom', label: 'Room lightup', min: 0, max: 100, step: 5 }],
      },
      { type: 'slider', key: 'dcSpin', label: 'Ball turning', min: 0, max: 300, step: 5 },
      { type: 'check', key: 'dcCamera', label: 'Camera moves', amount: { key: 'dcSwivel', min: 0, max: 500, step: 5 } },
      { type: 'choice', key: 'dcScale', label: 'Render scale', choices: [['100', '100%'], ['75', '75%'], ['50', '50%']] },
    ],
  });
})();
