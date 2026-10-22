'use strict';

// Ridges: in the manner of Joy Division's Unknown Pleasures. The music of the
// last few seconds as a stack of lines, the newest at the front, each a
// ridge of the spectrum (low to high across the middle, flat out at the
// edges) or of the waveform, every one hiding what lies
// behind it, flowing away into the distance.
//
// Its cogwheel: the colours (white on black, neon, heat, its own), how many lines,
// how fast they flow, and what they show.
//
// WebGL (viz/gl.js): each line is a black band filled down from it, then
// the line itself, drawn from the back to the front in one go.

(() => {
  const POINTS = 120;
  const TAIL = 12;          // pieces of each line's smooth fade out to the screen's edge
  const BLACK = [0, 0, 0];

  function hsv(h, s, v) {
    const f = (n) => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }

  class Ridges {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.lines = VizGL.lines(gl, 260000);
      this.rows = [];        // newest first: Float32Array(POINTS) of 0..1
      this.offset = 0;       // 0..1 of the way to the next row
      this.age = 0;
      // How each point leans on the middle: flat at the edges, as on the record's sleeve.
      this.envelope = new Float32Array(POINTS);
      this.jitter = new Float32Array(POINTS);
      for (let i = 0; i < POINTS; i += 1) {
        const x = (i / (POINTS - 1)) * 2 - 1;
        this.envelope[i] = Math.exp(-((x / 0.42) ** 4));
      }
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

    /** A new row from the music now. */
    _row(a) {
      const row = new Float32Array(POINTS);
      const source = Visualizer.setting('rdSource');
      if (source === 'wave') {
        const wave = a.lowWave(POINTS);
        for (let i = 0; i < POINTS; i += 1) row[i] = Math.max(0, (wave[i] * 0.5 + 0.5) * this.envelope[i] * a.level * 1.6);
      } else {
        // The spectrum across the middle, low to high, flat out at the edges.
        const bands = a.dynamic;
        const n = bands.length;
        for (let i = 0; i < POINTS; i += 1) {
          const x = (i / (POINTS - 1)) * 2 - 1;
          const f = Math.max(0, Math.min(n - 1, ((x + 0.75) / 1.5) * n * 0.82));
          const lo = Math.floor(f);
          const v = bands[lo] * (1 - (f - lo)) + bands[Math.min(n - 1, lo + 1)] * (f - lo);
          row[i] = v * v * this.envelope[i];
        }
      }
      // A little roughness, as on the sleeve; none where it is silent.
      for (let i = 0; i < POINTS; i += 1) row[i] += (Math.random() - 0.5) * 0.025 * this.envelope[i] * (a.playing ? 1 : 0.3);
      // Smoothed a touch, so a single band does not stand up as a spike.
      const out = new Float32Array(POINTS);
      for (let i = 0; i < POINTS; i += 1) out[i] = 0.25 * row[Math.max(0, i - 1)] + 0.5 * row[i] + 0.25 * row[Math.min(POINTS - 1, i + 1)];
      return out;
    }

    // A row's two parts, each a method of its own (rather than in frame(),
    // or a closure made for every row) so that lines' seg and tri are
    // inlined into them: their numbers then go in without being boxed.

    /** A row's tail from (xa, ya) flat out to xb, fading away. */
    _tail(xa, ya, xb, thick, col, alpha) {
      const lines = this.lines;
      for (let s = 0; s < TAIL; s += 1) {
        const t0 = s / TAIL;
        const t1 = (s + 1) / TAIL;
        lines.seg(xa + (xb - xa) * t0, ya, xa + (xb - xa) * t1, ya, thick, col, alpha * (1 - t0) ** 2, alpha * (1 - t1) ** 2);
      }
    }

    /** A row's line, the band below it hiding the rows behind; heat: the colour to fill by the level (Heat), else rgb. */
    _line(row, x0, y0, width, amp, unit, thick, alpha, rgb, heat) {
      const lines = this.lines;
      let px = 0;
      let py = 0;
      for (let i = 0; i < POINTS; i += 1) {
        const x = x0 + (i / (POINTS - 1)) * width;
        const y = y0 - row[i] * amp;
        if (i) {
          lines.tri(px, py, x, y, px, y0 + 3 * unit, BLACK, 1);
          lines.tri(x, y, x, y0 + 3 * unit, px, y0 + 3 * unit, BLACK, 1);
          let col = rgb;
          if (heat) {
            const t = Math.min(1, (row[i] + row[i - 1]) * 0.9);
            heat[0] = Math.min(1, 0.35 + t * 1.6);
            heat[1] = Math.min(1, t * 1.2);
            heat[2] = Math.min(1, t * t * 1.4);
            col = heat;
          }
          lines.seg(px, py, x, y, thick, col, alpha);
        }
        px = x;
        py = y;
      }
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      const count = set('rdRows');
      const speed = set('rdSpeed') / 100;
      // About 22 new rows a second at 100% and 120 BPM (with the tempo's
      // pace); while paused it flows on slowly.
      this.offset += dt * 22 * speed * (a.playing ? a.pace : 0.15);
      if (!this.rows.length) this.rows.unshift(this._row(a));
      while (this.offset >= 1) {
        this.offset -= 1;
        this.rows.unshift(this._row(a));
      }
      if (this.rows.length > count + 2) this.rows.length = count + 2;

      const gl = this.gl;
      const w = this.w;
      const h = this.h;
      const colors = set('rdColor');
      const own = VizGL.rgb(set('rdOwnColor'));
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const unit = h / 1080;
      const front = h * 0.9;
      const back = h * 0.14;
      const lines = this.lines;
      // The colours handed to lines (which copies them): the same arrays every time.
      const WHITE = [1, 1, 1];
      const EMBER = [0.35, 0, 0];
      const heat = [0, 0, 0];
      // From the back to the front; each row's place eases forward between new rows.
      for (let r = Math.min(this.rows.length, count + 1) - 1; r >= 0; r -= 1) {
        const pos = (r + this.offset) / count;   // 0 front, 1 back
        if (pos > 1) continue;
        const depth = pos;
        const scale = 1 / (1 + depth * 0.3);
        const y0 = front - (front - back) * (1 - (1 - depth) ** 1.15);
        const width = Math.min(w * 0.825, h * 1.26) * scale;
        const x0 = (w - width) / 2;
        const amp = h * 0.22 * scale;
        const row = this.rows[r];
        // Fading in at the back, so rows appear rather than pop.
        const fade = Math.min(1, (1 - pos) * 6);
        let rgb;
        if (colors === 'neon') rgb = hsv((0.52 + depth * 0.35 + this.age * 0.01) % 1, 0.8, 1);
        else if (colors === 'custom') rgb = own;
        else rgb = WHITE;
        const thick = 1.6 * unit * (0.6 + 0.4 * scale);
        const alpha = fade * (0.55 + 0.45 * scale);
        // Flat on out to the screen's edges either side, fading away.
        const tailCol = colors === 'heat' ? EMBER : rgb;
        this._tail(x0, y0 - row[0] * amp, 0, thick, tailCol, alpha);
        this._tail(x0 + width, y0 - row[POINTS - 1] * amp, w, thick, tailCol, alpha);
        this._line(row, x0, y0, width, amp, unit, thick, alpha, rgb, colors === 'heat' ? heat : null);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      lines.draw(w, h);
      gl.disable(gl.BLEND);
    }
  }

  Visualizer.add({
    id: 'ridges',
    name: 'Ridges',
    desc: 'In the manner of Unknown Pleasures: the last few seconds of the music as ridgelines flowing away, each hiding those behind',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h5l2-3 2 4 2-2h7M3 13h5l1-2 2 5 2-6 2 3h6M3 18h5l2-1 2 3 2-3 2 1h5"/></svg>',
    gl: true,
    create: (canvas) => new Ridges(canvas),
    options: [
      { type: 'choice', key: 'rdColor', label: 'Colors', choices: [['white', 'White'], ['neon', 'Neon'], ['heat', 'Heat']], color: { value: 'custom', key: 'rdOwnColor', presets: Visualizer.OWN_PRESETS } },
      { type: 'slider', key: 'rdRows', label: 'Lines', min: 20, max: 120, step: 5, unit: '' },
      { type: 'slider', key: 'rdSpeed', label: 'Speed', min: 25, max: 200, step: 5 },
      { type: 'choice', key: 'rdSource', label: 'Shows', choices: [['spectrum', 'Spectrum'], ['wave', 'Waveform']] },
    ],
  });
})();
