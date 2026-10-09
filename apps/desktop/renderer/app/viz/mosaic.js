'use strict';

// Mosaic Cover: the song's cover built from the covers of your own library,
// a tile for each: every tile the cover whose colour best fits that spot of
// the picture, shifted a little further towards it. The tiles flip over on
// the beat (a ripple round a place on each beat, a wave across on each bar)
// to another cover that fits as well; a new song turns them all over, from
// the middle out, into its own picture. A library with few covers has its
// gaps filled with plain coloured tiles.
//
// Its cogwheel: the tiles' size, how far each is shifted to the picture's
// colour.
//
// WebGL (viz/gl.js): the covers sit in one texture (32 x 32 of them, each
// put in as it loads; mipmapped, so the tiny tiles do not shimmer), each's
// average colour noted; the tiles' state (which cover each side, how far
// turned) is a small texture refreshed each frame; one pass draws them. The
// covers that best fit a tile are looked for once a picture (and again as
// covers come in), when the tile first turns.

(() => {
  const ATLAS = 32;             // covers across the atlas (and down)
  const CELL = 64;              // pixels a cover there
  const MAX = ATLAS * ATLAS;
  const LEVELS = 5;             // the atlas's mipmaps: down to 4 pixels a cover
  const SIZES = { tiny: 45, small: 30, medium: 20, large: 13 };
  const FLIP_S = 0.5;

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D atlas, means, tiles, targets;
    uniform vec2 res, grid;
    uniform float tint, time;
    out vec4 o;
    const float PI = 3.14159265;

    void main() {
      vec2 g = uv * grid;
      vec2 cell = floor(g);
      vec2 f = fract(g);
      vec4 d = texelFetch(tiles, ivec2(cell), 0);
      vec3 target = texelFetch(targets, ivec2(cell), 0).rgb;
      float t = d.z;
      // Turning about its upright middle: as wide as the cosine, the back after half way.
      float w = abs(cos(PI * t));
      float idx = t < 0.5 ? d.x : d.y;
      float gap = 0.04;
      vec3 col = vec3(0.012, 0.012, 0.014);
      float x = (f.x - 0.5) / max(w, 1e-3);
      if (abs(x) < 0.5 - gap && abs(f.y - 0.5) < 0.5 - gap) {
        vec2 q = vec2(x + 0.5, f.y);
        q = (q - 0.5) / (1.0 - 2.0 * gap) + 0.5;
        // As sharp as the tile is big on the screen (narrower while turning), and
        // half a pixel of that inside its cover, so the neighbours do not bleed in.
        vec2 texels = ${CELL}.0 * grid / (res * (1.0 - 2.0 * gap));
        float lod = clamp(log2(max(texels.y, texels.x / max(w, 1e-3))), 0.0, ${LEVELS - 1}.0);
        float edge = 0.5 * exp2(ceil(lod)) / ${CELL}.0;
        q = clamp(vec2(q.x, 1.0 - q.y), edge, 1.0 - edge);
        vec2 at = vec2(mod(idx, ${ATLAS}.0), floor(idx / ${ATLAS}.0));
        vec3 c = textureLod(atlas, (at + q) / ${ATLAS}.0, lod).rgb;
        vec3 mean = texelFetch(means, ivec2(at), 0).rgb;
        // Shifted towards the picture's colour there, its own light and dark kept.
        vec3 shifted = c * (target + 0.03) / (mean + 0.03);
        c = mix(c, clamp(shifted, 0.0, 1.5), tint);
        c = mix(c, target, tint * 0.3);
        // Turning: darker as it turns away, a glint on its edge.
        c *= 0.55 + 0.45 * w;
        c += vec3(0.25) * (1.0 - w) * smoothstep(0.5 - gap - 0.03, 0.5 - gap, abs(x)) * step(0.02, t) * step(t, 0.98);
        // The pop of a tile just turned on a beat.
        c *= 1.0 + d.w * 0.5;
        col = c;
      } else if (w < 0.999) {
        // The shadow in the gap a turning tile leaves.
        col *= 0.5;
      }
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

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

  class Mosaic {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.age = 0;
      this.dead = false;
      // The covers: each drawn into a cover's square, put into the atlas, its average colour noted.
      this.cell = document.createElement('canvas');
      this.cell.width = CELL;
      this.cell.height = CELL;
      this.cctx = this.cell.getContext('2d', { willReadFrequently: true });
      this.cctx.imageSmoothingQuality = 'high';
      this.means = new Uint8Array(MAX * 4);
      this.count = 0;
      this.atlasDirty = true;
      this.atlas = this._tex(gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texStorage2D(gl.TEXTURE_2D, LEVELS, gl.RGBA8, ATLAS * CELL, ATLAS * CELL);
      this.meansTex = this._tex(gl.NEAREST);
      this.tilesTex = this._tex(gl.NEAREST);
      this.targetsTex = this._tex(gl.NEAREST);
      this.rows = 0;
      this.cols = 0;
      this.tiles = [];
      this.targets = null;
      this.targetsDirty = false;
      // The covers that best fit each tile (4 a tile, -1 none), looked for again when `gen` moves on.
      this.cands = null;
      this.candsGen = null;
      this.gen = 1;
      this.genCount = 0;
      this.genAt = 0;
      this.best = new Float64Array(4);
      this.bestAt = new Int32Array(4);
      this.songKey = null;
      this.pending = null;
      this._fillStandIns();
      this._loadLibrary();
    }

    _tex(filter) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    /** Plain tiles in colours all round the wheel, for a library with few covers; covers take their places as they come. */
    _fillStandIns() {
      const n = 48;
      for (let i = 0; i < n; i += 1) {
        const h = i / n;
        const v = 0.35 + 0.6 * ((i * 7) % 5) / 4;
        const [r, g, b] = hsv(h, i % 6 === 0 ? 0.1 : 0.75, v);
        const grad = this.cctx.createLinearGradient(0, 0, CELL, CELL);
        const css = (k) => `rgb(${Math.round(r * 255 * k)}, ${Math.round(g * 255 * k)}, ${Math.round(b * 255 * k)})`;
        grad.addColorStop(0, css(1.1));
        grad.addColorStop(1, css(0.75));
        this.cctx.fillStyle = grad;
        this.cctx.fillRect(0, 0, CELL, CELL);
        this._put(i);
      }
      this.standIns = n;
      this.count = n;
    }

    /** Up to MAX covers from the library, one per album look, in no order; loaded a few at a time. */
    _loadLibrary() {
      const songs = (Store.library && Store.library.songs) || [];
      const seen = new Set();
      const picks = [];
      for (const s of songs.slice().sort(() => Math.random() - 0.5)) {
        const src = Covers.src(s);
        if (!src) continue;
        const key = `${s.album || ''}|${s.cover}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picks.push(src);
        if (picks.length >= MAX) break;
      }
      // Real covers replace the stand-ins from the first place on, once there are enough of them.
      let slot = 0;
      let left = picks.length;
      const enough = picks.length >= 24;
      if (enough) this.count = 0;
      // All in: every tile turned over again, to the best of them.
      const one = () => {
        left -= 1;
        if (left === 0 && slot > 0) this.rewave = true;
      };
      const next = () => {
        if (this.dead || !picks.length) return;
        const src = picks.shift();
        const img = new Image();
        img.onload = () => {
          if (this.dead) return;
          const at = enough ? slot : this.standIns + slot;
          if (at < MAX) {
            slot += 1;
            this._place(img, at);
            this.count = Math.max(this.count, at + 1);
          }
          one();
          next();
        };
        img.onerror = () => {
          one();
          next();
        };
        img.src = src;
      };
      for (let i = 0; i < 6; i += 1) next();
    }

    /** A cover into the atlas at `at`, cut square from its middle. */
    _place(img, at) {
      const side = Math.min(img.naturalWidth, img.naturalHeight) || 1;
      try {
        this.cctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, CELL, CELL);
        this._put(at);
      } catch {
        // Unreadable: left as it was.
      }
    }

    /** The cover's square as drawn into the atlas at `at`, its average colour noted. */
    _put(at) {
      const gl = this.gl;
      const img = this.cctx.getImageData(0, 0, CELL, CELL);
      const px = img.data;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < px.length; i += 16) {
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
      const n = px.length / 16;
      this.means.set([r / n, g / n, b / n, 255], at * 4);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, (at % ATLAS) * CELL, Math.floor(at / ATLAS) * CELL, gl.RGBA, gl.UNSIGNED_BYTE, img);
      this.atlasDirty = true;
    }

    /** The song's picture at the grid's size: its cover, or a glow in its own colour. */
    _target(song, done) {
      const c = document.createElement('canvas');
      c.width = this.cols;
      c.height = this.rows;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const finish = () => {
        try {
          done(ctx.getImageData(0, 0, this.cols, this.rows).data);
        } catch {
          done(null);
        }
      };
      const standIn = () => {
        const hue = hash((song && song.id) || 'flow');
        const [r, g, b] = hsv(hue, 0.7, 0.9).map((v) => Math.round(v * 255));
        const grad = ctx.createRadialGradient(this.cols / 2, this.rows / 2, 0, this.cols / 2, this.rows / 2, this.cols * 0.6);
        grad.addColorStop(0, `rgb(${r}, ${g}, ${b})`);
        grad.addColorStop(1, `rgb(${Math.round(r * 0.15)}, ${Math.round(g * 0.15)}, ${Math.round(b * 0.15)})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, this.cols, this.rows);
        finish();
      };
      const src = song ? Covers.src(song) : '';
      if (!src) {
        standIn();
        return;
      }
      const img = new Image();
      img.onload = () => {
        // The cover across the screen's width, cut to its shape.
        const s = Math.min(img.naturalWidth, (img.naturalHeight * this.cols) / this.rows);
        const sh = (s * this.rows) / this.cols;
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - sh) / 2, s, sh, 0, 0, this.cols, this.rows);
        finish();
      };
      img.onerror = standIn;
      img.src = src;
    }

    /** One of the covers that best fit tile k's colour (a few of the best, at random; not `not`). */
    _pick(k, not = -1) {
      const o = k * 4;
      if (this.candsGen[k] !== this.gen) {
        this.candsGen[k] = this.gen;
        this._fit(this.targets[o], this.targets[o + 1], this.targets[o + 2], o);
      }
      const c = this.cands;
      let n = 0;
      for (let j = o; j < o + 4; j += 1) if (c[j] >= 0 && c[j] !== not) n += 1;
      let r = Math.floor(Math.random() * n);
      for (let j = o; j < o + 4; j += 1) {
        if (c[j] < 0 || c[j] === not) continue;
        if (r === 0) return c[j];
        r -= 1;
      }
      return 0;
    }

    /** The 4 covers whose colour is nearest (r, g, b), best first, into cands at o. */
    _fit(r, g, b, o) {
      const m = this.means;
      const best = this.best;
      const at = this.bestAt;
      let n = 0;
      for (let i = 0; i < this.count; i += 1) {
        const dr = m[i * 4] - r;
        const dg = m[i * 4 + 1] - g;
        const db = m[i * 4 + 2] - b;
        const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
        if (n < 4 || d < best[3]) {
          let j = n < 4 ? n++ : 3;
          for (; j > 0 && best[j - 1] > d; j -= 1) {
            best[j] = best[j - 1];
            at[j] = at[j - 1];
          }
          best[j] = d;
          at[j] = i;
        }
      }
      for (let j = 0; j < 4; j += 1) this.cands[o + j] = j < n ? at[j] : -1;
    }

    /** The tiles' best fits looked for again (a new picture, more covers). */
    _refit() {
      this.gen += 1;
      this.genCount = this.count;
      this.genAt = this.age;
    }

    size(w, h) {
      this.w = w;
      this.h = h;
      this._grid();
    }

    _grid() {
      const rows = SIZES[Visualizer.setting('msSize')] ?? SIZES.medium;
      const cols = Math.max(1, Math.round((rows * this.w) / this.h));
      if (rows === this.rows && cols === this.cols) return;
      this.rows = rows;
      this.cols = cols;
      this.tiles = Array.from({ length: rows * cols }, () => ({ front: Math.floor(Math.random() * this.count), back: 0, at: null, pop: 0 }));
      this.targets = new Uint8Array(rows * cols * 4);
      this.targetsDirty = true;
      this.cands = new Int16Array(rows * cols * 4);
      this.candsGen = new Uint32Array(rows * cols);
      this.tileData = new Float32Array(rows * cols * 4);
      this.songKey = null;
    }

    destroy() {
      this.dead = true;
      VizGL.lose(this.gl);
    }

    /**
     * Flips the tiles within `radius` (tiles) of (cx, cy), the wave spreading
     * at `speed` tiles a second; each's new cover is picked as it starts to turn.
     */
    _wave(cx, cy, radius, speed) {
      for (let y = 0; y < this.rows; y += 1) {
        for (let x = 0; x < this.cols; x += 1) {
          const d = Math.hypot(x - cx, y - cy);
          if (d > radius) continue;
          const t = this.tiles[y * this.cols + x];
          if (t.at !== null) continue;
          t.back = -1;
          t.at = this.age + d / speed;
        }
      }
    }

    frame(a, dt) {
      const gl = this.gl;
      this.age += dt;
      this._grid();
      // A new song: its picture, then every tile turned over from the middle out.
      const id = Player.currentId;
      const song = id ? Store.song(id) : null;
      const key = `${id}|${song ? Covers.src(song) : ''}|${this.cols}x${this.rows}`;
      if (key !== this.songKey) {
        this.songKey = key;
        const asked = key;
        this._target(song, (px) => {
          if (this.dead || this.songKey !== asked) return;
          if (px) this.targets.set(px);
          this.targetsDirty = true;
          this._refit();
          for (const t of this.tiles) t.at = null;
          this._wave(this.cols / 2, this.rows / 2, 1e9, Math.max(this.cols, this.rows) / 1.2);
        });
      }
      if (this.rewave && this.targets) {
        this.rewave = false;
        this._refit();
        this._wave(this.cols / 2, this.rows / 2, 1e9, Math.max(this.cols, this.rows) / 1.5);
      } else if (this.count !== this.genCount && this.age - this.genAt > 0.5) {
        // Covers still coming in: looked for among them too, now and then.
        this._refit();
      }
      // On the beat a ripple round some place; on each bar a wide wave.
      if (a.playing && (a.lock > 0.5 ? a.tick : a.onset)) {
        const bar = a.lock > 0.5 && a.beats % 4 === 0;
        const cx = Math.random() * this.cols;
        const cy = Math.random() * this.rows;
        const r = bar ? Math.max(this.cols, this.rows) * 0.6 : 1.5 + 3 * (a.lock > 0.5 ? a.beat : a.onsetPower);
        this._wave(cx, cy, r, bar ? 18 : 10);
      }
      // The tiles turning.
      const data = this.tileData;
      for (let i = 0; i < this.tiles.length; i += 1) {
        const t = this.tiles[i];
        let turn = 0;
        if (t.at !== null && this.age >= t.at) {
          if (t.back < 0) t.back = this._pick(i, t.front);
          turn = (this.age - t.at) / FLIP_S;
          if (turn >= 1) {
            t.front = t.back;
            t.at = null;
            t.pop = 1;
            turn = 0;
          }
        }
        t.pop *= Math.exp(-dt * 5);
        // Eased: quick through the middle.
        const e = turn * turn * (3 - 2 * turn);
        data[i * 4] = t.front;
        data[i * 4 + 1] = t.back < 0 ? t.front : t.back;
        data[i * 4 + 2] = e;
        data[i * 4 + 3] = t.pop * (a.playing ? 1 : 0.3);
      }

      if (this.atlasDirty) {
        this.atlasDirty = false;
        gl.bindTexture(gl.TEXTURE_2D, this.atlas);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.bindTexture(gl.TEXTURE_2D, this.meansTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ATLAS, ATLAS, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.means);
      }
      gl.bindTexture(gl.TEXTURE_2D, this.tilesTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.cols, this.rows, 0, gl.RGBA, gl.FLOAT, data);
      if (this.targetsDirty) {
        this.targetsDirty = false;
        gl.bindTexture(gl.TEXTURE_2D, this.targetsTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        // Canvas rows run down, the screen's up: flipped as they go in.
        const flipped = new Uint8Array(this.targets.length);
        const rowBytes = this.cols * 4;
        for (let y = 0; y < this.rows; y += 1) flipped.set(this.targets.subarray(y * rowBytes, (y + 1) * rowBytes), (this.rows - 1 - y) * rowBytes);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.cols, this.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
      }

      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.atlas, this.atlas, 0);
      VizGL.bind(gl, u.means, this.meansTex, 1);
      VizGL.bind(gl, u.tiles, this.tilesTex, 2);
      VizGL.bind(gl, u.targets, this.targetsTex, 3);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform2f(u.grid, this.cols, this.rows);
      gl.uniform1f(u.tint, Visualizer.setting('msTint') / 100);
      gl.uniform1f(u.time, this.age);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'mosaic',
    name: 'Mosaic Cover',
    desc: "The song's cover built from the covers in your own library, the tiles flipping over on the beat",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 15l3.5-1.5L21 15v5l-3.5 1.5L14 20z"/></svg>',
    gl: true,
    create: (canvas) => new Mosaic(canvas),
    options: [
      { type: 'choice', key: 'msSize', label: 'Tiles', choices: [['tiny', 'Tiny'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] },
      { type: 'slider', key: 'msTint', label: 'Towards the picture', min: 0, max: 100, step: 5 },
    ],
  });
})();
