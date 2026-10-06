'use strict';

// Spectrogram: the music as a heat map flowing across the screen, time from
// right to left, pitch from the bottom (30 Hz) to the top (16 kHz) on a log
// axis, how loud in colour. Every kick, note and cymbal leaves its mark: a
// bass line shows as a wandering line low down, a voice as a stack of
// harmonics, a hi-hat as a stripe up high. A faint grid marks the octaves
// (the C of each), labelled at the left.
//
// Its cogwheel: the colour map (inferno, magma, viridis, ice, grey), how fast
// it flows, the grid.
//
// WebGL (viz/gl.js): a ring of columns in a texture, one written per step at
// a steady rate (its own sharper analysis: 256 bands), read back shifted so
// the newest stands at the right; the colour map in the shader.

(() => {
  const ROWS = 256;
  const COLS = 1024;
  const MIN_HZ = 30;
  const MAX_HZ = 16000;

  // Colour maps as stops (0..1 -> rgb), from matplotlib's perceptual ones.
  const MAPS = {
    inferno: [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]],
    magma: [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [252, 253, 191]],
    viridis: [[68, 1, 84], [70, 50, 127], [54, 92, 141], [39, 127, 142], [31, 161, 135], [74, 194, 109], [159, 218, 58], [253, 231, 37]],
    ice: [[0, 0, 0], [8, 18, 60], [20, 50, 130], [30, 100, 190], [60, 160, 230], [130, 210, 250], [200, 240, 255], [255, 255, 255]],
    grey: [[0, 0, 0], [36, 36, 36], [72, 72, 72], [109, 109, 109], [145, 145, 145], [182, 182, 182], [218, 218, 218], [255, 255, 255]],
  };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D columns;
    uniform sampler2D map;
    uniform vec2 res;
    uniform float head, grid, octaves;
    out vec4 o;
    void main() {
      // The newest column at the right edge.
      float x = fract(head - (1.0 - uv.x));
      float v = texture(columns, vec2(x, uv.y)).r;
      vec3 col = texture(map, vec2(v * 0.98 + 0.01, 0.5)).rgb;
      // The octaves' lines, faint.
      if (grid > 0.0) {
        float oct = uv.y * octaves;
        float d = abs(fract(oct + OFFSET) - 0.5);
        float line = 1.0 - smoothstep(0.0, fwidth(oct) * 1.2, 0.5 - d);
        col = mix(col, vec3(1.0), line * 0.18 * grid);
      }
      o = vec4(col, 1.0);
    }`;

  class Spectrogram {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      // The octave lines sit on the Cs: C1 is 32.7 Hz.
      const octaves = Math.log2(MAX_HZ / MIN_HZ);
      const offset = 0.5 - (Math.log2(32.703 / MIN_HZ) % 1);
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS.replace('OFFSET', offset.toFixed(5)));
      this.octaves = octaves;
      this.spec = Equalizer.active
        ? new Spectrum.Analyser({ sampleRate: Equalizer.ctx.sampleRate, bars: ROWS, minHz: MIN_HZ, maxHz: MAX_HZ, windowSeconds: 0.046, hop: 128, spread: 0.7 })
        : null;
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, COLS, ROWS, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(COLS * ROWS));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.mapTex = gl.createTexture();
      this.mapFor = null;
      this.column = new Uint8Array(ROWS);
      this.head = 0;
      this.owed = 0;
      this.labels = this._labels(canvas);
      this.w = 1;
      this.h = 1;
    }

    /** The octaves' names at the left edge (C1 .. C9), as page text over the canvas. */
    _labels(canvas) {
      const box = h('div.viz-spec');
      for (let n = 1; n <= 9; n += 1) {
        const hz = 32.703 * 2 ** (n - 1);
        if (hz < MIN_HZ || hz > MAX_HZ) continue;
        const y = Math.log2(hz / MIN_HZ) / Math.log2(MAX_HZ / MIN_HZ);
        const label = h('span.viz-spec__label', `C${n}`);
        label.style.bottom = `${y * 100}%`;
        box.appendChild(label);
      }
      canvas.parentNode.insertBefore(box, canvas.nextSibling);
      return box;
    }

    size(w, h) {
      this.w = w;
      this.h = h;
    }

    destroy() {
      this.labels.remove();
      VizGL.lose(this.gl);
    }

    _map(name) {
      if (this.mapFor === name) return;
      this.mapFor = name;
      const stops = MAPS[name] || MAPS.inferno;
      const px = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i += 1) {
        const f = (i / 255) * (stops.length - 1);
        const lo = Math.floor(f);
        const hi = Math.min(stops.length - 1, lo + 1);
        const t = f - lo;
        for (let c = 0; c < 3; c += 1) px[i * 4 + c] = Math.round(stops[lo][c] + (stops[hi][c] - stops[lo][c]) * t);
        px[i * 4 + 3] = 255;
      }
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this._map(set('sgColors'));
      // Columns at a steady rate: the whole width is about 9 s at 100%.
      const rate = (COLS / 9) * (set('sgSpeed') / 100);
      if (!a.playing) this.peak = undefined;
      this.owed = Math.min(8, this.owed + dt * rate);
      if (this.owed >= 1 && this.spec) {
        const db = a.playing ? this.spec.analyse(a.samples) : null;
        // The scale follows the song: 60 dB down from its loudest of late
        // (sinking 2 dB a second), so a quiet song shows as much as a loud one.
        if (db) {
          let top = -120;
          for (let i = 0; i < ROWS; i += 1) top = Math.max(top, db[i] + (8 * i) / (ROWS - 1));
          this.peak = Math.max(top, (this.peak ?? top) - dt * 2);
        }
        for (let i = 0; i < ROWS; i += 1) {
          const v = db ? Spectrum.unit(db[i] + (8 * i) / (ROWS - 1), this.peak - 60, this.peak + 1) : 0;
          this.column[i] = Math.round(v ** 1.6 * 255);
        }
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        // The same column for each step owed (a slow frame), so it stays even.
        while (this.owed >= 1) {
          this.owed -= 1;
          const x = Math.floor(this.head * COLS) % COLS;
          gl.texSubImage2D(gl.TEXTURE_2D, 0, x, 0, 1, ROWS, gl.RED, gl.UNSIGNED_BYTE, this.column);
          this.head = (this.head + 1 / COLS) % 1;
        }
      }
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.columns, this.tex, 0);
      VizGL.bind(gl, u.map, this.mapTex, 1);
      gl.uniform2f(u.res, this.w, this.h);
      // The last column written ends at head; its middle is half a column before.
      gl.uniform1f(u.head, this.head - 0.5 / COLS);
      const grid = set('sgGrid') ? 1 : 0;
      gl.uniform1f(u.grid, grid);
      gl.uniform1f(u.octaves, this.octaves);
      this.labels.hidden = !grid;
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'spectrogram',
    name: 'Spectrogram',
    desc: 'The music as a heat map flowing past: pitch up the screen, time across, every kick, note and cymbal leaving its mark',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M6 17h3M11 17h2M15 17h3M6 13h2M10 13h5M7 9h2M13 9h3M9 6h1"/></svg>',
    gl: true,
    create: (canvas) => new Spectrogram(canvas),
    options: [
      { type: 'choice', key: 'sgColors', label: 'Colors', choices: [['inferno', 'Inferno'], ['magma', 'Magma'], ['viridis', 'Viridis'], ['ice', 'Ice'], ['grey', 'Grey']] },
      { type: 'slider', key: 'sgSpeed', label: 'Speed', min: 25, max: 300, step: 5 },
      { type: 'check', key: 'sgGrid', label: 'Octaves' },
    ],
  });
})();
