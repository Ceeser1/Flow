'use strict';

// Demo: in the manner of the Amiga and C64 demos, at their low resolution,
// every pixel big. Behind, a plasma whose colours cycle faster with the music
// (or a starfield rushing out of the screen); over it copper bars, raster
// gradients bouncing on the beat, one for each part of the spectrum; and a
// sine scroller running the song's title and artist across, its wave the
// higher the louder.
//
// Its cogwheel: plasma or stars behind, the palette (Amiga, C64, neon), the
// copper bars, the scroller, CRT lines.
//
// Canvas 2D: everything at 180 lines into a small canvas (the plasma as
// pixels), then that onto the screen with no smoothing.

(() => {
  const LINES = 180;
  const C64 = ['#000000', '#352879', '#6c5eb5', '#40318d', '#588d43', '#9ad284', '#b8c76f', '#6f4f25', '#433900', '#9a6759', '#68372b', '#70a4b2', '#444444', '#6c6c6c', '#959595', '#ffffff'];

  function hsl(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h * 12) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  }

  /** 256 colours as ABGR words for the plasma. */
  function palette(kind) {
    const out = new Uint32Array(256);
    const pack = ([r, g, b]) => (255 << 24) | (b << 16) | (g << 8) | r;
    for (let i = 0; i < 256; i += 1) {
      const t = i / 256;
      let rgb;
      if (kind === 'c64') {
        const hex = C64[[6, 14, 3, 1, 2, 4, 10, 8, 7, 15, 13, 5, 11, 12, 9, 0][Math.floor(t * 16)]];
        rgb = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      } else if (kind === 'neon') {
        rgb = hsl((0.75 + 0.5 * Math.sin(t * Math.PI * 2) * 0.5 + t * 0.3) % 1, 1, 0.35 + 0.2 * Math.sin(t * Math.PI * 6));
      } else {
        // The Amiga's: smooth bands round the colour wheel.
        rgb = hsl(t, 0.85, 0.3 + 0.22 * (0.5 + 0.5 * Math.sin(t * Math.PI * 4)));
      }
      out[i] = pack(rgb);
    }
    return out;
  }

  const GLYPH = 16;

  /** A crisp 1-bit font: each glyph drawn once in a 16 x 16 cell and read back, on or off. */
  function font() {
    const chars = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`';
    const c = document.createElement('canvas');
    c.width = chars.length * GLYPH;
    c.height = GLYPH;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px "Consolas", "Courier New", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let i = 0; i < chars.length; i += 1) ctx.fillText(chars[i], i * GLYPH + GLYPH / 2, GLYPH / 2 + 1);
    const img = ctx.getImageData(0, 0, c.width, GLYPH);
    for (let i = 0; i < img.data.length; i += 4) {
      const on = img.data[i + 3] > 120;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = on ? 255 : 0;
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: c, chars };
  }

  class Demo {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.low = document.createElement('canvas');
      this.lctx = this.low.getContext('2d');
      this.font = font();
      this.paletteFor = null;
      this.sin = new Float32Array(1024);
      for (let i = 0; i < 1024; i += 1) this.sin[i] = Math.sin((i / 1024) * Math.PI * 2);
      this.t = 0;
      this.cycle = 0;
      this.scroll = 0;
      this.text = '';
      this.textFor = null;
      this.stars = Array.from({ length: 220 }, () => this._star({}));
      this.bars = [0, 1, 2, 3, 4].map((i) => ({ phase: i * 1.1, level: 0 }));
      this.age = 0;
    }

    _star(s) {
      s.x = (Math.random() - 0.5) * 2;
      s.y = (Math.random() - 0.5) * 2;
      s.z = 0.1 + Math.random();
      return s;
    }

    size(w, h) {
      this.w = w;
      this.h = h;
      this.lh = LINES;
      this.lw = Math.round((LINES * w) / h);
      this.low.width = this.lw;
      this.low.height = this.lh;
      this.image = this.lctx.createImageData(this.lw, this.lh);
      this.pixels = new Uint32Array(this.image.data.buffer);
      this.scan = null;
    }

    destroy() {}

    _sinAt(x) {
      return this.sin[(Math.floor(x * 162.97) % 1024 + 1024) % 1024];
    }

    /** What the scroller says: the song playing, or Flow. */
    _message() {
      const id = Player.currentId;
      if (this.textFor === id) return this.text;
      this.textFor = id;
      const song = id ? Store.song(id) || (Player.remote ? Player.remote.state : null) : null;
      const now = song ? `NOW PLAYING: ${song.title || 'UNTITLED'}${song.artist ? ` BY ${song.artist}` : ''}` : 'FLOW';
      this.text = `${now} *** FLOW MUSIC VISUALIZER *** GREETINGS TO EVERYONE STILL LISTENING ***     `.toUpperCase().replace(/[^ -`]/g, '?');
      return this.text;
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      const lw = this.lw;
      const lh = this.lh;
      const ctx = this.lctx;
      const pal = set('dmPalette');
      if (this.paletteFor !== pal) {
        this.paletteFor = pal;
        this.colors = palette(pal);
      }
      this.t += dt * (0.6 + 1.4 * a.level) * (a.playing ? 1 : 0.3);
      this.cycle = (this.cycle + dt * (30 + 160 * a.kick + 60 * a.intensity) * (a.playing ? 1 : 0.2)) % 256;

      if (set('dmBack') === 'stars') {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, lw, lh);
        for (const s of this.stars) {
          s.z -= dt * (0.25 + 1.2 * a.kick + 0.5 * a.level);
          if (s.z <= 0.05) this._star(s).z = 1.1;
          const x = Math.round(lw / 2 + (s.x / s.z) * lh * 0.5);
          const y = Math.round(lh / 2 + (s.y / s.z) * lh * 0.5);
          if (x < 0 || y < 0 || x >= lw || y >= lh) {
            this._star(s).z = 1.1;
            continue;
          }
          const b = Math.min(255, Math.round((1.15 - s.z) * 255));
          ctx.fillStyle = `rgb(${b}, ${b}, ${b})`;
          ctx.fillRect(x, y, s.z < 0.4 ? 2 : 1, s.z < 0.4 ? 2 : 1);
        }
      } else {
        // The plasma: four waves summed, its colours cycling.
        const px = this.pixels;
        const colors = this.colors;
        const t = this.t;
        const cx = lw / 2 + this._sinAt(t * 0.3) * lw * 0.3;
        const cy = lh / 2 + this._sinAt(t * 0.23 + 1) * lh * 0.3;
        const cycle = this.cycle;
        const zoom = 1 + 0.25 * a.bass;
        for (let y = 0; y < lh; y += 1) {
          const wy = this._sinAt((y * 0.045) / zoom - t * 0.7);
          for (let x = 0; x < lw; x += 1) {
            const dx = x - cx;
            const dy = y - cy;
            const v = this._sinAt((x * 0.06) / zoom + t) + wy + this._sinAt(((x + y) * 0.035) / zoom + t * 0.5)
              + this._sinAt((Math.sqrt(dx * dx + dy * dy) * 0.07) / zoom - t * 1.3);
            px[y * lw + x] = colors[(Math.floor((v + 4) * 32) + cycle) & 255];
          }
        }
        ctx.putImageData(this.image, 0, 0);
      }

      // The copper bars: one for each part of the spectrum, bouncing on the beat.
      if (set('dmCopper')) {
        const parts = [a.bass, (a.bass + a.mid) / 2, a.mid, (a.mid + a.treble) / 2, a.treble];
        this.bars.forEach((bar, i) => {
          bar.level += (parts[i] - bar.level) * Math.min(1, dt * 10);
          const y = lh * (0.5 + 0.38 * Math.sin(this.age * (1.1 + i * 0.17) + bar.phase)) - (a.kick * 10 * (i === 0 ? 1 : 0.4));
          const half = Math.round(2 + 4 * bar.level);
          const hue = (i / 5 + this.age * 0.02) % 1;
          for (let k = -half; k <= half; k += 1) {
            const l = 0.15 + 0.6 * (1 - Math.abs(k) / half);
            const [r, g, b] = hsl(hue, 1, l);
            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.fillRect(0, Math.round(y + k), lw, 1);
          }
        });
      }

      // The sine scroller.
      if (set('dmScroller')) {
        const text = this._message();
        const cell = GLYPH;
        const speed = 60 + 50 * a.level;
        this.scroll = (this.scroll + dt * speed * (a.playing ? 1 : 0.5)) % (text.length * cell);
        const base = lh * 0.72;
        const amp = 5 + 12 * a.mid + 5 * a.kick;
        const first = Math.floor(this.scroll / cell);
        const shift = this.scroll % cell;
        const glyphs = this.font;
        ctx.imageSmoothingEnabled = false;
        for (let i = 0; i <= Math.ceil(lw / cell) + 1; i += 1) {
          const ch = text[(first + i) % text.length];
          const k = glyphs.chars.indexOf(ch);
          if (k < 1) continue;
          const x = Math.round(i * cell - shift);
          const y = Math.round(base + Math.sin(x * 0.03 + this.age * 3) * amp);
          ctx.globalAlpha = 0.6;
          ctx.drawImage(glyphs.canvas, k * cell, 0, cell, cell, x + 1, y + 1, cell, cell);
          ctx.globalAlpha = 1;
          ctx.drawImage(glyphs.canvas, k * cell, 0, cell, cell, x, y, cell, cell);
        }
      }

      // Onto the screen, every pixel big.
      const out = this.ctx;
      out.imageSmoothingEnabled = false;
      out.drawImage(this.low, 0, 0, this.w, this.h);
      if (set('dmCrt')) {
        if (!this.scan) {
          const c = document.createElement('canvas');
          const step = Math.max(2, Math.round(this.h / lh));
          c.width = 1;
          c.height = step;
          const g = c.getContext('2d');
          g.fillStyle = 'rgba(0, 0, 0, 0.35)';
          g.fillRect(0, step - Math.max(1, Math.round(step / 3)), 1, Math.max(1, Math.round(step / 3)));
          this.scan = out.createPattern(c, 'repeat');
        }
        out.fillStyle = this.scan;
        out.fillRect(0, 0, this.w, this.h);
        const vignette = out.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.4, this.w / 2, this.h / 2, this.h);
        vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
        vignette.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
        out.fillStyle = vignette;
        out.fillRect(0, 0, this.w, this.h);
      }
    }
  }

  Visualizer.add({
    id: 'demo',
    name: 'Demo',
    desc: 'In the manner of the Amiga and C64 demos: a plasma, copper bars bouncing on the beat and a sine scroller with the song',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="square"><path d="M3 7h18M3 11h18M3 15h18"/><path d="M5 19l2-2 2 2 2-2 2 2 2-2 2 2 2-2"/></svg>',
    create: (canvas) => new Demo(canvas),
    options: [
      { type: 'choice', key: 'dmBack', label: 'Behind', choices: [['plasma', 'Plasma'], ['stars', 'Stars']] },
      { type: 'choice', key: 'dmPalette', label: 'Palette', choices: [['amiga', 'Amiga'], ['c64', 'C64'], ['neon', 'Neon']], when: (s) => s.dmBack !== 'stars' },
      { type: 'check', key: 'dmCopper', label: 'Copper bars' },
      { type: 'check', key: 'dmScroller', label: 'Scroller' },
      { type: 'check', key: 'dmCrt', label: 'CRT' },
    ],
  });
})();
