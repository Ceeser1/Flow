'use strict';

// Disco: a dance hall. A mirror ball turns under the ceiling, scattering its
// spots of light over the walls, the ceiling and the floor; moving heads on
// a truss sweep coloured beams through the haze, swinging with the beat and
// changing colour every bar; the floor is a grid of LED tiles playing a
// pattern to the music (a chequer flipping on the beat, rings running out
// from the middle on the kicks, the spectrum, a sparkle), another every few
// bars.
//
// Its cogwheel: the colours, the beams, how fast the ball turns.
//
// WebGL (viz/gl.js): one pass over the screen tracing each pixel's ray into
// the room (a box, the ball a sphere of facets, each beam a cone the ray
// passes through), into a texture; that blurred small for the glow.

(() => {
  const HEADS = 5;
  const PALETTES = {
    disco: ['#ff2a55', '#ffd22a', '#2ae8ff', '#c02aff'],
    warm: ['#ff2a6e', '#ff8a2a', '#ffd23a', '#ff2ad2'],
    cool: ['#2a6eff', '#2affd8', '#8a2aff', '#2ad2ff'],
  };

  const SCENE_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform float time, spin, beatPh, beatN, pulse, haze, sparkle, kick;
    uniform int pattern;
    uniform float kicks[4];
    uniform float levels[16];
    uniform vec3 pal[4];
    uniform vec3 headPos[${HEADS}];
    uniform vec3 headDir[${HEADS}];
    uniform vec3 headCol[${HEADS}];
    uniform float beams;
    out vec4 o;

    const vec3 BALL = vec3(0.0, 3.9, 2.0);
    const float BALL_R = 0.62;
    const vec3 ROOM = vec3(7.0, 5.6, 7.0);   // half width, height, back wall z
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
      return keep * exp(-r * r * 90.0) * 6.0 / (dist * dist + 1.0);
    }

    // The floor's tile (i, j) and how it shines.
    vec3 tile(vec2 ij) {
      float n = beatN;
      vec3 c = vec3(0.0);
      if (pattern == 0) {
        float on = mod(ij.x + ij.y + n, 2.0);
        c = pal[int(mod(floor(n / 2.0), 4.0))] * on * (0.3 + 0.7 * pulse);
      } else if (pattern == 1) {
        float d = length(ij + 0.5 - vec2(0.0, 2.0));
        for (int k = 0; k < 4; k++) {
          float age = kicks[k];
          float ring = exp(-pow(d - age * 7.0, 2.0) * 0.7) * exp(-age * 1.4);
          c += pal[int(mod(float(k) + floor(d * 0.5), 4.0))] * ring;
        }
      } else if (pattern == 2) {
        int col = int(clamp((ij.x + 7.0) / 14.0 * 16.0, 0.0, 15.0));
        float lv = levels[col];
        float row = (ij.y + 6.0) / 12.0;
        float on = step(row, lv);
        c = mix(pal[2], pal[0], row) * on * (0.55 + 0.45 * lv);
      } else {
        float h = hash12(ij + floor(n) * 7.13);
        float on = step(h, 0.3);
        c = pal[int(mod(h * 37.0, 4.0))] * on * exp(-beatPh * 2.5);
      }
      return c;
    }

    // How much of a beam's light the ray picks up on its way to tHit, and the pool where it lands.
    vec3 beamLight(vec3 ro, vec3 rd, float tHit, vec3 hitP, bool lit) {
      vec3 sum = vec3(0.0);
      for (int i = 0; i < ${HEADS}; i++) {
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
          float fog = 0.6 + 0.4 * fbm(p.xz * 0.6 + vec2(time * 0.15, 0.0));
          sum += headCol[i] * exp(-pow(dist / width, 2.0)) * (0.05 / width) * fog * haze * beams;
        }
        // Where it lands.
        if (lit) {
          vec3 v = hitP - s;
          float al = dot(v, d);
          if (al > 0.0) {
            float off = length(v - d * al) / (0.05 + al * 0.075);
            sum += headCol[i] * exp(-off * off * 1.5) * 0.9 * beams;
          }
        }
      }
      return sum;
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
      float glint = pow(max(0.0, dot(r, normalize(vec3(-0.4, 0.5, -0.8)))), 60.0) * 4.0;
      float twinkle = step(0.97 - sparkle * 0.05, hash12(id + floor(time * 8.0))) * 2.5;
      return (env + vec3(1.0) * (glint + twinkle * (0.3 + kick))) * grout + vec3(0.02) * (1.0 - grout);
    }

    void main() {
      vec2 sc = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      vec3 ro = vec3(sin(time * 0.07) * 0.6, 1.8, -7.5);
      vec3 ta = vec3(0.0, 2.3, 3.0);
      vec3 fw = normalize(ta - ro);
      vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
      vec3 up = cross(fw, rt);
      vec3 rd = normalize(fw + (sc.x * rt + sc.y * up) * 1.05);

      // Into the room: floor, ceiling, side walls, back wall.
      float t = 1e9;
      int surf = 0;
      if (rd.y < 0.0) { float tt = -ro.y / rd.y; if (tt < t) { t = tt; surf = 1; } }
      if (rd.y > 0.0) { float tt = (ROOM.y - ro.y) / rd.y; if (tt < t) { t = tt; surf = 2; } }
      if (abs(rd.x) > 1e-4) { float tt = (sign(rd.x) * ROOM.x - ro.x) / rd.x; if (tt > 0.0 && tt < t) { t = tt; surf = 3; } }
      if (rd.z > 0.0) { float tt = (ROOM.z - ro.z) / rd.z; if (tt < t) { t = tt; surf = 4; } }
      vec3 p = ro + rd * t;
      vec3 col;
      if (surf == 1) {
        vec2 xz = p.xz;
        vec2 ij = floor(xz);
        vec2 f = fract(xz);
        float inner = smoothstep(0.0, 0.06, f.x) * smoothstep(1.0, 0.94, f.x) * smoothstep(0.0, 0.06, f.y) * smoothstep(1.0, 0.94, f.y);
        vec3 e = tile(ij);
        float glow = 1.0 - length(f - 0.5) * 0.7;
        col = vec3(0.012, 0.012, 0.016) + e * inner * glow * 0.95;
        // The ball, mirrored in the glossy tiles.
        vec3 rr = vec3(rd.x, -rd.y, rd.z);
        float tb = sphere(p + rr * 0.01, rr, BALL, BALL_R);
        if (tb > 0.0) col += ballColor(p, rr, tb) * 0.18;
      } else if (surf == 2) {
        col = vec3(0.01, 0.01, 0.013);
      } else {
        // Walls: dark panels.
        float panel = surf == 3 ? p.z : p.x;
        float seam = smoothstep(0.02, 0.0, abs(fract(panel * 0.5) - 0.5) - 0.48);
        col = vec3(0.02, 0.018, 0.026) * (0.8 + 0.2 * vnoise(vec2(panel * 3.0, p.y * 3.0))) + seam * 0.01;
      }
      col += vec3(0.95, 0.92, 1.0) * spots(p) * (surf == 1 ? 0.35 : surf == 2 ? 0.4 : 1.0);
      col += beamLight(ro, rd, t, p, true) * (surf == 1 ? 0.6 : 0.35);

      // The ball and the rod it hangs from.
      float tb = sphere(ro, rd, BALL, BALL_R);
      if (tb > 0.0 && tb < t) col = ballColor(ro, rd, tb) + beamLight(ro, rd, tb, ro, false);
      vec3 w = ro - vec3(BALL.x, 0.0, BALL.z);
      vec2 dxz = rd.xz;
      float tr = -dot(w.xz, dxz) / max(dot(dxz, dxz), 1e-5);
      vec3 pr = ro + rd * tr;
      if (tr > 0.0 && pr.y > BALL.y + BALL_R * 0.9 && length(pr.xz - BALL.xz) < 0.015 && (tb < 0.0 || tr < tb)) col = vec3(0.06);

      // The trusses' heads: small bright lenses.
      for (int i = 0; i < ${HEADS}; i++) {
        vec3 v = headPos[i] - ro;
        float along = dot(v, rd);
        float off = length(v - rd * along);
        col += headCol[i] * exp(-off * off * 900.0) * 3.0 * beams;
      }
      o = vec4(col, 1.0);
    }`;

  const SHOW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D scene, glow;
    uniform float time;
    out vec4 o;
    void main() {
      vec3 c = texture(scene, uv).rgb + texture(glow, uv).rgb * 0.9;
      c = 1.0 - exp(-c * 1.15);
      c *= 1.0 - 0.35 * pow(length(uv - 0.5) * 1.3, 2.0);
      c += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(c, 1.0);
    }`;

  class Disco {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.scene = VizGL.program(gl, VizGL.SCREEN_VS, SCENE_FS);
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.age = 0;
      this.spin = 0;
      this.beatN = 0;
      this.ph = 0;
      this.kicks = [9, 9, 9, 9];
      this.pattern = 0;
      this.levels = new Float32Array(16);
      this.swing = 0;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.t, this.b1, this.b2]) VizGL.freeTarget(gl, t);
      this.t = VizGL.target(gl, w, h);
      const sw = Math.max(1, Math.round(w / 4));
      const sh = Math.max(1, Math.round(h / 4));
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
      for (let i = 0; i < 16; i += 1) {
        const from = Math.floor((i / 16) * a.BANDS * 0.9);
        const to = Math.floor(((i + 1) / 16) * a.BANDS * 0.9);
        let v = 0;
        for (let j = from; j < to; j += 1) v = Math.max(v, a.dynamic[j]);
        this.levels[i] += (v - this.levels[i]) * Math.min(1, dt * 14);
      }
      this.spin += dt * 0.35 * (set('dcSpin') / 100) * (a.playing ? a.pace : 0.3);

      // The moving heads: along a truss under the ceiling, swinging with the
      // beat (a full swing over two beats), their colours another each bar.
      const heads = new Float32Array(HEADS * 3);
      const dirs = new Float32Array(HEADS * 3);
      const cols = new Float32Array(HEADS * 3);
      const bar = Math.floor(this.beatN / 4);
      const beatT = this.beatN + this.ph;
      for (let i = 0; i < HEADS; i += 1) {
        const x = -5 + (10 * i) / (HEADS - 1);
        heads.set([x, 5.3, 4.5], i * 3);
        const s = Math.sin(((beatT / 2) * Math.PI) + i * (i % 2 ? 1.1 : -1.1));
        const pan = s * 0.55 + (i - (HEADS - 1) / 2) * -0.12;
        const tilt = 0.55 + 0.25 * Math.sin(beatT * Math.PI * 0.25 + i);
        const d = [Math.sin(pan) * Math.cos(tilt), -Math.sin(tilt) * 0.9 - 0.3, -Math.cos(pan) * Math.cos(tilt) * 0.9];
        const len = Math.hypot(...d);
        dirs.set(d.map((v) => v / len), i * 3);
        const c = pal[(i + bar) % 4];
        const bright = (a.playing ? 0.55 + 0.45 * a.throb : 0.25) * 1.4;
        cols.set(c.map((v) => v * bright), i * 3);
      }

      gl.disable(gl.BLEND);
      VizGL.into(gl, this.t);
      gl.useProgram(this.scene.p);
      const u = this.scene.u;
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.spin, this.spin);
      gl.uniform1f(u.beatPh, this.ph);
      gl.uniform1f(u.beatN, this.beatN);
      gl.uniform1f(u.pulse, a.playing ? Math.exp(-this.ph * 3.5) : 0.2);
      gl.uniform1f(u.haze, 0.8 + 0.6 * a.level);
      gl.uniform1f(u.sparkle, a.treble);
      gl.uniform1f(u.kick, a.kick);
      gl.uniform1i(u.pattern, this.pattern);
      gl.uniform1fv(u.kicks, this.kicks);
      gl.uniform1fv(u.levels, this.levels);
      gl.uniform3fv(u.pal, pal.flat());
      gl.uniform3fv(u.headPos, heads);
      gl.uniform3fv(u.headDir, dirs);
      gl.uniform3fv(u.headCol, cols);
      gl.uniform1f(u.beams, set('dcBeams') ? 1 : 0);
      VizGL.screen(gl);

      VizGL.blur(gl, this.t, this.b1, this.b2, 1);
      VizGL.blur(gl, this.b2, this.b1, this.b2, 1.5);
      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      VizGL.bind(gl, this.show.u.scene, this.t.tex, 0);
      VizGL.bind(gl, this.show.u.glow, this.b2.tex, 1);
      gl.uniform1f(this.show.u.time, this.age);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'disco',
    name: 'Disco',
    desc: 'A dance hall: a mirror ball scattering its spots, beams sweeping through the haze with the beat, an LED floor playing to the music',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><circle cx="12" cy="12" r="6"/><path d="M6 12h12M12 6c-2 2-2 10 0 12M12 6c2 2 2 10 0 12"/></svg>',
    gl: true,
    create: (canvas) => new Disco(canvas),
    options: [
      { type: 'choice', key: 'dcColors', label: 'Colours', choices: [['disco', 'Disco'], ['warm', 'Warm'], ['cool', 'Cool']] },
      { type: 'check', key: 'dcBeams', label: 'Beams' },
      { type: 'slider', key: 'dcSpin', label: 'Ball turning', min: 0, max: 300, step: 5 },
    ],
  });
})();
