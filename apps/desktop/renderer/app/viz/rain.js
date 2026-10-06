'use strict';

// Code Rain: in the manner of The Matrix. Columns of glyphs run down the
// screen, each drop a bright head with a fading tail, the glyphs flickering as
// they change. Every column belongs to a band of the spectrum (the bass in
// the middle, the highs out to the sides): the louder its band, the faster
// and brighter its drops, and the beats send a wave of light down the screen.
//
// Its cogwheel: the colour, how dense the columns are, how fast they fall,
// the glyphs (Katakana, binary, Latin letters).
//
// WebGL (viz/gl.js): one pass over the screen. Each cell works out its own
// glyph and brightness from its column's drops (a small texture written each
// frame: where the heads are) and a glyph atlas drawn once in Canvas 2D.

(() => {
  const GLYPHS = 64;            // in the atlas, 8 x 8
  const DROPS = 2;              // per column
  const SETS = {
    katakana: 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:.=*+-<>¦|',
    binary: '0101101001110010',
    latin: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&@?!<>+=*',
  };
  const PRESETS = ['#4dff7a', '#3fd0ff', '#ff4fd8', '#ffb347', '#ff4d4d', '#ffffff'];

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D atlas;
    uniform sampler2D drops;        // per column: head rows (r, g), how loud (b)
    uniform vec2 res, grid;         // cells across and down
    uniform float time, wave, flash, glyphs, mirror;
    uniform vec3 color;
    out vec4 o;
    void main() {
      vec2 px = vec2(uv.x, 1.0 - uv.y) * grid;
      vec2 cell = floor(px);
      vec2 inCell = fract(px);
      vec4 d = texture(drops, vec2((cell.x + 0.5) / grid.x, 0.5));
      // Bright at a head, fading up its tail.
      float tail = 6.0 + 22.0 * d.b;
      float b = 0.0;
      float head = 0.0;
      for (int k = 0; k < 2; k++) {
        float hy = (k == 0 ? d.r : d.g) * grid.y * 1.3 - grid.y * 0.15;
        float behind = hy - cell.y;
        if (behind >= 0.0 && behind < tail) {
          b = max(b, pow(1.0 - behind / tail, 1.6));
          if (behind < 1.0) head = 1.0;
        }
      }
      // The wave of a beat running down the screen.
      float w = exp(-pow((cell.y / grid.y - wave) * 16.0, 2.0)) * flash;
      // Its glyph: changing now and then, faster near the head.
      float rate = 0.6 + 6.0 * head + 2.0 * hash12(cell);
      float pick = floor(hash12(cell + floor(time * rate + hash12(cell.yx) * 10.0) * 0.137) * glyphs);
      vec2 a = vec2(mod(pick, 8.0), floor(pick / 8.0));
      // The katakana mirrored, as in the film.
      vec2 g = (a + vec2(mix(inCell.x, 1.0 - inCell.x, mirror), inCell.y) * 0.86 + 0.07) / 8.0;
      // Its sharpness from the cell grid itself, not from g, which jumps at
      // every cell's edge (and would pick a blurry mipmap there).
      vec2 gx = dFdx(px) * 0.86 / 8.0;
      vec2 gy = dFdy(px) * 0.86 / 8.0;
      float flip = mirror > 0.5 ? -1.0 : 1.0;
      float shape = textureGrad(atlas, g, vec2(gx.x * flip, gx.y), vec2(gy.x * flip, gy.y)).r;
      vec3 col = color * shape * (b * (0.6 + 0.6 * d.b) + w * 0.6 + 0.03);
      col += vec3(0.85, 1.0, 0.9) * shape * head * (0.7 + 0.5 * d.b);
      // A faint glow of the column behind its glyphs.
      col += color * b * 0.05;
      col = 1.0 - exp(-col * 1.5);
      o = vec4(col, 1.0);
    }`;

  /** The glyphs in an 8 x 8 atlas, white on black. */
  function atlas(chars) {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = size * 8;
    c.height = size * 8;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(size * 0.78)}px "MS Gothic", "Yu Gothic", "Consolas", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const list = [...chars];
    for (let i = 0; i < GLYPHS; i += 1) {
      ctx.fillText(list[i % list.length], (i % 8) * size + size / 2, Math.floor(i / 8) * size + size / 2 + size * 0.03);
    }
    return c;
  }

  class Rain {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.atlasTex = gl.createTexture();
      this.atlasFor = null;
      this.dropTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.dropTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.cols = 0;
      this.columns = [];
      this.wave = 2;
      this.flash = 0;
      this.age = 0;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      this.w = w;
      this.h = h;
      this.cols = 0;
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    _layout() {
      const density = Visualizer.setting('rnDensity') / 100;
      const cell = Math.max(10, Math.round((this.h / 1080) * 22 / density));
      const cols = Math.max(8, Math.floor(this.w / cell));
      if (cols === this.cols && this.cell === cell) return;
      this.cols = cols;
      this.cell = cell;
      this.rows = Math.ceil(this.h / (cell * 1.25));
      this.columns = [];
      for (let i = 0; i < cols; i += 1) {
        // Its band: the bass in the middle, the highs out to the sides.
        const x = Math.abs((i + 0.5) / cols * 2 - 1);
        this.columns.push({ band: x, heads: Array.from({ length: DROPS }, () => Math.random() * 1.2 - 0.2), speed: 0.15 + Math.random() * 0.2, level: 0 });
      }
      this.bytes = new Uint8Array(cols * 4);
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      this._layout();
      const gl = this.gl;
      const glyphSet = set('rnGlyphs');
      if (this.atlasFor !== glyphSet) {
        this.atlasFor = glyphSet;
        gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas(SETS[glyphSet] || SETS.katakana));
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }

      const pace = set('rnSpeed') / 100;
      const bands = a.dynamic;
      const nb = bands.length;
      for (let i = 0; i < this.cols; i += 1) {
        const c = this.columns[i];
        const v = bands[Math.min(nb - 1, Math.floor(c.band * nb * 0.85))];
        c.level += (v - c.level) * (1 - Math.exp(-dt / 0.1));
        const fall = (c.speed + 0.9 * c.level + 0.4 * a.throb) * pace * (a.playing ? 1 : 0.3);
        for (let k = 0; k < DROPS; k += 1) {
          c.heads[k] += fall * dt;
          if (c.heads[k] > 1.25) c.heads[k] = -0.1 - Math.random() * 0.6;
        }
        this.bytes[i * 4] = Math.max(0, Math.min(255, Math.round((c.heads[0] + 0.15) / 1.3 * 255)));
        this.bytes[i * 4 + 1] = Math.max(0, Math.min(255, Math.round((c.heads[1] + 0.15) / 1.3 * 255)));
        this.bytes[i * 4 + 2] = Math.round(Math.min(1, c.level) * 255);
        this.bytes[i * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.dropTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.cols, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.bytes);

      // A wave of light down the screen: on each phrase (eight beats) while
      // the beat is clear, else on a strong onset.
      const cue = a.lock > 0.5 ? (a.tick && a.beats % 8 === 0 ? 0.8 + 0.3 * a.intensity : 0) : (a.onset && a.onsetPower > 0.4 ? 0.6 + 0.5 * a.onsetPower : 0);
      if (cue && this.wave > 0.6) {
        this.wave = -0.05;
        this.flash = cue;
      }
      this.wave += dt * 1.6;
      this.flash *= Math.exp(-dt * 1.5);

      const c = VizGL.rgb(set('rnColor'));
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.atlas, this.atlasTex, 0);
      VizGL.bind(gl, u.drops, this.dropTex, 1);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform2f(u.grid, this.cols, this.rows);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.wave, this.wave);
      gl.uniform1f(u.flash, this.flash);
      gl.uniform1f(u.glyphs, Math.min(GLYPHS, [...(SETS[glyphSet] || SETS.katakana)].length));
      gl.uniform3f(u.color, c[0], c[1], c[2]);
      gl.uniform1f(u.mirror, glyphSet === 'katakana' ? 1 : 0);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'rain',
    name: 'Code Rain',
    desc: 'In the manner of The Matrix: columns of glyphs falling, faster and brighter the louder their part of the spectrum',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v6M5 13v2M10 6v10M10 19v2M15 3v4M15 10v8M20 5v9M20 17v2"/></svg>',
    gl: true,
    create: (canvas) => new Rain(canvas),
    options: [
      { type: 'color', key: 'rnColor', label: 'Color', presets: PRESETS },
      { type: 'slider', key: 'rnDensity', label: 'Density', min: 50, max: 200, step: 5 },
      { type: 'slider', key: 'rnSpeed', label: 'Speed', min: 25, max: 300, step: 5 },
      { type: 'choice', key: 'rnGlyphs', label: 'Glyphs', choices: [['katakana', 'Katakana'], ['binary', 'Binary'], ['latin', 'Letters']] },
    ],
  });
})();
