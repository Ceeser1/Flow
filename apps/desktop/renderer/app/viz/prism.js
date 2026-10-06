'use strict';

// Prism: the song's cover seen through a kaleidoscope. The cover is cut into
// mirrored slices around the middle, turning with the music, drifting
// through the picture, leaning in a little on the kicks and rippling with
// the bass; its colours shift slowly round the wheel. A song without a
// cover gets a pattern of its own colour to turn instead. Or, as Tiles, the
// picture mirrored into an endless floor of tiles drifting past.
//
// Its cogwheel: Kaleidoscope or Tiles, how many slices, how fast it turns,
// the colour shift.
//
// WebGL (viz/gl.js, viz/cover.js): one pass over the screen reading the
// cover (mirrored at its edges, so it never ends).

(() => {
  const NUDGE_S = 0.25;   // a beat's nudge is given over about this long
  const ZOOM_S = 0.3;     // the zoom follows the music this slowly

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D cover;
    uniform vec2 res, drift;
    uniform float segs, angle, zoom, ripple, time, tiles, shift, glow;
    out vec4 o;

    vec3 turnHue(vec3 c, float a) {
      const vec3 k = vec3(0.57735);
      float cs = cos(a);
      return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
    }

    void main() {
      vec2 p = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      float r = length(p);
      vec2 q;
      if (tiles > 0.5) {
        // An endless floor of the picture, mirrored at every edge, turning.
        q = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p * zoom * 1.6;
      } else {
        float slice = 6.2831853 / segs;
        float a = atan(p.y, p.x) + angle;
        a = mod(a, slice);
        a = abs(a - slice * 0.5);
        q = vec2(cos(a), sin(a)) * r * zoom;
      }
      // Rippling out from the middle with the bass.
      q += normalize(p + 1e-5) * sin(r * 26.0 - time * 5.0) * ripple * 0.02;
      vec3 c = texture(cover, q + drift).rgb;
      c = turnHue(c, shift);
      // A little more colour, a soft light in the middle on the kicks, darker edges.
      float grey = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(grey), c, 1.25);
      c *= 0.85 + glow * exp(-r * r * 6.0) * 0.8;
      c *= 1.0 - 0.45 * smoothstep(0.45, 1.05, r);
      c += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`;

  class Prism {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.cover = new VizCover(gl, { standIn: 'pattern' });
      this.angle = 0;
      this.drift = [Math.random(), Math.random()];
      this.heading = Math.random() * Math.PI * 2;
      this.zoom = 1;
      this.owed = 0;      // of the beats' nudges, still to turn
      this.shift = 0;
      this.age = 0;
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

    frame(a, dt) {
      this.age += dt;
      this.cover.update();
      const set = (k) => Visualizer.setting(k);
      const spin = set('psSpin') / 100;
      const music = a.playing ? 1 : 0.2;
      // Turning with the music, a small nudge on each beat: given over a
      // moment rather than at once, which looked like a skipped frame.
      this.owed += a.lock > 0.5 ? (a.tick ? 0.008 + 0.006 * a.beat : 0) : (a.onset ? 0.01 * a.onsetPower : 0);
      const give = this.owed * (1 - Math.exp(-dt / NUDGE_S));
      this.owed -= give;
      this.angle += dt * spin * (0.08 + 0.35 * a.mid + 0.12 * a.throb) * music + give * spin;
      // Drifting through the picture, the way bending slowly.
      this.heading += dt * 0.15 * (Math.sin(this.age * 0.21) + 0.3);
      const pace = dt * 0.025 * (0.4 + a.level) * music * Math.max(0.3, spin);
      this.drift[0] += Math.cos(this.heading) * pace;
      this.drift[1] += Math.sin(this.heading) * pace;
      // A slight lean in on the kicks, eased so it swells rather than jumps.
      const target = 0.55 - 0.025 * a.throb - 0.05 * a.intensity;
      this.zoom += (target - this.zoom) * (1 - Math.exp(-dt / ZOOM_S));
      if (set('psShift')) this.shift = (this.shift + dt * (0.04 + 0.2 * a.treble) * music) % (Math.PI * 2);
      else this.shift *= Math.exp(-dt * 2);

      const gl = this.gl;
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.cover, this.cover.tex, 0);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform2f(u.drift, this.drift[0], this.drift[1]);
      gl.uniform1f(u.segs, Number(set('psSlices')));
      gl.uniform1f(u.angle, this.angle);
      gl.uniform1f(u.zoom, this.zoom);
      gl.uniform1f(u.ripple, 0.5 * a.bass * a.bass);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.tiles, set('psMode') === 'tiles' ? 1 : 0);
      gl.uniform1f(u.shift, this.shift);
      gl.uniform1f(u.glow, 0.6 * a.kick);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'prism',
    name: 'Prism',
    desc: "The song's cover through a kaleidoscope, turning and rippling with the music",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8.66 5v10L12 22l-8.66-5V7z"/><path d="M12 2v20M3.34 7l17.32 10M20.66 7L3.34 17"/></svg>',
    gl: true,
    create: (canvas) => new Prism(canvas),
    options: [
      { type: 'choice', key: 'psMode', label: 'Mirror', choices: [['kaleido', 'Kaleidoscope'], ['tiles', 'Tiles']] },
      { type: 'choice', key: 'psSlices', label: 'Slices', choices: [['4', '4'], ['6', '6'], ['8', '8'], ['12', '12']], when: (s) => s.psMode !== 'tiles' },
      { type: 'slider', key: 'psSpin', label: 'Turning', min: 0, max: 200, step: 5 },
      { type: 'check', key: 'psShift', label: 'Color shift' },
    ],
  });
})();
