'use strict';

// Fireworks: a night sky over a city, the music set off as fireworks. Rockets
// climb all the while (more the more intense the music) and burst on the
// beats: the strongest beat bursts the highest rocket in the air, or one
// bursts high up at once if none is climbing. Bigger beats make bigger
// shells: peonies, rings, golden willows that droop and linger, crossettes
// that split again, and the snares and claps scatter glitter. A big burst
// lights the sky and the city.
//
// Its cogwheel: the colours (festive, gold and silver, the music's), how
// large the bursts are, how long the trails hang, the city.
//
// WebGL (viz/gl.js): the sparks are dots of light drawn into a texture that
// keeps the frames before fading (their trails), blurred for the glow; the
// sky, the stars and the city in one pass over it all. The city is drawn
// once, in Canvas 2D, and kept as a texture.

(() => {
  const MAX_SPARKS = 7000;
  const FESTIVE = [[1, 0.25, 0.3], [0.3, 0.6, 1], [0.35, 1, 0.45], [1, 0.85, 0.3], [0.85, 0.35, 1], [1, 0.55, 0.2], [0.4, 1, 1], [1, 1, 1]];
  const GOLD = [[1, 0.78, 0.35], [1, 0.9, 0.6], [0.95, 0.95, 1], [1, 0.65, 0.25]];

  const FADE_FS = `
    in vec2 uv;
    uniform sampler2D prev;
    uniform float keep;
    out vec4 o;
    void main() {
      o = vec4(max(texture(prev, uv).rgb * keep - 0.002, 0.0), 1.0);
    }`;

  const SKY_FS = VizGL.NOISE + VizGL.STARS + `
    in vec2 uv;
    uniform sampler2D sparks;
    uniform sampler2D glowA;
    uniform sampler2D glowB;
    uniform sampler2D city;
    uniform vec2 res;
    uniform float flash, time, hasCity, boom;
    uniform vec3 flashColor;
    out vec4 o;
    void main() {
      // Deep blue above, a little city glow low down.
      vec3 col = mix(vec3(0.03, 0.035, 0.07), vec3(0.004, 0.006, 0.02), smoothstep(0.0, 0.9, uv.y));
      col += vec3(0.06, 0.04, 0.05) * (1.0 - smoothstep(0.0, 0.3, uv.y)) * hasCity;
      // Stars, twinkling (as Aurora's), fading out low over the city.
      col += starField(gl_FragCoord.xy, time, boom) * smoothstep(0.2, 0.5, uv.y);
      col += flashColor * flash * (0.03 + 0.06 * uv.y);
      // The sparks and their glow.
      col += texture(sparks, uv).rgb + texture(glowA, uv).rgb * 0.9 + texture(glowB, uv).rgb * 1.4;
      // The city in front, lit a little by the bursts.
      if (hasCity > 0.0) {
        vec4 c = texture(city, vec2(uv.x, 1.0 - uv.y));
        vec3 lit = c.rgb + flashColor * flash * 0.06 * c.a;
        col = mix(col, lit, c.a);
      }
      col = 1.0 - exp(-col * 1.3);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  /** The skyline, drawn once at the screen's size: black blocks, some windows lit. */
  function skyline(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const unit = h / 1080;
    let x = -10 * unit;
    while (x < w) {
      const bw = (40 + Math.random() * 110) * unit;
      const tall = Math.random() < 0.15;
      const bh = (tall ? 160 + Math.random() * 180 : 50 + Math.random() * 120) * unit;
      const top = h - bh;
      ctx.fillStyle = '#05060b';
      ctx.fillRect(x, top, bw, bh);
      if (tall && Math.random() < 0.6) {
        // A spire with a red light.
        ctx.fillRect(x + bw / 2 - 1.5 * unit, top - 30 * unit, 3 * unit, 30 * unit);
        ctx.fillStyle = 'rgba(255, 60, 60, 0.9)';
        ctx.fillRect(x + bw / 2 - 2 * unit, top - 33 * unit, 4 * unit, 4 * unit);
      }
      const ww = 4 * unit;
      const wh = 6 * unit;
      for (let y = top + 8 * unit; y < h - 10 * unit; y += 13 * unit) {
        for (let wx = x + 6 * unit; wx < x + bw - 8 * unit; wx += 10 * unit) {
          if (Math.random() < 0.18) {
            const warm = Math.random() < 0.75;
            ctx.fillStyle = warm ? `rgba(255, ${190 + Math.random() * 40 | 0}, 120, ${0.35 + Math.random() * 0.4})` : `rgba(160, 200, 255, ${0.3 + Math.random() * 0.3})`;
            ctx.fillRect(wx, y, ww, wh);
          }
        }
      }
      x += bw + (Math.random() < 0.3 ? Math.random() * 20 * unit : 0);
    }
    return c;
  }

  class Fireworks {
    constructor(canvas) {
      this.starShift = VizGL.starShift();
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.fade = VizGL.program(gl, VizGL.SCREEN_VS, FADE_FS);
      this.sky = VizGL.program(gl, VizGL.SCREEN_VS, SKY_FS);
      this.lines = VizGL.lines(gl, MAX_SPARKS * 6 + 600);
      this.cityTex = gl.createTexture();
      this.sparks = [];
      this.rockets = [];
      this.flash = 0;
      this.flashColor = [1, 1, 1];
      this.age = 0;
      this.owed = 0;
      this.lastBurst = -1;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.a, this.b, this.qa, this.qb, this.ea, this.eb]) VizGL.freeTarget(gl, t);
      this.a = VizGL.target(gl, w, h);
      this.b = VizGL.target(gl, w, h);
      const q = (d) => [Math.max(1, Math.round(w / d)), Math.max(1, Math.round(h / d))];
      this.qa = VizGL.target(gl, ...q(3));
      this.qb = VizGL.target(gl, ...q(3));
      this.ea = VizGL.target(gl, ...q(6));
      this.eb = VizGL.target(gl, ...q(6));
      gl.bindTexture(gl.TEXTURE_2D, this.cityTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, skyline(w, h));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    _colour(a) {
      const set = Visualizer.setting('fwColors');
      if (set === 'gold') return GOLD[Math.floor(Math.random() * GOLD.length)];
      if (set === 'music') {
        // The harmony sounding as a hue (VizAudio.noteHue: related chords
        // near each other); without clear notes the loudest band's place on
        // the spectrum: bass red, highs blue.
        const chord = a.noteHue();
        let hue = chord.hue;
        if (chord.strength < 0.2) {
          let best = 0;
          for (let i = 1; i < a.BANDS; i += 1) if (a.dynamic[i] > a.dynamic[best]) best = i;
          hue = (best / a.BANDS) * 0.75;
        }
        hue += (Math.random() - 0.5) * 0.06;
        const f = (n) => {
          const k = (n + hue * 6 + 6) % 6;
          return 1 - Math.max(0, Math.min(k, 4 - k, 1)) * 0.75;
        };
        return [f(5), f(3), f(1)];
      }
      return FESTIVE[Math.floor(Math.random() * FESTIVE.length)];
    }

    /** A rocket from the ground (behind the city), climbing to burst about where `top` is. */
    _launch() {
      const h = this.h;
      const unit = h / 1080;
      const top = h * (0.12 + Math.random() * 0.3);
      // v² = 2 g s, so it would stop at its top.
      const g = 260 * unit;
      const vy = -Math.sqrt(2 * g * (h * 0.98 - top));
      this.rockets.push({ x: this.w * (0.1 + Math.random() * 0.8), y: h * 0.98, vx: (Math.random() - 0.5) * 60 * unit, vy, g });
    }

    /** A shell bursting at (x, y), as big as power 0..1. */
    _burst(x, y, power, a) {
      const unit = this.h / 1080;
      const size = Visualizer.setting('fwSize') / 100;
      const r = Math.random();
      const kind = power > 0.8 && r < 0.3 ? 'willow' : (power > 0.6 && r < 0.45 ? 'ring' : (power > 0.5 && r < 0.6 ? 'crossette' : 'peony'));
      const colour = this._colour(a);
      const second = Math.random() < 0.35 ? this._colour(a) : colour;
      const count = Math.round((90 + 260 * power) * Math.min(1.6, size));
      const speed = (180 + 320 * power) * unit * size;
      const tilt = Math.random() * Math.PI;
      for (let i = 0; i < count && this.sparks.length < MAX_SPARKS; i += 1) {
        let vx;
        let vy;
        if (kind === 'ring') {
          // A ring seen at a slant.
          const ang = (i / count) * Math.PI * 2;
          const cx = Math.cos(ang);
          const cy = Math.sin(ang) * 0.45;
          vx = (cx * Math.cos(tilt) - cy * Math.sin(tilt)) * speed;
          vy = (cx * Math.sin(tilt) + cy * Math.cos(tilt)) * speed;
        } else {
          // Evenly over a sphere, seen from the side.
          const u = Math.random() * 2 - 1;
          const ang = Math.random() * Math.PI * 2;
          const s = Math.sqrt(1 - u * u);
          const v = speed * (0.85 + Math.random() * 0.3);
          vx = Math.cos(ang) * s * v;
          vy = Math.sin(ang) * s * v;
        }
        const willow = kind === 'willow';
        // A ring flies out fast and stops short, so its trails do not fill it in.
        const ring = kind === 'ring';
        if (ring) {
          vx *= 2.6;
          vy *= 2.6;
        }
        this.sparks.push({
          x, y, vx, vy,
          life: 1,
          fade: willow ? 0.32 + Math.random() * 0.1 : 0.55 + Math.random() * 0.35,
          drag: willow ? 2.4 : (ring ? 6 : 1.6),
          g: (willow ? 70 : 110) * unit,
          rgb: willow ? [1, 0.72, 0.3] : (i % 2 ? colour : second),
          size: (willow ? 1.5 : 1.9) * unit,
          split: kind === 'crossette' && i % 6 === 0 ? 0.45 + Math.random() * 0.15 : 0,
          twinkle: Math.random() < 0.3,
        });
      }
      this.flash = Math.min(1, this.flash + 0.25 + 0.5 * power);
      this.flashColor = colour;
      this.lastBurst = this.age;
    }

    /** Glitter: a small scatter of white sparks. */
    _glitter(x, y, power) {
      const unit = this.h / 1080;
      for (let i = 0; i < 30 + 50 * power && this.sparks.length < MAX_SPARKS; i += 1) {
        const ang = Math.random() * Math.PI * 2;
        const v = (40 + Math.random() * 120) * unit;
        this.sparks.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, life: 1, fade: 1.2 + Math.random(), drag: 2, g: 60 * unit, rgb: [1, 0.95, 0.85], size: 1.2 * unit, split: 0, twinkle: true });
      }
    }

    _listen(a, dt) {
      if (!a.playing) {
        // Now and then, quietly.
        if (this.age - this.lastBurst > 5 && Math.random() < dt * 0.3) this._burst(this.w * (0.2 + Math.random() * 0.6), this.h * (0.2 + Math.random() * 0.25), 0.3, a);
        return;
      }
      // Keep some climbing, more in intense parts.
      this.owed += dt * (0.8 + 2.8 * a.intensity);
      while (this.owed >= 1) {
        this.owed -= 1;
        if (this.rockets.length < 8) this._launch();
      }
      if (a.onset && this.age - this.lastBurst > 0.12) {
        const power = Math.min(1, 0.3 * a.onsetPower + 0.5 * a.beat + 0.3 * a.intensity);
        // The highest rocket climbing bursts now; none: one high up at once.
        let best = null;
        for (const r of this.rockets) if (!best || r.y < best.y) best = r;
        if (best && best.y < this.h * 0.75) {
          this.rockets.splice(this.rockets.indexOf(best), 1);
          this._burst(best.x, best.y, power, a);
        } else {
          this._burst(this.w * (0.15 + Math.random() * 0.7), this.h * (0.15 + Math.random() * 0.3), power * 0.85, a);
        }
      } else if (a.hit && Math.random() < 0.35) {
        this._glitter(this.w * (0.15 + Math.random() * 0.7), this.h * (0.15 + Math.random() * 0.4), a.hitPower);
      }
    }

    frame(a, dt) {
      this.age += dt;
      this._listen(a, dt);
      const lines = this.lines;
      const unit = this.h / 1080;

      // The rockets climbing, a spark trail behind each; one that tops out bursts anyway.
      for (const r of this.rockets) {
        r.vy += r.g * dt;
        r.x += r.vx * dt;
        r.y += r.vy * dt;
        lines.dot(r.x, r.y, 2.2 * unit, [1, 0.8, 0.5], 0.9);
        if (Math.random() < 0.7 && this.sparks.length < MAX_SPARKS) {
          this.sparks.push({ x: r.x, y: r.y, vx: (Math.random() - 0.5) * 30 * unit, vy: 20 * unit, life: 0.5, fade: 2.5, drag: 3, g: 40 * unit, rgb: [1, 0.6, 0.25], size: 1.1 * unit, split: 0, twinkle: false });
        }
        if (r.vy >= -20 * unit) {
          r.done = true;
          this._burst(r.x, r.y, 0.35 + 0.3 * a.intensity, a);
        }
      }
      this.rockets = this.rockets.filter((r) => !r.done);

      // The sparks.
      const born = [];
      for (const s of this.sparks) {
        const k = Math.exp(-s.drag * dt);
        s.vx *= k;
        s.vy = s.vy * k + s.g * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const before = s.life;
        s.life -= s.fade * dt;
        if (s.split && before > s.split && s.life <= s.split) {
          // A crossette splits into four.
          for (let i = 0; i < 4; i += 1) {
            const ang = (i / 4) * Math.PI * 2 + Math.random();
            const v = 90 * unit;
            born.push({ ...s, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, split: 0, life: s.life, fade: 1.1 });
          }
          s.life = 0;
          continue;
        }
        let alpha = Math.max(0, s.life) ** 0.7 * 0.7;
        if (s.twinkle) alpha *= 0.4 + 0.6 * Math.abs(Math.sin(this.age * 30 + s.x));
        lines.dot(s.x, s.y, s.size * (0.8 + 0.6 * s.life), s.rgb, alpha);
      }
      this.sparks = this.sparks.filter((s) => s.life > 0 && s.y < this.h + 20);
      for (const s of born) if (this.sparks.length < MAX_SPARKS) this.sparks.push(s);
      this.flash *= Math.exp(-dt * 5);

      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      // 1. The trails fade, by Trails.
      const keep = Math.pow(0.02 + 0.9 * (set('fwTrails') / 100) ** 0.35, dt * 6);
      gl.disable(gl.BLEND);
      gl.useProgram(this.fade.p);
      VizGL.into(gl, this.b);
      VizGL.bind(gl, this.fade.u.prev, this.a.tex, 0);
      gl.uniform1f(this.fade.u.keep, Math.min(0.985, keep));
      VizGL.screen(gl);
      // 2. The sparks as light.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      lines.draw(this.w, this.h);
      gl.disable(gl.BLEND);
      // 3. The glow.
      VizGL.blur(gl, this.b, this.qa, this.qb, 1.4);
      VizGL.blur(gl, this.qb, this.ea, this.eb, 2.2);
      // 4. The sky, the sparks, the city.
      VizGL.into(gl, null);
      gl.useProgram(this.sky.p);
      const u = this.sky.u;
      VizGL.bind(gl, u.sparks, this.b.tex, 0);
      VizGL.bind(gl, u.glowA, this.qb.tex, 1);
      VizGL.bind(gl, u.glowB, this.eb.tex, 2);
      VizGL.bind(gl, u.city, this.cityTex, 3);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.flash, this.flash);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.boom, a.kick);
      gl.uniform2f(u.starShift, ...this.starShift);
      gl.uniform1f(u.hasCity, set('fwCity') ? 1 : 0);
      gl.uniform3f(u.flashColor, ...this.flashColor);
      VizGL.screen(gl);

      [this.a, this.b] = [this.b, this.a];
    }
  }

  Visualizer.add({
    id: 'fireworks',
    name: 'Fireworks',
    desc: 'Fireworks over a city at night, bursting on the beats: bigger shells for bigger beats, glitter on the snares',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 9V3M12 9l4-4M12 9l-4-4M12 9l5 1M12 9l-5 1M12 9l3 4M12 9l-3 4M12 22v-6"/></svg>',
    gl: true,
    create: (canvas) => new Fireworks(canvas),
    options: [
      { type: 'choice', key: 'fwColors', label: 'Colors', choices: [['festive', 'Festive'], ['gold', 'Gold & silver'], ['music', 'The music']] },
      { type: 'slider', key: 'fwSize', label: 'Bursts', min: 50, max: 200, step: 5 },
      { type: 'slider', key: 'fwTrails', label: 'Trails', min: 0, max: 100, step: 5 },
      { type: 'check', key: 'fwCity', label: 'City' },
    ],
  });
})();
