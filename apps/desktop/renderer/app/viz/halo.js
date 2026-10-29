'use strict';

// Halo: the song's cover in the middle (its dark parts see-through, black
// not there at all; a picture with see-through parts of its own just
// those), the spectrum standing out around it (bass at the top, higher
// towards the bottom, both sides alike), pulsing on the kicks, sparks
// thrown off it, and behind it all the cover again, blurred and dark,
// turning slowly. Its colours are the cover's own: the two most
// colourful hues in it (a cover without colour, or none, takes one from the
// song). A song without a cover gets a record instead. At the top the title
// and the artist (the lyrics, when shown, are under it all).
//
// Its cogwheel: the spectrum as bars with falling caps, as a line, or as
// dots, and its size (50-150%, the cover growing with it); the colours
// (the cover's, a rainbow round the circle, by the chord sounding, one of
// its own); the cover (the song's, or a picture picked: either not squeezed,
// its shorter side across the circle, its middle on the circle's; the song's
// cut off at the circle's edge, the picture whole, past it), its size
// (50-150%), it wiggling (rocking left and right, pushed further by the
// beats) and pulsing (growing on the kicks; at 100% of each and its own
// size, at most to the spectrum's inner edge), each 0-200%, and its outline
// (a rim of light, brighter on the kicks, and a shadow under it); the
// sparks (and how many: 100% ten times what 10% was); the background (the
// cover blurred, or a picture or an MP4 or WebM video picked, filling the
// screen as it is, darkened; the video playing without its sound, over and
// over); the title.
//
// WebGL (viz/gl.js): the background and the cover are passes over the whole
// screen reading the cover's texture (its mipmaps blur the background), the
// spectrum and the sparks soft lines.

(() => {
  const BARS = 64;          // each side
  const SPARKS = 420;       // at most, at 10% (the amount they had before it could be set)
  const MIN_HZ = 40;
  const MAX_HZ = 12000;

  const BG_FS = `
    in vec2 uv;
    uniform sampler2D cover;
    uniform vec2 res, fit;
    uniform float zoom, turn, dim, on;
    uniform vec3 tint;
    out vec4 o;
    void main() {
      float aspect = res.x / res.y;
      vec2 q = uv - 0.5;
      q.y /= aspect;
      q = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * q / zoom;
      q = vec2(q.x, -q.y) * fit + 0.5;
      // The cover's smallest mipmaps, read a few times around, for a soft blur.
      vec3 c = vec3(0.0);
      for (int i = 0; i < 4; i++) {
        float a = float(i) * 1.5708 + 0.4;
        // (Its colour premultiplied: see-through parts black.)
        c += textureLod(cover, q + vec2(cos(a), sin(a)) * 0.015, 5.5).rgb;
      }
      c *= 0.25;
      vec3 dark = tint * 0.08;
      c = mix(dark, c * dim, on);
      vec2 v = uv - 0.5;
      v.x *= aspect;
      c *= 1.0 - 0.6 * smoothstep(0.3, 1.0, length(v));
      o = vec4(c, 1.0);
    }`;

  // A picture (or a video) picked for the background: filling the screen (its
  // middle, not stretched), darkened at the edges, a little nearer on the kicks.
  const PIC_FS = `
    in vec2 uv;
    uniform sampler2D pic;
    uniform vec2 res, size;
    uniform float zoom, dim, on;
    out vec4 o;
    void main() {
      vec2 s = res / size;
      vec2 q = (uv - 0.5) * (s / max(s.x, s.y)) / zoom;
      vec3 c = texture(pic, vec2(q.x, -q.y) + 0.5).rgb * dim;
      vec2 v = uv - 0.5;
      v.x *= res.x / res.y;
      c *= 1.0 - 0.5 * smoothstep(0.4, 1.0, length(v));
      o = vec4(c, on);
    }`;

  const COVER_FS = `
    in vec2 uv;
    uniform sampler2D cover;
    uniform vec2 res, center, fit;
    uniform float radius, angle, ring, shade, spill, clear;
    uniform vec3 ringColor;
    out vec4 o;

    void main() {
      vec2 px = uv * res;
      vec2 p = (px - center) / radius;
      // 1 at the edge.
      float d = length(p);
      float edge = 1.5 / radius;
      float inside = 1.0 - smoothstep(1.0 - edge, 1.0, d);
      vec2 q = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p;
      // Its shorter side across the circle, not squeezed (fit: the part of
      // each side within it), its middle on the circle's. Shown inside the
      // circle, or (spill, a picture picked) whole, past the circle's edge.
      vec4 t = texture(cover, vec2(q.x, -q.y) * 0.5 * fit + 0.5);
      vec2 out2 = abs(q) - 1.0 / fit;
      float whole = 1.0 - smoothstep(-edge, 0.0, max(out2.x, out2.y));
      float shown = mix(inside, whole, spill);
      // Its colour premultiplied by its alpha.
      vec3 c = t.rgb;
      // Its dark parts see through: as solid as its strongest channel on a
      // log scale over its 255 steps (0 not there at all, 1 an eighth, 15
      // half, 64 three quarters), its colour laid over what is behind as
      // light. A picture with see-through parts of its own (clear) is as
      // solid as they say, its dark parts and soft shadows kept.
      float bright = max(c.r, max(c.g, c.b)) / max(t.a, 0.004);
      float solid = shown * t.a * mix(log(1.0 + 255.0 * bright) / log(256.0), 1.0, clear);
      // A rim of light just outside, brighter on the kicks, and a soft shadow
      // under it (none under a picture picked), both under what spills over.
      float out1 = max(0.0, d - 1.0);
      float glow = ring * exp(-out1 * 40.0) * (1.0 - inside);
      float shadow = shade * exp(-out1 * 7.0) * (1.0 - inside);
      vec3 col = c * shown + ringColor * glow * (1.0 - solid);
      float a = clamp(solid + (glow + shadow) * (1.0 - solid), 0.0, 1.0);
      o = vec4(col, a);
    }`;

  const hsv = VizCover.hsv;
  const wrap = (x) => ((x % 1) + 1) % 1;

  class Halo {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.bg = VizGL.program(gl, VizGL.SCREEN_VS, BG_FS);
      this.disc = VizGL.program(gl, VizGL.SCREEN_VS, COVER_FS);
      this.picBg = VizGL.program(gl, VizGL.SCREEN_VS, PIC_FS);
      this.lines = VizGL.lines(gl, 40000);
      this.cover = new VizCover(gl, { standIn: 'record' });
      // The pictures picked for the cover and the background.
      this.coverPic = new VizCover.Picture(gl);
      this.backPic = new VizCover.Picture(gl);
      this.colors = this.cover.colors;
      this.coverOn = 0;        // the cover behind fading in, 0..1
      this.picOn = 0;          // the picture behind over it, 0..1
      this.turn = 0;
      this.wiggle = 0;         // the beats' push on the rocking (radians) and its speed
      this.wiggleV = 0;
      this.rock = 0;           // the steady rocking, faded in and out with the box
      this.grow = 0;           // the cover pulsing, 0..1 of the way to the spectrum
      this.scale = 1;          // the spectrum's size (and the cover's with it), 0.5..1.5
      this.levels = new Float32Array(BARS);
      this.caps = new Float32Array(BARS);
      this.capFall = new Float32Array(BARS);
      this.sparks = [];
      this.age = 0;
      this.w = 1;
      this.h = 1;
      this.text = h('div.viz-halo', h('div.viz-halo__title'), h('div.viz-halo__artist'));
      canvas.parentNode.insertBefore(this.text, canvas.nextSibling);
      this._map = null;
    }

    size(w, h) {
      this.w = w;
      this.h = h;
    }

    destroy() {
      this.text.remove();
      this.coverPic.close();
      this.backPic.close();
      VizGL.lose(this.gl);
    }

    /** The song playing changed (or its cover did): its title, faded in. */
    _song() {
      if (!this.cover.update()) return;
      const song = this.cover.song;
      this.text.firstChild.textContent = song ? song.title || 'Untitled' : '';
      this.text.lastChild.textContent = song ? [song.artist, song.mix ? `(${song.mix})` : ''].filter(Boolean).join(' ') : '';
      this.text.classList.remove('viz-halo--in');
      void this.text.offsetWidth;
      this.text.classList.add('viz-halo--in');
    }

    /** Which of the 96 bands each of the BARS reads, MIN_HZ..MAX_HZ on a log axis. */
    _bands(a) {
      if (!this._map) {
        this._map = new Float32Array(BARS);
        const n = a.BANDS;
        const lo = Math.log(a.MIN_HZ);
        const span = Math.log(a.MAX_HZ) - lo;
        for (let i = 0; i < BARS; i += 1) {
          const hz = MIN_HZ * (MAX_HZ / MIN_HZ) ** (i / (BARS - 1));
          this._map[i] = Math.max(0, Math.min(n - 1, ((Math.log(hz) - lo) / span) * n - 0.5));
        }
      }
      return this._map;
    }

    frame(a, dt) {
      this.age += dt;
      this._song();
      const set = Store.settings;
      const gl = this.gl;
      const w = this.w;
      const h = this.h;
      // The cover shown: the picture picked, once loaded, else the song's.
      this.coverPic.want(set.hlCover === 'pick' ? set.hlCoverFile : '');
      // A video plays only while it is shown.
      this.backPic.want(set.hlBackground && set.hlBack === 'pick' ? set.hlBackFile : '');
      this.backPic.tick();
      const pic = this.coverPic.loaded ? this.coverPic : null;
      const coverTex = pic ? pic.tex : this.cover.tex;
      const shown = pic || this.cover;
      const fitX = Math.min(1, shown.height / shown.width);
      const fitY = Math.min(1, shown.width / shown.height);
      // The two colours: the cover's (gliding to a new song's), the chord's,
      // one of its own (and a paler one), or turning slowly through the rainbow.
      const mode = set.hlColors;
      let target = (pic && pic.colors) || this.cover.colors;
      if (mode === 'notes') {
        const chord = a.playing ? a.noteHue() : null;
        if (chord) this.chordHue = this.chordHue === undefined ? chord.hue : this.chordHue + ((((chord.hue - this.chordHue + 1.5) % 1) - 0.5) * Math.min(1, dt * 3 * chord.strength));
        const hue = this.chordHue === undefined ? 0.6 : this.chordHue;
        target = [hsv(wrap(hue), 0.75, 1), hsv(wrap(hue + 0.1), 0.6, 1)];
      } else if (mode === 'custom') {
        const own = VizGL.rgb(Visualizer.setting('hlColor'));
        target = [own, own.map((v) => Math.min(1, v * 0.6 + 0.4))];
      } else if (mode === 'rainbow') target = [hsv(wrap(this.age * 0.03), 0.8, 1), hsv(wrap(this.age * 0.03 + 0.2), 0.8, 1)];
      const k = 1 - Math.exp(-dt / 0.6);
      this.colors = this.colors.map((c, i) => c.map((v, j) => v + (target[i][j] - v) * k));
      const [c1, c2] = this.colors;
      this.coverOn += ((set.hlBackground && (pic || this.cover.loaded) ? 1 : 0) - this.coverOn) * k;
      this.picOn += ((set.hlBackground && this.backPic.loaded ? 1 : 0) - this.picOn) * k;

      const cx = w / 2;
      const cy = h * 0.46;
      this.scale = (set.hlScale || 100) / 100;
      const R = h * 0.17 * this.scale * (1 + 0.06 * a.kick);
      this.turn += dt * 0.02;
      // Wiggle: rocking left and right (0.1 rad at 100%, every 2.5 s), and
      // each beat pushes it further the way it is going, springing back.
      const t = Math.min(dt, 0.05);
      const wiggle = !!set.hlWiggle;
      const sway = (set.hlWiggleAmount ?? 100) / 100;
      this.rock += ((wiggle ? sway : 0) - this.rock) * (1 - Math.exp(-dt * 3));
      const phase = this.age * ((2 * Math.PI) / 2.5);
      if (wiggle && a.onset) this.wiggleV += Math.sign(Math.cos(phase) || 1) * (0.8 + 1.6 * a.onsetPower) * sway;
      this.wiggleV += (-60 * this.wiggle - 7 * this.wiggleV) * t;
      const most = 0.35 * Math.max(sway, 0.05);
      this.wiggle = Math.max(-most, Math.min(most, this.wiggle + this.wiggleV * t));
      const tilt = this.rock * 0.1 * Math.sin(phase) + this.wiggle;
      // Pulsing: the cover grows on the kicks, by a tenth at 100% (up to the
      // spectrum's inner edge, R * 1.12, its rim just inside it).
      this.grow = Math.max(set.hlPulse ? Math.min(1, a.kick * 1.3) : 0, this.grow - dt * 2.5);
      const swell = 0.1 * ((set.hlPulseAmount ?? 100) / 100);
      const coverR = R * ((set.hlCoverScale || 100) / 100) * (1 + swell * this.grow);
      const outline = set.hlOutline !== false;

      // 1. Behind: the cover blurred and dark (or near black in its colour),
      // and the picture picked over it (alone once it is fully there).
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      let u;
      if (this.picOn < 0.999) {
        gl.useProgram(this.bg.p);
        u = this.bg.u;
        VizGL.bind(gl, u.cover, coverTex, 0);
        gl.uniform2f(u.res, w, h);
        gl.uniform2f(u.fit, fitX, fitY);
        gl.uniform1f(u.zoom, 1.25 + 0.04 * a.kick);
        gl.uniform1f(u.turn, this.turn);
        gl.uniform1f(u.dim, 0.32 + 0.12 * a.kick);
        gl.uniform1f(u.on, this.coverOn);
        gl.uniform3f(u.tint, c1[0], c1[1], c1[2]);
        VizGL.screen(gl);
      }
      if (this.picOn > 0.001) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(this.picBg.p);
        u = this.picBg.u;
        VizGL.bind(gl, u.pic, this.backPic.tex, 0);
        gl.uniform2f(u.res, w, h);
        gl.uniform2f(u.size, this.backPic.width, this.backPic.height);
        gl.uniform1f(u.zoom, 1.02 + 0.03 * a.kick);
        gl.uniform1f(u.dim, 0.55 + 0.1 * a.kick);
        gl.uniform1f(u.on, this.picOn);
        VizGL.screen(gl);
      }

      // 2. The sparks and the spectrum, added as light.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      const rainbow = mode === 'rainbow';
      if (set.hlParticles) this._sparks(a, dt, cx, cy, R, c1, c2, rainbow);
      this._spectrum(a, dt, cx, cy, R, c1, c2, set.hlStyle, rainbow);
      this.lines.draw(w, h);

      // 3. The cover on top.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.disc.p);
      u = this.disc.u;
      VizGL.bind(gl, u.cover, coverTex, 0);
      gl.uniform2f(u.res, w, h);
      gl.uniform2f(u.center, cx, h - cy);
      gl.uniform2f(u.fit, fitX, fitY);
      gl.uniform1f(u.radius, coverR);
      gl.uniform1f(u.angle, tilt);
      // Its shadow fainter as it nears the spectrum, not darkening the bars.
      gl.uniform1f(u.shade, pic || !outline ? 0 : 0.55 * (1 - 0.7 * this.grow));
      gl.uniform1f(u.spill, pic ? 1 : 0);
      gl.uniform1f(u.clear, pic && pic.clear ? 1 : 0);
      gl.uniform1f(u.ring, outline ? 0.35 + 0.9 * a.kick : 0);
      gl.uniform3f(u.ringColor, c1[0], c1[1], c1[2]);
      VizGL.screen(gl);
      gl.disable(gl.BLEND);

      this.text.hidden = !set.hlTitle;
    }

    _spectrum(a, dt, cx, cy, R, c1, c2, style, rainbow) {
      const map = this._bands(a);
      const bands = a.dynamic;
      const lines = this.lines;
      // Its lines and dots as much bigger as it is.
      const unit = (this.h / 1080) * this.scale;
      const reach = R * 1.05;
      const base = R * 1.12;
      for (let i = 0; i < BARS; i += 1) {
        const f = map[i];
        const lo = Math.floor(f);
        const t = f - lo;
        const v = bands[lo] * (1 - t) + bands[Math.min(bands.length - 1, lo + 1)] * t;
        this.levels[i] = Math.max(v, this.levels[i] - dt * 2.2);
        const level = this.levels[i];
        if (level >= this.caps[i]) {
          this.caps[i] = level;
          this.capFall[i] = 0;
        } else {
          this.capFall[i] += dt * 1.6;
          this.caps[i] = Math.max(level, this.caps[i] - this.capFall[i] * dt);
        }
      }
      const pitch = (Math.PI / BARS);
      // From the first colour to the second by x; in the rainbow, by the place
      // round the circle (pos, the top 0, the bottom 1), paler as it rises.
      const colour = rainbow
        ? (x, pos) => hsv(wrap(pos * 0.85 + this.age * 0.02), 0.85 - 0.3 * x, 1)
        : (x) => [0, 1, 2].map((j) => c1[j] + (c2[j] - c1[j]) * x);
      if (style === 'line') {
        // A closed line through the tips, and a fainter one inside it.
        for (const side of [1, -1]) {
          let px = 0;
          let py = 0;
          for (let i = 0; i <= BARS; i += 1) {
            const j = Math.min(BARS - 1, i);
            const ang = -Math.PI / 2 + side * i * pitch;
            const len = base + this.levels[j] ** 1.4 * reach;
            const x = cx + Math.cos(ang) * len;
            const y = cy + Math.sin(ang) * len;
            if (i) {
              const col = colour(rainbow ? this.levels[j] : i / BARS, i / BARS);
              lines.seg(px, py, x, y, 6 * unit, col, 0.18);
              lines.seg(px, py, x, y, 1.8 * unit, col, 0.9);
            }
            px = x;
            py = y;
          }
        }
        return;
      }
      for (let i = 0; i < BARS; i += 1) {
        const level = this.levels[i];
        const len = Math.max(2 * unit, level ** 1.4 * reach);
        const col = colour(Math.min(1, level * 1.2), (i + 0.5) / BARS);
        for (const side of [1, -1]) {
          const ang = -Math.PI / 2 + side * (i + 0.5) * pitch;
          const ux = Math.cos(ang);
          const uy = Math.sin(ang);
          const x0 = cx + ux * base;
          const y0 = cy + uy * base;
          if (style === 'dots') {
            const n = Math.max(1, Math.round(len / (9 * unit)));
            for (let d = 0; d < n; d += 1) {
              const r = base + (d + 0.5) * (len / n);
              lines.dot(cx + ux * r, cy + uy * r, 4.5 * unit, col, 0.9 * (1 - (d / n) * 0.4));
            }
          } else {
            const half = Math.max(1.2 * unit, base * pitch * 0.32);
            const x1 = cx + ux * (base + len);
            const y1 = cy + uy * (base + len);
            lines.seg(x0, y0, x1, y1, half * 2.6, col, 0.12);
            lines.seg(x0, y0, x1, y1, half, col, 0.95);
            // The cap, hanging a moment before it falls.
            const cr = base + this.caps[i] ** 1.4 * reach + 5 * unit;
            lines.seg(cx + ux * cr, cy + uy * cr, cx + ux * (cr + 3 * unit), cy + uy * (cr + 3 * unit), half, [1, 1, 1], 0.75);
          }
        }
      }
    }

    _sparks(a, dt, cx, cy, R, c1, c2, rainbow) {
      const unit = this.h / 1080;
      // New ones from the rim, many more on the kicks.
      // The amount: 10% as many as there always were, 100% ten times that.
      const amount = (Store.settings.hlSparkAmount || 0) / 10;
      const born = (8 + 160 * a.kick * a.kick + (a.onset ? 40 * a.onsetPower : 0)) * dt * (a.playing ? 1 : 0.3) * amount;
      this._owed = (this._owed || 0) + born;
      while (this._owed >= 1 && this.sparks.length < SPARKS * amount) {
        this._owed -= 1;
        const ang = Math.random() * Math.PI * 2;
        this.sparks.push({ ang, r: R * (1.1 + Math.random() * 0.15), v: (60 + Math.random() * 140) * unit, size: (1 + Math.random() * 2) * unit, c: Math.random() });
      }
      this._owed = Math.min(this._owed, 1);
      const push = 1 + 6 * a.kick;
      const far = Math.hypot(this.w, this.h) * 0.6;
      for (const s of this.sparks) {
        s.r += s.v * push * dt;
        s.ang += dt * 0.05;
        const fade = Math.max(0, 1 - s.r / far);
        let col = s.c < 0.45 ? c1 : (s.c < 0.9 ? c2 : [1, 1, 1]);
        if (rainbow && s.c < 0.9) col = hsv(wrap(s.c / 0.9 + this.age * 0.02), 0.75, 1);
        this.lines.dot(cx + Math.cos(s.ang) * s.r, cy + Math.sin(s.ang) * s.r, s.size * 1.6, col, 0.7 * fade);
      }
      this.sparks = this.sparks.filter((s) => s.r < far);
    }
  }

  Visualizer.add({
    id: 'halo',
    name: 'Halo',
    desc: "The song's cover with the spectrum around it, in the cover's own colours (or others), sparks flying off on the kicks",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
    gl: true,
    create: (canvas) => new Halo(canvas),
    options: [
      {
        type: 'choice',
        key: 'hlStyle',
        label: 'Spectrum',
        choices: [['bars', 'Bars'], ['line', 'Line'], ['dots', 'Dots']],
        group: [{ type: 'slider', key: 'hlScale', label: 'Scale', min: 50, max: 150, step: 5 }],
      },
      {
        type: 'choice',
        key: 'hlColors',
        label: 'Color',
        choices: [['cover', 'Cover'], ['rainbow', 'Rainbow'], ['notes', 'By the notes']],
        color: { value: 'custom', key: 'hlColor', presets: Visualizer.OWN_PRESETS },
      },
      {
        type: 'choice',
        key: 'hlCover',
        label: 'Cover',
        choices: [['original', 'Original'], ['pick', 'Pick']],
        pick: { value: 'pick', key: 'hlCoverFile', name: 'halo-cover', max: 2048 },
        group: [
          { type: 'slider', key: 'hlCoverScale', label: 'Scale', min: 50, max: 150, step: 5 },
          { type: 'check', key: 'hlWiggle', label: 'Wiggle', amount: { key: 'hlWiggleAmount', min: 0, max: 200, step: 5 } },
          { type: 'check', key: 'hlPulse', label: 'Pulsing', amount: { key: 'hlPulseAmount', min: 0, max: 200, step: 5 } },
          { type: 'check', key: 'hlOutline', label: 'Outline' },
        ],
      },
      { type: 'check', key: 'hlParticles', label: 'Sparks', amount: { key: 'hlSparkAmount', min: 0, max: 200, step: 5 } },
      {
        type: 'check',
        key: 'hlBackground',
        label: 'Background',
        group: [{
          type: 'choice',
          key: 'hlBack',
          label: '',
          choices: [['cover', 'Cover'], ['pick', 'Pick']],
          pick: { value: 'pick', key: 'hlBackFile', name: 'halo-background', max: 3840, video: true },
        }],
      },
      { type: 'check', key: 'hlTitle', label: 'Song title' },
    ],
  });
})();
