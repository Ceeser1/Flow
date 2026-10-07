'use strict';

// Black Hole: a black hole with a glowing disk of gas round it, its light
// bent by the hole's gravity: the far side of the disk shows over the top
// and under the bottom of the black shadow as a thin bright ring, the side
// turning towards us brighter and whiter than the side turning away. The
// disk shines with the music, its inner edge with the bass; its gas swirls
// faster near the hole (and with the tempo), in streaks the mids stir up;
// the kicks set hot spots flaring that circle in and fade; the highs make
// the ring round the shadow shimmer. The stars behind (as Aurora's) are bent
// round it too.
//
// Its cogwheel: the colours, the view (almost edge on, slanted, from above),
// how fast the gas turns.
//
// WebGL (viz/gl.js): each pixel's ray is stepped back from the eye through
// the hole's field (a photon's path round a Schwarzschild black hole, its
// pull 1.5 h^2 / r^5, h its angular momentum), gathering the disk's light
// each time it crosses the disk, at half the screen's size; then a glow.
// The stars are drawn at the full size afterwards: the ray pass keeps, in a
// second texture, where on the sky each pixel's bent ray ends up (as an
// offset from where it would without the hole, which is smooth enough to
// be read between pixels) and how much of the sky shows there.

(() => {
  const SPOTS = 4;
  const COLORS = { warm: 0, blue: 1, neon: 2 };
  const VIEWS = { edge: 0.1, slant: 0.42, above: 1.05 };

  const SCENE_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform vec3 eye;
    uniform float time, spin, glow, inner, stir, shimmer;
    uniform int palette;
    layout(location = 1) out vec4 o2;   // the stars' bend (screen plane), how much sky shows
    uniform vec4 spots[${SPOTS}];   // radius, angle, age, strength
    layout(location = 0) out vec4 o;

    const float R_IN = 2.6;
    const float R_OUT = 13.0;

    vec3 tint(float t) {
      // t: 0 cool (the outer disk) .. 1 hottest.
      if (palette == 1) return mix(vec3(0.25, 0.35, 1.0), vec3(0.85, 0.95, 1.2), t) * mix(0.6, 1.4, t);
      if (palette == 2) return mix(vec3(0.9, 0.1, 0.8), vec3(0.3, 1.0, 1.2), t) * mix(0.6, 1.3, t);
      return mix(mix(vec3(0.7, 0.12, 0.02), vec3(1.0, 0.55, 0.15), smoothstep(0.0, 0.5, t)), vec3(1.25, 1.1, 0.9), smoothstep(0.5, 1.0, t));
    }

    float ring(vec2 q) {
      return fbm(q);
    }

    // The disk's light and how much it hides behind it, where the ray crosses it at p going along rd.
    vec4 disk(vec3 p, vec3 rd) {
      float r = length(p.xz);
      if (r < R_IN || r > R_OUT) return vec4(0.0);
      float a = atan(p.z, p.x);
      // Gas turning as a planet's orbit does: faster further in.
      float w = spin * pow(r, -1.5) * 6.0;
      float aa = a - w;
      vec2 q = vec2(cos(aa), sin(aa)) * (r * 0.55) ;
      float n = fbm(q * 1.2 + vec2(r * 0.7, 0.0));
      // Fine rings of gas, stirred by the mids.
      float streak = fbm(vec2(r * 6.0, 0.0) + vec2(cos(aa), sin(aa)) * (1.5 + 1.5 * stir));
      float lanes = 0.7 + 0.3 * sin(r * 7.0 + streak * 9.0);
      float dens = smoothstep(R_IN, R_IN + 0.35, r) * smoothstep(R_OUT, R_OUT - 5.0, r);
      dens *= (0.2 + 1.1 * n * n * 1.6) * (0.45 + 0.75 * lanes);
      // Hot: in near the hole, as the gas there.
      float t = clamp(pow(R_IN / r, 1.1) * 1.1, 0.0, 1.0);
      // Hot spots set off by the kicks, circling.
      float spot = 0.0;
      for (int i = 0; i < ${SPOTS}; i++) {
        vec4 s = spots[i];
        if (s.w <= 0.0) continue;
        float sa = s.y - spin * pow(s.x, -1.5) * 6.0;
        vec2 sp = vec2(cos(sa), sin(sa)) * s.x;
        float d = length(p.xz - sp);
        spot += s.w * exp(-d * d * 2.2) * exp(-s.z * 0.9);
      }
      // Doppler: the gas coming towards the eye brighter and whiter.
      vec3 vel = normalize(vec3(-p.z, 0.0, p.x)) * sqrt(0.5 / r);
      float beta = length(vel);
      float gamma = 1.0 / sqrt(1.0 - beta * beta);
      float dop = 1.0 / (gamma * (1.0 - dot(vel, -rd)));
      float boost = pow(dop, 3.0);
      // Climbing out of the hole's pull dims what comes from near it.
      float grav = sqrt(max(0.0, 1.0 - 1.0 / r));
      float tt = clamp(t * mix(0.75, 1.25, clamp(dop - 0.5, 0.0, 1.0)) + spot * 0.3, 0.0, 1.0);
      vec3 c = tint(tt) * dens * glow * boost * grav * (1.0 + inner * 2.5 * exp(-(r - R_IN) * 1.4)) * 0.85;
      c += tint(1.0) * spot * 2.5 * grav * boost;
      float alpha = clamp(dens * 1.4, 0.0, 0.95);
      return vec4(c, alpha);
    }

    // The sky behind, but for its stars (drawn later, at the full size): a
    // faint band of the galaxy's dust.
    vec3 sky(vec3 d) {
      vec2 sp = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0)));
      vec3 c = vec3(0.0);
      float band = exp(-pow(d.y * 3.0 + 0.4 * sin(sp.x * 2.0), 2.0));
      c += vec3(0.05, 0.04, 0.06) * band * fbm(d.xz * 3.0 + d.y * 2.0);   // no seam where the angle wraps
      return c;
    }

    void main() {
      vec2 sc = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      vec3 fw = normalize(-eye);
      vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
      vec3 up = cross(fw, rt);
      vec3 rd = normalize(fw + (sc.x * rt + sc.y * up) * 0.95);
      vec3 pos = eye;
      vec3 vel = rd;
      float h2 = dot(cross(pos, vel), cross(pos, vel));
      vec3 col = vec3(0.0);
      float hidden = 0.0;
      vec3 ringLight = vec3(0.0);
      float crossings = 0.0;
      bool swallowed = false;
      for (int i = 0; i < 220; i++) {
        float r2 = dot(pos, pos);
        float r = sqrt(r2);
        if (r < 1.0) { swallowed = true; break; }
        if (r > 40.0 && dot(pos, vel) > 0.0) break;
        float dt = clamp(0.07 * r, 0.03, 1.2);
        // Close in to the disk: smaller steps, so it is not skipped.
        dt = min(dt, max(0.05, abs(pos.y) * 0.6 + 0.04));
        // And round the photon sphere, so its ring comes out smooth.
        dt = min(dt, 0.025 + abs(r - 1.5) * 0.35);
        vec3 prev = pos;
        vel += -1.5 * h2 * pos / (r2 * r2 * r) * dt;
        pos += vel * dt;
        if (prev.y * pos.y < 0.0) {
          vec3 p = mix(prev, pos, prev.y / (prev.y - pos.y));
          vec4 d = disk(p, normalize(vel));
          // The third image on (rays that went round the hole) is a hair
          // wide and only flickers at this size: kept faint.
          float k = crossings < 1.5 ? 1.0 : 0.3;
          crossings += 1.0;
          col += (1.0 - hidden) * d.rgb * k;
          hidden += (1.0 - hidden) * d.a * k;
          if (hidden > 0.98) break;
        }
        // The ring of light round the shadow, shimmering with the highs.
        // (Only for rays that get away again: those falling in stay black.)
        ringLight += (1.0 - hidden) * tint(0.9) * exp(-pow(r - 1.5, 2.0) * 18.0) * dt * 0.035 * (0.4 + shimmer * 1.6);
      }
      vec2 bend = vec2(0.0);
      float starsShow = 0.0;
      if (!swallowed) {
        vec3 d = normalize(vel);
        col += (1.0 - hidden) * sky(d) + ringLight;
        // Where the ray points now, on the screen's plane (rays bent round
        // to behind the eye show no stars).
        float f = dot(d, fw);
        if (f > 0.05) {
          bend = vec2(dot(d, rt), dot(d, up)) / f - sc * 0.95;
          starsShow = (1.0 - hidden) * smoothstep(0.05, 0.2, f);
        }
      }
      o = vec4(col, 1.0);
      o2 = vec4(bend, starsShow, 1.0);
    }`;

  const SHOW_FS = VizGL.NOISE + VizGL.STARS + `
    in vec2 uv;
    uniform sampler2D scene, glow, bent;
    uniform vec2 res;
    uniform float time, boom, orbit;
    out vec4 o;
    void main() {
      vec3 c = texture(scene, uv).rgb + texture(glow, uv).rgb * 0.8;
      // The stars where this pixel's ray ends up, moving on as the eye
      // circles round.
      vec3 b = texture(bent, uv).xyz;
      vec2 sc = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      vec2 px = (sc + b.xy / 0.95) * res.y + res * 0.5 + vec2(orbit / 0.95 * res.y, 0.0);
      if (b.z > 0.0) c += starField(px, time, boom) * b.z;
      c = 1.0 - exp(-c * 1.2);
      c = pow(c, vec3(0.95));
      c += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(c, 1.0);
    }`;

  class BlackHole {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.scene = VizGL.program(gl, VizGL.SCREEN_VS, SCENE_FS);
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.age = 0;
      this.spin = 0;
      this.orbit = Math.random() * Math.PI * 2;
      this.elev = null;
      this.glow = 0.6;
      this.spots = [];
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.t, this.bent, this.b1, this.b2]) VizGL.freeTarget(gl, t);
      // Half the screen's size: every pixel steps a long way. The ray pass
      // draws into both: the picture, and where the stars are bent to.
      const hw = Math.max(1, Math.round(w / 2));
      const hh = Math.max(1, Math.round(h / 2));
      this.t = VizGL.target(gl, hw, hh);
      this.bent = VizGL.target(gl, hw, hh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.t.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.bent.tex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const sw = Math.max(1, Math.round(w / 6));
      const sh = Math.max(1, Math.round(h / 6));
      this.b1 = VizGL.target(gl, sw, sh);
      this.b2 = VizGL.target(gl, sw, sh);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      const music = a.playing ? 1 : 0.15;
      this.spin += dt * 0.25 * (set('bhSpin') / 100) * (a.playing ? a.pace * (0.7 + 0.6 * a.level) : 0.15);
      // The eye: circling slowly at the chosen height, nearer when the music swells.
      const elev = VIEWS[set('bhView')] ?? VIEWS.edge;
      this.elev = this.elev === null ? elev : this.elev + (elev - this.elev) * Math.min(1, dt * 1.5);
      this.orbit += dt * 0.025 * music;
      const dist = 24 - 3 * a.intensity;
      this.dist = this.dist ? this.dist + (dist - this.dist) * Math.min(1, dt * 0.5) : dist;
      const eye = [
        Math.cos(this.orbit) * Math.cos(this.elev) * this.dist,
        Math.sin(this.elev) * this.dist,
        Math.sin(this.orbit) * Math.cos(this.elev) * this.dist,
      ];
      const target = a.playing ? 0.55 + 0.6 * a.level + 0.3 * a.intensity : 0.35;
      this.glow += (target - this.glow) * Math.min(1, dt * 3);
      // A hot spot on each kick (on the beat, with one), somewhere in the inner disk.
      if (a.playing && (a.lock > 0.5 ? a.tick && a.beat > 0.4 : a.onset)) {
        this.spots.push({ r: 3.4 + Math.random() * 4, ang: Math.random() * Math.PI * 2, age: 0, s: 0.6 + 0.6 * (a.onsetPower || a.beat) });
        if (this.spots.length > SPOTS) this.spots.shift();
      }
      for (const s of this.spots) {
        s.age += dt;
        // Spiralling in a little as it fades.
        s.r = Math.max(2.8, s.r - dt * 0.25);
      }
      this.spots = this.spots.filter((s) => s.age < 5);
      const spots = new Float32Array(SPOTS * 4);
      this.spots.forEach((s, i) => spots.set([s.r, s.ang, s.age, s.s], i * 4));

      gl.disable(gl.BLEND);
      VizGL.into(gl, this.t);
      gl.useProgram(this.scene.p);
      const u = this.scene.u;
      gl.uniform2f(u.res, this.t.w, this.t.h);
      gl.uniform3f(u.eye, eye[0], eye[1], eye[2]);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.spin, this.spin);
      gl.uniform1f(u.glow, this.glow);
      gl.uniform1f(u.inner, a.bass * music);
      gl.uniform1f(u.stir, a.mid * music);
      gl.uniform1f(u.shimmer, a.treble * music);
      gl.uniform1i(u.palette, COLORS[set('bhColors')] ?? 0);
      gl.uniform4fv(u.spots, spots);
      VizGL.screen(gl);

      // Twice, narrow: one wide pass leaves ghosts of each star round it.
      VizGL.blur(gl, this.t, this.b1, this.b2, 1);
      VizGL.blur(gl, this.b2, this.b1, this.b2, 1.5);
      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      VizGL.bind(gl, this.show.u.scene, this.t.tex, 0);
      VizGL.bind(gl, this.show.u.glow, this.b2.tex, 1);
      VizGL.bind(gl, this.show.u.bent, this.bent.tex, 2);
      gl.uniform2f(this.show.u.res, this.w, this.h);
      gl.uniform1f(this.show.u.time, this.age);
      gl.uniform1f(this.show.u.boom, a.kick);
      gl.uniform1f(this.show.u.orbit, this.orbit);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'blackhole',
    name: 'Black Hole',
    desc: 'A black hole bending the light of its glowing disk round itself, the gas swirling faster with the music, hot spots flaring on the kicks',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="10" ry="3"/><path d="M8 9.5a5 5 0 0 1 8 0"/></svg>',
    gl: true,
    create: (canvas) => new BlackHole(canvas),
    options: [
      { type: 'choice', key: 'bhColors', label: 'Colours', choices: [['warm', 'Warm'], ['blue', 'Blue'], ['neon', 'Neon']] },
      { type: 'choice', key: 'bhView', label: 'View', choices: [['edge', 'Edge on'], ['slant', 'Slanted'], ['above', 'From above']] },
      { type: 'slider', key: 'bhSpin', label: 'Swirling', min: 0, max: 300, step: 5 },
    ],
  });
})();
