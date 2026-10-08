'use strict';

// Strings: twelve strings stretched across the dark, one for each note (C at
// the bottom up to B), each vibrating as strongly as its note sounds in the
// music. A note sounding low swings its string slowly and wide in one long
// loop; sounding high, it shivers in two, three or four; each string shows
// the blur of its swing and, brighter, where it is now. On a hit the
// strings whose notes are sounding are plucked anew. Beside them their
// names, and above the key the song is in.
//
// Its cogwheel: the colours (round the circle of fifths, as the notes go;
// gold; ice), the names.
//
// WebGL (viz/gl.js): one pass, each pixel measured against the twelve
// strings' curves; the names come from a small texture drawn with a canvas.

(() => {
  const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const COLORS = { notes: 0, gold: 1, ice: 2 };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform sampler2D labels;
    uniform float amp[12], loops[12], speed[12], phase[12];
    uniform float time, glow;
    uniform int palette;
    uniform bool names;
    out vec4 o;
    const float PI = 3.14159265;

    vec3 hsv(float h, float s, float v) {
      vec3 p = abs(fract(vec3(h) + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
      return v * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), s);
    }

    vec3 colourOf(int i) {
      float f = float(i) / 11.0;
      if (palette == 1) return mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.9, 0.55), f);
      if (palette == 2) return mix(vec3(0.3, 0.55, 1.0), vec3(0.75, 0.95, 1.0), f);
      // Round the circle of fifths: C red, G orange, D yellow ...
      return hsv(float((i * 7) % 12) / 12.0, 0.75, 1.0);
    }

    void main() {
      float aspect = res.x / res.y;
      vec2 s = vec2(uv.x * aspect, uv.y);
      float x0 = aspect * 0.1;
      float x1 = aspect * 0.93;
      float u = (s.x - x0) / (x1 - x0);
      float px = 1.0 / res.y;
      vec3 col = mix(vec3(0.012, 0.01, 0.016), vec3(0.03, 0.022, 0.03), uv.y) * (1.0 - 0.4 * abs(uv.x - 0.5));
      // A faint board behind, its grain running along.
      col += vec3(0.02, 0.012, 0.006) * vnoise(vec2(s.x * 3.0, s.y * 160.0)) * smoothstep(0.03, 0.06, uv.y) * smoothstep(0.97, 0.94, uv.y);
      for (int i = 0; i < 12; i++) {
        float yb = 0.1 + 0.8 * (float(i) + 0.5) / 12.0;
        if (abs(s.y - yb) > 0.06) continue;
        vec3 c = colourOf(i);
        float a = amp[i];
        float pegs = smoothstep(0.006, 0.004, min(length(s - vec2(x0, yb)), length(s - vec2(x1, yb))));
        col = mix(col, vec3(0.55, 0.55, 0.6), pegs);
        if (u < 0.0 || u > 1.0) continue;
        // The swing's shape along the string, and where it is now.
        float shape = sin(PI * loops[i] * u) * sin(PI * u * 0.999 + 0.0005);
        float env = a * 0.045 * shape;
        float now = env * cos(time * speed[i] + phase[i]);
        float d = s.y - yb;
        // The blur of the swing: most where it turns back.
        float e = abs(env) + px;
        float inside = clamp(abs(d) / e, 0.0, 1.0);
        float blur = step(abs(d), e) / sqrt(max(1.0 - inside * inside, 0.04)) * 0.06 * min(1.0, a * 3.0);
        col += c * blur * (0.4 + glow);
        // The string itself, metal, catching its colour as it moves.
        float dist = abs(d - now);
        float w = (1.1 + 0.6 * (1.0 - float(i) / 11.0)) * px;
        float core = smoothstep(w + px, w * 0.3, dist);
        col = mix(col, mix(vec3(0.35, 0.35, 0.38), c * 1.4 + 0.4, min(1.0, a * 2.0)), core);
        col += c * exp(-dist / (px * (3.0 + 10.0 * a))) * (0.05 + 0.6 * a) * (0.5 + glow);
      }
      // The names: on a strip of the texture, one cell each, the key in the last part.
      if (names) {
        for (int i = 0; i < 12; i++) {
          float yb = 0.1 + 0.8 * (float(i) + 0.5) / 12.0;
          vec2 q = (s - vec2(x0 - 0.06, yb)) / 0.045 + 0.5;
          if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0) {
            float t = texture(labels, vec2((float(i) + q.x) / 16.0, 1.0 - q.y)).r;
            col = mix(col, colourOf(i) * (0.5 + 0.6 * amp[i]) + 0.15, t);
          }
        }
        vec2 q = vec2((s.x - (x1 - 0.5)) / 0.5, (s.y - 0.93) / 0.05 + 0.5);
        if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0) {
          float t = texture(labels, vec2((12.0 + q.x * 4.0) / 16.0, 1.0 - q.y)).r;
          col = mix(col, vec3(0.6, 0.58, 0.62), t);
        }
      }
      col = 1.0 - exp(-col * 1.4);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Strings {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.age = 0;
      this.amp = new Float32Array(12);
      this.loops = new Float32Array(12).fill(1);
      this.speed = new Float32Array(12).fill(10);
      this.phase = new Float32Array(12).map(() => Math.random() * 6.28);
      this.glow = 0;
      // The names: twelve cells of 64 x 64, then the key across four.
      this.labelCanvas = document.createElement('canvas');
      this.labelCanvas.width = 1024;
      this.labelCanvas.height = 64;
      this.labelTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.labelTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.keyText = null;
      this._labels('');
      this.w = 1;
      this.h = 1;
    }

    _labels(key) {
      if (key === this.keyText) return;
      this.keyText = key;
      const c = this.labelCanvas.getContext('2d');
      c.clearRect(0, 0, 1024, 64);
      c.fillStyle = '#fff';
      c.textBaseline = 'middle';
      c.font = '600 34px system-ui, sans-serif';
      c.textAlign = 'center';
      NAMES.forEach((n, i) => c.fillText(n, i * 64 + 32, 34));
      c.textAlign = 'right';
      c.font = '500 30px system-ui, sans-serif';
      c.fillText(key, 1020, 34);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.labelTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.labelCanvas);
    }

    size(w, h) {
      this.w = w;
      this.h = h;
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      const notes = a.playing ? a.notes() : null;
      const pluck = a.playing && (a.hit || a.onset);
      for (let p = 0; p < 12; p += 1) {
        let target = 0;
        let oct = 2;
        if (notes) {
          target = notes.chroma[p] * Math.min(1, 0.4 + notes.tonal) * Math.min(1, 0.35 + a.level * 1.6);
          // Which octave it sounds in: its semitones' levels, weighted.
          let sum = 0;
          let w = 0;
          for (let i = 0; i < notes.count; i += 1) {
            if ((notes.low + i) % 12 !== p) continue;
            const o = Math.floor(i / 12);
            sum += notes.level[i] * o;
            w += notes.level[i];
          }
          if (w > 0.01) oct = sum / w;
        }
        // Plucked on a hit: up at once, then dying away towards how loud it sounds.
        if (pluck && target > 0.5) this.amp[p] = Math.max(this.amp[p], Math.min(1, target * 1.3));
        const k = target > this.amp[p] ? 10 : 2.2;
        this.amp[p] += (target - this.amp[p]) * Math.min(1, dt * k);
        const loops = 1 + Math.min(3, Math.floor(oct * 0.75));
        this.loops[p] += (loops - this.loops[p]) * Math.min(1, dt * 3);
        // The loops change whole: snapped once close.
        if (Math.abs(this.loops[p] - loops) < 0.05) this.loops[p] = loops;
        this.speed[p] = 7 * Math.pow(1.6, oct);
      }
      this.glow += ((a.playing ? a.throb : 0) - this.glow) * Math.min(1, dt * 10);
      if (set('stNames') && notes && notes.key >= 0 && notes.clarity > 0.15) this._labels(`${NAMES[notes.key]} ${notes.minor ? 'minor' : 'major'}`);
      else if (!notes) this._labels('');

      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.labels, this.labelTex, 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1fv(u.amp, this.amp);
      gl.uniform1fv(u.loops, this.loops);
      gl.uniform1fv(u.speed, this.speed);
      gl.uniform1fv(u.phase, this.phase);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.glow, this.glow);
      gl.uniform1i(u.palette, COLORS[set('stColors')] ?? 0);
      gl.uniform1i(u.names, set('stNames') ? 1 : 0);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'strings',
    name: 'Strings',
    desc: 'Twelve strings, one for each note, vibrating as strongly as their notes sound: slow and wide when low, shivering when high',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 10c6-3 12 3 18 0M3 14c4 2 6-2 9 0s5 2 9 0M3 18h18"/></svg>',
    gl: true,
    create: (canvas) => new Strings(canvas),
    options: [
      { type: 'choice', key: 'stColors', label: 'Colours', choices: [['notes', 'Round the notes'], ['gold', 'Gold'], ['ice', 'Ice']] },
      { type: 'check', key: 'stNames', label: "The notes' names and the key" },
    ],
  });
})();
