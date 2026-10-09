'use strict';

// Lighthouse: a night sea under the moon, a lighthouse on its rocks off to
// the right. The swell rises with the bass and rolls on with the tempo; big
// waves roll in towards the eye, one a bar (one every four beats), each
// breaking on the rocks as its bar begins. The moon lays a glittering path
// across the sea. The lighthouse's two beams turn round once every four bars
// (with a clear beat; slowly without), reaching out over the sea through the
// haze and, as each sweeps past, flooding everything with light; the lantern
// flares on the kicks, its light trembling on the water. Now and then a ship
// passes: a fishing boat, a yacht racing by or a container ship crossing
// slowly, the beams lighting it up as they sweep over it, its lights
// mirrored in the sea.
//
// Its cogwheel: the weather (clear, cloudy, a storm with rain), the ships.
//
// WebGL (viz/gl.js): one pass. The camera sits low over the water; each
// pixel's ray either meets the sky (clouds, moon, stars) or the sea: the big
// waves stand up out of it (the ray marched to where it meets them), a sum of
// smaller waves gives its slope, and it reflects the sky, the moon and the
// lights. The lighthouse, its rocks and the ships are drawn where they stand,
// hidden where a wave rises in front of them; the beams are cones in the air,
// each pixel lit by how near its ray passes their axes.

(() => {
  const WEATHER = {
    clear: { clouds: 0.18, rain: 0, swell: 0.8, haze: 0.6, roll: 0.55 },
    cloudy: { clouds: 0.5, rain: 0, swell: 1.0, haze: 0.8, roll: 0.7 },
    storm: { clouds: 0.85, rain: 1, swell: 1.7, haze: 1.3, roll: 1.0 },
  };

  // The ships that may pass, one at a time, never the same twice running:
  // how far off (z, metres), how long, how fast (metres a second), how much
  // they rock, and how far their wake trails behind.
  const SHIPS = [
    { z: 170, len: 18, speed: 5, rock: 0.035, trail: 0 },     // a fishing boat
    { z: 230, len: 40, speed: 22, rock: 0.012, trail: 110 },  // a motor yacht, fast
    { z: 650, len: 292, speed: 7, rock: 0.0015, trail: 0 },   // a container ship, the slowest across
  ];
  const F = 1.5;  // the shader's focal length

  const FS = VizGL.NOISE + VizGL.STARS + `
    in vec2 uv;
    uniform vec2 res;
    uniform float time, wave, swell, beamAng, lamp, splash, rain, clouds, haze, boom, roll, rollAmp;
    uniform vec4 ship;          // x, its way (-1 to the left, 1 to the right), kind (0 fishing boat, 1 yacht, 2 container ship), shown (0..1)
    uniform float shipPitch;
    out vec4 o;

    const float F = 1.5;        // focal length
    const float CAMH = 1.6;     // the eye above the water
    const float HORIZON = 0.42; // where the horizon lies on the screen
    const vec3 LANTERN = vec3(18.0, 14.8, 60.0);
    const vec3 MOONDIR = vec3(-0.5, 0.3, 1.5) / 1.6093;
    const vec2 ROLLDIR = vec2(-0.196, -0.981);  // the big waves' way: towards the eye, a little from the right
    const float ROLLLEN = 22.0;                 // between their crests
    const float FAR = 400.0;                    // beyond, the big waves are only shading

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

    // The big waves at p: their height, slope (x, z) and how near a crest
    // (0..1, more on the tallest). One a bar (roll counts the bars), each
    // crest at the lighthouse's foot as its bar begins; their crests bending,
    // each its own height, rising high here and sinking low there.
    vec4 rollers(vec2 p) {
      vec2 across = vec2(-ROLLDIR.y, ROLLDIR.x);
      float along = dot(p - LANTERN.xz, across);
      float bend = 4.0 * sin(along * 0.045) + 2.0 * sin(along * 0.11);
      float c = (dot(p - LANTERN.xz, ROLLDIR) + bend) / ROLLLEN - roll;
      float n = floor(c + 0.5);
      float x = c - n;
      float a1 = along * 0.13 + n * 2.3, a2 = along * 0.29 + n * 4.1;
      float h0 = rollAmp * (0.75 + 0.5 * hash12(vec2(n, 7.0)));
      float h = h0 * (0.6 + 0.2 * (sin(a1) + sin(a2)));
      float dh = h0 * 0.2 * (0.13 * cos(a1) + 0.29 * cos(a2));
      float sw = 0.5 + 0.5 * cos(6.2831853 * x);
      float sh = sw * sw * sw;
      float dsh = 3.0 * sw * sw * -3.14159265 * sin(6.2831853 * x) / ROLLLEN;
      vec2 dc = ROLLDIR + across * (4.0 * 0.045 * cos(along * 0.045) + 2.0 * 0.11 * cos(along * 0.11));
      return vec4(h * sh - 0.31 * rollAmp, h * dsh * dc + sh * dh * across, sh * h / max(rollAmp, 0.01));
    }

    // How far along d (looking down) the sea is met, the big waves standing
    // up out of it; past FAR, where the calm sea's level is.
    float seaHit(vec3 d) {
      float calm = CAMH / -d.y;
      if (rollAmp < 0.01) return calm;
      float t0 = (CAMH - rollAmp * 0.95) / -d.y;
      if (t0 > FAR) return calm;
      float t1 = min((CAMH + rollAmp * 0.32) / -d.y, FAR);
      float dt = (t1 - t0) / 32.0;
      float ta = t0;
      for (int i = 1; i <= 32; i++) {
        float tb = t0 + dt * float(i);
        vec3 p = vec3(0.0, CAMH, 0.0) + d * tb;
        if (p.y < rollers(p.xz).x) {
          for (int j = 0; j < 6; j++) {
            float tm = 0.5 * (ta + tb);
            vec3 pm = vec3(0.0, CAMH, 0.0) + d * tm;
            if (pm.y < rollers(pm.xz).x) tb = tm;
            else ta = tm;
          }
          return tb;
        }
        ta = tb;
      }
      return calm;
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

    // How much the beams light the point p (on a ship).
    float beamOn(vec3 p) {
      float sum = 0.0;
      vec3 v = p - LANTERN;
      for (int k = 0; k < 2; k++) {
        float a = beamAng + float(k) * 3.14159265;
        vec3 b = normalize(vec3(cos(a), -0.012, sin(a)));
        float u = dot(v, b);
        if (u <= 0.0) continue;
        float r = 0.5 + u * 0.075;
        float dist = length(v - b * u);
        sum += exp(-(dist * dist) / (r * r)) / (1.0 + u * 0.004);
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

    // The ships, drawn side on in metres (q: from the middle of the ship at
    // the waterline, its bow to the left), out of signed distances (< 0
    // inside): a box from lo to hi; a line from a to b (the outside on its
    // right, going round the outline anticlockwise); a stroke along a to b.
    float box(vec2 q, vec2 lo, vec2 hi) { vec2 d = max(lo - q, q - hi); return max(d.x, d.y); }
    float side(vec2 q, vec2 a, vec2 b) { vec2 e = b - a; return dot(q - a, normalize(vec2(e.y, -e.x))); }
    float stroke(vec2 q, vec2 a, vec2 b) {
      vec2 qa = q - a, ba = b - a;
      return length(qa - ba * clamp(dot(qa, ba) / dot(ba, ba), 0.0, 1.0));
    }
    // Paints a part (its distance d) over what is there; pw: a pixel in metres.
    void part(float d, float pw, vec3 paint, inout float cov, inout vec3 col) {
      float a = clamp(0.5 - d / pw, 0.0, 1.0);
      col = mix(col, paint, a);
      cov = max(cov, a);
    }
    // A lamp at c: a bright core at least a pixel or so wide, a soft halo.
    vec3 spot(vec2 q, vec2 c, float r, float pw, vec3 tint) {
      float rr = max(r, 1.1 * pw);
      float dd = dot(q - c, q - c);
      return tint * (2.5 * exp(-dd / (rr * rr)) + 0.12 * exp(-sqrt(dd) / (rr * 5.0)));
    }

    float shipZ() { return ship.z < 0.5 ? 170.0 : ship.z < 1.5 ? 230.0 : 650.0; }

    // A fishing boat, about 18 m: a red hull rising to its bow, a white
    // wheelhouse, a mast and a derrick, a gantry at the stern; trawling
    // lights (green over white), its side light, the deck lit from the mast.
    void fishingBoat(vec2 q, float pw, vec3 sideCol, inout float cov, inout vec3 col, inout vec3 glow, inout float flood) {
      float hull = max(max(box(q, vec2(-12.0, -1.0), vec2(8.5, 4.0)), side(q, vec2(-9.5, 3.0), vec2(-6.0, -1.0))), side(q, vec2(8.5, 2.2), vec2(-9.5, 3.0)));
      part(hull, pw, mix(vec3(0.32, 0.07, 0.06), vec3(0.7, 0.68, 0.64), step(1.9, q.y) * step(q.y, 2.3)), cov, col);
      float house = min(box(q, vec2(-4.5, 2.0), vec2(0.0, 5.3)), box(q, vec2(-5.0, 5.2), vec2(0.4, 5.6)));
      part(house, pw, vec3(0.75, 0.75, 0.72), cov, col);
      float rig = min(box(q, vec2(1.2, 2.0), vec2(1.5, 10.4)), stroke(q, vec2(1.4, 8.0), vec2(8.0, 2.6)) - 0.08);
      rig = min(rig, min(box(q, vec2(7.3, 2.0), vec2(7.6, 6.4)), stroke(q, vec2(7.45, 6.4), vec2(5.8, 2.3)) - 0.08));
      part(rig, pw, vec3(0.35, 0.36, 0.38), cov, col);
      float win = min(min(box(q, vec2(-4.1, 3.9), vec2(-3.1, 4.7)), box(q, vec2(-2.8, 3.9), vec2(-1.8, 4.7))), box(q, vec2(-1.5, 3.9), vec2(-0.5, 4.7)));
      float wa = clamp(0.5 - win / pw, 0.0, 1.0);
      col = mix(col, vec3(0.02), wa);
      glow += vec3(1.0, 0.72, 0.4) * 0.5 * wa;
      glow += spot(q, vec2(1.35, 10.0), 0.18, pw, vec3(0.2, 1.0, 0.4));
      glow += spot(q, vec2(1.35, 9.1), 0.18, pw, vec3(1.0, 0.97, 0.9));
      glow += spot(q, vec2(-4.6, 4.9), 0.16, pw, sideCol);
      glow += spot(q, vec2(1.7, 7.3), 0.3, pw, vec3(1.0, 0.9, 0.75) * 1.4);
      flood += 1.6 * exp(-length(q - vec2(3.5, 3.5)) / 3.5);
    }

    // A motor yacht, about 40 m: long and low, white, its bow sharp and
    // raked, two decks swept back behind long bands of tinted glass glowing
    // warm, a hardtop and a raked arch on top; its bow wave and a long white
    // wake (wx: across the world).
    void yacht(vec2 q, float pw, float wx, vec3 sideCol, inout float cov, inout vec3 col, inout vec3 glow, inout float flood) {
      vec3 white = vec3(0.85, 0.86, 0.88);
      float hull = max(max(box(q, vec2(-24.0, -1.0), vec2(19.0, 6.0)), side(q, vec2(-21.5, 4.9), vec2(-14.0, -1.0))), side(q, vec2(19.0, 3.5), vec2(-21.5, 4.9)));
      part(hull, pw, white, cov, col);
      float lower = max(max(box(q, vec2(-12.0, 3.0), vec2(14.5, 6.2)), side(q, vec2(-3.0, 6.2), vec2(-10.5, 3.0))), side(q, vec2(14.5, 3.0), vec2(13.0, 6.2)));
      float upper = max(max(box(q, vec2(-5.0, 6.0), vec2(9.5, 8.2)), side(q, vec2(2.5, 8.2), vec2(-3.0, 6.0))), side(q, vec2(9.5, 6.0), vec2(8.5, 8.2)));
      float hardtop = max(box(q, vec2(1.0, 8.15), vec2(12.0, 8.5)), side(q, vec2(12.0, 8.15), vec2(11.0, 8.5)));
      float arch = max(max(box(q, vec2(4.0, 8.4), vec2(10.0, 10.2)), side(q, vec2(7.0, 10.2), vec2(4.5, 8.4))), side(q, vec2(8.5, 8.4), vec2(9.6, 10.2)));
      part(min(min(lower, upper), min(arch, hardtop)), pw, white, cov, col);
      // The glass: a band along each deck, following its raked front; the
      // hull's long windows. Lit warm, brighter here and dimmer there.
      float pane = floor(q.x / 3.6);
      float g1 = clamp(0.5 - max(lower + 0.5, box(q, vec2(-30.0, 4.1), vec2(30.0, 5.7))) / pw, 0.0, 1.0);
      float g2 = clamp(0.5 - max(upper + 0.45, box(q, vec2(-30.0, 6.6), vec2(30.0, 7.75))) / pw, 0.0, 1.0);
      float g3 = clamp(0.5 - max(box(q, vec2(-9.0, 1.7), vec2(12.0, 2.3)), side(q, vec2(-6.0, 2.3), vec2(-9.0, 1.7))) / pw, 0.0, 1.0);
      float mull = smoothstep(0.03, 0.06, abs(fract(q.x / 3.6) - 0.5));
      col = mix(col, vec3(0.02, 0.025, 0.03), max(max(g1, g2), g3));
      glow += vec3(1.0, 0.8, 0.55) * (0.15 + 0.35 * hash12(vec2(pane, 1.0))) * g1 * mull;
      glow += vec3(1.0, 0.85, 0.65) * (0.1 + 0.3 * hash12(vec2(pane, 2.0))) * g2 * mull;
      glow += vec3(0.8, 0.85, 1.0) * 0.4 * g3 * step(0.55, hash12(vec2(floor(q.x / 1.5), 3.0))) * step(0.3, fract(q.x / 1.5));
      glow += spot(q, vec2(8.3, 10.5), 0.18, pw, vec3(1.0, 0.97, 0.9));
      glow += spot(q, vec2(-1.5, 6.6), 0.16, pw, sideCol);
      flood += 0.6 * exp(-length(q - vec2(2.0, 5.0)) / 8.0);
      // Its bow wave and wake, white on the water in the moonlight.
      float bow = smoothstep(-28.0, -21.0, q.x) * smoothstep(-9.0, -16.0, q.x);
      float wake = smoothstep(18.0, 21.0, q.x) * exp(-(q.x - 19.0) / 35.0);
      float fh = 1.8 * bow + 1.1 * wake;
      float n = vnoise(vec2(wx * 0.35 + time * (bow > 0.0 ? 1.5 : 0.2), q.y * 1.6 - time * 2.5));
      float foam = step(-0.2, q.y) * smoothstep(fh, fh * 0.3, q.y) * smoothstep(0.3, 0.65, n) * max(bow, wake) * step(0.01, fh);
      col = mix(col, vec3(0.6, 0.63, 0.67), foam);
      glow += vec3(0.2, 0.22, 0.26) * foam;
      cov = max(cov, foam);
    }

    // A container ship, about 290 m: a dark hull, its bow raked, the boxes
    // stacked four to eight high bay by bay in their colours, the white
    // accommodation near the stern (a window lit here and there, the bridge
    // across its top) and the funnel behind; two masthead lights, the aft
    // one higher, its side light on the bridge wing, deck lights.
    void containerShip(vec2 q, float pw, vec3 sideCol, inout float cov, inout vec3 col, inout vec3 glow, inout float flood) {
      float bowE = side(q, vec2(-146.5, 15.5), vec2(-139.0, -2.0));
      float hull = max(max(box(q, vec2(-150.0, -2.0), vec2(146.0, 12.0)), bowE), side(q, vec2(141.0, -2.0), vec2(145.0, 12.0)));
      hull = min(hull, max(box(q, vec2(-150.0, 11.0), vec2(-126.0, 15.0)), bowE));
      part(hull, pw, mix(vec3(0.07, 0.08, 0.1), vec3(0.3, 0.06, 0.05), step(q.y, 1.2)), cov, col);
      // The containers.
      float b = floor((q.x + 124.0) / 12.8);
      if ((b >= 0.0 && b < 17.0) || b == 19.0) {
        float tiers = 4.0 + floor(hash12(vec2(b, 3.0)) * 5.0);
        float x0 = -124.0 + b * 12.8;
        float cont = box(q, vec2(x0 + 0.2, 11.0), vec2(x0 + 12.6, 12.0 + tiers * 2.6));
        float tier = floor((q.y - 12.0) / 2.6);
        float half20 = step(0.5, hash12(vec2(b, tier + 20.0))) * step(q.x, x0 + 6.4);
        float pick = hash12(vec2(b * 2.0 + half20, tier));
        vec3 box_ = pick < 0.16 ? vec3(0.55, 0.1, 0.08) : pick < 0.32 ? vec3(0.1, 0.2, 0.5) : pick < 0.45 ? vec3(0.1, 0.35, 0.2)
          : pick < 0.6 ? vec3(0.45) : pick < 0.72 ? vec3(0.7, 0.35, 0.08) : pick < 0.82 ? vec3(0.75, 0.75, 0.72)
          : pick < 0.92 ? vec3(0.35, 0.08, 0.1) : vec3(0.1, 0.4, 0.45);
        float seam = smoothstep(0.0, 0.08, fract((q.y - 12.0) / 2.6)) * (1.0 - 0.6 * step(abs(q.x - x0 - 6.4), 0.12) * step(0.5, hash12(vec2(b, tier + 20.0))));
        box_ *= (0.5 + 0.5 * seam) * (0.85 + 0.15 * hash12(vec2(b, tier + 40.0)));
        part(cont, pw, box_, cov, col);
      }
      // The accommodation, the bridge and its wings, the mast; the funnel.
      float acc = min(box(q, vec2(88.0, 11.0), vec2(112.0, 42.0)), box(q, vec2(84.0, 41.0), vec2(116.0, 45.0)));
      acc = min(acc, min(box(q, vec2(100.5, 45.0), vec2(101.5, 55.0)), box(q, vec2(97.0, 51.0), vec2(105.0, 51.5))));
      part(acc, pw, vec3(0.8, 0.8, 0.78), cov, col);
      float funnel = max(max(box(q, vec2(112.5, 11.0), vec2(121.5, 47.0)), side(q, vec2(121.5, 11.0), vec2(119.0, 47.0))), side(q, vec2(115.0, 47.0), vec2(112.5, 11.0)));
      part(funnel, pw, mix(vec3(0.12, 0.12, 0.14), vec3(0.65, 0.12, 0.08), step(40.0, q.y) * step(q.y, 43.0)), cov, col);
      part(box(q, vec2(-132.5, 14.0), vec2(-131.5, 33.0)), pw, vec3(0.3), cov, col);
      // Its windows: here and there one lit; the bridge's long row, dim.
      if (q.x > 89.0 && q.x < 111.0 && q.y > 15.0 && q.y < 40.0) {
        vec2 cell = floor(vec2((q.x - 89.0) / 2.2, (q.y - 15.0) / 2.9));
        vec2 f = fract(vec2((q.x - 89.0) / 2.2, (q.y - 15.0) / 2.9));
        float w = step(0.2, f.x) * step(f.x, 0.75) * step(0.25, f.y) * step(f.y, 0.65);
        col = mix(col, vec3(0.03), w);
        glow += vec3(1.0, 0.78, 0.48) * 0.45 * w * step(0.62, hash12(cell + 11.0));
      }
      float bw = step(85.0, q.x) * step(q.x, 115.0) * step(42.2, q.y) * step(q.y, 44.0) * step(0.15, fract(q.x / 1.8));
      col = mix(col, vec3(0.03), bw);
      glow += vec3(0.6, 0.7, 0.9) * 0.12 * bw;
      glow += spot(q, vec2(-132.0, 33.6), 0.5, pw, vec3(1.0, 0.97, 0.9));
      glow += spot(q, vec2(101.0, 55.4), 0.5, pw, vec3(1.0, 0.97, 0.9));
      glow += spot(q, vec2(84.5, 44.0), 0.45, pw, sideCol);
      glow += spot(q, vec2(87.5, 15.0), 0.5, pw, vec3(1.0, 0.6, 0.25) * 0.8);
      glow += spot(q, vec2(-127.0, 16.5), 0.5, pw, vec3(1.0, 0.6, 0.25) * 0.8);
      flood += 1.2 * exp(-length(q - vec2(80.0, 16.0)) / 16.0) + 1.0 * exp(-length(q - vec2(-118.0, 15.0)) / 12.0);
    }

    // A ship's light at l mirrored in the sea at p (rf: the reflected ray
    // there): a streak as narrow across as the lamp, long down the water.
    float glint(vec3 p, vec3 rf, vec3 l) {
      vec3 L = normalize(l - p);
      float c = dot(rf, L);
      if (c <= 0.0) return 0.0;
      float ax = dot(rf, normalize(vec3(L.z, 0.0, -L.x)));
      float ay2 = max(1.0 - c * c - ax * ax, 0.0);
      return exp(-6000.0 * ax * ax - 750.0 * ay2);
    }

    // The ship's brightest lights mirrored in the sea at p (rf: the
    // reflected ray there).
    vec3 shipGlints(vec3 p, vec3 rf) {
      float Z = shipZ();
      if (p.z > Z) return vec3(0.0);
      vec2 l0, l1, l2;
      vec3 c0, c1, c2;
      if (ship.z < 0.5) {
        l0 = vec2(1.7, 7.3); c0 = vec3(1.0, 0.9, 0.75);
        l1 = vec2(-2.3, 4.3); c1 = vec3(1.0, 0.72, 0.4) * 0.4;
        l2 = vec2(1.35, 9.6); c2 = vec3(0.6, 0.9, 0.7) * 0.5;
      } else if (ship.z < 1.5) {
        l0 = vec2(-2.0, 5.0); c0 = vec3(1.0, 0.8, 0.55) * 0.6;
        l1 = vec2(9.0, 5.0); c1 = c0;
        l2 = vec2(8.3, 10.5); c2 = vec3(1.0, 0.97, 0.9) * 0.5;
      } else {
        l0 = vec2(100.0, 28.0); c0 = vec3(1.0, 0.78, 0.48) * 0.5;
        l1 = vec2(-132.0, 33.6); c1 = vec3(0.6);
        l2 = vec2(87.5, 15.0); c2 = vec3(1.0, 0.6, 0.25) * 0.6;
      }
      float sx = -ship.y;
      vec3 g = c0 * glint(p, rf, vec3(ship.x + l0.x * sx, l0.y, Z));
      g += c1 * glint(p, rf, vec3(ship.x + l1.x * sx, l1.y, Z));
      g += c2 * glint(p, rf, vec3(ship.x + l2.x * sx, l2.y, Z));
      return g;
    }

    void main() {
      float aspect = res.x / res.y;
      vec2 s = vec2((uv.x - 0.5) * aspect, uv.y - HORIZON);
      vec3 d = rayFor(s);
      vec2 ls = onScreen(LANTERN);
      vec3 col;
      float tMax = 1e4;
      // Where the sea is met, and where the calm sea would be: a wave
      // standing up in front hides what lies behind it.
      float seaT = 1e9;
      float calmT = 1e9;
      if (d.y > 0.0) {
        col = sky(d, gl_FragCoord.xy, true);
      } else {
        // The sea.
        calmT = CAMH / -d.y;
        float t = seaHit(d);
        seaT = t;
        tMax = t;
        vec3 p = vec3(0.0, CAMH, 0.0) + d * t;
        vec3 w = waves(p.xz);
        vec4 big = rollers(p.xz);
        float fade = 1.0 / (1.0 + t * 0.012);
        float bigFade = smoothstep(300.0, 50.0, t);
        vec2 sl = w.yz * fade + big.yz * bigFade;
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
        col = vec3(0.004, 0.009, 0.016) * (0.6 + 0.6 * w.x / max(swell, 0.1) + 0.5 * big.x / max(rollAmp, 0.1));
        // The moon through the big waves' thin crests.
        col += vec3(0.0, 0.018, 0.022) * big.w * big.w * bigFade * (1.0 - 0.7 * clouds);
        col += sky(rf, vec2(0.0), false) * fres;
        // The moon's path: glints.
        col += vec3(1.0, 0.95, 0.85) * pow(max(dot(rf, MOONDIR), 0.0), 700.0) * 4.0 * (1.0 - 0.8 * cloudAt(MOONDIR));
        // The lantern's trembling light on the water.
        vec3 tl = normalize(LANTERN - p);
        col += vec3(1.0, 0.85, 0.55) * pow(max(dot(rf, tl), 0.0), 500.0) * 3.0 * lamp;
        // The ship's lights, their streaks kept narrow: the waves' tilt
        // across damped for them.
        if (ship.w > 0.0) {
          vec3 rs = reflect(d, normalize(vec3(-sl.x * 0.4, 1.0, -sl.y)));
          rs.y = abs(rs.y);
          col += shipGlints(p, rs) * ship.w;
        }
        // Whitecaps on the crests, and along the big waves' when they run high.
        float crest = w.x / max(0.5 * swell, 0.1);
        float foam = smoothstep(0.55, 0.95, crest) * smoothstep(0.35, 0.75, vnoise(p.xz * 0.9 + wave * 0.3));
        col += vec3(0.22, 0.24, 0.28) * foam * smoothstep(0.55, 1.5, swell) * fade * (0.5 + 0.5 * (1.0 - clouds));
        float bigFoam = smoothstep(0.45, 0.95, big.w) * smoothstep(0.35, 0.9, rollAmp) * smoothstep(0.3, 0.7, vnoise(p.xz * vec2(0.7, 1.4) + vec2(wave * 0.4, 0.0)));
        col += vec3(0.22, 0.24, 0.28) * bigFoam * bigFade * (0.5 + 0.5 * (1.0 - clouds));
      }
      // A wave standing up between the eye and the lighthouse's rocks.
      bool front = seaT < 55.0 && seaT < calmT - 1.0;

      // A ship passing, side on, riding the big waves (the bigger it is, the
      // less), the beams lighting it as they sweep over it.
      if (ship.w > 0.0) {
        float Z = shipZ();
        float pw = Z / F / res.y;
        float wx = s.x * Z / F;
        vec2 q = vec2(wx - ship.x, s.y * Z / F + CAMH);
        float ride = ship.z < 0.5 ? 0.9 : ship.z < 1.5 ? 0.5 : 0.08;
        q.y -= rollers(vec2(ship.x, Z)).x * ride;
        q.x *= -ship.y;
        float cp = cos(shipPitch), sp = sin(shipPitch);
        q = mat2(cp, sp, -sp, cp) * q;
        float reach = ship.z < 0.5 ? 13.0 : ship.z < 1.5 ? 140.0 : 150.0;
        if (seaT > Z && abs(q.x) < reach && q.y > -3.0 && q.y < 60.0) {
          vec3 sideCol = ship.y < 0.0 ? vec3(1.0, 0.12, 0.08) : vec3(0.1, 1.0, 0.35);
          float cov = 0.0, flood = 0.0;
          vec3 paint = vec3(0.0), glow = vec3(0.0);
          if (ship.z < 0.5) fishingBoat(q, pw, sideCol, cov, paint, glow, flood);
          else if (ship.z < 1.5) yacht(q, pw, wx, sideCol, cov, paint, glow, flood);
          else containerShip(q, pw, sideCol, cov, paint, glow, flood);
          float lit = 0.07 * (1.0 - 0.6 * clouds) + 0.06 * flood + 2.2 * beamOn(vec3(wx, s.y * Z / F + CAMH, Z)) * lamp;
          float hz = 1.0 - exp(-Z * 0.0005 * haze);
          vec3 sc = mix(paint * lit, vec3(0.025, 0.035, 0.065), hz);
          col = mix(col, sc, cov * ship.w);
          col += glow * ship.w * (1.0 - 0.5 * hz);
        }
      }

      // The rocks and the lighthouse on them.
      float px = 1.0 / res.y;
      float rt = rockTop(s.x);
      float base = (0.0 - CAMH) / LANTERN.z * F;
      if (!front && s.y < rt && s.y > base - 0.012 && abs(s.x - 0.44) < 0.19) {
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
      if (!front && s.y > tb - 0.03 && s.y < top) {
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
      if (splash > 0.01 && !front) {
        vec2 q = vec2((s.x - 0.44) / 0.17, (s.y - base) / 0.09);
        float sh = (1.0 - q.x * q.x) * splash;
        if (q.y > -0.1 && q.y < sh && abs(q.x) < 1.0) {
          float n = fbm(vec2(q.x * 6.0, q.y * 4.0 - time * 0.6) + 3.0);
          float a = smoothstep(0.45, 0.75, n) * smoothstep(sh, sh * 0.4, q.y) * splash;
          col = mix(col, vec3(0.35, 0.38, 0.45) * 0.7, a);
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
      // The big waves: bars rolled in so far, and how high they run.
      this.roll = Math.random() * 10;
      this.rollAmp = 0.5;
      // The ship: which, its way (-1 to the left), where it is (x), and a
      // wait before the next. Often one is already on its way.
      this.ship = { kind: Math.floor(Math.random() * SHIPS.length), dir: Math.random() < 0.5 ? -1 : 1, x: 0, wait: 0, on: Math.random() < 0.7, at: Math.random() };
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

    /** How far out (x, metres) a ship of this kind is off the screen's side. */
    edge(kind) {
      return (this.w / this.h / 2) * (kind.z / F) + kind.len / 2 + 3;
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
      const locked = a.playing && a.lock > 0.5 && a.bpm > 0;
      const perTurn = locked ? (16 * 60) / a.bpm : 9;
      this.ang += (dt * Math.PI * 2) / perTurn * (a.playing ? 1 : 0.5);
      const lamp = 0.75 + 0.5 * a.throb * playing;
      this.lamp += (lamp - this.lamp) * Math.min(1, dt * 10);
      // The big waves: one a bar (a quarter of the tempo) with a clear beat,
      // pulled onto the beats so each reaches the rocks as its bar begins
      // (never rolling back); one about every 8 seconds without. Higher
      // with the music, in a storm the highest.
      const before = this.roll;
      const step = dt / (locked ? 240 / a.bpm : 8) * (a.playing ? 1 : 0.6);
      this.roll += step;
      if (locked) {
        let off = (a.beats + a.phase) / 4 - this.roll;
        off -= Math.round(off);
        this.roll += Math.max(off * Math.min(1, dt * 1.5), -0.5 * step);
      }
      const rollAmp = w.roll * (a.playing ? 0.55 + 0.35 * a.intensity + 0.25 * a.bass : 0.45);
      this.rollAmp += (rollAmp - this.rollAmp) * Math.min(1, dt * 0.8);
      if (a.playing && Math.floor(this.roll) > Math.floor(before)) this.splash = Math.max(this.splash, 0.3 + 0.45 * this.rollAmp);
      this.splash *= Math.exp(-dt * 1.6);
      // The ships: across at their own speeds, one after another.
      const s = this.ship;
      let kind = SHIPS[s.kind];
      if (s.at !== undefined) {
        // The first: placed somewhere along its way, once the size is known.
        s.x = s.dir * this.edge(kind) * (2 * s.at - 1);
        delete s.at;
      }
      if (s.on) {
        s.x += s.dir * kind.speed * dt;
        if (s.x * s.dir > this.edge(kind) + kind.trail) {
          s.on = false;
          s.wait = 15 + Math.random() * 35;
        }
      } else if ((s.wait -= dt) <= 0) {
        s.kind = (s.kind + 1 + Math.floor(Math.random() * (SHIPS.length - 1))) % SHIPS.length;
        s.dir = Math.random() < 0.5 ? -1 : 1;
        kind = SHIPS[s.kind];
        s.x = -s.dir * this.edge(kind);
        s.on = true;
      }
      const showShip = set('lhShip') && s.on ? 1 : 0;
      const pitch = kind.rock * Math.sin(this.age * 0.9) * (0.4 + 0.6 * this.swell);

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
      gl.uniform1f(u.roll, this.roll);
      gl.uniform1f(u.rollAmp, this.rollAmp);
      gl.uniform4f(u.ship, s.x, s.dir, s.kind, showShip);
      gl.uniform1f(u.shipPitch, pitch);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'lighthouse',
    name: 'Lighthouse',
    desc: 'A lighthouse on its rocks over a night sea, its beams sweeping round with the tempo, a big wave rolling in every bar and breaking on the rocks, now and then a ship passing',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M10 21l1-12h2l1 12z"/><path d="M10 9h4M11 9V6h2v3M12 6V4"/><path d="M14 7l7-2M14 8l7 2M3 21h18"/></svg>',
    gl: true,
    create: (canvas) => new Lighthouse(canvas),
    options: [
      { type: 'choice', key: 'lhWeather', label: 'Weather', choices: [['clear', 'Clear'], ['cloudy', 'Cloudy'], ['storm', 'Storm']] },
      { type: 'check', key: 'lhShip', label: 'Ships passing' },
    ],
  });
})();
