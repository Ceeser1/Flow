'use strict';

// The menu's background texture (Settings > App Visuals > Show a Menu
// background, off until turned on): one of STYLES, shown in the menu, as strong
// as Settings' Visibility, and with Settings' Animate moving a little, as fast
// as Settings' Speed.
//
// Reach over (Settings, not on the phone's layout, whose menu is a drawer over
// the page): the texture goes on beyond the menu's right edge, over the
// content's background, fading out to nothing within Settings' Reach (percent
// of the content's width). For that a style builds its layers twice, in the
// menu and behind the content (`spots`), both laid the same on the window and
// moved the same, so the texture crosses the menu's edge without a seam; the
// box behind the content is as wide as the Reach and fades out to its right
// (menuBg.css). There it lies at the very back: under the cover (Show Cover
// as background), the clouds and the equalizer, in that order. Cover and
// clouds are one solid picture (ambient.js), which is see-through for that
// while the texture reaches over (where it cannot be, the texture lies on it).
//
// Nothing is ever drawn again while it moves. A style is a few pictures made
// beforehand, each a layer of its own on the GPU; moving is setting a layer's
// place, turn or opacity, which the GPU does by laying the same picture
// elsewhere. Pictures that go on and on (flowing, rising, drifting) are tiles:
// their layer is a tile larger than the menu and comes back by a whole tile,
// which cannot be seen.
//
// The pictures: Flow comes with none. menuBgMake.js makes the chosen style's
// here, from the style's seed in Settings (the box beside Style: up to six
// letters and digits, one kept for every style; none: the style's standard
// look): once, when the style is first shown or its seed or the style changes
// (a few ms, Roots about 30), never while it moves. The same seed gives the
// same pictures again, so nothing is kept but the ones in use: the chosen
// style's with its seed, in memory, gone when another is chosen or the texture
// is turned off.
//
// How often: a style names the changes a second it needs at the pace as
// designed (`fps`: so slow a style that a step is far below a pixel), and gets
// as many more as it is faster, never over MAX_FPS (60; on a 144 Hz screen that
// is every third of its frames, 48); `followFps` while it follows the mouse. A
// timer wakes it for each change, so the window is not asked for a frame 144
// times a second only to skip most of them: as many wake-ups as changes
// (measured). No frames at all while the texture is off or does not move
// (Animate unticked, or Windows' "Show animations" off: it stands in its middle
// then, the mouse not followed either), while Flow is in the tray, or while
// nothing of it moves (Speed 0 and the mouse where it was: the next move of the
// mouse wakes it); two a second, changing nothing, under the full-screen
// visualizer. On the phone layout none while its menu (a drawer) is closed:
// opening it wakes the texture (wake), which goes on at once from where it
// stood, so nothing of it changes at some later moment, with the drawer just
// slid in (it did, up to half a second after: a jump towards the finger).
//
// Speed: every style has its own `speed`, its pace at Settings' Speed 100 %; all
// its other numbers (pixels a second, periods) are at pace 1. So a style that is
// too slow or too fast is put right with that one number, and Settings' Speed
// stays the same for all (Roots: 10, twice the pace it was first drawn for at
// the 20 % it started with; the others 5, so 20 % is their pace as designed).
//
// Visibility: the pictures are made four times as strong as they look as
// designed, and shown at Settings' Visibility: 25 % as designed, 100 % whole.
// On the phone layout they are made PHONE times as strong again (`gain`).

const MenuBg = {
  box: null, // in the menu
  out: null, // behind the content, as wide as the texture reaches over
  // Reaching over: in `out`, a box laid on the window as the menu's is (it begins at the window's left edge).
  far: null,
  over: false,
  // Where a style builds its layers: the menu's box, and `far` while it reaches over.
  spots: [],
  id: '',
  style: null,
  // The style's seed in Settings ('' : its standard look), what menuBgMake.js made with its pictures (Circuit's ways,
  // Scales' look, Vinyl's beams), and the pictures themselves, each held in memory under an address (name: a blob: address).
  seed: '',
  made: null,
  urls: {},
  raf: null,
  timer: null,
  last: 0,
  // Seconds the style has moved so far, at its pace (only while it moves, so it goes on where it stood).
  time: 0,
  // How solid the layers show now (0 to 1), from Settings' Visibility.
  strength: 0,
  // The phone layout (its menu a drawer), and the height its box there has now (_phoneBox).
  phone: false,
  _phoneTall: 0,
  // Windows' "Show animations" off; Flow in the tray.
  reduced: false,
  resting: false,
  // The mouse against the window's middle (-1 to 1), and how far the texture follows it now.
  mouse: { x: 0, y: 0 },
  follow: { x: 0, y: 0 },
  EASE_S: 0.7,
  MIN_FPS: 2,
  MAX_FPS: 60,
  FOLLOW_FPS: 30,
  // The layers reach this far beyond the menu on every side, so their edges never show while they move.
  MARGIN: 20,
  // The Visibility that gives the look as designed.
  VISIBILITY: 25,
  // The phone layout: everything this many times as strong. A phone's screen shows what is so little lighter
  // than the menu far fainter than a monitor does: as made for the computer it could hardly be seen there
  // even at Visibility 100 %.
  PHONE: 1.5,
  // How many times as strong the pictures are made, and what is drawn here shown (PHONE on the phone layout).
  gain: 1,
  STYLES: {},

  init() {
    this.box = $('menuBg');
    this.out = $('menuBgOut');
    if (!this.box) return;
    this.resting = !!Store.away;
    this.phone = document.body.classList.contains('mobile');
    this.gain = this.phone ? this.PHONE : 1;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced = motion.matches;
    motion.addEventListener('change', () => {
      this.reduced = motion.matches;
      this._apply();
    });
    window.addEventListener('pointermove', (e) => {
      this.mouse.x = Math.max(-1, Math.min(1, (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1));
      this.mouse.y = Math.max(-1, Math.min(1, (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1));
      if (this.style && this.style.parallax) this._run();
    }, { passive: true });
    // The mouse gone from the window: back to the middle.
    document.documentElement.addEventListener('mouseleave', () => {
      this.mouse.x = 0;
      this.mouse.y = 0;
      if (this.style && this.style.parallax) this._run();
    });
    // A menu of another height, or the reach of another width: a style laid out by them (Scales' rows, the
    // pictures that grow from an edge, what of Circuit is in sight) follows.
    if (typeof ResizeObserver !== 'undefined') {
      const sized = new ResizeObserver(() => {
        if (!this.style || !this.style.resize) return;
        this.style.resize(this);
        this._show();
      });
      sized.observe(this.box);
      sized.observe(this.out);
      // The phone layout: the texture's box as tall as the drawer it sticks in.
      if (this.phone && this.box.parentElement) new ResizeObserver(() => this._phoneBox()).observe(this.box.parentElement);
    }
    this._phoneBox();
    Store.onSettings((patch) => {
      if (Object.keys(patch || {}).some((k) => k.startsWith('menuBg'))) this._apply();
    });
    this._apply();
  },

  /**
   * The phone layout: its menu is a drawer that scrolls as a whole, so the texture's box sticks to the drawer's
   * top (menuBg.css) instead of lying in what scrolls: as tall as the drawer, with as much margin back up below it,
   * so the entries begin where they would without it.
   */
  _phoneBox() {
    if (!this.phone || !this.box.parentElement) return;
    const tall = this.box.parentElement.clientHeight;
    if (!tall || tall === this._phoneTall) return;
    this._phoneTall = tall;
    this.box.style.height = `${tall}px`;
    this.box.style.marginBottom = `${-tall}px`;
  },

  /** The phone layout's drawer opens (or is pulled out by a finger): frames again, on from where it stood, without a jump. */
  wake() {
    if (!this.box || !this.phone) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.last = 0;
    this._run();
  },

  /** Whether the phone layout's drawer is out of sight (closed, and not being pulled out). */
  _drawerShut() {
    const c = document.body.classList;
    return this.phone && !c.contains('drawer-open') && !c.contains('drawer-dragging');
  },

  /** Flow's window into the tray (true): no more frames; back (false): on from where it stood. */
  rest(on) {
    this.resting = !!on;
    // (Back: the clouds may only now have started, and can be see-through for the texture under them.)
    if (on) this._run();
    else this._apply();
  },

  // ---- what the styles build with ----

  /** A layer in the menu (or in `where`), showing `file` if given; `css`: its own place and size. */
  layer(cls, file = '', css = null, where = this.box) {
    const el = document.createElement('div');
    el.className = `menubg__layer ${cls}`;
    if (file) el.style.backgroundImage = `url("${this.src(file)}")`;
    if (css) Object.assign(el.style, css);
    where.appendChild(el);
    return el;
  },

  /** A picture of the style in use: its address (_make). */
  src(file) {
    return this.urls[file] || '';
  },

  /** The pictures in memory let go of. */
  _forget() {
    for (const url of Object.values(this.urls)) URL.revokeObjectURL(url);
    this.urls = {};
    this.made = null;
  },

  /** The style's pictures made from its seed, and what goes with them; `more`: also those it needs only for reaching over. */
  _make(id, seed, more) {
    this.made = {};
    try {
      const { files, ...rest } = MenuBgMake.make(id, seed, more, this.gain);
      for (const [name, text] of Object.entries(files)) this.urls[name] = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
      this.made = rest;
    } catch (e) {
      // No pictures then: an empty menu, as with the texture off.
      console.error('menuBg', e);
    }
  },

  /**
   * A layer of a picture that is a tile (`w` x `h`), laid over the whole menu and
   * a margin; `scrollX` / `scrollY`: a tile more that way, for moving it on and on
   * (its place then `wrap`ped into one tile).
   */
  tiled(cls, file, w, h, scrollX, scrollY, where = this.box) {
    const m = this.MARGIN;
    const more = (on, size) => (on ? size : 0);
    return this.layer(`menubg__tile ${cls}`, file, {
      left: `${-m - more(scrollX, w)}px`,
      top: `${-m - more(scrollY, h)}px`,
      width: `calc(100% + ${m * 2 + more(scrollX, w)}px)`,
      height: `calc(100% + ${m * 2 + more(scrollY, h)}px)`,
      backgroundSize: `${w}px ${h}px`,
    }, where);
  },

  /**
   * A layer of a picture made `w` x `h` that grows from one of the menu's edges
   * (CSS says which): as tall as the menu and `extra`, the picture as made, or
   * larger where the menu is taller than it, so it covers the whole height on any
   * window. `wide`: the layer's width is CSS's (its box's: a picture that goes on
   * to the side). Returns how many times larger (1: as made).
   */
  fit(el, w, h, extra = 0, wide = false) {
    const tall = (this.box.clientHeight || 0) + extra;
    const k = Math.max(1, tall / h);
    if (!wide) el.style.width = `${Math.ceil(w * k)}px`;
    el.style.height = `${tall}px`;
    el.style.backgroundSize = `${(w * k).toFixed(1)}px ${(h * k).toFixed(1)}px`;
    return k;
  },

  /** `v` brought into one tile of `size` (0 up to it). */
  wrap(v, size) {
    return ((v % size) + size) % size;
  },

  /** A layer where it is now and how solid (0 to 1, before Visibility); written only when it changed. */
  put(el, transform, alpha = 1) {
    const opacity = (alpha * this.strength).toFixed(4);
    if (el._mbTransform !== transform) {
      el._mbTransform = transform;
      el.style.transform = transform;
    }
    if (el._mbOpacity !== opacity) {
      el._mbOpacity = opacity;
      el.style.opacity = opacity;
    }
  },

  /** A layer (or anything else) where it is now, its opacity left alone; written only when it changed. */
  move(el, transform) {
    if (el._mbTransform !== transform) {
      el._mbTransform = transform;
      el.style.transform = transform;
    }
  },

  /** A wave between -1 and 1: once round every `period` seconds, `shift` rounds ahead. */
  wave(t, period, shift = 0) {
    return Math.sin((t / period + shift) * Math.PI * 2);
  },

  // ---- the settings ----

  /** The style to show, or '' while the setting is off. */
  _wanted() {
    const s = Store.settings || {};
    if (!s.menuBgOn) return '';
    return this.STYLES[s.menuBgStyle] ? s.menuBgStyle : 'roots';
  },

  /** The seed Settings keeps for a style ('' : none, its standard look). */
  _seed(id) {
    const all = (Store.settings || {}).menuBgSeeds;
    return all && typeof all === 'object' ? MenuBgMake.clean(all[id]) : '';
  },

  /**
   * How far the texture reaches over into the content's background: percent of the content's width (0: not at
   * all; never on the phone's layout).
   */
  _reach() {
    const s = Store.settings || {};
    if (!s.menuBgReachOn || document.body.classList.contains('mobile')) return 0;
    return Math.min(100, Math.max(0, Number(s.menuBgReach) || 0));
  },

  /** Standing in its middle: Animate unticked, or Windows' "Show animations" off. */
  _still() {
    return this.reduced || !(Store.settings || {}).menuBgAnimate;
  },

  /** The style's pace now: its own at Speed 100 %, times Settings' Speed (0: it does not move by itself). */
  _pace() {
    const speed = Math.max(0, Number((Store.settings || {}).menuBgSpeed) || 0) / 100;
    return this.style ? this.style.speed * speed : 0;
  },

  /**
   * After a setting changed: the style there or gone, as it looks now, moving or not. Its pictures are made when it
   * or its seed is another one (and for a style with pictures only for reaching over, `more`, when it begins or
   * stops reaching over), its layers built then and when it begins or stops reaching over.
   */
  _apply() {
    if (!this.box) return;
    const id = this._wanted();
    const seed = id ? this._seed(id) : '';
    const reach = id ? this._reach() : 0;
    const other = id !== this.id || seed !== this.seed;
    if (other || (reach > 0) !== this.over) {
      this.box.textContent = '';
      this.out.textContent = '';
      this.id = id;
      this.seed = seed;
      this.over = reach > 0;
      this.style = id ? this.STYLES[id] : null;
      if (other || (this.style && this.style.more)) {
        this._forget();
        if (this.style) this._make(id, seed, this.over && !!this.style.more);
      }
      this.box.className = `menubg menubg--menu${id ? ` menubg--${id}` : ''}`;
      this.far = null;
      this.spots = [this.box];
      if (this.style && this.over) {
        this.far = document.createElement('div');
        this.far.className = `menubg__far menubg--${id}`;
        this.out.appendChild(this.far);
        this.spots.push(this.far);
      }
      if (this.style) this.style.build(this);
    }
    this.box.hidden = !this.style;
    this.out.hidden = !this.style || !this.over;
    const width = this.over ? `${reach}%` : '';
    if (this.out.style.width !== width) this.out.style.width = width;
    // Under the cover and the clouds, which let it show through for that (if they can).
    const under = typeof Ambient !== 'undefined' && Ambient.seeThrough(!!this.style && this.over);
    this.out.classList.toggle('menubg--under', under);
    if (this.style) this._show();
    this._run();
  },

  _show() {
    const still = this._still();
    this.strength = Math.min(1, Math.max(0, Number((Store.settings || {}).menuBgVisibility) || 0) / 100);
    this.style.show(this, still ? 0 : this.time, still ? 0 : this.follow.x, still ? 0 : this.follow.y, still);
  },

  // ---- the frames ----

  /** A frame planned if it is there and moves and none is planned yet; none any more otherwise. */
  _run() {
    if (!this.box) return;
    if (!this.style || this._still() || this.resting || this._drawerShut()) {
      if (this.raf !== null) cancelAnimationFrame(this.raf);
      clearTimeout(this.timer);
      this.raf = null;
      this.timer = null;
      this.last = 0;
      return;
    }
    if (this.raf !== null || this.timer !== null) return;
    this.raf = requestAnimationFrame((t) => this._frame(t));
  },

  /**
   * The next change, `fps` a second: a timer until shortly before it is due, then the
   * screen's next frame. So the window is asked for a frame once for every change, not
   * 144 times a second to skip most of them.
   */
  _plan(fps) {
    const wait = Math.max(0, 1000 / fps - (performance.now() - this.last) - 4);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.raf = requestAnimationFrame((t) => this._frame(t));
    }, wait);
  },

  /** Whether the texture is still on its way to where the mouse wants it. */
  _following() {
    return Math.abs(this.mouse.x - this.follow.x) > 0.002 || Math.abs(this.mouse.y - this.follow.y) > 0.002;
  },

  _frame(now) {
    this.raf = null;
    const st = this.style;
    if (!st || this._still() || this.resting) return;
    const pace = this._pace();
    const following = !!st.parallax && this._following();
    // As many more a second as it is faster, so a step stays as small.
    let fps = 0;
    if (pace) fps = st.fpsNow ? st.fpsNow(this, pace) : Math.max(this.MIN_FPS, st.fps * pace);
    if (following) fps = Math.max(fps, st.followFps || this.FOLLOW_FPS);
    fps = Math.min(this.MAX_FPS, fps);
    // Nothing of it moves: no more frames until the mouse does (_run).
    if (!fps) {
      this.last = 0;
      return;
    }
    // A frame that comes too early (a 144 Hz screen's, 7 ms after the last one: 60 a second there are 48, evenly).
    // A slow style takes the frame its timer woke it for, also one a few ms early.
    const early = 1000 / fps - Math.min(5, 120 / fps) - (now - this.last);
    if (this.last && early > 0) {
      if (early < 8) this.raf = requestAnimationFrame((t) => this._frame(t));
      else this._plan(fps);
      return;
    }
    // The phone's drawer shut: no frames at all until it opens (wake).
    if (this._drawerShut()) {
      this.last = 0;
      return;
    }
    // Not seen: nothing changed (and the time not counted, so it goes on from there).
    const hidden = document.hidden || (typeof Visualizer !== 'undefined' && Visualizer.shown);
    const dt = this.last ? Math.min(0.6, (now - this.last) / 1000) : 0;
    this.last = now;
    if (hidden) {
      this._plan(this.MIN_FPS);
      return;
    }
    this.time += dt * pace;
    if (st.parallax) {
      const k = 1 - Math.exp(-dt / this.EASE_S);
      this.follow.x += (this.mouse.x - this.follow.x) * k;
      this.follow.y += (this.mouse.y - this.follow.y) * k;
    }
    this._show();
    // What it just began (Circuit: a light on its way) may want the next change sooner.
    this._plan(st.fpsNow ? Math.min(this.MAX_FPS, Math.max(fps, st.fpsNow(this, pace))) : fps);
  },
};

// Every style: `speed` (its pace at Settings' Speed 100 %), `fps` (changes a
// second it needs at pace 1), `parallax` (it follows the mouse), build(bg) (its
// layers, once: the same in each of bg.spots, the menu and, reaching over,
// behind the content) and show(bg, t, fx, fy, still): everything where it is
// after `t` seconds at its pace, the mouse followed to fx / fy (-1 to 1); still:
// standing, t and the mouse 0.

// Roots: faint roots growing down from the menu's top at two depths (far ones
// fainter, thinner and soft, near ones crisp), some reaching out over the
// content's background, where the menu also casts a soft shade. Reaching over,
// more roots hang down from the top all along the content, as far as Settings'
// Reach lets them show (two more pictures, which go on into themselves to the
// sides; the menu's own two end 500 px beyond it). A fake 3D: each
// depth drifts without ever stopping, as if hanging in water (round a small
// loop: the speed stays the same, there is no turning point where they stand),
// turns a little about the menu's top, and shifts against the mouse, the near
// roots more than the far ones. Both breathe very slowly in brightness, by turns.
// Measured on a quiet window (clouds off): drifting at 20 changes a second it
// cost 0.2 % CPU and 0.85 % GPU, following the mouse every frame 0.3 % and 1.5 %.
MenuBg.STYLES.roots = {
  speed: 10,
  fps: 8,
  followFps: 15,
  parallax: true,
  // It has pictures only for reaching over.
  more: true,
  // Each depth: how much of the movement it makes, and where in its rhythms it is.
  DEPTHS: { far: { amount: 0.45, phase: 0.37 }, near: { amount: 1, phase: 0 } },
  // The loop's size (px; a little wider than tall) and how long a round takes (s):
  // about half a pixel a second near. A slow wobble of the loop's size on top, so
  // its path does not look drawn with a compass; the turn about the menu's top
  // middle (degrees); how strongly it pulses (the opacity between 1 - PULSE and 1).
  // The periods share no beat, so the movement does not repeat soon.
  LOOP_X: 4.5,
  LOOP_Y: 3.5,
  WOBBLE: 0.3,
  TURN: 0.35,
  PULSE: 0.25,
  PERIODS: { loop: 53, wobble: 29, turn: 41, pulse: 30 },
  // How far the near roots follow the mouse (px, with the mouse at the window's edge).
  PARALLAX_X: 9,
  PARALLAX_Y: 6,

  build(bg) {
    this.layers = [];
    for (const where of bg.spots) {
      for (const name of ['far', 'near']) {
        const layer = (cls, file, wide) => this.layers.push({ el: bg.layer(cls, file, null, where), depth: this.DEPTHS[name], far: name === 'far', wide });
        // Behind the content: the roots that hang there, under the menu's own reaching out.
        if (where === bg.far) layer('mb-roots mb-roots-more', `roots-more-${name}.svg`, true);
        layer('mb-roots', `roots-${name}.svg`, false);
      }
    }
    this.shade = null;
    if (bg.far) {
      this.shade = document.createElement('div');
      this.shade.className = 'mb-roots-shade';
      bg.out.insertBefore(this.shade, bg.far);
    }
    this.resize(bg);
  },

  /**
   * The pictures (the menu's 768 x 1400, the ones beyond it 960 x 1400 and going on to the side; from the menu's
   * top, a margin above and below) larger where the menu is taller than they are.
   */
  resize(bg) {
    for (const { el, wide } of this.layers) bg.fit(el, wide ? 960 : 768, 1400, 20, wide);
  },

  show(bg, t, fx, fy, still) {
    const p = this.PERIODS;
    for (const { el, depth, far } of this.layers) {
      // Round the loop at an even pace (cos and sin of the same angle: never both still).
      const round = (t / p.loop + depth.phase) * Math.PI * 2;
      const size = (1 + this.WOBBLE * bg.wave(t, p.wobble, depth.phase)) * depth.amount;
      // Against the mouse, as things nearer by seem to move more when one looks past them.
      const x = this.LOOP_X * size * Math.cos(round) - fx * this.PARALLAX_X * depth.amount;
      const y = this.LOOP_Y * size * Math.sin(round) - fy * this.PARALLAX_Y * depth.amount;
      const turn = this.TURN * depth.amount * bg.wave(t, p.turn, 0.6 + depth.phase);
      // From 1 - PULSE up to 1 and back, eased (a breath rather than a blink); the depths by turns.
      const pulse = still ? 1 : 1 - this.PULSE * (0.5 - 0.5 * bg.wave(t, p.pulse, 0.25 + (far ? 0.5 : 0)));
      bg.put(el, `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${turn.toFixed(3)}deg)`, pulse);
    }
    // The menu's shade over the content: as designed from that Visibility up, fainter below it.
    if (this.shade) this.shade.style.opacity = Math.min(1, (bg.strength * 100) / bg.VISIBILITY).toFixed(3);
  },
};

// Currents: long streamlines running down the menu, bundling and parting like
// water round stones, at two depths. They flow down along themselves on and on
// (tiles), the near ones faster, sway a little to the sides, and shift against
// the mouse.
MenuBg.STYLES.currents = {
  speed: 5,
  fps: 20,
  parallax: true,
  W: 320,
  T: 900,
  // Each depth: px a second down, the sway (px, s), how far it follows the mouse (px), how far its breath goes.
  LAYERS: [
    { file: 'currents-far.svg', flow: 3.5, sway: 2.5, period: 37, px: 5, py: 3, pulse: 0.2, phase: 0.4 },
    { file: 'currents-near.svg', flow: 6, sway: 4, period: 29, px: 11, py: 6, pulse: 0.2, phase: 0 },
  ],

  build(bg) {
    this.layers = bg.spots.flatMap((where) => this.LAYERS.map((d) => ({ d, el: bg.tiled('mb-currents', d.file, this.W, this.T, false, true, where) })));
  },

  show(bg, t, fx, fy, still) {
    for (const { d, el } of this.layers) {
      const x = d.sway * bg.wave(t, d.period, d.phase) - fx * d.px;
      const y = bg.wrap(d.flow * t + d.phase * this.T, this.T) - fy * d.py;
      const pulse = still ? 1 : 1 - d.pulse * (0.5 - 0.5 * bg.wave(t, 23, d.phase));
      bg.put(el, `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`, pulse);
    }
  },
};

// Vines: Roots' counterpart. Thin tendrils with small leaves climbing up from
// the menu's bottom to its top (fainter the higher), at two depths. They sway about where they grow from, as in
// a light wind (two rhythms on top of each other, so no swing is like the last),
// and shift against the mouse.
MenuBg.STYLES.vines = {
  speed: 5,
  fps: 16,
  parallax: true,
  // Each depth: the sway (degrees about the menu's bottom), how far it follows the mouse (px).
  LAYERS: [
    { file: 'vines-far.svg', sway: 0.3, px: 4, py: 2, phase: 0.45 },
    { file: 'vines-near.svg', sway: 0.5, px: 9, py: 4, phase: 0 },
  ],
  PERIODS: { sway: 14, gust: 5.3, lift: 19 },

  build(bg) {
    this.layers = bg.spots.flatMap((where) => this.LAYERS.map((d) => ({ d, el: bg.layer('mb-vines', d.file, null, where) })));
    this.resize(bg);
  },

  /**
   * The pictures (480 x 1400, standing on the menu's bottom, a margin below and above, going on into themselves to
   * the sides) larger where the menu is taller than they are.
   */
  resize(bg) {
    for (const { el } of this.layers) bg.fit(el, 480, 1400, bg.MARGIN * 2, true);
  },

  show(bg, t, fx, fy, still) {
    const p = this.PERIODS;
    for (const { d, el } of this.layers) {
      const turn = still ? 0 : d.sway * (bg.wave(t, p.sway, d.phase) + 0.3 * bg.wave(t, p.gust, d.phase * 2));
      const x = -fx * d.px;
      const y = (still ? 0 : 1.5 * bg.wave(t, p.lift, d.phase)) - fy * d.py;
      bg.put(el, `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${turn.toFixed(3)}deg)`, 1);
    }
  },
};

// Stars: small dots at three depths, the nearest with a soft glow, a few joined
// into constellations by hairlines. They drift very slowly (tiles), the nearer
// the faster, the middle and near ones twinkle in halves by turns, and they
// shift against the mouse more than any other style: the near ones most.
MenuBg.STYLES.stars = {
  speed: 5,
  fps: 10,
  parallax: true,
  W: 320,
  T: 640,
  // Each picture: px a second it drifts, how far it follows the mouse (px), how far it dims while twinkling and how often (s).
  LAYERS: [
    { file: 'stars-far.svg', vx: -0.22, vy: -0.14, px: 4, py: 3, dim: 0, period: 1, phase: 0 },
    { file: 'stars-mid-a.svg', vx: -0.5, vy: -0.3, px: 9, py: 6, dim: 0.45, period: 7, phase: 0 },
    { file: 'stars-mid-b.svg', vx: -0.5, vy: -0.3, px: 9, py: 6, dim: 0.45, period: 11, phase: 0.5 },
    { file: 'stars-near-a.svg', vx: -0.9, vy: -0.55, px: 16, py: 10, dim: 0.35, period: 9, phase: 0.2 },
    { file: 'stars-near-b.svg', vx: -0.9, vy: -0.55, px: 16, py: 10, dim: 0.35, period: 13, phase: 0.7 },
  ],

  build(bg) {
    this.layers = bg.spots.flatMap((where) => this.LAYERS.map((d) => ({ d, el: bg.tiled('mb-stars', d.file, this.W, this.T, true, true, where) })));
  },

  show(bg, t, fx, fy, still) {
    for (const { d, el } of this.layers) {
      const x = bg.wrap(d.vx * t, this.W) - fx * d.px;
      const y = bg.wrap(d.vy * t, this.T) - fy * d.py;
      const shine = still ? 1 : 1 - d.dim * (0.5 - 0.5 * bg.wave(t, d.period, d.phase));
      bg.put(el, `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`, shine);
    }
  },
};

// Vinyl: a record lying beyond the menu's bottom left corner: its grooves as
// rings round that middle, in bands with gaps between the songs, and the label's
// edge in the corner. Light lies on it in four soft beams from its middle (two
// strong ones opposite each other, two faint ones between), seen only on the
// grooves, which turn slowly round the record; the mouse turns them a little
// too, as a record's shine moves when one looks at it from elsewhere. The beams
// are one small picture (a canvas, drawn once, stretched over the whole record),
// so turning it draws nothing.
MenuBg.STYLES.vinyl = {
  speed: 5,
  fps: 12,
  parallax: true,
  // The pictures' size (as wide as any window), and the record's middle against the menu's bottom left corner (px), as in them.
  W: 4000,
  H: 3200,
  CX: -40,
  CY: 40,
  // The light: its picture's size (px) and how large it is shown (the record's far rim), a round's seconds, the mouse's degrees.
  LIGHT: 320,
  SIZE: 6600,
  ROUND: 420,
  MOUSE: 7,
  // How bright the grooves are in a strong beam's middle (against the picture whole).
  GLINT: 0.22,
  // The beams: where (degrees), how wide (to each side), how strong. A seed brings its own (menuBgMake.js).
  BEAMS: [[0, 10, 1], [180, 10, 1], [82, 6, 0.5], [262, 6, 0.5]],

  build(bg) {
    // In each spot: the grooves, and over them what the light shines through (the grooves again) with the light in it.
    this.sets = bg.spots.map((where, n) => {
      const grooves = bg.layer('mb-vinyl', 'vinyl-grooves.svg', null, where);
      const glint = bg.layer('mb-vinyl mb-vinyl-glint', '', null, where);
      const mask = `url("${bg.src('vinyl-mask.svg')}")`;
      glint.style.maskImage = mask;
      glint.style.webkitMaskImage = mask;
      const light = document.createElement('canvas');
      light.className = 'mb-vinyl-light';
      light.width = this.LIGHT;
      light.height = this.LIGHT;
      glint.appendChild(light);
      return { grooves, glint, light, n };
    });
    // Drawn once, copied for the other spot.
    this._drawLight(this.sets[0].light, bg.made.beams || this.BEAMS);
    for (const set of this.sets.slice(1)) {
      const ctx = set.light.getContext('2d');
      if (ctx) ctx.drawImage(this.sets[0].light, 0, 0);
    }
    this.resize(bg);
  },

  /** As tall as the menu; the record larger where the menu is taller than its pictures, the light with it. */
  resize(bg) {
    for (const { grooves, glint, light } of this.sets) {
      const k = bg.fit(grooves, this.W, this.H, 0, true);
      bg.fit(glint, this.W, this.H, 0, true);
      const size = `${(this.W * k).toFixed(1)}px ${(this.H * k).toFixed(1)}px`;
      glint.style.maskSize = size;
      glint.style.webkitMaskSize = size;
      Object.assign(light.style, {
        width: `${this.SIZE * k}px`,
        height: `${this.SIZE * k}px`,
        // Its middle on the record's.
        left: `${(this.CX - this.SIZE / 2) * k}px`,
        bottom: `${(-this.CY - this.SIZE / 2) * k}px`,
      });
    }
  },

  /** The beams, once: every pixel as bright as the beams reach at its angle (a soft bell across each). */
  _drawLight(canvas, beams) {
    const n = canvas.width;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(n, n);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const angle = (Math.atan2(y - n / 2 + 0.5, x - n / 2 + 0.5) * 180) / Math.PI;
        let a = 0;
        for (const [at, wide, strong] of beams) {
          const off = Math.abs(((angle - at + 540) % 360) - 180) / wide;
          if (off < 1) a += strong * (0.5 + 0.5 * Math.cos(off * Math.PI));
        }
        const i = (y * n + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(Math.min(1, a) * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  },

  show(bg, t, fx) {
    // Standing: a strong beam up through the menu.
    const turn = `rotate(${(-70 + (t / this.ROUND) * 360 + fx * this.MOUSE).toFixed(2)}deg)`;
    for (const { grooves, glint, light } of this.sets) {
      bg.put(grooves, 'none', 1);
      bg.put(glint, 'none', Math.min(1, this.GLINT * bg.gain));
      bg.move(light, turn);
    }
  },
};

// Mist: no lines at all. Soft wisps at two depths, thickest at the menu's
// bottom and thinning out all the way up to its top (the menu's own fade: menuBg.css). They
// rise on and on (tiles), drift to the sides and back, breathe, and shift a
// little against the mouse.
MenuBg.STYLES.mist = {
  speed: 5,
  fps: 12,
  parallax: true,
  W: 320,
  T: 800,
  // Each depth: px a second up, the drift to the sides (px, s), how far it follows the mouse (px).
  LAYERS: [
    { file: 'mist-far.svg', rise: 2.4, drift: 14, period: 61, px: 3, py: 2, phase: 0.3 },
    { file: 'mist-near.svg', rise: 4, drift: 20, period: 43, px: 7, py: 4, phase: 0 },
  ],

  build(bg) {
    this.layers = bg.spots.flatMap((where) => this.LAYERS.map((d) => ({ d, el: bg.tiled('mb-mist', d.file, this.W, this.T, true, true, where) })));
  },

  show(bg, t, fx, fy, still) {
    for (const { d, el } of this.layers) {
      const x = bg.wrap(d.drift * bg.wave(t, d.period, d.phase) + d.phase * this.W, this.W) - fx * d.px;
      const y = bg.wrap(-d.rise * t + d.phase * this.T, this.T) - fy * d.py;
      const breath = still ? 1 : 1 - 0.3 * (0.5 - 0.5 * bg.wave(t, 17, d.phase * 2));
      bg.put(el, `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`, breath);
    }
  },
};

// Circuit: thin traces on a grid, running up from the menu's bottom edge, and
// higher up from pads of their own (some coming in over the window's edge),
// turning at right angles, branching, each ending in a pad; fainter the higher
// they are. One picture that never moves. Now and then a signal sets out where
// a trace begins: a small light running along it, and where the trace branches
// it splits and runs on along every way at once, as a current does, each light
// to its pad, where it glows up and goes out. (The ways come with the picture:
// menuBgMake.js.)
// Only then are there frames: 60 a second at most while a signal is on its way,
// two a second while none is (to send the next one in time): one signal at a
// time, and a rest of some seconds after each.
MenuBg.STYLES.circuit = {
  speed: 5,
  fps: 2,
  parallax: false,
  // A light: px a second, the seconds of rest after a signal before the next (from, to), how long it glows at the pad,
  // how far from its start it fades in.
  RUN: 70,
  GAP: [3, 9],
  GLOW_S: 0.9,
  FADE: 36,
  // How many signals may be on their way at once. One: after it the picture rests (two frames a second) for a while.
  SIGNALS: 1,

  build(bg) {
    this.traces = bg.spots.map((where) => bg.layer('mb-circuit', 'circuit.svg', null, where));
    const rows = bg.made.ways || [];
    // The traces by their trunk: all the ways a signal that comes in there takes.
    const trees = new Map();
    for (const row of rows) {
      const pts = [];
      for (let i = 2; i < row.length; i += 2) pts.push([row[i], row[i + 1]]);
      if (pts.length < 2) continue;
      // How far along the way each corner is.
      const at = [0];
      for (let i = 1; i < pts.length; i += 1) at.push(at[i - 1] + Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]));
      // `from`: where it leaves the trace it branches from; up to there another light shows the signal.
      const way = { pts, at, length: at[at.length - 1], from: row[1], pad: false, stop: 0 };
      if (!trees.has(row[0])) trees.set(row[0], []);
      trees.get(row[0]).push(way);
    }
    this.trees = [...trees.values()].map((ways) => ({ ways, pads: 0, stop: 0 }));
    // The signals on their way ({ tree, since, lights: for each way, while it shows, its light in every spot })
    // and the lights not in use, by spot.
    this.signals = [];
    this.spare = bg.spots.map(() => []);
    this.next = null;
    this.seen = 0;
    this.seed = 7;
    this.resize(bg);
  },

  /**
   * As tall as the menu, the picture (480 x 1400, going on into itself to the sides) larger where the menu is
   * taller than it. And what of the ways is in sight (from the window's left edge to the menu's right one, or
   * as far as the texture reaches over): a light is shown up to its pad (`pad`) or up to where its way leaves
   * that for good, and a signal is sent only where a pad is in sight.
   */
  resize(bg) {
    for (const el of this.traces) this.k = bg.fit(el, 480, 1400, 0, true);
    const wide = ((bg.box.clientWidth || 248) + (bg.far ? bg.out.clientWidth : 0) - 4) / this.k;
    const seen = (x) => x >= 0 && x < wide;
    for (const tree of this.trees) {
      tree.pads = 0;
      tree.stop = 0;
      for (const way of tree.ways) {
        const last = way.pts.length - 1;
        way.pad = seen(way.pts[last][0]);
        way.stop = way.pad ? way.length + this.RUN * this.GLOW_S : 0;
        for (let i = last; i >= 1 && !way.pad; i -= 1) {
          const a = way.pts[i - 1][0];
          const b = way.pts[i][0];
          // A stretch wholly out of sight on one side.
          if (!seen(a) && !seen(b) && (a < 0) === (b < 0)) continue;
          // Out of sight from here on: a little beyond the edge it leaves by.
          way.stop = Math.min(way.at[i], way.at[i - 1] + Math.abs((b < 0 ? 0 : wide) - a) + 12);
          break;
        }
        if (way.pad) tree.pads += 1;
        tree.stop = Math.max(tree.stop, way.stop);
      }
    }
  },

  _random() {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  },

  /** While a signal is on its way: as smooth as allowed. */
  fpsNow(bg) {
    return this.signals.length ? bg.MAX_FPS : this.fps;
  },

  /** A way's lights (one in every spot) out, and kept for the next way. */
  _off(bg, lights) {
    lights.forEach((el, n) => {
      bg.put(el, el._mbTransform || 'none', 0);
      this.spare[n].push(el);
    });
  },

  show(bg, t, fx, fy, still) {
    for (const el of this.traces) bg.put(el, 'none', 1);
    if (still) {
      for (const s of this.signals) for (const lights of s.lights) if (lights) this._off(bg, lights);
      this.signals = [];
      return;
    }
    // The first one soon after it shows (or after standing still, which begins at 0 again).
    if (this.next === null || t < this.seen) this.next = t + 1.5;
    this.seen = t;
    if (t >= this.next) {
      if (this.signals.length < this.SIGNALS) {
        // Where a trunk no signal is on begins; one with more pads in sight the likelier, so the splitting shows.
        const open = this.trees.filter((tree) => tree.pads && !this.signals.some((s) => s.tree === tree));
        let pick = this._random() * open.reduce((sum, tree) => sum + tree.pads, 0);
        const tree = open.find((o) => (pick -= o.pads) < 0);
        if (tree) this.signals.push({ tree, since: t, lights: tree.ways.map(() => null) });
      }
      this.next = t + this.GAP[0] + this._random() * (this.GAP[1] - this.GAP[0]);
    }
    const on = this.signals.length;
    this.signals = this.signals.filter((s) => this._signal(bg, s, t));
    // The rest before the next one begins when the last one is over.
    if (on && !this.signals.length) this.next = t + this.GAP[0] + this._random() * (this.GAP[1] - this.GAP[0]);
  },

  /** A signal where it is now: a light on every way it has got to and not done with. False: it is over. */
  _signal(bg, s, t) {
    const gone = (t - s.since) * this.RUN;
    const over = gone >= s.tree.stop;
    s.tree.ways.forEach((way, n) => {
      if (over || gone < way.from || gone >= way.stop) {
        if (s.lights[n]) this._off(bg, s.lights[n]);
        s.lights[n] = null;
        return;
      }
      if (!s.lights[n]) s.lights[n] = bg.spots.map((where, i) => this.spare[i].pop() || bg.layer('mb-circuit-light', '', null, where));
      const glow = (gone - way.length) / this.RUN / this.GLOW_S;
      // Where along the way.
      const d = Math.min(way.length, gone);
      let i = 1;
      while (i < way.at.length - 1 && way.at[i] < d) i += 1;
      const k = (d - way.at[i - 1]) / Math.max(1, way.at[i] - way.at[i - 1]);
      const x = way.pts[i - 1][0] + (way.pts[i][0] - way.pts[i - 1][0]) * k;
      const y = way.pts[i - 1][1] + (way.pts[i][1] - way.pts[i - 1][1]) * k;
      // Coming up where it starts; at the pad larger and brighter for a moment, then gone.
      const size = glow > 0 ? 1 + 1.6 * Math.sin(Math.min(1, glow * 2.5) * Math.PI / 2) : 1;
      const alpha = glow > 0 ? 1 - glow * glow : Math.min(1, gone / this.FADE) * 0.8;
      // Fainter the higher, as the traces are.
      const high = 1 - 0.6 * Math.min(1, y / 1400);
      const place = `translate(${(x * this.k).toFixed(1)}px, ${(-y * this.k).toFixed(1)}px) scale(${size.toFixed(2)})`;
      for (const el of s.lights[n]) bg.put(el, place, alpha * high);
    });
    return !over;
  },
};

// Scales: a snake's or a dragon's scales over the whole menu, row under row,
// every other row half a scale over. Each row is a layer of its own (the same
// small picture), lying over the row below it as scales do: a scale's picture
// is its whole body, filled, so it hides the upper part of the scales under it.
// The rows sway to the left and right one after another: a wave running along
// the menu, as the body of a snake moving does (a second, longer and slower
// wave on top, running the other way). And they are not one piece: a slow wave
// pushes them together and apart a little, and every row slides a tiny bit by
// itself, sideways and up and down, so the rows shift over one another and
// each hides more or less of the one below. The mouse pushes all of them the
// other way, to the sides and up and down.
// The scales' measures and the movement's numbers come with the picture
// (menuBgMake.js, scalesLook), others for every seed. All rows lie in one box that is as solid as Settings'
// Visibility, the rows in it whole: only so a scale hides what is under it.
MenuBg.STYLES.scales = {
  speed: 5,
  fps: 24,
  parallax: true,
  PARALLAX_X: 9,
  PARALLAX_Y: 7,
  // The periods (s) of a row's own sliding, sideways and up and down: from, to.
  OWN_S: [[8, 15], [6, 11]],

  build(bg) {
    this.look = bg.made.look || MenuBgMake.scalesLook('');
    this.alls = bg.spots.map((where) => {
      const all = document.createElement('div');
      all.className = 'mb-scales-all';
      where.appendChild(all);
      return all;
    });
    // How far the rows reach beyond the menu to each side: the waves, their own sliding and the mouse together, and some more.
    this.side = Math.ceil(this.look.waves.reduce((sum, w) => sum + Math.abs(w[0]), 0) + this.look.own[0] + this.PARALLAX_X + 6);
    this.rows = [];
    this.count = 0;
    this.resize(bg);
  },

  /** A number between 0 and 1 for row `r`, always the same one (`n`: which of its numbers). */
  _of(r, n) {
    const v = Math.sin(r * 127.1 + n * 311.7 + this.look.key * 17.3) * 43758.5453;
    return v - Math.floor(v);
  },

  /** As many rows as the menu is tall, two more above and below; each over the next one. */
  resize(bg) {
    const L = this.look;
    const want = Math.ceil((bg.box.clientHeight || 0) / L.ROW) + 4;
    for (let r = this.count; r < want; r += 1) {
      const y = (r - 2) * L.ROW;
      const els = this.alls.map((all) => bg.layer('mb-scales', 'scales.svg', {
        top: `${y - L.BAND}px`,
        left: `${-this.side - (r % 2 ? L.W / 2 : 0)}px`,
        width: `calc(100% + ${this.side * 2 + L.W / 2}px)`,
        height: `${L.H}px`,
        backgroundSize: `${L.W}px ${L.H}px`,
        zIndex: String(4000 - r),
      }, all));
      const between = ([a, b], n) => a + (b - a) * this._of(r, n);
      this.rows.push({
        els,
        y,
        // Its own sliding: how much of it (sideways, up and down), how long a swing takes, where in it the row is.
        ax: 0.5 + 0.5 * this._of(r, 1),
        sx: between(this.OWN_S[0], 2),
        px: this._of(r, 3),
        ay: 0.5 + 0.5 * this._of(r, 4),
        sy: between(this.OWN_S[1], 5),
        py: this._of(r, 6),
      });
    }
    this.count = Math.max(this.count, want);
  },

  show(bg, t, fx, fy, still) {
    const L = this.look;
    const opacity = bg.strength.toFixed(4);
    for (const all of this.alls) {
      if (all._mbOpacity !== opacity) {
        all._mbOpacity = opacity;
        all.style.opacity = opacity;
      }
    }
    for (const row of this.rows) {
      let x = -fx * this.PARALLAX_X;
      let y = -fy * this.PARALLAX_Y;
      if (!still) {
        for (const [far, period, length] of L.waves) x += far * bg.wave(t, period, -row.y / length);
        x += L.own[0] * row.ax * bg.wave(t, row.sx, row.px);
        y += L.squeeze[0] * bg.wave(t, L.squeeze[1], -row.y / L.squeeze[2]) + L.own[1] * row.ay * bg.wave(t, row.sy, row.py);
      }
      const place = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
      for (const el of row.els) bg.move(el, place);
    }
  },
};
