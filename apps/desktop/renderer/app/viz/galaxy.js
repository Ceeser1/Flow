'use strict';

// Galaxy: a spiral galaxy turning, seen at a slant. Its stars sit along the
// arms, which turn slowly as a whole, each star swaying about; each star
// shines with the band of the spectrum its distance from the middle belongs
// to (the bass in the core, the highs out at the rim), so the music runs
// through it in rings, and the kicks make the core flare.
//
// Its cogwheel: how many arms, the colours, how fast it turns, the view.
//
// WebGL (viz/gl.js): ~40000 stars as points; where each one is this frame is
// worked out on the graphics card from its place in the galaxy, so nothing is
// sent but the time and the spectrum. Light into a texture, blurred for the
// glow, over a dark sky.

(() => {
  const STARS = 40000;
  const PALETTES = {
    classic: [[1.0, 0.85, 0.6], [0.45, 0.6, 1.0], [1.0, 0.45, 0.65]],
    neon: [[1.0, 0.6, 1.0], [0.2, 0.9, 1.0], [0.7, 0.3, 1.0]],
    fire: [[1.0, 0.95, 0.7], [1.0, 0.45, 0.1], [1.0, 0.2, 0.15]],
    ice: [[0.9, 0.95, 1.0], [0.4, 0.7, 1.0], [0.6, 0.5, 1.0]],
  };

  const STAR_VS = `
    layout(location = 0) in vec4 star;   // radius 0..1, angle, height, seed
    uniform sampler2D bands;
    uniform float time, arms, twist, tilt, turn, pulse, scale, aspect, unit;
    uniform vec3 core, armA, armB;
    out vec3 c;
    void main() {
      float r = star.x;
      // The arms turn as a whole (they are a pattern the stars pass through:
      // were each star to keep its own pace, they would wind up tight within
      // minutes); each star sways a little about its place.
      float ang = star.y + time * 0.3 + 0.04 * sin(time * 1.3 + star.w * 40.0) / (0.3 + r);
      vec3 p = vec3(cos(ang) * r, star.z * (0.06 + 0.12 * (1.0 - r)), sin(ang) * r);
      // Turned about its axis, tipped towards us.
      float ct = cos(turn), st = sin(turn);
      p = vec3(p.x * ct - p.z * st, p.y, p.x * st + p.z * ct);
      float cx = cos(tilt), sx = sin(tilt);
      p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
      float persp = 2.6 / (2.6 + p.z);
      vec2 s = p.xy * persp * scale * (1.0 + 0.04 * pulse);
      gl_Position = vec4(s.x / aspect, s.y, 0.0, 1.0);
      // How bright: its band of the spectrum (core the bass), the core flaring on kicks.
      float level = texture(bands, vec2(clamp(r, 0.0, 1.0) * 0.9 + 0.02, 0.5)).r;
      float coreGlow = exp(-r * 9.0);
      float b = (0.35 + 1.7 * level) * (0.4 + 0.6 * fract(star.w * 7.13)) + coreGlow * (0.35 + 1.1 * pulse);
      vec3 col = mix(armA, armB, fract(star.w * 3.7));
      col = mix(col, core, coreGlow * 1.6 > 1.0 ? 1.0 : coreGlow * 1.6);
      c = col * b * 0.9;
      gl_PointSize = max(1.0, (1.2 + 2.2 * fract(star.w * 11.3) + 1.5 * coreGlow) * persp * unit);
    }`;
  const STAR_FS = `
    in vec3 c;
    out vec4 o;
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      float f = max(0.0, 1.0 - dot(d, d) * 4.0);
      o = vec4(c * f * f, 1.0);
    }`;

  const OUT_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D light;
    uniform sampler2D glowA;
    uniform sampler2D glowB;
    uniform vec2 res;
    uniform float time;
    out vec4 o;
    void main() {
      vec3 col = vec3(0.004, 0.004, 0.01);
      // Far stars behind.
      vec2 g = floor(gl_FragCoord.xy / 2.0);
      float h = hash12(g);
      if (h > 0.9975) col += vec3(0.5) * (h - 0.9975) / 0.0025;
      col += texture(light, uv).rgb + texture(glowA, uv).rgb * 1.3 + texture(glowB, uv).rgb * 2.0;
      col = 1.0 - exp(-col * 1.2);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Galaxy {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.stars = VizGL.program(gl, STAR_VS, STAR_FS);
      this.out = VizGL.program(gl, VizGL.SCREEN_VS, OUT_FS);
      this.vao = gl.createVertexArray();
      this.buf = gl.createBuffer();
      this.armsFor = 0;
      this.bandTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.bytes = null;
      this.levels = null;
      this.time = 0;
      this.turn = 0;
      this.tilt = 0.5;
      this.age = 0;
      this.w = 1;
      this.h = 1;
    }

    /** The stars along `arms` arms: a log spiral each, scattered about it, and a bulge in the core. */
    _build(arms) {
      const gl = this.gl;
      const data = new Float32Array(STARS * 4);
      const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
      for (let i = 0; i < STARS; i += 1) {
        let r;
        let ang;
        if (i < STARS * 0.18) {
          // The core.
          r = Math.abs(gauss()) * 0.16;
          ang = Math.random() * Math.PI * 2;
        } else {
          r = 0.06 + Math.random() ** 0.8 * 0.94;
          const arm = Math.floor(Math.random() * arms);
          // The arm winds out: angle grows with log(r); stars scatter more further out.
          ang = (arm / arms) * Math.PI * 2 + Math.log(r) * 3.0 + gauss() * (0.25 + 0.35 * r);
          if (Math.random() < 0.15) ang += Math.random() * Math.PI * 2;   // between the arms
        }
        data[i * 4] = r;
        data[i * 4 + 1] = ang;
        data[i * 4 + 2] = gauss();
        data[i * 4 + 3] = Math.random();
      }
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      gl.bindVertexArray(null);
      this.armsFor = arms;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.a, this.qa, this.qb, this.ea, this.eb]) VizGL.freeTarget(gl, t);
      this.a = VizGL.target(gl, w, h);
      const q = (d) => [Math.max(1, Math.round(w / d)), Math.max(1, Math.round(h / d))];
      this.qa = VizGL.target(gl, ...q(3));
      this.qb = VizGL.target(gl, ...q(3));
      this.ea = VizGL.target(gl, ...q(8));
      this.eb = VizGL.target(gl, ...q(8));
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      const arms = Number(set('gxArms'));
      if (arms !== this.armsFor) this._build(arms);
      const n = a.BANDS;
      if (!this.bytes) {
        this.bytes = new Uint8Array(n);
        this.levels = new Float32Array(n);
      }
      for (let i = 0; i < n; i += 1) {
        const v = 0.4 * a.smooth[i] + 0.6 * a.dynamic[i];
        this.levels[i] += (v - this.levels[i]) * Math.min(1, dt * (v > this.levels[i] ? 20 : 4));
        this.bytes[i] = Math.round(Math.min(1, this.levels[i]) * 255);
      }
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, n, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this.bytes);

      const spin = set('gxSpin') / 100;
      this.time += dt * spin * (a.playing ? (0.5 + 0.8 * a.level) * (0.6 + 0.4 * a.pace) : 0.15);
      this.turn += dt * 0.02;
      const view = set('gxView');
      // How far the disc is turned towards us: pi/2 seen from above, 0 edge on.
      const tilt = view === 'face' ? 1.45 : (view === 'edge' ? 0.1 : 0.5);
      this.tilt += (tilt + 0.05 * Math.sin(this.age * 0.2) - this.tilt) * (1 - Math.exp(-dt / 1.5));
      const pal = PALETTES[set('gxColors')] || PALETTES.classic;

      VizGL.into(gl, this.a);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.stars.p);
      const u = this.stars.u;
      VizGL.bind(gl, u.bands, this.bandTex, 0);
      gl.uniform1f(u.time, this.time);
      gl.uniform1f(u.tilt, this.tilt);
      gl.uniform1f(u.turn, this.turn);
      gl.uniform1f(u.pulse, a.kick);
      gl.uniform1f(u.scale, 0.95);
      gl.uniform1f(u.aspect, this.w / this.h);
      gl.uniform1f(u.unit, this.h / 1080);
      gl.uniform3f(u.core, ...pal[0]);
      gl.uniform3f(u.armA, ...pal[1]);
      gl.uniform3f(u.armB, ...pal[2]);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.POINTS, 0, STARS);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);

      VizGL.blur(gl, this.a, this.qa, this.qb, 1.3);
      VizGL.blur(gl, this.qb, this.ea, this.eb, 2);
      VizGL.into(gl, null);
      gl.useProgram(this.out.p);
      const o = this.out.u;
      VizGL.bind(gl, o.light, this.a.tex, 0);
      VizGL.bind(gl, o.glowA, this.qb.tex, 1);
      VizGL.bind(gl, o.glowB, this.eb.tex, 2);
      gl.uniform2f(o.res, this.w, this.h);
      gl.uniform1f(o.time, this.age);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'galaxy',
    name: 'Galaxy',
    desc: 'A spiral galaxy turning, the music running through it in rings: the bass in the core, the highs at the rim',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 12c0-3 3-5 6-3M12 12c0 3-3 5-6 3M12 12c3 0 5 3 3 6M12 12c-3 0-5-3-3-6"/><circle cx="12" cy="12" r="1"/></svg>',
    gl: true,
    create: (canvas) => new Galaxy(canvas),
    options: [
      { type: 'choice', key: 'gxArms', label: 'Arms', choices: [['2', '2'], ['3', '3'], ['4', '4'], ['6', '6']] },
      { type: 'choice', key: 'gxColors', label: 'Colors', choices: [['classic', 'Classic'], ['neon', 'Neon'], ['fire', 'Fire'], ['ice', 'Ice']] },
      { type: 'slider', key: 'gxSpin', label: 'Turning', min: 0, max: 300, step: 5 },
      { type: 'choice', key: 'gxView', label: 'View', choices: [['face', 'From above'], ['slant', 'Slanted'], ['edge', 'Edge on']] },
    ],
  });
})();
