'use strict';

// Radar: a sonar screen in the dark. Its sweep goes round once a bar (with a
// clear beat; every four seconds without), and as it goes it paints the
// music into the phosphor: along the sweep the spectrum, the bass by the
// middle and the highs out at the rim, glowing on and fading as it comes
// round again, so the screen holds the bar just gone. Each beat and hit
// leaves a contact under the sweep, as far out as what struck was high,
// nudged a little left or right as it sounded in the stereo; the contacts
// glow, then fade, a ring spreading round each.
//
// Its cogwheel: the phosphor's colour (green, amber, blue), how long it glows.
//
// WebGL (viz/gl.js): the phosphor is a texture drawn over each frame (the
// last frame a little dimmer, the wedge the sweep crossed added); the
// screen, its rings and marks, the sweep and the contacts are drawn over it.

(() => {
  const COLORS = { green: [0.3, 1.0, 0.45], amber: [1.0, 0.65, 0.15], blue: [0.35, 0.75, 1.0] };
  const BLIPS = 24;

  const PERSIST_FS = `
    in vec2 uv;
    uniform sampler2D prev, spectrum;
    uniform vec2 res;
    uniform float a0, a1, fade;
    out vec4 o;
    const float PI = 3.14159265;
    void main() {
      vec2 p = (uv - 0.5) * vec2(res.x / res.y, 1.0) / 0.44;
      float r = length(p);
      float v = texture(prev, uv).r * fade;
      // Clockwise from the top: the angle the sweep reaches.
      float ang = mod(atan(p.x, p.y), 2.0 * PI);
      float span = mod(a1 - a0, 2.0 * PI);
      float into = mod(ang - a0, 2.0 * PI);
      if (r < 1.0 && into <= span + 0.004) {
        // The spectrum along the sweep, low in the middle.
        float s = texture(spectrum, vec2(clamp(r, 0.0, 1.0) * 0.98 + 0.01, 0.5)).r;
        v = max(v, s);
      }
      o = vec4(v, 0.0, 0.0, 1.0);
    }`;

  const SHOW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D phos;
    uniform vec2 res;
    uniform vec3 tint;
    uniform float sweep, time, glow;
    uniform vec4 blips[${BLIPS}];   // angle, radius, age (s), strength
    out vec4 o;
    const float PI = 3.14159265;

    void main() {
      float aspect = res.x / res.y;
      vec2 s = (uv - 0.5) * vec2(aspect, 1.0);
      vec2 p = s / 0.44;
      float r = length(p);
      float px = 1.0 / (res.y * 0.44);
      float ang = mod(atan(p.x, p.y), 2.0 * PI);
      vec3 col = vec3(0.01, 0.011, 0.012);
      // The console round the screen: dark, a bevel, screws.
      float bez = r - 1.0;
      if (bez > 0.0) {
        col = vec3(0.035, 0.037, 0.04) * (1.0 - 0.3 * smoothstep(0.0, 0.25, bez));
        col += vec3(0.08) * smoothstep(0.012, 0.0, abs(bez - 0.03)) * (0.5 + 0.5 * p.y / max(r, 1e-3));
        for (int i = 0; i < 4; i++) {
          float a = PI * 0.25 + float(i) * PI * 0.5;
          vec2 sc = vec2(sin(a), cos(a)) * 1.12;
          float d = length(p - sc);
          col = mix(col, vec3(0.12, 0.12, 0.13) * (0.7 + 0.5 * (p.y - sc.y) / 0.03), smoothstep(0.03, 0.026, d));
          col = mix(col, vec3(0.02), smoothstep(0.004, 0.0, abs((p - sc).x + (p - sc).y)) * step(d, 0.026));
        }
        // The bearings round the rim, every ten degrees, longer every thirty.
        float major = step(abs(fract(ang / (2.0 * PI) * 12.0 + 0.5) - 0.5), 0.01);
        col += tint * 0.35 * step(abs(fract(ang / (2.0 * PI) * 36.0 + 0.5) - 0.5), 0.012) * step(bez, 0.035 + 0.03 * major) * step(0.008, bez);
      } else {
        // The phosphor, glowing where the sweep has painted.
        float v = texture(phos, uv).r;
        col += tint * (v * v * 0.8 + v * 0.12);
        // Rings, the cross, faint.
        float rings = smoothstep(px * 1.5, 0.0, abs(fract(r * 4.0 + 0.5) - 0.5) / 4.0);
        float cross = smoothstep(px * 1.5, 0.0, min(abs(p.x), abs(p.y)));
        col += tint * 0.06 * max(rings, cross);
        // The sweep: a bright line and the glow just behind it.
        float behind = mod(sweep - ang, 2.0 * PI);
        col += tint * exp(-behind * 9.0) * 0.18 * (1.0 + glow);
        col += tint * smoothstep(px * 2.0, 0.0, behind * r) * 0.9;
        // The contacts: a bright dot, a ring spreading, both fading.
        for (int i = 0; i < ${BLIPS}; i++) {
          vec4 b = blips[i];
          if (b.w <= 0.0) continue;
          vec2 c = vec2(sin(b.x), cos(b.x)) * b.y;
          float d = length(p - c);
          if (d > b.z * 0.12 + 0.15) continue;
          float life = exp(-b.z * 0.9);
          col += tint * (exp(-d * d / (0.0004 + 0.0006 * b.w)) * 2.5 + exp(-d * 30.0) * 0.4) * b.w * life;
          float ring = abs(d - b.z * 0.12);
          col += tint * smoothstep(px * 2.0, 0.0, ring) * 0.5 * b.w * exp(-b.z * 1.6);
        }
        // The glass: curved, a sheen up and left, darker to its edge.
        col *= 1.0 - 0.35 * r * r;
        col += vec3(0.04, 0.045, 0.05) * smoothstep(0.5, 0.0, length(p - vec2(-0.45, 0.5))) * 0.6;
        // Scan lines.
        col *= 0.92 + 0.08 * sin(gl_FragCoord.y * 2.2);
      }
      col = 1.0 - exp(-col * 1.5);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Radar {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.persist = VizGL.program(gl, VizGL.SCREEN_VS, PERSIST_FS);
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.spec = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.spec);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.specData = null;
      this.age = 0;
      this.sweep = 0;
      this.last = 0;
      this.blips = [];
      this.glow = 0;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      VizGL.freeTarget(gl, this.a);
      VizGL.freeTarget(gl, this.b);
      const hw = Math.max(1, Math.round(w / 2));
      const hh = Math.max(1, Math.round(h / 2));
      this.a = VizGL.target(gl, hw, hh);
      this.b = VizGL.target(gl, hw, hh);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      const turn = a.playing && a.lock > 0.5 && a.bpm ? (4 * 60) / a.bpm : 4;
      const from = this.sweep;
      this.sweep = (this.sweep + (dt * Math.PI * 2) / turn * (a.playing ? 1 : 0.4)) % (Math.PI * 2);
      // How the music sounds left to right: -1 .. 1.
      let pan = 0;
      if (a.left && a.right) {
        let l = 0;
        let r = 0;
        for (let i = a.left.length - 1024; i < a.left.length; i += 4) {
          l += a.left[i] * a.left[i];
          r += a.right[i] * a.right[i];
        }
        pan = l + r > 1e-6 ? (r - l) / (r + l) : 0;
      }
      // A contact on each beat and hit: as far out as what struck was high.
      const struck = a.playing && ((a.lock > 0.5 ? a.tick : a.onset) || (a.hit && a.hitPower > 0.4));
      if (struck) {
        let sum = 0;
        let w = 0;
        for (let i = 0; i < a.BANDS; i += 1) {
          const v = Math.max(0, a.dynamic[i] - 0.45);
          sum += v * i;
          w += v;
        }
        const pitch = w > 0 ? sum / w / a.BANDS : 0.3;
        this.blips.push({
          ang: this.sweep + pan * 0.35 + (Math.random() - 0.5) * 0.06,
          r: Math.min(0.95, 0.12 + pitch * 0.95),
          age: 0,
          s: 0.45 + 0.55 * Math.max(a.onsetPower || 0, a.hitPower || 0, a.beat || 0),
        });
        if (this.blips.length > BLIPS) this.blips.shift();
      }
      for (const b of this.blips) b.age += dt;
      this.blips = this.blips.filter((b) => b.age < 5);
      const blips = new Float32Array(BLIPS * 4);
      this.blips.forEach((b, i) => blips.set([b.ang, b.r, b.age, b.s], i * 4));
      this.glow += ((a.playing ? a.throb : 0) - this.glow) * Math.min(1, dt * 10);

      // The spectrum for the sweep to paint: each band against its own usual.
      const n = a.BANDS;
      if (!this.specData || this.specData.length !== n) this.specData = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const v = a.playing ? Math.max(0, a.dynamic[i] - 0.42) / 0.58 : 0;
        this.specData[i] = Math.min(1, v * 0.9);
      }
      gl.bindTexture(gl.TEXTURE_2D, this.spec);
      // Half floats: linear filtering of full ones needs an extension.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, n, 1, 0, gl.RED, gl.FLOAT, this.specData);

      // The phosphor: last frame dimmer (about a turn's glow at 100%), the swept wedge added.
      const glowTurns = set('raTrail') / 100;
      const fade = Math.exp(-dt / Math.max(0.2, turn * glowTurns * 0.45));
      gl.disable(gl.BLEND);
      VizGL.into(gl, this.b);
      gl.useProgram(this.persist.p);
      VizGL.bind(gl, this.persist.u.prev, this.a.tex, 0);
      VizGL.bind(gl, this.persist.u.spectrum, this.spec, 1);
      gl.uniform2f(this.persist.u.res, this.b.w, this.b.h);
      gl.uniform1f(this.persist.u.a0, from);
      gl.uniform1f(this.persist.u.a1, this.sweep);
      gl.uniform1f(this.persist.u.fade, fade);
      VizGL.screen(gl);
      [this.a, this.b] = [this.b, this.a];

      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      const u = this.show.u;
      VizGL.bind(gl, u.phos, this.a.tex, 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform3f(u.tint, ...(COLORS[set('raColors')] || COLORS.green));
      gl.uniform1f(u.sweep, this.sweep);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.glow, this.glow);
      gl.uniform4fv(u.blips, blips);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'radar',
    name: 'Radar',
    desc: 'A sonar screen whose sweep goes round once a bar, painting the spectrum into its glow, each beat and hit leaving a contact',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/><circle cx="15" cy="15" r="1"/></svg>',
    gl: true,
    stereo: true,
    create: (canvas) => new Radar(canvas),
    options: [
      { type: 'choice', key: 'raColors', label: 'Phosphor', choices: [['green', 'Green'], ['amber', 'Amber'], ['blue', 'Blue']] },
      { type: 'slider', key: 'raTrail', label: 'Glow', min: 25, max: 200, step: 5 },
    ],
  });
})();
