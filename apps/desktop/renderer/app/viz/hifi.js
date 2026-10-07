'use strict';

// Hi-Fi: an 80s stereo rack between walnut cheeks, four units high. At the
// top a processor whose fluorescent display (VFD) runs the song's title in
// dots, the time played, the tempo and the key, and a level bar for each
// channel; under it a spectrum analyser of 31 LED columns, green, yellow and
// red, the peaks hanging a moment; then the amplifier with two backlit VU
// meters, their needles swinging with the left and the right channel as a
// real meter's do (a little overshoot, a slow fall), the volume knob where
// the player's volume is; at the bottom a double cassette deck, the tape on
// deck A turning from the left reel onto the right one as the song goes on
// (winding fast when you skip), its counter rolling.
//
// Its cogwheel: the faceplates' finish, the display's colour, the meters'
// light, the analyser's peaks.
//
// Canvas 2D: the rack is drawn once per size into a canvas of its own;
// each frame that, then the needles and the reels, then whatever glows on a
// layer of its own that is also drawn back small and blurred for the glow.

(() => {
  const VFD = { teal: [111, 247, 228], amber: [255, 170, 64], blue: [130, 196, 255], green: [150, 255, 120] };
  const METER = {
    amber: { mid: '#ffd98c', edge: '#b87a2e', ink: '#2a1a08' },
    white: { mid: '#fbf7ea', edge: '#b3ab98', ink: '#1d1d1d' },
    blue: { mid: '#b4e2ff', edge: '#3a74ab', ink: '#071d33' },
  };
  const FINISH = {
    silver: { top: '#dcdde0', bottom: '#a4a6ab', ink: '#26272a', soft: 'rgba(30, 30, 34, 0.6)', brush: 0.1, edge: '#f6f7f9', dark: '#6b6d72' },
    black: { top: '#2c2d31', bottom: '#141518', ink: '#c9cacf', soft: 'rgba(205, 205, 212, 0.55)', brush: 0.05, edge: '#4c4d52', dark: '#050506' },
  };
  const LED = { green: '#41ff6c', yellow: '#ffe04a', red: '#ff3a32' };
  const UI = '"Segoe UI", Arial, sans-serif';
  const HAND = '"Ink Free", "Segoe Print", "Comic Sans MS", cursive';
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // A 5 x 7 dot font: each glyph seven rows top down, each row a base-32
  // digit whose five bits are its dots, the leftmost the highest.
  const FONT = {};
  ('A:ehhvhhh B:uhhuhhu C:ehggghe D:sihhhis E:vgguggv F:vgguggg G:ehgnhhf H:hhhvhhh I:e44444e J:72222ic '
    + 'K:hikokih L:ggggggv M:hrllhhh N:hhpljhh O:ehhhhhe P:uhhuggg Q:ehhhlid R:uhhukih S:fgge11u T:v444444 '
    + 'U:hhhhhhe V:hhhhha4 W:hhhllla X:hha4ahh Y:hha4444 Z:v1248gv 0:ehjlphe 1:4c4444e 2:eh1248v 3:v2421he '
    + '4:26aiv22 5:vgu11he 6:68guhhe 7:v124888 8:ehhehhe 9:ehhf12c -:000v000 .:00000cc ,:0000c48 ::0cc0cc0 '
    + "':c480000 !:4444404 ?:eh12404 &:cik8lid (:2488842 ):8422248 /:01248g0 #:aavavaa +:044v440 \":aa00000 "
    + '_:000000v *:04lel40 %:op248j3 =:00v0v00 [:e88888e ]:e22222e')
    .split(' ').forEach((entry) => {
      const ch = entry[0];
      const rows = entry.slice(2);
      FONT[ch] = [...rows].map((d) => parseInt(d, 32));
    });
  FONT[' '] = [0, 0, 0, 0, 0, 0, 0];

  /** Text the dot font can show: upper case, accents dropped, the rest '?'. */
  function dotText(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'SS').toUpperCase()
      .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .split('').map((c) => (FONT[c] ? c : '?')).join('');
  }

  // Seven segments: a top, b top right, c bottom right, d bottom, e bottom
  // left, f top left, g the middle.
  const SEG = {
    0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '',
  };

  /** Seven-segment digit `ch` in the box x, y, w, h, slanted; only the segments lit (all for a ghost '8'). */
  function seg7(g, x, y, w, h, ch) {
    const on = SEG[ch] || '';
    const t = Math.max(1.5, w * 0.17);
    const gap = t * 0.18;
    const slant = 0.1;
    const P = {
      a: [[0, 0], [w, 0]], g: [[0, h / 2], [w, h / 2]], d: [[0, h], [w, h]],
      f: [[0, 0], [0, h / 2]], b: [[w, 0], [w, h / 2]], e: [[0, h / 2], [0, h]], c: [[w, h / 2], [w, h]],
    };
    g.beginPath();
    for (const s of on) {
      const [[x0, y0], [x1, y1]] = P[s];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const ux = (x1 - x0) / len;
      const uy = (y1 - y0) / len;
      const nx = -uy * t / 2;
      const ny = ux * t / 2;
      const pts = [
        [x0 + ux * gap, y0 + uy * gap],
        [x0 + ux * (gap + t / 2) + nx, y0 + uy * (gap + t / 2) + ny],
        [x1 - ux * (gap + t / 2) + nx, y1 - uy * (gap + t / 2) + ny],
        [x1 - ux * gap, y1 - uy * gap],
        [x1 - ux * (gap + t / 2) - nx, y1 - uy * (gap + t / 2) - ny],
        [x0 + ux * (gap + t / 2) - nx, y0 + uy * (gap + t / 2) - ny],
      ];
      pts.forEach(([px, py], i) => {
        const sx = x + px + (h - py) * slant;
        const sy = y + py;
        if (i) g.lineTo(sx, sy);
        else g.moveTo(sx, sy);
      });
      g.closePath();
    }
    g.fill();
  }

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;

  /** The VU scale: where `vu` dB sits, 0..1 across the meter (a real one's goes by voltage). */
  function vuPos(vu) {
    const p = (v) => 10 ** (v / 20) / 10 ** (3 / 20);
    return (p(vu) - p(-20)) / (1 - p(-20));
  }

  class HiFi {
    constructor(cv) {
      this.canvas = cv;
      this.ctx = cv.getContext('2d');
      this.w = 1;
      this.h = 1;
      this.builtFor = '';
      this.age = 0;
      this.cols = new Float32Array(31);
      this.peaks = new Float32Array(31);
      this.hold = new Float32Array(31);
      this.needle = [{ x: 0, v: 0 }, { x: 0, v: 0 }];
      this.ref = -14;      // dB the loud parts of the song reach lately: 0 VU sits a little under
      this.bar = [0, 0];
      this.barPeak = [0, 0];
      this.barHold = [0, 0];
      this.reel = [0, 0];
      this.lastPos = null;
      this.wind = 0;       // fast winding after a skip: seconds left, its sign the direction
      this.spin = 0;       // the tape's speed, easing to a stop when paused
      this.strips = new Map();
    }

    size(w, h) {
      this.w = w;
      this.h = h;
      this.lit = canvas(w, h);
      this.lctx = this.lit.getContext('2d');
      this.s1 = canvas(w / 4, h / 4);
      this.s2 = canvas(w / 16, h / 16);
      this.builtFor = '';
    }

    destroy() {}

    // ---- the rack, drawn once -------------------------------------------

    _layout() {
      const { w, h } = this;
      let RH = h * 0.94;
      let RW = Math.min(w * 0.95, RH * 1.55);
      RH = Math.min(RH, RW / 1.15);
      RW = Math.min(RW, RH * 1.55);
      const x0 = (w - RW) / 2;
      const y0 = (h - RH) / 2;
      const cheek = RW * 0.032;
      const gap = RH * 0.012;
      const ix = x0 + cheek;
      const iw = RW - cheek * 2;
      const share = [0.2, 0.245, 0.31, 0.245];
      const free = RH - gap * 5;
      let y = y0 + gap;
      const units = share.map((s) => {
        const u = { x: ix, y, w: iw, h: free * s };
        y += u.h + gap;
        return u;
      });
      const base = RH / 100;
      return { x0, y0, RW, RH, cheek, gap, units, base };
    }

    _build(finish, vfdColor, meterKind) {
      const L = this._layout();
      this.L = L;
      const F = FINISH[finish] || FINISH.silver;
      this.F = F;
      const c = canvas(this.w, this.h);
      const g = c.getContext('2d');
      this.static = c;

      // The room: dark, a soft light on the rack.
      const bg = g.createRadialGradient(this.w / 2, this.h * 0.45, 0, this.w / 2, this.h * 0.45, Math.max(this.w, this.h) * 0.75);
      bg.addColorStop(0, '#2a2420');
      bg.addColorStop(1, '#070605');
      g.fillStyle = bg;
      g.fillRect(0, 0, this.w, this.h);

      // The rack's back and its walnut cheeks.
      g.fillStyle = '#0b0a09';
      g.fillRect(L.x0, L.y0, L.RW, L.RH);
      for (const side of [0, 1]) {
        const x = side ? L.x0 + L.RW - L.cheek : L.x0;
        const wood = g.createLinearGradient(x, 0, x + L.cheek, 0);
        wood.addColorStop(0, side ? '#4a2a17' : '#2a160b');
        wood.addColorStop(0.5, '#6b3d21');
        wood.addColorStop(1, side ? '#2a160b' : '#4a2a17');
        g.fillStyle = wood;
        g.fillRect(x, L.y0 - L.gap, L.cheek, L.RH + L.gap * 2);
        // Grain: long wavy streaks.
        g.save();
        g.beginPath();
        g.rect(x, L.y0 - L.gap, L.cheek, L.RH + L.gap * 2);
        g.clip();
        let s = 7 + side * 13;
        const rnd = () => {
          s = (s * 16807) % 2147483647;
          return s / 2147483647;
        };
        for (let k = 0; k < 26; k += 1) {
          const gx = x + rnd() * L.cheek;
          g.strokeStyle = rnd() < 0.5 ? 'rgba(20, 8, 2, 0.35)' : 'rgba(150, 90, 50, 0.18)';
          g.lineWidth = 0.6 + rnd() * 1.6;
          g.beginPath();
          const amp = L.cheek * (0.04 + rnd() * 0.12);
          const per = L.RH * (0.15 + rnd() * 0.4);
          const ph = rnd() * 6.28;
          for (let yy = L.y0 - L.gap; yy <= L.y0 + L.RH + L.gap; yy += 12) {
            const xx = gx + Math.sin(yy / per * 6.28 + ph) * amp;
            if (yy === L.y0 - L.gap) g.moveTo(xx, yy);
            else g.lineTo(xx, yy);
          }
          g.stroke();
        }
        g.restore();
      }

      const [A, B, C, D] = L.units;
      for (const u of L.units) this._plate(g, u);
      this._displayUnit(g, A, VFD[vfdColor] || VFD.teal);
      this._analyserUnit(g, B);
      this._ampUnit(g, C, METER[meterKind] || METER.amber);
      this._deckUnit(g, D);
    }

    /** Brushed-metal stripes, once per finish: a pattern to lay over the plates. */
    _brush() {
      const c = canvas(512, 96);
      const g = c.getContext('2d');
      let s = 99;
      const rnd = () => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647;
      };
      for (let i = 0; i < 1400; i += 1) {
        g.fillStyle = rnd() < 0.5 ? `rgba(255, 255, 255, ${rnd() * 0.5})` : `rgba(0, 0, 0, ${rnd() * 0.5})`;
        g.fillRect(rnd() * 512, Math.floor(rnd() * 96), 30 + rnd() * 300, 1);
      }
      return c;
    }

    /** A unit's faceplate: brushed metal, a bevel, the rack ears and their screws. */
    _plate(g, u) {
      const F = this.F;
      const grad = g.createLinearGradient(0, u.y, 0, u.y + u.h);
      grad.addColorStop(0, F.top);
      grad.addColorStop(1, F.bottom);
      g.fillStyle = grad;
      g.fillRect(u.x, u.y, u.w, u.h);
      g.save();
      g.globalAlpha = F.brush;
      this.brush = this.brush || this._brush();
      g.fillStyle = g.createPattern(this.brush, 'repeat');
      g.fillRect(u.x, u.y, u.w, u.h);
      g.restore();
      // Bevel: light along the top, dark along the bottom.
      g.fillStyle = F.edge;
      g.fillRect(u.x, u.y, u.w, Math.max(1, u.h * 0.012));
      g.fillStyle = F.dark;
      g.fillRect(u.x, u.y + u.h - Math.max(1, u.h * 0.015), u.w, Math.max(1, u.h * 0.015));
      // The ears' screws.
      const r = Math.max(2.5, u.h * 0.035);
      for (const sx of [u.x + u.w * 0.017, u.x + u.w * 0.983]) {
        for (const sy of [u.y + u.h * 0.2, u.y + u.h * 0.8]) this._screw(g, sx, sy, r);
      }
    }

    _screw(g, x, y, r) {
      const head = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
      head.addColorStop(0, '#f0f0f0');
      head.addColorStop(1, '#5d5f63');
      g.fillStyle = 'rgba(0, 0, 0, 0.45)';
      g.beginPath();
      g.arc(x + r * 0.15, y + r * 0.2, r * 1.1, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = head;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(30, 30, 30, 0.8)';
      g.lineWidth = Math.max(1, r * 0.25);
      g.beginPath();
      g.moveTo(x - r * 0.6, y - r * 0.25);
      g.lineTo(x + r * 0.6, y + r * 0.25);
      g.stroke();
    }

    /** Text on a plate, in the finish's ink. */
    _label(g, text, x, y, size, { align = 'center', weight = 600, color = null, spacing = 0.12, font = UI } = {}) {
      g.font = `${weight} ${size}px ${font}`;
      g.textAlign = align;
      g.textBaseline = 'middle';
      g.letterSpacing = `${size * spacing}px`;
      g.fillStyle = color || this.F.ink;
      g.fillText(text, x, y);
      g.letterSpacing = '0px';
    }

    /** A dark window set into a plate. */
    _window(g, x, y, w, h, r, fill = '#040606') {
      g.fillStyle = 'rgba(0, 0, 0, 0.5)';
      g.beginPath();
      g.roundRect(x - 2, y - 2, w + 4, h + 4, r + 2);
      g.fill();
      g.fillStyle = fill;
      g.beginPath();
      g.roundRect(x, y, w, h, r);
      g.fill();
      const shade = g.createLinearGradient(0, y, 0, y + h * 0.25);
      shade.addColorStop(0, 'rgba(0, 0, 0, 0.6)');
      shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
      g.fillStyle = shade;
      g.fill();
    }

    /** A knob of spun aluminium on a dark skirt; returns its geometry for the pointer. */
    _knob(g, x, y, r, angle = null) {
      g.fillStyle = 'rgba(0, 0, 0, 0.5)';
      g.beginPath();
      g.arc(x + r * 0.06, y + r * 0.12, r * 1.08, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#16171a';
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      // The knurled rim.
      g.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      g.lineWidth = Math.max(1, r * 0.03);
      g.beginPath();
      const n = Math.max(24, Math.round(r * 1.2));
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * Math.PI * 2;
        g.moveTo(x + Math.cos(a) * r * 0.82, y + Math.sin(a) * r * 0.82);
        g.lineTo(x + Math.cos(a) * r * 0.98, y + Math.sin(a) * r * 0.98);
      }
      g.stroke();
      const cap = g.createConicGradient(0.6, x, y);
      [['#f7f7f8', 0], ['#8f9196', 0.12], ['#e9eaec', 0.25], ['#7d7f84', 0.4], ['#f2f2f3', 0.55], ['#8a8c91', 0.7], ['#e4e5e7', 0.85], ['#f7f7f8', 1]]
        .forEach(([col, at]) => cap.addColorStop(at, col));
      g.fillStyle = cap;
      g.beginPath();
      g.arc(x, y, r * 0.78, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      g.lineWidth = 1;
      g.stroke();
      if (angle !== null) this._pointer(g, { x, y, r }, angle);
      return { x, y, r };
    }

    /** The line on a knob's cap, at angle (radians, 0 straight up). */
    _pointer(g, k, angle) {
      const s = Math.sin(angle);
      const c = -Math.cos(angle);
      g.strokeStyle = '#1c1c1e';
      g.lineWidth = Math.max(1.5, k.r * 0.08);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(k.x + s * k.r * 0.3, k.y + c * k.r * 0.3);
      g.lineTo(k.x + s * k.r * 0.7, k.y + c * k.r * 0.7);
      g.stroke();
      g.lineCap = 'butt';
    }

    /** A round LED, dark; lit later on the glow layer. */
    _ledSocket(g, x, y, r) {
      g.fillStyle = 'rgba(0, 0, 0, 0.55)';
      g.beginPath();
      g.arc(x, y, r * 1.35, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#2a1a18';
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }

    // The processor: logo, the display, two knobs.
    _displayUnit(g, u, col) {
      const b = this.L.base;
      this._label(g, 'FLOW', u.x + u.w * 0.1, u.y + u.h * 0.36, b * 3.6, { weight: '800 italic', spacing: 0.04 });
      this._label(g, 'DIGITAL AUDIO PROCESSOR', u.x + u.w * 0.1, u.y + u.h * 0.58, b * 0.95, { color: this.F.soft });
      this._label(g, 'DP-1986', u.x + u.w * 0.1, u.y + u.h * 0.72, b * 0.95, { color: this.F.soft });
      const v = { x: u.x + u.w * 0.19, y: u.y + u.h * 0.15, w: u.w * 0.66, h: u.h * 0.7 };
      this.vfd = v;
      this.vfdColor = col;
      this._window(g, v.x, v.y, v.w, v.h, b * 0.6, '#030807');
      const ghost = rgba(col, 0.07);

      // The dot-matrix line.
      const pitch = Math.max(2, Math.floor((v.h * 0.4) / 7));
      const chars = Math.floor((v.w * 0.6) / (pitch * 6));
      const tx = Math.round(v.x + v.w * 0.035);
      const ty = Math.round(v.y + v.h * 0.12);
      this.matrix = { x: tx, y: ty, pitch, cols: chars * 6 - 1, chars };
      g.fillStyle = ghost;
      const dot = Math.max(1, pitch * 0.78);
      for (let cx = 0; cx < chars * 6 - 1; cx += 1) {
        if (cx % 6 === 5) continue;
        for (let r = 0; r < 7; r += 1) g.fillRect(tx + cx * pitch, ty + r * pitch, dot, dot);
      }

      // The time: M M : S S.
      const dh = v.h * 0.42;
      const dw = dh * 0.52;
      const timeX = v.x + v.w * 0.97 - dw * 4.9;
      this.time = { x: timeX, y: v.y + v.h * 0.12, w: dw, h: dh };
      g.fillStyle = ghost;
      for (let i = 0; i < 4; i += 1) seg7(g, this._digitX(this.time, i), this.time.y, dw, dh, 8);
      this._colon(g, this.time);

      // The second line: level bars, the annunciators, the tempo and the key.
      const row = v.y + v.h * 0.66;
      const barW = v.w * 0.3;
      const segs = 32;
      this.bars = { x: v.x + v.w * 0.035 + pitch * 2, y: row, w: barW, h: v.h * 0.09, segs, gap: v.h * 0.04 };
      g.fillStyle = ghost;
      for (let ch = 0; ch < 2; ch += 1) {
        const by = row + ch * (this.bars.h + this.bars.gap);
        for (let i = 0; i < segs; i += 1) g.fillRect(this.bars.x + (i * barW) / segs, by, (barW / segs) * 0.7, this.bars.h);
        this.chLabel = { x: v.x + v.w * 0.035, size: v.h * 0.1 };
      }
      this.scale = { text: '-30    -20    -10     -5      0 dB', x: this.bars.x, y: row + this.bars.h * 2 + this.bars.gap + v.h * 0.07, size: v.h * 0.065 };
      const ann = v.h * 0.085;
      this.annunciators = [
        { key: 'play', text: '▶ PLAY', x: v.x + v.w * 0.42, y: row + v.h * 0.03 },
        { key: 'pause', text: '❙❙ PAUSE', x: v.x + v.w * 0.42, y: row + v.h * 0.15 },
        { key: 'stereo', text: 'STEREO', x: v.x + v.w * 0.51, y: row + v.h * 0.03 },
        { key: 'beat', text: '● BEAT', x: v.x + v.w * 0.51, y: row + v.h * 0.15 },
      ].map((a) => ({ ...a, size: ann }));
      for (const a of this.annunciators) this._vfdText(g, a.text, a.x, a.y, a.size, ghost, 'left');

      const bh = v.h * 0.2;
      const bw = bh * 0.52;
      this.bpm = { x: v.x + v.w * 0.62, y: row, w: bw, h: bh };
      g.fillStyle = ghost;
      for (let i = 0; i < 3; i += 1) seg7(g, this.bpm.x + i * bw * 1.45, row, bw, bh, 8);
      this.bpmLabel = { x: this.bpm.x + bw * 4.5, y: row + bh * 0.75, size: v.h * 0.08 };
      const kp = Math.max(1.5, Math.floor(bh / 7));
      this.keyM = { x: Math.round(v.x + v.w * 0.97 - kp * 6 * 6), y: Math.round(row), pitch: kp, chars: 6 };
      g.fillStyle = ghost;
      for (let cx = 0; cx < 6 * 6 - 1; cx += 1) {
        if (cx % 6 === 5) continue;
        for (let r = 0; r < 7; r += 1) g.fillRect(this.keyM.x + cx * kp, this.keyM.y + r * kp, kp * 0.78, kp * 0.78);
      }
      this.keyLabel = { x: this.keyM.x - kp * 1.5, y: row + bh * 0.75, size: v.h * 0.08 };

      // Glass over it all.
      const glass = g.createLinearGradient(v.x, v.y, v.x + v.w * 0.4, v.y + v.h);
      glass.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
      glass.addColorStop(0.5, 'rgba(255, 255, 255, 0.0)');
      this.vfdGlass = glass;

      // Two knobs on the right.
      const kr = u.h * 0.17;
      for (const [i, name] of [[0, 'DIMMER'], [1, 'MODE']]) {
        const kx = u.x + u.w * (0.895 + i * 0.055);
        this._knob(g, kx, u.y + u.h * 0.44, kr, -0.8 + i * 1.4);
        this._label(g, name, kx, u.y + u.h * 0.78, b * 0.85, { color: this.F.soft });
      }
    }

    _digitX(t, i) {
      return t.x + i * t.w * 1.38 + (i >= 2 ? t.w * 0.55 : 0);
    }

    _colon(g, t) {
      const x = t.x + t.w * 2.76 + t.w * 0.05;
      const r = t.w * 0.1;
      for (const fy of [0.32, 0.72]) {
        g.beginPath();
        g.arc(x + (1 - fy) * t.h * 0.1, t.y + t.h * fy, r, 0, Math.PI * 2);
        g.fill();
      }
    }

    _vfdText(g, text, x, y, size, color, align) {
      g.font = `600 ${size}px ${UI}`;
      g.textAlign = align;
      g.textBaseline = 'middle';
      g.letterSpacing = `${size * 0.08}px`;
      g.fillStyle = color;
      g.fillText(text, x, y);
      g.letterSpacing = '0px';
    }

    // The analyser: 31 columns of LEDs, a third of an octave each.
    _analyserUnit(g, u) {
      const b = this.L.base;
      this._label(g, 'SPECTRUM', u.x + u.w * 0.095, u.y + u.h * 0.3, b * 1.35, { weight: 700 });
      this._label(g, 'ANALYZER', u.x + u.w * 0.095, u.y + u.h * 0.42, b * 1.35, { weight: 700 });
      this._label(g, '31 BAND  ·  1/3 OCTAVE', u.x + u.w * 0.095, u.y + u.h * 0.54, b * 0.8, { color: this.F.soft });
      for (const [i, name] of [[0, 'PEAK'], [1, 'FAST'], [2, 'LOG']]) {
        const bx = u.x + u.w * (0.06 + i * 0.035);
        g.fillStyle = 'rgba(0, 0, 0, 0.5)';
        g.fillRect(bx - b * 0.95, u.y + u.h * 0.66, b * 1.9, b * 1.3);
        g.fillStyle = '#2b2c30';
        g.fillRect(bx - b * 0.85, u.y + u.h * 0.66 + b * 0.1, b * 1.7, b * 1.1);
        this._label(g, name, bx, u.y + u.h * 0.84, b * 0.7, { color: this.F.soft });
      }
      const m = { x: u.x + u.w * 0.17, y: u.y + u.h * 0.1, w: u.w * 0.67, h: u.h * 0.68 };
      this._window(g, m.x, m.y, m.w, m.h, b * 0.4, '#050505');
      const cols = 31;
      const rows = 16;
      const cw = (m.w * 0.96) / cols;
      const rh = (m.h * 0.92) / rows;
      this.grid = { x: m.x + m.w * 0.02, y: m.y + m.h * 0.04, cw, rh, cols, rows };
      for (let c = 0; c < cols; c += 1) {
        for (let r = 0; r < rows; r += 1) {
          g.fillStyle = r >= 14 ? '#2a0c0a' : r >= 11 ? '#29240c' : '#0c2412';
          g.fillRect(this.grid.x + c * cw + cw * 0.12, this._rowY(r), cw * 0.76, rh * 0.62);
        }
      }
      const hz = ['31', '63', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
      hz.forEach((t, i) => {
        const c = 1 + i * 3;
        this._label(g, t, this.grid.x + (c + 0.5) * cw, u.y + u.h * 0.875, b * 0.78, { color: this.F.soft, spacing: 0.02 });
      });
      // The level knob and its LED.
      this._knob(g, u.x + u.w * 0.915, u.y + u.h * 0.44, u.h * 0.21, 0.6);
      this._label(g, 'LEVEL', u.x + u.w * 0.915, u.y + u.h * 0.8, b * 0.85, { color: this.F.soft });
      this._ledSocket(g, u.x + u.w * 0.865, u.y + u.h * 0.2, b * 0.4);
      this.analyserLed = { x: u.x + u.w * 0.865, y: u.y + u.h * 0.2, r: b * 0.4 };
    }

    _rowY(r) {
      const gr = this.grid;
      return gr.y + (gr.rows - 1 - r) * gr.rh + gr.rh * 0.19;
    }

    // The amplifier: two VU meters, knobs, the inputs.
    _ampUnit(g, u, M) {
      const b = this.L.base;
      this.meters = [];
      const mw = u.w * 0.25;
      const mh = u.h * 0.72;
      for (let i = 0; i < 2; i += 1) {
        const m = { x: u.x + u.w * (0.055 + i * 0.27), y: u.y + u.h * 0.12, w: mw, h: mh };
        this._meter(g, m, M, i ? 'R' : 'L');
        this.meters.push(m);
      }
      this._label(g, 'STEREO INTEGRATED AMPLIFIER', u.x + u.w * 0.6, u.y + u.h * 0.14, b * 1.05, { align: 'left', weight: 700 });
      this._label(g, 'FLOW  A-90  ·  2 × 120 W', u.x + u.w * 0.6, u.y + u.h * 0.24, b * 0.85, { align: 'left', color: this.F.soft });
      // The volume knob, big.
      this.volume = this._knob(g, u.x + u.w * 0.885, u.y + u.h * 0.5, u.h * 0.3);
      this._label(g, 'VOLUME', this.volume.x, u.y + u.h * 0.9, b * 0.9, { color: this.F.soft });
      // Ticks round it.
      g.strokeStyle = this.F.soft;
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i <= 10; i += 1) {
        const a = (-135 + i * 27) * (Math.PI / 180);
        const r0 = this.volume.r * 1.12;
        const r1 = this.volume.r * (i % 5 ? 1.18 : 1.24);
        g.moveTo(this.volume.x + Math.sin(a) * r0, this.volume.y - Math.cos(a) * r0);
        g.lineTo(this.volume.x + Math.sin(a) * r1, this.volume.y - Math.cos(a) * r1);
      }
      g.stroke();
      // Three small knobs.
      ['BASS', 'TREBLE', 'BALANCE'].forEach((name, i) => {
        const kx = u.x + u.w * (0.625 + i * 0.065);
        this._knob(g, kx, u.y + u.h * 0.48, u.h * 0.1, [0.4, -0.3, 0][i]);
        this._label(g, name, kx, u.y + u.h * 0.64, b * 0.75, { color: this.F.soft });
      });
      // The inputs, CD lit.
      this.inputs = [];
      ['PHONO', 'TUNER', 'TAPE', 'CD', 'AUX'].forEach((name, i) => {
        const lx = u.x + u.w * (0.645 + i * 0.038);
        const ly = u.y + u.h * 0.78;
        this._ledSocket(g, lx, ly, b * 0.32);
        this._label(g, name, lx, ly + b * 1.2, b * 0.7, { color: this.F.soft, spacing: 0.04 });
        this.inputs.push({ name, x: lx, y: ly, r: b * 0.32 });
      });
      // Power.
      const px = u.x + u.w * 0.6;
      g.fillStyle = 'rgba(0, 0, 0, 0.5)';
      g.fillRect(px - b * 1.6, u.y + u.h * 0.72, b * 3.2, b * 2.2);
      g.fillStyle = '#26272b';
      g.fillRect(px - b * 1.45, u.y + u.h * 0.72 + b * 0.15, b * 2.9, b * 1.9);
      this._label(g, 'POWER', px, u.y + u.h * 0.72 + b * 3.0, b * 0.75, { color: this.F.soft });
      this._ledSocket(g, px, u.y + u.h * 0.72 - b * 0.9, b * 0.3);
      this.power = { x: px, y: u.y + u.h * 0.72 - b * 0.9, r: b * 0.3 };
    }

    /** A VU meter's window and face; the needle is drawn each frame. */
    _meter(g, m, M, side) {
      const b = this.L.base;
      g.fillStyle = 'rgba(0, 0, 0, 0.55)';
      g.fillRect(m.x - b * 0.5, m.y - b * 0.5, m.w + b, m.h + b);
      g.fillStyle = '#0d0d0f';
      g.fillRect(m.x - b * 0.3, m.y - b * 0.3, m.w + b * 0.6, m.h + b * 0.6);
      const face = g.createRadialGradient(m.x + m.w / 2, m.y + m.h * 0.9, 0, m.x + m.w / 2, m.y + m.h * 0.6, m.w * 0.62);
      face.addColorStop(0, M.mid);
      face.addColorStop(1, M.edge);
      g.fillStyle = face;
      g.fillRect(m.x, m.y, m.w, m.h);
      // The scale: an arc round a pivot under the face.
      const R = (m.w * 0.4) / Math.sin((44 * Math.PI) / 180);
      const px = m.x + m.w / 2;
      const py = m.y + m.h * 0.27 + R;
      Object.assign(m, { R, px, py, plate: m.y + m.h * 0.8 });
      const ang = (p) => ((-44 + 88 * p) * Math.PI) / 180;
      const at = (p, r) => [px + Math.sin(ang(p)) * r, py - Math.cos(ang(p)) * r];
      g.strokeStyle = M.ink;
      g.lineWidth = Math.max(1, m.h * 0.008);
      g.beginPath();
      g.arc(px, py, R, ang(0) - Math.PI / 2, ang(vuPos(0)) - Math.PI / 2);
      g.stroke();
      g.strokeStyle = '#c4231b';
      g.lineWidth = Math.max(2, m.h * 0.035);
      g.beginPath();
      g.arc(px, py, R * 1.012, ang(vuPos(0)) - Math.PI / 2, ang(1) - Math.PI / 2);
      g.stroke();
      const marks = [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3];
      g.lineWidth = Math.max(1, m.h * 0.01);
      for (const v of marks) {
        const p = vuPos(v);
        const [x0, y0] = at(p, R);
        const [x1, y1] = at(p, R * 1.07);
        g.strokeStyle = v > 0 ? '#c4231b' : M.ink;
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
        const [tx, ty] = at(p, R * 1.14);
        this._label(g, v > 0 ? `+${v}` : String(Math.abs(v)), tx, ty, m.h * 0.075, { color: v > 0 ? '#c4231b' : M.ink, spacing: 0, weight: 600 });
      }
      // Minor ticks, and the percent scale inside.
      for (let v = -20; v <= 3; v += 1) {
        if (marks.includes(v)) continue;
        const [x0, y0] = at(vuPos(v), R);
        const [x1, y1] = at(vuPos(v), R * 1.035);
        g.strokeStyle = M.ink;
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
      }
      g.lineWidth = Math.max(1, m.h * 0.006);
      g.strokeStyle = M.ink;
      g.beginPath();
      g.arc(px, py, R * 0.9, ang(0) - Math.PI / 2, ang(1) - Math.PI / 2);
      g.stroke();
      for (let k = 0; k <= 10; k += 1) {
        const p = vuPos(20 * Math.log10(Math.max(0.0001, (k / 10) * 10 ** (0 / 20))));
        if (p < 0) continue;
        const [x0, y0] = at(p, R * 0.9);
        const [x1, y1] = at(p, R * (k % 5 ? 0.875 : 0.86));
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
      }
      this._label(g, 'VU', px, m.y + m.h * 0.6, m.h * 0.16, { color: M.ink, weight: 700, spacing: 0.05 });
      this._label(g, side, m.x + m.w * 0.08, m.y + m.h * 0.7, m.h * 0.08, { color: M.ink, weight: 700 });
      this._label(g, 'PEAK', m.x + m.w * 0.86, m.y + m.h * 0.1, m.h * 0.055, { color: M.ink, weight: 700 });
      this._ledSocket(g, m.x + m.w * 0.86, m.y + m.h * 0.18, m.h * 0.025);
      m.led = { x: m.x + m.w * 0.86, y: m.y + m.h * 0.18, r: m.h * 0.025 };
      // The plate over the pivot.
      g.fillStyle = '#121214';
      g.fillRect(m.x, m.plate, m.w, m.y + m.h - m.plate);
      g.fillStyle = 'rgba(255, 255, 255, 0.06)';
      g.fillRect(m.x, m.plate, m.w, Math.max(1, m.h * 0.01));
      // The glass's glare, drawn over the needle each frame.
      const gl = canvas(m.w, m.h);
      const gg = gl.getContext('2d');
      const glare = gg.createLinearGradient(0, 0, m.w * 0.6, m.h);
      glare.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
      glare.addColorStop(0.45, 'rgba(255, 255, 255, 0.04)');
      glare.addColorStop(0.46, 'rgba(255, 255, 255, 0)');
      gg.fillStyle = glare;
      gg.fillRect(0, 0, m.w, m.h);
      const vig = gg.createRadialGradient(m.w / 2, m.h * 0.5, m.h * 0.3, m.w / 2, m.h * 0.5, m.w * 0.7);
      vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vig.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
      gg.fillStyle = vig;
      gg.fillRect(0, 0, m.w, m.h);
      m.glare = gl;
    }

    // The cassette deck: two doors, the counter, the keys.
    _deckUnit(g, u) {
      const b = this.L.base;
      const ch = u.h * 0.62;
      const cw = ch * 1.59;
      const dw = cw * 1.14;
      const dh = ch * 1.2;
      this.doors = [u.x + u.w * 0.05, u.x + u.w * 0.95 - dw].map((dx) => ({ x: dx, y: u.y + u.h * 0.11, w: dw, h: dh }));
      this.doors.forEach((d, i) => {
        // The door's recess and frame.
        g.fillStyle = 'rgba(0, 0, 0, 0.55)';
        g.fillRect(d.x - b * 0.4, d.y - b * 0.4, d.w + b * 0.8, d.h + b * 0.8);
        g.fillStyle = '#18181b';
        g.fillRect(d.x, d.y, d.w, d.h);
        const c = { x: d.x + (d.w - cw) / 2, y: d.y + (d.h - ch) * 0.42, w: cw, h: ch };
        d.cassette = c;
        this._cassette(g, c, i ? 'FLOW MIX ’86' : null, i);
        if (i) this._reels(g, c, 0.35, 0.4, 1.9);
        this._label(g, i ? 'DECK B' : 'DECK A', d.x + d.w / 2, d.y + d.h + b * 1.1, b * 0.8, { color: this.F.soft });
        // The smoked window's tint and glare, drawn over the reels each frame.
        const ov = canvas(d.w, d.h);
        const og = ov.getContext('2d');
        og.fillStyle = 'rgba(25, 18, 12, 0.22)';
        og.fillRect(0, 0, d.w, d.h);
        const glare = og.createLinearGradient(0, 0, d.w * 0.7, d.h);
        glare.addColorStop(0, 'rgba(255, 255, 255, 0.14)');
        glare.addColorStop(0.35, 'rgba(255, 255, 255, 0.03)');
        glare.addColorStop(0.36, 'rgba(255, 255, 255, 0)');
        og.fillStyle = glare;
        og.fillRect(0, 0, d.w, d.h);
        og.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        og.lineWidth = 2;
        og.strokeRect(1, 1, d.w - 2, d.h - 2);
        d.overlay = ov;
        if (i) g.drawImage(ov, d.x, d.y);
      });
      // The middle: name, counter, keys.
      const mx = this.doors[0].x + dw + u.w * 0.03;
      const mw = this.doors[1].x - u.w * 0.03 - mx;
      this._label(g, 'STEREO DOUBLE CASSETTE DECK', mx + mw / 2, u.y + u.h * 0.13, b * 1.0, { weight: 700 });
      this._label(g, 'AUTO REVERSE  ·  HIGH SPEED DUBBING  ·  METAL', mx + mw / 2, u.y + u.h * 0.22, b * 0.72, { color: this.F.soft });
      const cnt = { w: mw * 0.22, h: u.h * 0.17 };
      cnt.x = mx + mw * 0.12;
      cnt.y = u.y + u.h * 0.33;
      this.counter = cnt;
      this._window(g, cnt.x - b * 0.3, cnt.y - b * 0.3, cnt.w + b * 0.6, cnt.h + b * 0.6, b * 0.2, '#0a0a0b');
      this._label(g, 'TAPE COUNTER', cnt.x + cnt.w / 2, cnt.y + cnt.h + b * 1.1, b * 0.7, { color: this.F.soft });
      // Tape type and the deck's own LEDs.
      this.deckLeds = [];
      ['NORMAL', 'CrO₂', 'METAL'].forEach((name, i) => {
        const lx = mx + mw * (0.55 + i * 0.13);
        const ly = u.y + u.h * 0.38;
        this._ledSocket(g, lx, ly, b * 0.3);
        this._label(g, name, lx, ly + b * 1.1, b * 0.68, { color: this.F.soft, spacing: 0.04 });
        this.deckLeds.push({ name, x: lx, y: ly, r: b * 0.3 });
      });
      // The keys.
      const kinds = ['eject', 'rew', 'play', 'ff', 'stop', 'pause'];
      const kw = (mw * 0.92) / kinds.length;
      const ky = u.y + u.h * 0.62;
      const kh = u.h * 0.24;
      this.keys = kinds.map((kind, i) => {
        const k = { kind, x: mx + mw * 0.04 + i * kw + kw * 0.06, y: ky, w: kw * 0.88, h: kh };
        g.fillStyle = 'rgba(0, 0, 0, 0.55)';
        g.fillRect(k.x - 1, k.y - 1, k.w + 2, k.h + 3);
        const kg = g.createLinearGradient(0, k.y, 0, k.y + k.h);
        kg.addColorStop(0, '#3a3b40');
        kg.addColorStop(1, '#202125');
        g.fillStyle = kg;
        g.fillRect(k.x, k.y, k.w, k.h);
        g.fillStyle = 'rgba(255, 255, 255, 0.1)';
        g.fillRect(k.x, k.y, k.w, Math.max(1, k.h * 0.05));
        this._keySymbol(g, k, '#d8d8dc');
        k.led = { x: k.x + k.w / 2, y: k.y - b * 0.8, r: b * 0.26 };
        if (kind === 'play' || kind === 'pause' || kind === 'rew' || kind === 'ff') this._ledSocket(g, k.led.x, k.led.y, k.led.r);
        return k;
      });
    }

    _keySymbol(g, k, color) {
      const s = Math.min(k.w, k.h) * 0.32;
      const cx = k.x + k.w / 2;
      const cy = k.y + k.h / 2;
      g.fillStyle = color;
      const tri = (x, dir) => {
        g.beginPath();
        g.moveTo(x - (s / 2) * dir, cy - s / 2);
        g.lineTo(x + (s / 2) * dir, cy);
        g.lineTo(x - (s / 2) * dir, cy + s / 2);
        g.closePath();
        g.fill();
      };
      if (k.kind === 'play') tri(cx, 1);
      else if (k.kind === 'ff') {
        tri(cx - s * 0.4, 1);
        tri(cx + s * 0.4, 1);
      } else if (k.kind === 'rew') {
        tri(cx - s * 0.4, -1);
        tri(cx + s * 0.4, -1);
      } else if (k.kind === 'stop') g.fillRect(cx - s * 0.42, cy - s * 0.42, s * 0.84, s * 0.84);
      else if (k.kind === 'pause') {
        g.fillRect(cx - s * 0.42, cy - s / 2, s * 0.28, s);
        g.fillRect(cx + s * 0.14, cy - s / 2, s * 0.28, s);
      } else if (k.kind === 'eject') {
        g.beginPath();
        g.moveTo(cx - s / 2, cy + s * 0.1);
        g.lineTo(cx, cy - s / 2);
        g.lineTo(cx + s / 2, cy + s * 0.1);
        g.closePath();
        g.fill();
        g.fillRect(cx - s / 2, cy + s * 0.25, s, s * 0.18);
      }
    }

    /** A cassette's shell and label (the reels are drawn on top through its window). */
    _cassette(g, c, title, side) {
      const r = c.h * 0.05;
      g.fillStyle = '#26262b';
      g.beginPath();
      g.roundRect(c.x, c.y, c.w, c.h, r);
      g.fill();
      g.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      g.lineWidth = 1;
      g.stroke();
      // The label, its stripes, side A.
      const lx = c.x + c.w * 0.06;
      const ly = c.y + c.h * 0.07;
      const lw = c.w * 0.88;
      const lh = c.h * 0.63;
      g.fillStyle = side ? '#e9dfc9' : '#f1ead8';
      g.beginPath();
      g.roundRect(lx, ly, lw, lh, r * 0.6);
      g.fill();
      const stripes = side ? ['#2f6fb5', '#5aa0dd'] : ['#e2572b', '#f2a03a'];
      g.fillStyle = stripes[0];
      g.fillRect(lx, ly + lh * 0.72, lw, lh * 0.06);
      g.fillStyle = stripes[1];
      g.fillRect(lx, ly + lh * 0.8, lw, lh * 0.06);
      g.strokeStyle = 'rgba(80, 70, 60, 0.35)';
      g.lineWidth = 1;
      for (let k = 1; k <= 2; k += 1) {
        g.beginPath();
        g.moveTo(lx + lw * 0.08, ly + lh * (0.16 + k * 0.1));
        g.lineTo(lx + lw * 0.92, ly + lh * (0.16 + k * 0.1));
        g.stroke();
      }
      this._label(g, 'A', lx + lw * 0.05, ly + lh * 0.13, c.h * 0.08, { color: '#3a332b', weight: 800, spacing: 0 });
      this._label(g, side ? 'C90' : 'C60', lx + lw * 0.93, ly + lh * 0.9, c.h * 0.055, { color: '#ffffff', weight: 800, spacing: 0 });
      c.title = { x: lx + lw * 0.5, y: ly + lh * 0.15, size: c.h * 0.1, max: lw * 0.8 };
      if (title) this._handwrite(g, c, title);
      // The window, the hubs in it.
      c.win = { x: c.x + c.w * 0.21, y: c.y + c.h * 0.33, w: c.w * 0.58, h: c.h * 0.27 };
      c.hubs = [[c.x + c.w * 0.3, c.y + c.h * 0.465], [c.x + c.w * 0.7, c.y + c.h * 0.465]];
      g.fillStyle = '#141113';
      this._winPath(g, c);
      g.fill();
      // The bottom: where the heads reach in, and the tape across it.
      g.fillStyle = '#1b1b1f';
      g.beginPath();
      g.moveTo(c.x + c.w * 0.2, c.y + c.h);
      g.lineTo(c.x + c.w * 0.25, c.y + c.h * 0.78);
      g.lineTo(c.x + c.w * 0.75, c.y + c.h * 0.78);
      g.lineTo(c.x + c.w * 0.8, c.y + c.h);
      g.closePath();
      g.fill();
      g.fillStyle = '#3b2416';
      g.fillRect(c.x + c.w * 0.22, c.y + c.h * 0.95, c.w * 0.56, Math.max(1.5, c.h * 0.012));
      for (const fx of [0.33, 0.5, 0.67]) {
        g.fillStyle = '#0c0c0e';
        g.fillRect(c.x + c.w * fx - c.w * 0.025, c.y + c.h * 0.86, c.w * 0.05, c.h * 0.07);
      }
      for (const [fx, fy] of [[0.04, 0.06], [0.96, 0.06], [0.04, 0.94], [0.96, 0.94], [0.5, 0.82]]) {
        g.fillStyle = '#4a4a50';
        g.beginPath();
        g.arc(c.x + c.w * fx, c.y + c.h * fy, c.h * 0.018, 0, Math.PI * 2);
        g.fill();
      }
    }

    _handwrite(g, c, title) {
      const t = c.title;
      let size = t.size;
      g.font = `${size}px ${HAND}`;
      while (size > t.size * 0.5 && g.measureText(title).width > t.max) {
        size *= 0.92;
        g.font = `${size}px ${HAND}`;
      }
      let text = title;
      while (text.length > 3 && g.measureText(text).width > t.max) text = text.slice(0, -2);
      if (text !== title) text = text.trimEnd() + '…';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#1b2a6b';
      g.save();
      g.translate(t.x, t.y);
      g.rotate(-0.015);
      g.fillText(text, 0, 0);
      g.restore();
    }

    _winPath(g, c) {
      const w = c.win;
      g.beginPath();
      g.roundRect(w.x, w.y, w.w, w.h, w.h / 2);
    }

    /** The two reels in a cassette's window: p of the tape on the right one, the hubs turned by angL, angR. */
    _reels(g, c, p, angL, angR) {
      const hub = c.h * 0.085;
      const core = c.h * 0.1;
      const full = c.h * 0.285;
      g.save();
      this._winPath(g, c);
      g.clip();
      g.fillStyle = '#17100c';
      g.fillRect(c.win.x, c.win.y, c.win.w, c.win.h);
      [1 - p, p].forEach((share, i) => {
        const [x, y] = c.hubs[i];
        const r = Math.sqrt(core * core + share * (full * full - core * core));
        const pack = g.createRadialGradient(x, y, core, x, y, r);
        pack.addColorStop(0, '#2c1a10');
        pack.addColorStop(0.7, '#4a2c1a');
        pack.addColorStop(0.97, '#5b3820');
        pack.addColorStop(1, '#2a170d');
        g.fillStyle = pack;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        // The hub and its six teeth.
        const ang = i ? angR : angL;
        g.fillStyle = '#ece6d8';
        g.beginPath();
        g.arc(x, y, hub, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#141113';
        g.beginPath();
        g.arc(x, y, hub * 0.62, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#ece6d8';
        for (let k = 0; k < 6; k += 1) {
          const a = ang + (k * Math.PI) / 3;
          g.save();
          g.translate(x, y);
          g.rotate(a);
          g.fillRect(-hub * 0.1, -hub * 0.64, hub * 0.2, hub * 0.24);
          g.restore();
        }
      });
      // The window's own plastic: a faint sheen.
      const sheen = g.createLinearGradient(0, c.win.y, 0, c.win.y + c.win.h);
      sheen.addColorStop(0, 'rgba(255, 255, 255, 0.12)');
      sheen.addColorStop(0.4, 'rgba(255, 255, 255, 0.02)');
      sheen.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
      g.fillStyle = sheen;
      g.fillRect(c.win.x, c.win.y, c.win.w, c.win.h);
      g.restore();
      g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      g.lineWidth = Math.max(1, c.h * 0.012);
      this._winPath(g, c);
      g.stroke();
    }

    // ---- each frame -----------------------------------------------------

    /** The song's title and artist, as a canvas of lit dots (once per text). */
    _strip(text, pitch, col) {
      const key = `${text}|${pitch}|${col}`;
      let s = this.strips.get(key);
      if (s) return s;
      if (this.strips.size > 8) this.strips.clear();
      const cols = text.length * 6;
      s = canvas(cols * pitch, 7 * pitch);
      const g = s.getContext('2d');
      g.fillStyle = rgba(col, 1);
      const dot = Math.max(1, pitch * 0.78);
      for (let i = 0; i < text.length; i += 1) {
        const rows = FONT[text[i]] || FONT['?'];
        for (let r = 0; r < 7; r += 1) {
          for (let b = 0; b < 5; b += 1) {
            if (rows[r] & (16 >> b)) g.fillRect((i * 6 + b) * pitch, r * pitch, dot, dot);
          }
        }
      }
      this.strips.set(key, s);
      return s;
    }

    _songText() {
      const id = Player.currentId;
      const song = id ? Store.song(id) || (Player.remote ? Player.remote.state : null) : null;
      if (!song) return { line: 'FLOW', title: '' };
      const title = song.title || 'Untitled';
      return { line: dotText(song.artist ? `${title} - ${song.artist}` : title), title };
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      const finish = set('hfFinish');
      const disp = set('hfDisplay');
      const meter = set('hfMeters');
      const song = this._songText();
      const built = `${this.w}x${this.h}|${finish}|${disp}|${meter}|${song.title}`;
      if (built !== this.builtFor) {
        this._build(finish, disp, meter);
        this._handwrite(this.static.getContext('2d'), this.doors[0].cassette, song.title || 'Flow');
        this.builtFor = built;
      }
      const g = this.ctx;
      const lg = this.lctx;
      g.drawImage(this.static, 0, 0);
      lg.clearRect(0, 0, this.w, this.h);
      const col = this.vfdColor;

      const playing = a.playing;
      const pos = Player.position || 0;
      const dur = Player.duration || 0;

      this._display(lg, a, song.line, col, pos);
      this._analyser(lg, a, dt, set('hfPeaks'));
      this._amp(g, lg, a, dt);
      this._deck(g, lg, a, dt, pos, dur, playing);

      // What glows: onto the screen, then blurred over it.
      g.drawImage(this.lit, 0, 0);
      const s1 = this.s1.getContext('2d');
      const s2 = this.s2.getContext('2d');
      s1.clearRect(0, 0, this.s1.width, this.s1.height);
      s1.drawImage(this.lit, 0, 0, this.s1.width, this.s1.height);
      s2.clearRect(0, 0, this.s2.width, this.s2.height);
      s2.drawImage(this.s1, 0, 0, this.s2.width, this.s2.height);
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.55;
      g.drawImage(this.s1, 0, 0, this.w, this.h);
      g.globalAlpha = 0.8;
      g.drawImage(this.s2, 0, 0, this.w, this.h);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      // The display's glass.
      const v = this.vfd;
      g.fillStyle = this.vfdGlass;
      g.fillRect(v.x, v.y, v.w, v.h);
    }

    _display(lg, a, line, col, pos) {
      const lit = rgba(col, 1);
      const m = this.matrix;
      // The title: still if it fits, else running through by dot columns.
      const fits = line.length * 6 - 1 <= m.cols;
      const text = fits ? line : `${line}     ${line}     `;
      const strip = this._strip(text, m.pitch, col);
      if (fits) {
        const lead = Math.floor((m.chars - line.length) / 2) * 6;
        lg.drawImage(strip, m.x + lead * m.pitch, m.y);
      } else {
        const loop = (line.length + 5) * 6;
        const off = Math.floor(this.age * 14) % loop;
        lg.drawImage(strip, off * m.pitch, 0, m.cols * m.pitch, 7 * m.pitch, m.x, m.y, m.cols * m.pitch, 7 * m.pitch);
      }

      // The time played.
      lg.fillStyle = lit;
      const t = Math.max(0, Math.floor(pos));
      const mins = Math.min(99, Math.floor(t / 60));
      const digits = `${mins < 10 ? ' ' : ''}${mins}${String(t % 60).padStart(2, '0')}`;
      for (let i = 0; i < 4; i += 1) seg7(lg, this._digitX(this.time, i), this.time.y, this.time.w, this.time.h, digits[i]);
      if (!a.playing || this.age % 1 < 0.6) this._colon(lg, this.time);

      // Level bars, per channel, a peak segment hanging.
      const bars = this.bars;
      for (let ch = 0; ch < 2; ch += 1) {
        const s = ch ? a.right : a.left;
        // The peak against where the song's loud parts reach (as the VU
        // meters below), so a loud master does not sit at the top.
        let peak = 0;
        if (s) for (let i = s.length - 1024; i < s.length; i += 1) peak = Math.max(peak, Math.abs(s[i]));
        const db = peak > 1e-5 ? 20 * Math.log10(peak) - (this.ref + 9) : -60;
        const v = a.playing ? Math.max(0, Math.min(1, (db + 30) / 30)) : 0;
        this.bar[ch] = Math.max(v, this.bar[ch] - a._dt * 1.2);
        if (this.bar[ch] >= this.barPeak[ch]) {
          this.barPeak[ch] = this.bar[ch];
          this.barHold[ch] = 0.8;
        } else if ((this.barHold[ch] -= a._dt) < 0) this.barPeak[ch] = Math.max(this.bar[ch], this.barPeak[ch] - a._dt * 0.5);
        const by = bars.y + ch * (bars.h + bars.gap);
        const n = Math.round(this.bar[ch] * bars.segs);
        const pk = Math.min(bars.segs - 1, Math.round(this.barPeak[ch] * bars.segs) - 1);
        for (let i = 0; i < bars.segs; i += 1) {
          if (i >= n && i !== pk) continue;
          lg.fillStyle = i >= bars.segs - 3 ? 'rgb(255, 80, 70)' : lit;
          lg.fillRect(bars.x + (i * bars.w) / bars.segs, by, (bars.w / bars.segs) * 0.7, bars.h);
        }
      }

      // The printed scale and labels, always lit, dimmer.
      const dim = rgba(col, 0.55);
      this._vfdText(lg, this.scale.text, this.scale.x, this.scale.y, this.scale.size, dim, 'left');
      this._vfdText(lg, 'BPM', this.bpmLabel.x, this.bpmLabel.y, this.bpmLabel.size, dim, 'left');
      this._vfdText(lg, 'KEY', this.keyLabel.x, this.keyLabel.y, this.keyLabel.size, dim, 'right');
      for (let ch = 0; ch < 2; ch += 1) {
        this._vfdText(lg, ch ? 'R' : 'L', this.chLabel.x, bars.y + ch * (bars.h + bars.gap) + bars.h / 2, this.chLabel.size, dim, 'left');
      }

      // The annunciators.
      const on = {
        play: a.playing,
        pause: !a.playing && !!Player.currentId,
        stereo: !!a.left && a.playing,
        beat: a.sure >= 0.35 && a.phase < 0.15 && a.playing,
      };
      for (const an of this.annunciators) if (on[an.key]) this._vfdText(lg, an.text, an.x, an.y, an.size, lit, 'left');

      // The tempo and the key, once they are known.
      lg.fillStyle = lit;
      const bpm = a.sure >= 0.35 && a.bpm ? String(Math.round(a.bpm)).padStart(3, ' ') : '---';
      for (let i = 0; i < 3; i += 1) seg7(lg, this.bpm.x + i * this.bpm.w * 1.45, this.bpm.y, this.bpm.w, this.bpm.h, bpm[i]);
      const notes = a.notes();
      const key = notes.key >= 0 && notes.clarity > 0.2 ? `${NAMES[notes.key]}${notes.minor ? ' MIN' : ' MAJ'}` : '';
      if (key) {
        const k = this.keyM;
        lg.drawImage(this._strip(key.padStart(6, ' '), k.pitch, col), k.x, k.y);
      }
    }

    _analyser(lg, a, dt, peaks) {
      const gr = this.grid;
      const n = gr.cols;
      const nb = a.BANDS;
      for (let c = 0; c < n; c += 1) {
        // Column c: a third of an octave from 31 Hz up, read off the bands.
        const hz0 = 31.5 * 2 ** ((c - 0.5) / 3);
        const hz1 = 31.5 * 2 ** ((c + 0.5) / 3);
        let v = 0;
        let k = 0;
        for (let j = 0; j < nb; j += 1) {
          const f = a.bandHz(j);
          if (f < hz0 || f >= hz1) continue;
          v = Math.max(v, 0.55 * a.bands[j] + 0.45 * a.dynamic[j]);
          k += 1;
        }
        if (!k) {
          // Narrower than a band down low: the nearest one.
          const f = 31.5 * 2 ** (c / 3);
          const j = Math.max(0, Math.min(nb - 1, Math.round((Math.log(f / a.MIN_HZ) / Math.log(a.MAX_HZ / a.MIN_HZ)) * nb - 0.5)));
          v = 0.55 * a.bands[j] + 0.45 * a.dynamic[j];
        }
        v = Math.min(1, v * 1.05);
        this.cols[c] = Math.max(v, this.cols[c] - dt * 2.2);
        if (this.cols[c] >= this.peaks[c]) {
          this.peaks[c] = this.cols[c];
          this.hold[c] = 0.6;
        } else if ((this.hold[c] -= dt) < 0) this.peaks[c] = Math.max(this.cols[c], this.peaks[c] - dt * 0.7);
        const lit = Math.round(this.cols[c] * gr.rows);
        const pk = Math.min(gr.rows - 1, Math.round(this.peaks[c] * gr.rows) - 1);
        for (let r = 0; r < gr.rows; r += 1) {
          if (r >= lit && !(peaks && r === pk && pk >= lit)) continue;
          lg.fillStyle = r >= 14 ? LED.red : r >= 11 ? LED.yellow : LED.green;
          lg.fillRect(gr.x + c * gr.cw + gr.cw * 0.12, this._rowY(r), gr.cw * 0.76, gr.rh * 0.62);
        }
      }
      this._led(lg, this.analyserLed, a.playing ? LED.green : '#3a2a20');
    }

    _led(lg, l, color) {
      lg.fillStyle = color;
      lg.beginPath();
      lg.arc(l.x, l.y, l.r, 0, Math.PI * 2);
      lg.fill();
    }

    _amp(g, lg, a, dt) {
      // The needles: each channel's loudness over the last ~40 ms, against
      // the level the song's loud parts reach lately, through a spring.
      const rms = [a.left, a.right].map((s) => {
        if (!s) return 0;
        let sum = 0;
        const from = s.length - 2048;
        for (let i = from; i < s.length; i += 1) sum += s[i] * s[i];
        return Math.sqrt(sum / 2048);
      });
      const loud = Math.max(...rms);
      if (loud > 1e-4) {
        const db = 20 * Math.log10(loud);
        this.ref = db > this.ref ? this.ref + (db - this.ref) * Math.min(1, dt * 0.6) : this.ref - dt * 0.25;
      }
      const step = Math.min(dt, 0.05);
      this.meters.forEach((m, i) => {
        const db = rms[i] > 1e-6 ? 20 * Math.log10(rms[i]) : -80;
        const vu = db - this.ref - 0.5;
        const target = a.playing ? Math.max(0, Math.min(1.06, vuPos(Math.max(-23, vu)))) : 0;
        const n = this.needle[i];
        // A real meter's: about 300 ms to get there, a percent or so past it.
        for (let s = 0; s < 4; s += 1) {
          const h = step / 4;
          n.v += (180 * (target - n.x) - 22 * n.v) * h;
          n.x += n.v * h;
          if (n.x < -0.02) {
            n.x = -0.02;
            n.v = Math.abs(n.v) * 0.2;
          }
          if (n.x > 1.08) {
            n.x = 1.08;
            n.v = -Math.abs(n.v) * 0.3;
          }
        }
        const ang = ((-44 + 88 * n.x) * Math.PI) / 180;
        const tipR = m.R * 1.03;
        const tx = m.px + Math.sin(ang) * tipR;
        const ty = m.py - Math.cos(ang) * tipR;
        g.save();
        g.beginPath();
        g.rect(m.x, m.y, m.w, m.plate - m.y);
        g.clip();
        g.lineCap = 'round';
        g.strokeStyle = 'rgba(0, 0, 0, 0.18)';
        g.lineWidth = Math.max(1.5, m.h * 0.014);
        g.beginPath();
        g.moveTo(m.px + m.w * 0.02, m.py + m.h * 0.03);
        g.lineTo(tx + m.w * 0.02, ty + m.h * 0.03);
        g.stroke();
        g.strokeStyle = '#151515';
        g.lineWidth = Math.max(1.2, m.h * 0.011);
        g.beginPath();
        g.moveTo(m.px, m.py);
        g.lineTo(tx, ty);
        g.stroke();
        g.restore();
        g.drawImage(m.glare, m.x, m.y);
        this._led(lg, m.led, vu > 1.5 && a.playing ? LED.red : 'rgba(0, 0, 0, 0)');
      });
      // The volume knob where the player's volume is.
      const vol = Math.max(0, Math.min(1, Number(Store.settings.volume) || 0));
      this._pointer(g, this.volume, ((-135 + 270 * vol) * Math.PI) / 180);
      this._led(lg, this.power, LED.red);
      for (const inp of this.inputs) if (inp.name === 'CD') this._led(lg, inp, LED.yellow);
    }

    _deck(g, lg, a, dt, pos, dur, playing) {
      const d = this.doors[0];
      const c = d.cassette;
      const p = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
      // A skip: wind fast that way for a moment.
      if (this.lastPos !== null) {
        const jump = pos - this.lastPos - (playing ? dt : 0);
        if (Math.abs(jump) > 1.5) this.wind = Math.sign(jump) * 0.7;
      }
      this.lastPos = pos;
      const target = playing ? 1 : 0;
      this.spin += (target - this.spin) * Math.min(1, dt * (playing ? 6 : 4));
      let speed = this.spin;
      if (this.wind) {
        speed = Math.sign(this.wind) * 9;
        this.wind = Math.sign(this.wind) * Math.max(0, Math.abs(this.wind) - dt);
      }
      // The tape runs at one speed: each reel turns the faster the less tape it carries.
      const core = c.h * 0.1;
      const full = c.h * 0.285;
      const v = c.h * 0.6 * speed;
      [1 - p, p].forEach((share, i) => {
        const r = Math.sqrt(core * core + share * (full * full - core * core));
        this.reel[i] -= (v / r) * dt;
      });
      this._reels(g, c, p, this.reel[0], this.reel[1]);
      g.drawImage(d.overlay, d.x, d.y);

      // The counter: three wheels, the last one rolling.
      const cnt = this.counter;
      const value = (pos * 1.2) % 1000;
      g.save();
      g.beginPath();
      g.rect(cnt.x, cnt.y, cnt.w, cnt.h);
      g.clip();
      const cw = cnt.w / 3;
      g.font = `600 ${cnt.h * 0.78}px Consolas, "Courier New", monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let i = 0; i < 3; i += 1) {
        const place = 10 ** (2 - i);
        const whole = Math.floor(value / place) % 10;
        // Each wheel clicks on in the last fifth of a count, the ones before
        // it with it as it rolls from 9 to 0.
        const below = value % place;
        const t = Math.max(0, (below - (place - 0.2)) / 0.2);
        const roll = t * t * (3 - 2 * t);
        const x = cnt.x + cw * (i + 0.5);
        const wheel = g.createLinearGradient(0, cnt.y, 0, cnt.y + cnt.h);
        wheel.addColorStop(0, '#0c0c0c');
        wheel.addColorStop(0.5, '#222');
        wheel.addColorStop(1, '#0c0c0c');
        g.fillStyle = wheel;
        g.fillRect(cnt.x + cw * i + 1, cnt.y, cw - 2, cnt.h);
        g.fillStyle = '#f1f1ee';
        for (const k of [0, 1]) g.fillText(String((whole + k) % 10), x, cnt.y + cnt.h * (0.54 + k - roll));
      }
      const shade = g.createLinearGradient(0, cnt.y, 0, cnt.y + cnt.h);
      shade.addColorStop(0, 'rgba(0, 0, 0, 0.7)');
      shade.addColorStop(0.3, 'rgba(0, 0, 0, 0)');
      shade.addColorStop(0.7, 'rgba(0, 0, 0, 0)');
      shade.addColorStop(1, 'rgba(0, 0, 0, 0.7)');
      g.fillStyle = shade;
      g.fillRect(cnt.x, cnt.y, cnt.w, cnt.h);
      g.restore();

      // The keys: the one down darker, its LED lit.
      const down = this.wind > 0 ? 'ff' : this.wind < 0 ? 'rew' : playing ? 'play' : Player.currentId ? 'pause' : 'stop';
      for (const k of this.keys) {
        if (k.kind !== down) continue;
        g.fillStyle = 'rgba(0, 0, 0, 0.35)';
        g.fillRect(k.x, k.y, k.w, k.h);
        g.fillStyle = 'rgba(0, 0, 0, 0.5)';
        g.fillRect(k.x, k.y, k.w, Math.max(1, k.h * 0.06));
        if (k.kind === 'play' || k.kind === 'ff' || k.kind === 'rew') this._led(lg, k.led, LED.green);
        if (k.kind === 'pause') this._led(lg, k.led, LED.yellow);
      }
      this._led(lg, this.deckLeds[2], LED.yellow);
    }
  }

  Visualizer.add({
    id: 'hifi',
    name: 'Hi-Fi',
    desc: 'An 80s stereo rack: the title on a glowing display, an LED spectrum analyser, VU meters swinging with each channel, a cassette turning',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 15l2.5-5M15 15l2.5-5"/>'
      + '<path d="M4.5 15h7M13.5 15h7"/></svg>',
    stereo: true,
    sharp: true,
    create: (cv) => new HiFi(cv),
    options: [
      { type: 'choice', key: 'hfFinish', label: 'Finish', choices: [['silver', 'Silver'], ['black', 'Black']] },
      { type: 'choice', key: 'hfDisplay', label: 'Display', choices: [['teal', 'Teal'], ['amber', 'Amber'], ['blue', 'Blue'], ['green', 'Green']] },
      { type: 'choice', key: 'hfMeters', label: 'Meter light', choices: [['amber', 'Warm'], ['white', 'White'], ['blue', 'Blue']] },
      { type: 'check', key: 'hfPeaks', label: 'Analyzer peaks' },
    ],
  });
})();
