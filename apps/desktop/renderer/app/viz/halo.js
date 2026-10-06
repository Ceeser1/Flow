'use strict';

// Halo: the song's cover in the middle, the spectrum standing out around it
// (bass at the top, higher towards the bottom, both sides alike), pulsing on
// the kicks, sparks thrown off it, and behind it all the cover again, blurred
// and dark, turning slowly. Its colours are the cover's own: the two most
// colourful hues in it (a cover without colour, or none, takes one from the
// song). A song without a cover gets a record instead. Under it the title
// and the artist.
//
// Its cogwheel: the cover round (and turning, like a record) or square; the
// spectrum as bars with falling caps, as a line, or as dots; the sparks;
// the cover behind; the title.
//
// WebGL (viz/gl.js): the background and the cover are passes over the whole
// screen reading the cover's texture (its mipmaps blur the background), the
// spectrum and the sparks soft lines.

(() => {
  const BARS = 64;          // each side
  const SPARKS = 420;
  const MIN_HZ = 40;
  const MAX_HZ = 12000;

  const BG_FS = `
    in vec2 uv;
    uniform sampler2D cover;
    uniform vec2 res;
    uniform float zoom, turn, dim, on;
    uniform vec3 tint;
    out vec4 o;
    void main() {
      float aspect = res.x / res.y;
      vec2 q = uv - 0.5;
      q.y /= aspect;
      q = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * q / zoom;
      q = vec2(q.x, -q.y) + 0.5;
      // The cover's smallest mipmaps, read a few times around, for a soft blur.
      vec3 c = vec3(0.0);
      for (int i = 0; i < 4; i++) {
        float a = float(i) * 1.5708 + 0.4;
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

  const COVER_FS = `
    in vec2 uv;
    uniform sampler2D cover;
    uniform vec2 res, center;
    uniform float radius, angle, square, ring;
    uniform vec3 ringColor;
    out vec4 o;

    float box(vec2 p, float r) {
      vec2 d = abs(p) - vec2(1.0 - r);
      return (length(max(d, 0.0)) + min(max(d.x, d.y), 0.0)) / r;
    }

    void main() {
      vec2 px = uv * res;
      vec2 p = (px - center) / radius;
      // Round: 1 at the edge; square: the same, its corners rounded.
      float d = mix(length(p), 1.0 + box(p, 0.12) * 0.12, square);
      float edge = 1.5 / radius;
      float inside = 1.0 - smoothstep(1.0 - edge, 1.0, d);
      vec2 q = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p;
      vec3 c = texture(cover, vec2(q.x, -q.y) * 0.5 + 0.5).rgb;
      // A rim of light just outside, brighter on the kicks, and a soft shadow under it.
      float out1 = max(0.0, d - 1.0);
      float glow = ring * exp(-out1 * 40.0) * (1.0 - inside);
      float shadow = 0.55 * exp(-out1 * 7.0) * (1.0 - inside);
      vec3 col = c * inside + ringColor * glow;
      float a = clamp(inside + glow + shadow, 0.0, 1.0);
      o = vec4(col, a);
    }`;

  /** '#rrggbb'-free colour helpers: rgb 0..1 from hue 0..1, saturation, value. */
  function hsv(h, s, v) {
    const f = (n) => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }

  function hash(text) {
    let x = 2166136261;
    for (let i = 0; i < text.length; i += 1) x = Math.imul(x ^ text.charCodeAt(i), 16777619);
    return (x >>> 0) / 4294967296;
  }

  /**
   * The two most colourful hues of an image: [primary, secondary] as rgb,
   * read from it at 24 x 24; null for one with hardly any colour.
   */
  function paletteOf(img) {
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 24;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 24, 24);
    const px = ctx.getImageData(0, 0, 24, 24).data;
    const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255;
      const g = px[i + 1] / 255;
      const b = px[i + 2] / 255;
      const max = Math.max(r, g, b);
      const sat = max ? (max - Math.min(r, g, b)) / max : 0;
      const w = sat * sat * max;
      if (w < 0.02) continue;
      const bin = bins[Math.floor(hueOf(r, g, b) / 30) % 12];
      bin.w += w;
      bin.r += r * w;
      bin.g += g * w;
      bin.b += b * w;
    }
    const order = bins.map((b, i) => ({ ...b, i })).filter((b) => b.w > 0).sort((x, y) => y.w - x.w);
    if (!order.length || order[0].w < 2) return null;
    const colour = (b) => {
      const rgb = [b.r / b.w, b.g / b.w, b.b / b.w];
      // As bright as a light: the strongest channel up to 1.
      const m = Math.max(...rgb, 0.01);
      return rgb.map((v) => Math.min(1, (v / m) * 0.95));
    };
    const first = order[0];
    const second = order.find((b) => Math.min(Math.abs(b.i - first.i), 12 - Math.abs(b.i - first.i)) >= 2 && b.w > first.w * 0.15);
    const a = colour(first);
    return [a, second ? colour(second) : a.map((v) => Math.min(1, v * 0.6 + 0.4))];
  }

  /** A record, for a song without a cover: dark grooves and a label in its colour. */
  function record(hue) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0b0b0e';
    ctx.fillRect(0, 0, 512, 512);
    for (let r = 250; r > 110; r -= 3) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.025 + 0.03 * Math.abs(Math.sin(r * 0.37))})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(256, 256, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // The shine across it.
    const shine = ctx.createConicGradient(0.6, 256, 256);
    shine.addColorStop(0, 'rgba(255,255,255,0)');
    shine.addColorStop(0.08, 'rgba(255,255,255,0.08)');
    shine.addColorStop(0.16, 'rgba(255,255,255,0)');
    shine.addColorStop(0.5, 'rgba(255,255,255,0)');
    shine.addColorStop(0.58, 'rgba(255,255,255,0.08)');
    shine.addColorStop(0.66, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    ctx.fillRect(0, 0, 512, 512);
    const [r, g, b] = hsv(hue, 0.75, 0.9).map((v) => Math.round(v * 255));
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.beginPath();
    ctx.arc(256, 256, 100, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b0b0e';
    ctx.beginPath();
    ctx.arc(256, 256, 9, 0, Math.PI * 2);
    ctx.fill();
    return c;
  }

  class Halo {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.bg = VizGL.program(gl, VizGL.SCREEN_VS, BG_FS);
      this.disc = VizGL.program(gl, VizGL.SCREEN_VS, COVER_FS);
      this.lines = VizGL.lines(gl, 40000);
      this.tex = gl.createTexture();
      this.key = null;         // the song and cover shown
      this.colors = [[0.6, 0.4, 1], [1, 0.5, 0.8]];
      this.target = this.colors;
      this.coverOn = 0;        // the cover behind fading in, 0..1
      this.angle = 0;
      this.turn = 0;
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
      VizGL.lose(this.gl);
    }

    /** The song playing changed (or its cover did): its picture, colours and title. */
    _song() {
      const id = Player.currentId;
      const song = id ? Store.song(id) || (Player.remote ? { ...Player.remote.state, id } : null) : null;
      const src = song ? Covers.src(song) : '';
      const key = `${id}|${src}`;
      if (key === this.key) return;
      this.key = key;
      this.text.firstChild.textContent = song ? song.title || 'Untitled' : '';
      this.text.lastChild.textContent = song ? [song.artist, song.mix ? `(${song.mix})` : ''].filter(Boolean).join(' ') : '';
      this.text.classList.remove('viz-halo--in');
      void this.text.offsetWidth;
      this.text.classList.add('viz-halo--in');
      const hue = hash(id || 'flow');
      const fallback = () => {
        if (this.key !== key) return;
        this._upload(record(hue));
        this.target = [hsv(hue, 0.7, 1), hsv((hue + 0.12) % 1, 0.6, 1)];
      };
      if (!src) {
        fallback();
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (this.key !== key) return;
        this._upload(img);
        let pal = null;
        try {
          pal = paletteOf(img);
        } catch {
          // Unreadable: the song's own colour.
        }
        this.target = pal || [hsv(hue, 0.6, 1), hsv((hue + 0.1) % 1, 0.5, 1)];
      };
      img.onerror = fallback;
      img.src = src;
    }

    _upload(source) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      this.loaded = true;
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
      // Colours glide to a new song's.
      const k = 1 - Math.exp(-dt / 0.6);
      this.colors = this.colors.map((c, i) => c.map((v, j) => v + (this.target[i][j] - v) * k));
      const [c1, c2] = this.colors;
      this.coverOn += ((set.hlBackground && this.loaded ? 1 : 0) - this.coverOn) * k;

      const cx = w / 2;
      const cy = h * 0.46;
      const R = h * 0.17 * (1 + 0.06 * a.kick);
      if (set.hlSpin && set.hlShape === 'round') this.angle += dt * (0.25 + 0.6 * a.bass);
      else this.angle *= Math.exp(-dt * 3);
      this.turn += dt * 0.02;

      // 1. Behind: the cover blurred and dark (or near black in its colour).
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.bg.p);
      let u = this.bg.u;
      VizGL.bind(gl, u.cover, this.tex, 0);
      gl.uniform2f(u.res, w, h);
      gl.uniform1f(u.zoom, 1.25 + 0.04 * a.kick);
      gl.uniform1f(u.turn, this.turn);
      gl.uniform1f(u.dim, 0.32 + 0.12 * a.kick);
      gl.uniform1f(u.on, this.coverOn);
      gl.uniform3f(u.tint, c1[0], c1[1], c1[2]);
      VizGL.screen(gl);

      // 2. The sparks and the spectrum, added as light.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      if (set.hlParticles) this._sparks(a, dt, cx, cy, R, c1, c2);
      this._spectrum(a, dt, cx, cy, R, c1, c2, set.hlStyle);
      this.lines.draw(w, h);

      // 3. The cover on top.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.disc.p);
      u = this.disc.u;
      VizGL.bind(gl, u.cover, this.tex, 0);
      gl.uniform2f(u.res, w, h);
      gl.uniform2f(u.center, cx, h - cy);
      gl.uniform1f(u.radius, R);
      gl.uniform1f(u.angle, this.angle);
      gl.uniform1f(u.square, set.hlShape === 'square' ? 1 : 0);
      gl.uniform1f(u.ring, 0.35 + 0.9 * a.kick);
      gl.uniform3f(u.ringColor, c1[0], c1[1], c1[2]);
      VizGL.screen(gl);
      gl.disable(gl.BLEND);

      this.text.hidden = !set.hlTitle;
    }

    _spectrum(a, dt, cx, cy, R, c1, c2, style) {
      const map = this._bands(a);
      const bands = a.dynamic;
      const lines = this.lines;
      const unit = this.h / 1080;
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
      const colour = (x) => [0, 1, 2].map((j) => c1[j] + (c2[j] - c1[j]) * x);
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
              const col = colour(i / BARS);
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
        const col = colour(Math.min(1, level * 1.2));
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
              lines.dot(cx + ux * r, cy + uy * r, 3.4 * unit, col, 0.9 * (1 - (d / n) * 0.4));
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

    _sparks(a, dt, cx, cy, R, c1, c2) {
      const unit = this.h / 1080;
      // New ones from the rim, many more on the kicks.
      const born = (8 + 160 * a.kick * a.kick + (a.onset ? 40 * a.onsetPower : 0)) * dt * (a.playing ? 1 : 0.3);
      this._owed = (this._owed || 0) + born;
      while (this._owed >= 1 && this.sparks.length < SPARKS) {
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
        const col = s.c < 0.45 ? c1 : (s.c < 0.9 ? c2 : [1, 1, 1]);
        this.lines.dot(cx + Math.cos(s.ang) * s.r, cy + Math.sin(s.ang) * s.r, s.size * 1.6, col, 0.7 * fade);
      }
      this.sparks = this.sparks.filter((s) => s.r < far);
    }
  }

  Visualizer.add({
    id: 'halo',
    name: 'Halo',
    desc: "The song's cover with the spectrum around it, in the cover's own colours, sparks flying off on the kicks",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
    gl: true,
    create: (canvas) => new Halo(canvas),
    options: [
      { type: 'choice', key: 'hlShape', label: 'Cover', choices: [['round', 'Round'], ['square', 'Square']] },
      { type: 'check', key: 'hlSpin', label: 'Spin', when: (s) => s.hlShape === 'round' },
      { type: 'choice', key: 'hlStyle', label: 'Spectrum', choices: [['bars', 'Bars'], ['line', 'Line'], ['dots', 'Dots']] },
      { type: 'check', key: 'hlParticles', label: 'Sparks' },
      { type: 'check', key: 'hlBackground', label: 'Cover behind' },
      { type: 'check', key: 'hlTitle', label: 'Song title' },
    ],
  });
})();
