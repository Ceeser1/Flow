'use strict';

// The clouds behind the content: a few large, shapeless clouds of deep colour,
// each a wide core with a far, faint shine around it, that drift about slowly
// and never stop. Each one also comes and goes on its own slow cycle, so at
// any time some of the background is plain and some is tinted, and it is
// never the same twice. While a song plays they breathe with it: a kick or a
// bass note that stands out from the last half second swells and brightens
// them a little.
//
// A cloud is a loose scatter of puffs, each drifting and swelling on its own.
// A puff is a round glow that falls off like a bell curve, a dense middle
// running out into a wide, faint shine, drawn with many colour steps so the
// fall-off has no corners. Where puffs overlap the cloud is denser, which is
// what gives it its uneven, changing shape. (Not the canvas blur filter: at
// these widths Chromium blurs in shrunk-down stages, which leaves streaks.)
//
// The visible canvas is solid: it is painted with the page background first
// and the clouds are mixed into that. A see-through canvas holding such faint
// colour keeps too few steps of it (colour and see-through are each rounded
// to 256 steps, and at a few percent the two roundings disagree), which shows
// as rings that fade out and start again. Solid, only the colour is rounded,
// in steps too small to see.
//
// At full size: Chromium speckles colour fades by a step to hide banding,
// invisible pixel by pixel, but a canvas drawn smaller and stretched turns the
// speckles into a grid. The equalizer's canvas lies on top of this one.
//
// With WebGL 2 (and float targets) they are drawn there instead: the same
// puffs, laid over each other the same way, into a quarter-size picture of
// half floats, then stretched over the screen with a speckle of its own at
// each of the screen's pixels (the clouds are so soft that the quarter size
// loses nothing, and the speckle hides the steps as Chromium's does). Drawn
// at full size by the canvas, the puffs' wide gradients were most of the
// app's GPU work.
//
// Settings: in Rainbow each cloud takes a random colour every time it comes
// back; a solid scheme gives them all that one. The amount at 50% is the
// first half of CLOUDS (the look as designed), 100% all of them, 0% none.
//
// Show Cover as background (a computer's window): the playing song's big
// cover on the background, under the clouds, at its Visibility, in the middle
// of what shows of the list (between the bottom of its column names, where
// they are now, and the player bar; pages without a list from their top), 80%
// as tall as that, its corners rounded by 5% of its size. In WebGL the clouds
// are then drawn onto nothing (their colour and how much they cover) and laid
// over the background with the cover on it, which is the same picture as
// before while there is no cover.
//
// The cover has no edge to see, it comes out of the background: from a little
// inside its edge it thins more and more, through the edge, to nothing well
// outside it (the same at every Visibility). Its last few percent blur more
// and more towards the edge, and outside it the picture goes on as a blur of
// that outer band (mirrored at the edge, never the last row of pixels pulled
// outwards). That picture, the cover with its surround, is made once when a cover
// has loaded (_bake), not while drawing: a frame only reads it. A plain frame
// round the artwork (a white border in the file) is left out first, so the
// surround has the artwork's colours and not the frame's.

const Ambient = {
  canvas: null,
  background: '#1e1e22',
  raf: null,
  lastDraw: 0,
  lastFrame: 0,
  time: 0,          // seconds of drift so far
  bassAverage: 0,
  pulse: 0,         // 0..1, the swell of the last bass hit
  frozen: false,    // Windows' "Show animations" off: the clouds stand still
  started: false,   // the canvas's drawing is made (not yet after a start in the tray)
  coverPic: null,   // the cover shown (Show Cover as background) with its surround, baked: { image, pad }, or null
  coverKey: '',     // the song and address it is (or is being) loaded for
  coverJob: null,   // the baking under way, if any (another one, or none, ends it)
  coverBox: null,   // where it goes: { x, y, size } in the canvas's pixels
  coverPiece: null, // the canvas way's copy of it with the fade in it: { pic, canvas }
  lastPlace: 0,
  PLACE_MS: 250,    // how often its place is looked at again (pages, banners)
  scrolled: false,  // the page was scrolled since: its place is looked at with the next frame
  COVER_SHARE: 0.8, // its height against the room it is in the middle of
  COVER_ROUND: 0.05,
  // The cover has no edge to see: it thins from COVER_FADE_IN inside its edge
  // to nothing COVER_FADE outside it (against its width, the same at every
  // Visibility), along a bell curve (FADE_BELL: how far down the bell it is
  // cut off), which leaves it about half as solid at the edge itself.
  COVER_FADE_IN: 0.12,
  COVER_FADE: 0.2,
  FADE_BELL: 5,
  // The baked picture (all against the cover's width): the cover at most
  // COVER_PIXELS wide (the big covers' size), the blur beginning BLUR_IN
  // inside its edge, as strong as BLUR_EDGE at the edge (a bell curve's
  // width) and BLUR_END from BLUR_OUT outside it on.
  COVER_PIXELS: 512,
  COVER_BLUR_IN: 0.044,
  COVER_BLUR_EDGE: 0.0165,
  COVER_BLUR_END: 0.044,
  COVER_BLUR_OUT: 0.11,
  BAKE_MS: 3,       // of making it, then the page's turn again
  BAKE_STEP: 60000, // pixels blurred in one part of making it (well under a millisecond)
  // A plain frame round the artwork is left out when it is at most this wide
  // on every side, one colour (each channel within FRAME_STEP of it, in
  // FRAME_PLAIN of a row's pixels), and ends at once (FRAME_OVER of the row
  // after it another colour).
  COVER_FRAME: 0.08,
  FRAME_STEP: 18,
  FRAME_PLAIN: 0.95,
  FRAME_OVER: 0.5,

  IDLE_FPS: 24,     // without a song they only drift, which needs no more
  // One puff: its strength in the middle, and how far the shine reaches, in
  // puff radii. Where several overlap the cloud gets stronger.
  PUFF_ALPHA: 0.1,   // at Settings' 50% intensity; 100% doubles it
  SHINE_SHARE: 0.35, // the shine's strength against the core's
  SHINE_WIDTH: 2.2,  // the shine's width against the core's
  REACH: 3.4,        // where the puff has faded to nothing
  STOPS: 24,
  // The pulse: bass above its own average of the last AVERAGE_MS by more than
  // THRESHOLD, rising over ATTACK_MS and falling back over RELEASE_MS.
  AVERAGE_MS: 500,
  THRESHOLD: 0.06,
  GAIN: 2.3,
  ATTACK_MS: 40,
  RELEASE_MS: 280,
  PULSE_ALPHA: 0.8, // a full pulse makes a cloud this much brighter
  PULSE_GROW: 0.08, // and this much larger (both at Settings' 25% reaction)
  PUFFS: 9,         // per cloud

  // Each cloud: saturation and lightness of its colour (the hue is Rainbow's
  // pick), size (share of the larger side), the slow paths it drifts along
  // (centre, reach and period in seconds, for x and for y), and how long one
  // round of coming and going takes. It is away for about a third of that.
  CLOUDS: [
    { sat: 90, light: 46, size: 0.24, x: [0.2, 0.2, 97], y: [0.3, 0.2, 131], hueSwing: 14, cycle: 71 },
    { sat: 85, light: 48, size: 0.22, x: [0.78, 0.16, 113], y: [0.25, 0.18, 89], hueSwing: 18, cycle: 97 },
    { sat: 90, light: 38, size: 0.22, x: [0.6, 0.28, 149], y: [0.7, 0.2, 103], hueSwing: 12, cycle: 83 },
    { sat: 85, light: 46, size: 0.2, x: [0.3, 0.24, 167], y: [0.75, 0.18, 119], hueSwing: 16, cycle: 109 },
    { sat: 80, light: 50, size: 0.22, x: [0.5, 0.32, 83], y: [0.45, 0.26, 157], hueSwing: 20, cycle: 61 },
    { sat: 85, light: 44, size: 0.18, x: [0.85, 0.1, 139], y: [0.6, 0.26, 127], hueSwing: 14, cycle: 131 },
    // Above 50%.
    { sat: 85, light: 44, size: 0.2, x: [0.4, 0.3, 107], y: [0.2, 0.15, 137], hueSwing: 14, cycle: 79 },
    { sat: 88, light: 42, size: 0.21, x: [0.7, 0.22, 127], y: [0.45, 0.3, 101], hueSwing: 16, cycle: 103 },
    { sat: 80, light: 48, size: 0.19, x: [0.15, 0.12, 151], y: [0.6, 0.3, 109], hueSwing: 12, cycle: 89 },
    { sat: 85, light: 45, size: 0.23, x: [0.55, 0.35, 173], y: [0.85, 0.12, 113], hueSwing: 18, cycle: 127 },
    { sat: 90, light: 40, size: 0.18, x: [0.9, 0.08, 93], y: [0.15, 0.12, 143], hueSwing: 14, cycle: 67 },
    { sat: 82, light: 47, size: 0.2, x: [0.35, 0.28, 131], y: [0.5, 0.35, 163], hueSwing: 16, cycle: 113 },
  ],

  // The solid schemes: [hue, saturation, lightness], as the equalizer's.
  SOLID: {
    white: [0, 0, 78],
    red: [0, 85, 46],
    green: [130, 70, 40],
    yellow: [52, 95, 48],
    blue: [215, 90, 50],
    purple: [275, 75, 52],
    black: [0, 0, 0],
  },

  init() {
    this.canvas = $('ambientCanvas');
    if (!this.canvas) return;
    this.background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || this.background;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.frozen = motion.matches;
    motion.addEventListener('change', () => {
      this.frozen = motion.matches;
    });
    this._makeFalloff();
    this._makePuffs();
    // Each start somewhere else along the paths.
    this.time = Math.random() * 600;
    Store.onSettings((patch) => {
      if ('coverBgOn' in patch) this._wantCover();
      if (['cloudsOn', 'cloudsIntensity', 'cloudsColors', 'cloudsAmount', 'coverBgOn', 'coverBgVisibility'].some((k) => k in patch)) this._draw();
    });
    Player.onChange(() => this._wantCover());
    Covers.onArrived((ids) => {
      if (!Player.currentId || (ids && !ids.includes(Player.currentId))) return;
      // Asked again: the big one may be there now.
      this.coverKey = '';
      this._wantCover();
    });
    this._wantCover();
    // Started in the tray, nothing is made or drawn until the window is opened (rest).
    if (!Store.away) this._start();
  },

  /** The canvas's drawing made, and the frames started. */
  _start() {
    if (this.started) return;
    this.started = true;
    this.gl = this._webgl();
    if (this.gl && this.coverPic && !this.gl.cover(this.coverPic)) this.coverPic = null;
    this._layout();
    new ResizeObserver(() => this._layout()).observe(document.querySelector('.content'));
    // Scrolling moves the list's column names, and with them the cover's room.
    const pages = $('pages');
    if (pages) {
      pages.addEventListener('scroll', () => {
        this.scrolled = true;
      }, { passive: true });
    }
    this.raf = requestAnimationFrame((t) => this._frame(t));
  },

  /**
   * The window goes into the tray (true): no more frames. It is back
   * (false): they drift on from where they stood, or start now if the window
   * began in the tray.
   */
  rest(on) {
    if (!this.canvas) return;
    if (on) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
      return;
    }
    if (!this.started) {
      this._start();
      return;
    }
    if (this.raf !== null) return;
    // The time away is not drifted through in one step.
    this.lastFrame = 0;
    this.lastDraw = 0;
    this.raf = requestAnimationFrame((t) => this._frame(t));
  },

  /**
   * The clouds in WebGL 2, or null (then the canvas draws them): size(w, h)
   * when the canvas changes, draw(n) the first n of puffData (none: the
   * plain background). Each puff a square round it (instanced), its colour
   * at its strength times falloff (the same steps, read between them as
   * the canvas's gradient does) laid over what is there, as the canvas lays
   * it; into a quarter-size half-float target, then stretched onto the
   * screen with a speckle of a 255th at each pixel.
   */
  _webgl() {
    let gl = null;
    try {
      gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      // No float target: back to the canvas (a fresh one, this one being WebGL's now).
      const fresh = this.canvas.cloneNode(false);
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
      return null;
    }
    const shader = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, `#version 300 es
precision highp float;
${src}`);
      gl.compileShader(sh);
      return sh;
    };
    const program = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`clouds: ${gl.getProgramInfoLog(p)}`);
      return p;
    };
    const STOPS = this.STOPS;
    let puffProg;
    let showProg;
    try {
      puffProg = program(`
        layout(location = 0) in vec4 puff;     // x, y, reach (pixels, y down), strength
        layout(location = 1) in vec3 colour;
        uniform vec2 res;
        out vec2 at;                           // where in the puff, in reaches
        flat out vec4 col;
        void main() {
          int k = gl_VertexID;
          vec2 corner = vec2(k == 1 || k == 4 || k == 5 ? 1.0 : -1.0, k == 2 || k == 3 || k == 5 ? 1.0 : -1.0);
          at = corner;
          col = vec4(colour, puff.w);
          vec2 p = puff.xy + corner * puff.z;
          gl_Position = vec4(p.x / res.x * 2.0 - 1.0, 1.0 - p.y / res.y * 2.0, 0.0, 1.0);
        }`, `
        in vec2 at;
        flat in vec4 col;
        uniform float falloff[${STOPS + 1}];
        out vec4 o;
        void main() {
          float k = min(length(at), 1.0) * ${STOPS}.0;
          int i = min(int(k), ${STOPS - 1});
          float v = mix(falloff[i], falloff[i + 1], k - float(i));
          o = vec4(col.rgb, col.a * v);
        }`);
      showProg = program(`
        out vec2 uv;
        void main() {
          vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
          uv = p;
          gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
        }`, `
        in vec2 uv;
        uniform sampler2D clouds;              // their colour times how much they cover, and that
        uniform sampler2D cover;               // the cover with its surround (baked)
        uniform float pad;                     // the surround's width on each side, against the cover's
        uniform vec2 part;                     // how much of the target the screen covers (from its top left)
        uniform vec3 bg;
        uniform float screenH;
        uniform vec4 box;                      // the cover's left, top, size and corner radius (pixels, y down)
        uniform float coverAlpha;              // 0: no cover
        uniform vec2 fade;                     // how far inside the cover's edge it begins to thin, and how far outside it is gone (pixels)
        uniform float bell;                    // how far down the bell curve it thins along is cut off
        out vec4 o;
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * .1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        void main() {
          vec4 c = texture(clouds, vec2(uv.x * part.x, 1.0 - (1.0 - uv.y) * part.y));
          vec3 base = bg;
          if (coverAlpha > 0.0) {
            vec2 px = vec2(gl_FragCoord.x, screenH - gl_FragCoord.y);
            // The cover's core (the cover drawn in by fade.x, its corners as round) shows whole. From
            // there outwards it thins along a bell curve, through its edge, to nothing fade.y outside
            // it (the baked surround): no edge to see, the picture comes out of the background.
            vec2 d = abs(px - box.xy - vec2(box.z * 0.5)) - vec2(box.z * 0.5 - fade.x) + box.w;
            float away = clamp((length(max(d, 0.0)) - box.w) / max(fade.x + fade.y, 1.0), 0.0, 1.0);
            float m = (exp(-bell * away * away) - exp(-bell)) / (1.0 - exp(-bell)) * coverAlpha;
            base = mix(bg, texture(cover, ((px - box.xy) / box.z + pad) / (1.0 + 2.0 * pad)).rgb, m);
          }
          o = vec4(c.rgb + base * (1.0 - c.a) + (hash12(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
        }`);
    } catch (err) {
      console.warn(err);
      return null;
    }
    const u = {
      res: gl.getUniformLocation(puffProg, 'res'),
      falloff: gl.getUniformLocation(puffProg, 'falloff[0]'),
      clouds: gl.getUniformLocation(showProg, 'clouds'),
      cover: gl.getUniformLocation(showProg, 'cover'),
      pad: gl.getUniformLocation(showProg, 'pad'),
      part: gl.getUniformLocation(showProg, 'part'),
      bg: gl.getUniformLocation(showProg, 'bg'),
      screenH: gl.getUniformLocation(showProg, 'screenH'),
      box: gl.getUniformLocation(showProg, 'box'),
      coverAlpha: gl.getUniformLocation(showProg, 'coverAlpha'),
      fade: gl.getUniformLocation(showProg, 'fade'),
      bell: gl.getUniformLocation(showProg, 'bell'),
    };
    gl.useProgram(puffProg);
    gl.uniform1fv(u.falloff, this.falloff.map(([, v]) => v));
    // The puffs, one instance each: x, y, reach, strength, r, g, b.
    const data = new Float32Array(this.CLOUDS.length * this.PUFFS * 7);
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 28, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    // The background as the canvas has it, 0..1.
    const probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = this.background;
    const hex = probe.fillStyle;
    const bg = /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255) : [30 / 255, 30 / 255, 34 / 255];
    let target = null;
    let w = 1;
    let h = 1;
    const coverTex = gl.createTexture();
    let hasCover = false;
    let pad = 0;
    return {
      /** The baked cover ({ image, pad }) into its texture (with mipmaps); false when that fails. */
      cover: (pic) => {
        gl.bindTexture(gl.TEXTURE_2D, coverTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pic.image);
          hasCover = true;
        } catch {
          hasCover = false;
        }
        if (!hasCover) return false;
        pad = pic.pad;
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return true;
      },
      size: (cw, ch) => {
        w = cw;
        h = ch;
        const tw = Math.max(1, Math.ceil(cw / 4));
        const th = Math.max(1, Math.ceil(ch / 4));
        if (target && target.w === tw && target.h === th) return;
        if (target) {
          gl.deleteTexture(target.tex);
          gl.deleteFramebuffer(target.fb);
        }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, tw, th, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        target = { tex, fb, w: tw, h: th };
      },
      /** n puffs, and the cover where box says ({ x, y, size }) at alpha (0: none). */
      draw: (n, box, alpha) => {
        if (!target) return;
        const showCover = hasCover && !!box && alpha > 0;
        if (!n && !showCover) {
          // The plain background, straight onto the screen.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
          gl.clearColor(bg[0], bg[1], bg[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          return;
        }
        const P = this.puffData;
        for (let k = 0; k < n; k += 1) {
          const q = k * 7;
          data[q] = P[q];
          data[q + 1] = P[q + 1];
          data[q + 2] = P[q + 2];
          data[q + 3] = P[q + 6];
          data[q + 4] = P[q + 3];
          data[q + 5] = P[q + 4];
          data[q + 6] = P[q + 5];
        }
        // The clouds onto nothing: their colour times how much they cover
        // (laid over each other as before), and how much that is.
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
        gl.viewport(0, 0, target.w, target.h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (n) {
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(puffProg);
          // The quarter-size target covers the pixels the screen's would (4 a texel).
          gl.uniform2f(u.res, target.w * 4, target.h * 4);
          gl.bindVertexArray(vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * 7);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
          gl.bindVertexArray(null);
          gl.disable(gl.BLEND);
        }
        // Over the background, the cover on it.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.useProgram(showProg);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, coverTex);
        gl.uniform1i(u.cover, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        gl.uniform1i(u.clouds, 0);
        gl.uniform2f(u.part, w / (target.w * 4), h / (target.h * 4));
        gl.uniform3f(u.bg, bg[0], bg[1], bg[2]);
        gl.uniform1f(u.screenH, gl.drawingBufferHeight);
        if (showCover) gl.uniform4f(u.box, box.x, box.y, box.size, box.size * this.COVER_ROUND);
        gl.uniform1f(u.coverAlpha, showCover ? alpha : 0);
        gl.uniform1f(u.pad, pad);
        gl.uniform2f(u.fade, showCover ? box.size * this.COVER_FADE_IN : 0, showCover ? box.size * this.COVER_FADE : 0);
        gl.uniform1f(u.bell, this.FADE_BELL);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  },

  /**
   * Each cloud's puffs: scattered wide around its middle (the same every
   * start), each wandering and swelling on its own periods, so the cloud has
   * no shape to speak of and a different one every minute.
   */
  _makePuffs() {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (const cl of this.CLOUDS) {
      // Some lie, some stand.
      const stretch = 0.6 + rand() * 1.1;
      cl.puffs = [];
      for (let k = 0; k < this.PUFFS; k += 1) {
        const angle = rand() * Math.PI * 2;
        const dist = Math.sqrt(rand()) * 1.3;
        cl.puffs.push({
          dx: Math.cos(angle) * dist * stretch,
          dy: Math.sin(angle) * dist / stretch,
          r: 0.25 + rand() * 0.45,
          wander: 0.25 + rand() * 0.35,
          period: 31 + rand() * 50,
          phase: rand() * Math.PI * 2,
        });
      }
    }
  },

  /**
   * A puff's strength from its middle (0) to its edge (1), sampled at STOPS
   * points: a bell curve for the core plus a wider, fainter one for the shine,
   * lowered so it ends at exactly nothing.
   */
  _makeFalloff() {
    const at = (u) => Math.exp(-u * u) + this.SHINE_SHARE * Math.exp(-(u * u) / (this.SHINE_WIDTH * this.SHINE_WIDTH));
    const end = at(this.REACH);
    const top = at(0) - end;
    this.falloff = [];
    for (let k = 0; k <= this.STOPS; k += 1) {
      const d = k / this.STOPS;
      this.falloff.push([d, Math.max(0, (at(d * this.REACH) - end) / top)]);
    }
  },

  _layout() {
    const content = document.querySelector('.content');
    const w = Math.max(1, content.clientWidth);
    const h = Math.max(1, content.clientHeight);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (this.gl) this.gl.size(w, h);
    this._draw();
  },

  _frame(now) {
    this.raf = requestAnimationFrame((t) => this._frame(t));
    const dt = Math.min(100, Math.max(0, now - (this.lastFrame || now)));
    this.lastFrame = now;
    // The cover's place: another page, a banner over the list (looked at now
    // and then), the list scrolled (looked at with this frame, so it follows).
    const scrolled = this.scrolled;
    this.scrolled = false;
    let moved = false;
    if (this.coverPic && !Visualizer.shown && (scrolled || now - this.lastPlace >= this.PLACE_MS)) {
      this.lastPlace = now;
      moved = this._place();
    }
    // Turned off in Settings: the plain background, drawn once by _draw (and when the cover moved).
    if (Store.settings.cloudsOn === false) {
      if (moved) this._draw();
      return;
    }
    this._follow(dt);
    // Under the full-screen visualizer nobody would see them: they were
    // about half the GPU's work there, drawn for nothing.
    if (Visualizer.shown) return;
    // With nothing playing and no pulse left to fade, fewer frames will do (a cover that moved is drawn at once).
    const lively = Equalizer.bass > 0 || this.pulse > 0.002;
    if (!moved && !lively && now - this.lastDraw < 1000 / this.IDLE_FPS) return;
    if (!this.frozen) this.time += (now - (this.lastDraw || now)) / 1000;
    this.lastDraw = now;
    this._draw();
  },

  /** The bass pulse, from the equalizer's bass level. */
  _follow(dt) {
    const bass = Equalizer.bass || 0;
    // A song starting is not a hit: the average starts where the bass is.
    if (bass > 0 && !this._hearing) this.bassAverage = bass;
    this._hearing = bass > 0;
    this.bassAverage += (bass - this.bassAverage) * (1 - Math.exp(-dt / this.AVERAGE_MS));
    const hit = Math.min(1, Math.max(0, bass - this.bassAverage - this.THRESHOLD) * this.GAIN);
    this.pulse = hit > this.pulse
      ? this.pulse + (hit - this.pulse) * (1 - Math.exp(-dt / this.ATTACK_MS))
      : hit + (this.pulse - hit) * Math.exp(-dt / this.RELEASE_MS);
  },

  _draw() {
    const c = this.canvas;
    if (!c || !this.started) return;
    const s = Store.settings;
    const puffs = s.cloudsOn === false ? 0 : this._puffs(c.width, c.height);
    if (this.coverPic && !this.coverBox) this._place();
    const box = this.coverPic ? this.coverBox : null;
    const alpha = box && s.coverBgOn ? (Number(s.coverBgVisibility) || 0) / 100 : 0;
    if (this.gl) {
      this.gl.draw(puffs, box, alpha);
      return;
    }
    const out = c.getContext('2d');
    out.fillStyle = this.background;
    out.fillRect(0, 0, c.width, c.height);
    if (alpha > 0) {
      // The baked cover with its fade in it, the surround reaching past the box.
      const more = box.size * this.coverPic.pad;
      out.globalAlpha = alpha;
      out.drawImage(this._piece(), box.x - more, box.y - more, box.size + more * 2, box.size + more * 2);
      out.globalAlpha = 1;
    }
    const P = this.puffData;
    for (let k = 0; k < puffs; k += 1) {
      const q = k * 7;
      const px = P[q];
      const py = P[q + 1];
      const reach = P[q + 2];
      const colour = this.puffColour[k];
      const strength = P[q + 6];
      const grad = out.createRadialGradient(px, py, 0, px, py, reach);
      for (const [d, v] of this.falloff) grad.addColorStop(d, colour + (strength * v).toFixed(4) + ')');
      out.fillStyle = grad;
      out.fillRect(px - reach, py - reach, reach * 2, reach * 2);
    }
  },

  /**
   * The canvas way's picture: the baked cover with its fade in it (how solid
   * each pixel is, as the WebGL way works it out while drawing), made once
   * for a cover, not for every frame.
   */
  _piece() {
    const pic = this.coverPic;
    const was = this.coverPiece;
    if (was && was.pic === pic) return was.canvas;
    const P = pic.image.width;
    const S = Math.round(P / (1 + 2 * pic.pad));
    const M = (P - S) / 2;
    const data = new Uint8ClampedArray(pic.image.data);
    for (let y = 0; y < P; y += 1) {
      for (let x = 0; x < P; x += 1) {
        const i = y * P + x;
        // In whole steps with a speckle of one step (no bands in the long faint end).
        let hash = Math.imul(i + 1, 0x9e3779b1);
        hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca77);
        data[i * 4 + 3] = 255 * this._solid(x + 0.5 - M, y + 0.5 - M, S) + ((hash ^ (hash >>> 13)) >>> 0) / 4294967296 - 0.5;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = P;
    canvas.height = P;
    canvas.getContext('2d').putImageData(new ImageData(data, P, P), 0, 0);
    this.coverPiece = { pic, canvas };
    return canvas;
  },

  /**
   * Show Cover as background: the playing song's big cover loaded (the
   * thumbnail standing in until it is here) and baked with its surround, or
   * none; the one shown stays until the next is ready. Drawn once it is.
   */
  _wantCover() {
    const s = Store.settings;
    const id = Player.currentId;
    const song = s.coverBgOn && !Store.phone && id ? Store.song(id) || (Player.remote ? { ...Player.remote.state, id } : null) : null;
    const list = song ? Covers.candidates(song, 'big') : [];
    const key = list.length ? `${id}|${list[0]}` : '';
    if (key === this.coverKey) return;
    this.coverKey = key;
    // A cover still being baked is no longer the one wanted.
    this.coverJob = null;
    const none = () => {
      if (!this.coverPic) return;
      this.coverPic = null;
      this.coverPiece = null;
      this._draw();
    };
    if (!key) {
      none();
      return;
    }
    const img = new Image();
    let at = 0;
    img.onload = () => {
      if (this.coverKey !== key) return;
      const job = {};
      this.coverJob = job;
      this._bake(img, () => this.coverJob === job, (pic) => {
        this.coverJob = null;
        if (!pic || (this.gl && !this.gl.cover(pic))) {
          none();
          return;
        }
        this.coverPic = pic;
        this.coverPiece = null;
        this._place();
        this._draw();
      });
    };
    img.onerror = () => {
      if (this.coverKey !== key) return;
      if (at === 0) Covers.askBig(song);
      at += 1;
      if (at < list.length) img.src = list[at];
      else none();
    };
    // A Flow Server's cover on a page of another address (the web player): asked for as WebGL may read it.
    if (/^https?:/i.test(list[0])) img.crossOrigin = 'anonymous';
    img.src = list[0];
  },

  /**
   * How solid the cover is at a point (1 whole, 0 gone), x and y from its top
   * left corner in the units of `size`, its width: whole in its core (the
   * cover drawn in by COVER_FADE_IN, its corners as round), thinning from
   * there outwards along a bell curve, to nothing COVER_FADE outside its
   * edge. The same the WebGL way works out for each pixel while drawing.
   */
  _solid(x, y, size) {
    const away = this._away(x, y, size);
    const end = Math.exp(-this.FADE_BELL);
    return (Math.exp(-this.FADE_BELL * away * away) - end) / (1 - end);
  },

  /** How far along its fade a point is: 0 in the cover's core, 1 where nothing of it is seen any more. */
  _away(x, y, size) {
    const round = size * this.COVER_ROUND;
    const half = size / 2;
    const ax = Math.abs(x - half) - half + size * this.COVER_FADE_IN + round;
    const ay = Math.abs(y - half) - half + size * this.COVER_FADE_IN + round;
    const ox = ax > 0 ? ax : 0;
    const oy = ay > 0 ? ay : 0;
    return Math.min(1, Math.max(0, (Math.sqrt(ox * ox + oy * oy) - round) / Math.max(size * (this.COVER_FADE_IN + this.COVER_FADE), 1e-6)));
  },

  /**
   * How far a point lies outside the cover's rounded square (below 0:
   * inside), in the units of `size`, the cover's width; x and y from the
   * cover's top left corner.
   */
  _edge(x, y, size) {
    const round = size * this.COVER_ROUND;
    const half = size / 2;
    const ax = Math.abs(x - half) - half + round;
    const ay = Math.abs(y - half) - half + round;
    const ox = ax > 0 ? ax : 0;
    const oy = ay > 0 ? ay : 0;
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(ax, ay), 0) - round;
  },

  /**
   * The cover with its surround, made once when a cover has loaded, in small
   * parts (BAKE_MS of work, then the page's turn again, so no frame of the
   * equalizer is lost over it): done({ image, pad }) at the end, image an
   * ImageData with the cover in its middle and the surround `pad` of the
   * cover's width on each side; done(null) when the page may not read the
   * picture. Given up without a word once still() says no (another cover is
   * wanted by then).
   */
  _bake(img, still, done) {
    const parts = this._bakeParts(img);
    const turn = () => {
      if (!still()) return;
      const end = performance.now() + this.BAKE_MS;
      let part;
      try {
        do part = parts.next(); while (!part.done && performance.now() < end);
      } catch {
        done(null);
        return;
      }
      if (part.done) done(part.value);
      else setTimeout(turn, 0);
    };
    turn();
  },

  /**
   * The parts of _bake, one after another: the cover's pixels read (at most
   * COVER_PIXELS wide, on black), a plain frame round its artwork left out,
   * the surround made. Returns { image, pad }, or null for an empty picture.
   */
  *_bakeParts(img) {
    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    if (!w || !h) return null;
    const S = Math.max(8, Math.min(this.COVER_PIXELS, Math.max(w, h)));
    const M = Math.max(1, Math.round(S * this.COVER_FADE));
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    const read = (sx, sy, sw, sh) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, S, S);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, S, S);
      return ctx.getImageData(0, 0, S, S).data;
    };
    let src = read(0, 0, w, h);
    const cut = this._frameOf(src, S);
    if (cut) {
      const kx = w / S;
      const ky = h / S;
      src = read(cut[0] * kx, cut[1] * ky, w - (cut[0] + cut[2]) * kx, h - (cut[1] + cut[3]) * ky);
    }
    yield;
    const pixels = yield* this._surroundParts(src, S, M);
    const P = S + 2 * M;
    return { image: new ImageData(pixels, P, P), pad: M / S };
  },

  /**
   * A plain frame round the artwork in a cover's pixels (S x S, RGBA): how
   * many rows to leave out at the left, top, right and bottom, or null
   * without one. A frame is the same single colour on all four sides from
   * the edge inwards, at most COVER_FRAME wide, and ends at once along most
   * of each side. A plain background does not end like that (the artwork
   * comes in bit by bit), so it stays.
   */
  _frameOf(src, S) {
    const most = Math.floor(S * this.COVER_FRAME);
    if (most < 1) return null;
    const step = this.FRAME_STEP;
    // The pixel k rows in from a side, i along it.
    const sides = [
      (k, i) => (i * S + k) * 4,
      (k, i) => (k * S + i) * 4,
      (k, i) => (i * S + S - 1 - k) * 4,
      (k, i) => ((S - 1 - k) * S + i) * 4,
    ];
    let colour = null;
    const cut = [];
    for (const px of sides) {
      // The frame's colour: the outermost row's, the same on every side.
      const c = [0, 0, 0];
      for (let i = 0; i < S; i += 1) {
        const q = px(0, i);
        c[0] += src[q];
        c[1] += src[q + 1];
        c[2] += src[q + 2];
      }
      for (let j = 0; j < 3; j += 1) c[j] /= S;
      if (!colour) colour = c;
      else if (c.some((v, j) => Math.abs(v - colour[j]) > step)) return null;
      // How much of row k has that colour.
      const share = (k) => {
        let n = 0;
        for (let i = 0; i < S; i += 1) {
          const q = px(k, i);
          if (Math.abs(src[q] - colour[0]) <= step && Math.abs(src[q + 1] - colour[1]) <= step && Math.abs(src[q + 2] - colour[2]) <= step) n += 1;
        }
        return n / S;
      };
      let k = 0;
      while (k <= most && share(k) >= this.FRAME_PLAIN) k += 1;
      if (k < 1 || k > most || share(k + 1) > this.FRAME_OVER) return null;
      // The row it ends in is half frame, half artwork: left out as well.
      cut.push(k + 1);
    }
    return cut;
  },

  /**
   * The baked picture's pixels (RGBA, S + 2 M wide) from a cover's (S x S,
   * RGBA): the cover in the middle, M more on each side, where it goes on
   * mirrored at its edge. From COVER_BLUR_IN inside the cover's rounded edge
   * outwards each pixel is blurred, the more the further out, so the cover's
   * rim softens and the surround is a blur of the cover's outer band.
   *
   * The blur: three rounds of a square average whose reach is each pixel's
   * own (together a bell curve of the width wanted there), each average four
   * reads from the sums of all pixels above and left of a point; a reach
   * between two whole numbers is the two averages mixed.
   */
  _surround(src, S, M) {
    const parts = this._surroundParts(src, S, M);
    for (;;) {
      const part = parts.next();
      if (part.done) return part.value;
    }
  },

  /** _surround in parts (a millisecond or two each), the pixels returned at the end. */
  *_surroundParts(src, S, M) {
    const P = S + 2 * M;
    const out = this._mirrored(src, S, M);
    yield;
    const rim = yield* this._rimParts(S, M);
    const sums = new Float64Array((P + 1) * (P + 1));
    const val = new Float32Array(P * P);
    for (let ch = 0; ch < 3; ch += 1) {
      this._channel(out, val, ch);
      for (let round = 0; round < 3; round += 1) {
        this._sums(val, sums, P);
        yield;
        // The sums stay as they are for the round, so its averages can be taken a stretch at a time.
        for (let from = 0; from < rim.count; from += this.BAKE_STEP) {
          this._averages(val, sums, rim, P, from, Math.min(rim.count, from + this.BAKE_STEP));
          yield;
        }
      }
      this._settle(out, val, rim, ch);
    }
    return out;
  },

  /** A cover's pixels (S x S) in the middle of the baked picture's (S + 2 M wide), going on mirrored at its edges. */
  _mirrored(src, S, M) {
    const P = S + 2 * M;
    const out = new Uint8ClampedArray(P * P * 4);
    const from = new Int32Array(P);
    for (let i = 0; i < P; i += 1) {
      const s = i - M;
      from[i] = Math.min(S - 1, Math.max(0, s < 0 ? -1 - s : s >= S ? 2 * S - 1 - s : s));
    }
    for (let y = 0; y < P; y += 1) {
      const row = from[y] * S;
      for (let x = 0; x < P; x += 1) {
        const q = (row + from[x]) * 4;
        const o = (y * P + x) * 4;
        out[o] = src[q];
        out[o + 1] = src[q + 1];
        out[o + 2] = src[q + 2];
        out[o + 3] = 255;
      }
    }
    return out;
  },

  /**
   * The baked picture's pixels that are blurred: { count, at (which pixel),
   * n and f (its average's reach: whole, and the share of the next one up) }.
   * The bell curve's width wanted at a pixel: none COVER_BLUR_IN inside the
   * cover's edge, rising gently at first to COVER_BLUR_EDGE at the edge, on
   * to COVER_BLUR_END at COVER_BLUR_OUT outside it, and as strong from there on.
   * Where nothing of the cover is seen any more (past the far end of its
   * fade, in the surround's corners) nothing is blurred. In parts, a band of
   * rows each.
   */
  *_rimParts(S, M) {
    const P = S + 2 * M;
    const inset = S * this.COVER_BLUR_IN;
    const atEdge = S * this.COVER_BLUR_EDGE;
    const atEnd = S * this.COVER_BLUR_END;
    const reach = Math.max(1, S * this.COVER_BLUR_OUT);
    // Rows in the middle are looked at near their two ends alone: further in than `deep` nothing is blurred
    // (in the rounded corners the blur reaches a little deeper than along the sides).
    const deep = Math.min(P >> 1, M + Math.ceil(inset + 0.3 * S * this.COVER_ROUND) + 1);
    const most = P * P - (P - 2 * deep) * (P - 2 * deep);
    const at = new Uint32Array(most);
    const n = new Uint16Array(most);
    const f = new Float32Array(most);
    let count = 0;
    for (let y = 0; y < P; y += 1) {
      if (y && y % 48 === 0) yield;
      const middle = y >= deep && y < P - deep;
      for (let x = 0; x < P; x += 1) {
        if (middle && x === deep) x = P - deep;
        const d = this._edge(x + 0.5 - M, y + 0.5 - M, S);
        if (d <= -inset || (d > 0 && this._away(x + 0.5 - M, y + 0.5 - M, S) >= 1)) continue;
        const u = (d + inset) / inset;
        const sigma = d < 0 ? atEdge * u * u : atEdge + (atEnd - atEdge) * Math.min(1, d / reach);
        const v = sigma * sigma;
        if (v < 0.02) continue;
        // Three averages over 2 k + 1 pixels are as wide as a bell curve whose width squared is k (k + 1).
        const k = Math.floor((Math.sqrt(1 + 4 * v) - 1) / 2);
        at[count] = y * P + x;
        n[count] = k;
        f[count] = (v - k * (k + 1)) / (2 * (k + 1));
        count += 1;
      }
    }
    return { count, at, n, f };
  },

  /** One colour (0, 1, 2) of the picture's pixels into val. */
  _channel(out, val, ch) {
    for (let i = 0, o = ch; i < val.length; i += 1, o += 4) val[i] = out[o];
  },

  /** sums (P + 1 wide, its first row and column 0): at each point the sum of val's pixels above and left of it. */
  _sums(val, sums, P) {
    const W = P + 1;
    for (let y = 0; y < P; y += 1) {
      let run = 0;
      const a = (y + 1) * W + 1;
      const b = y * W + 1;
      const r = y * P;
      for (let x = 0; x < P; x += 1) {
        run += val[r + x];
        sums[a + x] = sums[b + x] + run;
      }
    }
  },

  /** Each of the rim's pixels from `from` up to `to` in val becomes the average of the square round it (as far as the picture goes), read from sums. */
  _averages(val, sums, rim, P, from, to) {
    const W = P + 1;
    const { at, n, f } = rim;
    for (let k = from; k < to; k += 1) {
      const i = at[k];
      const y = (i / P) | 0;
      const x = i - y * P;
      const reach = n[k];
      const more = f[k];
      let x0 = x - reach < 0 ? 0 : x - reach;
      let x1 = x + reach + 1 > P ? P : x + reach + 1;
      let y0 = y - reach < 0 ? 0 : y - reach;
      let y1 = y + reach + 1 > P ? P : y + reach + 1;
      let v = (sums[y1 * W + x1] - sums[y0 * W + x1] - sums[y1 * W + x0] + sums[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
      if (more > 0) {
        if (x0 > 0) x0 -= 1;
        if (x1 < P) x1 += 1;
        if (y0 > 0) y0 -= 1;
        if (y1 < P) y1 += 1;
        v += more * ((sums[y1 * W + x1] - sums[y0 * W + x1] - sums[y1 * W + x0] + sums[y0 * W + x0]) / ((x1 - x0) * (y1 - y0)) - v);
      }
      val[i] = v;
    }
  },

  /** The rim's blurred pixels of one colour back into the picture, in whole steps with a speckle of one step (no bands in the wide soft fades). */
  _settle(out, val, rim, ch) {
    const { count, at } = rim;
    for (let k = 0; k < count; k += 1) {
      const i = at[k];
      let hash = Math.imul(i * 3 + ch + 1, 0x9e3779b1);
      hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca77);
      out[i * 4 + ch] = val[i] + ((hash ^ (hash >>> 13)) >>> 0) / 4294967296 - 0.5;
    }
  },

  /**
   * Where the cover goes, in the canvas's pixels: in the middle of the room
   * between the bottom of the shown page's column names and the player bar,
   * COVER_SHARE as tall as that room, never wider than the list. The column
   * names where they are now: under a banner while the page is at its top,
   * at the top of the page once the banner is scrolled away (where they
   * stay), so the cover is in the middle of what shows of the list. A page
   * without a list: from its top. True when that moved.
   */
  _place() {
    const content = document.querySelector('.content');
    const pages = $('pages');
    if (!content || !pages) return false;
    const cr = content.getBoundingClientRect();
    const pr = pages.getBoundingClientRect();
    const player = $('player');
    const bottom = (player && player.offsetParent ? player.getBoundingClientRect().top : cr.bottom) - cr.top;
    let top = pr.top - cr.top;
    let left = pr.left - cr.left;
    let width = pages.clientWidth;
    const page = pages.querySelector(':scope > .page:not([hidden])');
    const th = page ? page.querySelector('table th') : null;
    if (th && th.offsetParent) {
      const tr = th.closest('table').getBoundingClientRect();
      const rest = tr.top + pages.scrollTop - cr.top + th.offsetHeight;
      // Far down the page (a list under other things) it is not the list's head:
      // told by where it stands unscrolled, so scrolling never changes that.
      if (rest > top && rest < (top + bottom) / 2) {
        // Scrolled, the names have moved up, at most to the top of the page.
        top = Math.max(top, Math.min(rest, th.getBoundingClientRect().bottom - cr.top));
        left = tr.left - cr.left;
        width = tr.width;
      }
    }
    const room = Math.max(0, bottom - top);
    const size = Math.max(1, Math.round(Math.min(room * this.COVER_SHARE, width)));
    const box = { x: Math.round(left + (width - size) / 2), y: Math.round(top + (room - size) / 2), size };
    const was = this.coverBox;
    this.coverBox = box;
    return !was || was.x !== box.x || was.y !== box.y || was.size !== box.size;
  },

  /**
   * The puffs to draw now, in the order they are laid on, into puffData
   * (x, y, reach in pixels, r, g, b 0..1, strength; 7 floats each) and
   * puffColour (the canvas's 'hsla(h, s%, l%, ' each). Returns how many.
   */
  _puffs(w, h) {
    const s = Store.settings;
    const t = this.time;
    const tau = 2 * Math.PI;
    const side = Math.max(w, h);
    // Settings: intensity at 50% and bass reaction at 25% are the look as
    // designed; 100% reaction is four times that.
    const react = s.cloudsBass === false ? 0 : (s.cloudsBassAmount || 50) / 25;
    const swell = 1 + this.PULSE_GROW * this.pulse * react;
    const brighter = 1 + this.PULSE_ALPHA * this.pulse * react;
    const intensity = (s.cloudsIntensity || 50) / 50;
    const at = ([centre, reach, period], phase) => centre + reach * Math.sin((tau * t) / period + phase);
    const solid = this.SOLID[s.cloudsColors] || null;
    const amount = Number.isFinite(s.cloudsAmount) ? s.cloudsAmount : 50;
    const count = Math.round((this.CLOUDS.length * amount) / 100);
    if (!this.puffData) {
      this.puffData = new Float64Array(this.CLOUDS.length * this.PUFFS * 7);
      this.puffColour = [];
    }
    const P = this.puffData;
    let n = 0;

    this.CLOUDS.forEach((cl, i) => {
      if (i >= count) return;
      // Away while the wave is well below zero, easing in and out around it.
      const wave = Math.min(1, Math.max(0, 0.5 + 0.8 * Math.sin((tau * t) / cl.cycle + i * 2.1)));
      const here = wave * wave * (3 - 2 * wave);
      if (here < 0.005) {
        cl.away = true;
        return;
      }
      // Rainbow: a new colour each time it comes back.
      if (cl.away || cl.hue == null) {
        cl.hue = Math.random() * 360;
        cl.away = false;
      }
      const x = at(cl.x, i * 1.7) * w;
      const y = at(cl.y, i * 2.3 + 1) * h;
      // Growing as it comes, shrinking as it goes.
      const r = cl.size * side * swell * (0.7 + 0.3 * here);
      const hue = solid ? solid[0] : Number((cl.hue + cl.hueSwing * Math.sin((tau * t) / 211 + i)).toFixed(1));
      const sat = solid ? solid[1] : cl.sat;
      const light = solid ? solid[2] : cl.light;
      const colour = `hsla(${solid ? hue : hue.toFixed(1)}, ${sat}%, ${light}%, `;
      const rgb = this._rgb(hue, sat, light);
      const strength = Math.min(1, this.PUFF_ALPHA * intensity * here * brighter);

      for (const p of cl.puffs) {
        const a = (tau * t) / p.period + p.phase;
        const q = n * 7;
        P[q] = x + (p.dx + p.wander * Math.sin(a)) * r;
        P[q + 1] = y + (p.dy + p.wander * 0.6 * Math.cos(a * 0.83)) * r;
        P[q + 2] = p.r * r * (1 + 0.3 * Math.sin(a * 1.37 + 1)) * this.REACH;
        P[q + 3] = rgb[0];
        P[q + 4] = rgb[1];
        P[q + 5] = rgb[2];
        P[q + 6] = strength;
        this.puffColour[n] = colour;
        n += 1;
      }
    });
    return n;
  },

  /** hsl (degrees, percent) as the canvas takes it: r, g, b in whole 255ths, as 0..1. */
  _rgb(h, s, l) {
    const sat = s / 100;
    const lig = l / 100;
    const f = (k0) => {
      const k = (k0 + h / 30) % 12;
      const a = sat * Math.min(lig, 1 - lig);
      return Math.round(255 * (lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))) / 255;
    };
    this._rgbOut = this._rgbOut || [0, 0, 0];
    this._rgbOut[0] = f(0);
    this._rgbOut[1] = f(8);
    this._rgbOut[2] = f(4);
    return this._rgbOut;
  },

};
