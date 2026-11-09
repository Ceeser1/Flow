'use strict';

// Song covers in the window: files in Music\FlowPlayer\Covers (the main
// process's covers.js keeps them), in two sizes since 4.3.1:
// <folder>\thumbnails\<id>.webp (128 x 128, every list) and
// <folder>\high_res\<id>.webp (512 x 512: Details, the visualizers, the lock
// screen). The version (song.cover) is on the address, so a new cover is a
// new picture. Without one, or until its file is there, a note stands in.
//
// Covers.el(song) is the picture at the front of every song row. A Flow
// Server's covers come when shown: while a list scrolls by fast (more than a
// screen a second) its rows wait, and once it stops or almost stops (50 ms
// still, or slower) the rows still on screen show theirs, those without a
// file asking the main process for them in one go (onCoversUpdated brings
// them). The big ones are asked for one at a time where they are shown (and
// for the next song a little before it starts); the main process fetches
// them only with "Download high resolution covers", the thumbnail stands in
// meanwhile.
//
// Covers.pendingEl(key) is the cover of a song on the Add Songs page that is
// downloaded but not saved yet, found right after its download: key is its
// cached file, or 'server:<index>' for a song of the server's download.

const Covers = {
  dirs: { local: '', server: '' },
  SUB: { small: 'thumbnails', big: 'high_res' },
  ASK_MAX: 100,
  _asked: new Set(), // song ids asked for (thumbnails) since their last arrival
  _askedBig: new Set(), // `${id}:${version}` asked for (big)
  _ask: new Map(), // id -> its box, waiting for the scrolling to settle
  _waiting: new Set(), // boxes of a server's songs to be filled once the scrolling settles
  _tries: 0,
  // song id -> how often its file arrived since: a new address each time, so
  // a load that failed before is not taken from Chromium's memory.
  _arrived: new Map(),
  _bigHere: new Set(), // `${id}:${version}` whose big file loaded
  _listeners: [],
  // Add Songs: key -> file:// address of a song's cover before it is saved.
  _pending: new Map(),
  _serverAsked: new Map(), // 'server:<index>' -> version asked for
  // The scrolling: the last move, whether it was fast, a sample per scroller
  // (taken once a frame: reading where a list is in the scroll event itself
  // would measure the page again at every event).
  _lastScroll: 0,
  _fast: false,
  _samples: new WeakMap(),
  _scrolled: new Set(),
  _scrollFrame: 0,
  _settleTimer: null,
  // Boxes waiting (or asked for) that are on screen, told by an
  // IntersectionObserver, so nothing is measured to find them.
  _visible: new Set(),
  _watched: new WeakSet(),
  _placed: new WeakSet(),
  _io: null,
  // Addresses that loaded: a list drawn again shows them at once (a box
  // left empty until its look would blink at every redraw).
  _loaded: new Set(),

  init(dirs) {
    this.dirs = dirs || this.dirs;
    window.flow.onCoversUpdated((info) => {
      if (info.dirs) this.dirs = info.dirs;
      this.refresh(info.ids, info.size || null);
    });
    window.flow.onCoverStaged((info) => {
      this._setPending(info.cachePath, this._address(info.file, `v=${encodeURIComponent(info.version)}`));
    });
    document.addEventListener('scroll', (e) => this._onScroll(e), { capture: true, passive: true });
    // The high-res tick changed: the big covers asked for again (after the setting reached the app).
    Store.onSettings((patch) => {
      if ('highResCovers' in patch || 'thumbCovers' in patch) setTimeout(() => this.refresh(null));
    });
  },

  /** fn(ids, size): covers arrived (the player and the visualizers take a big one in). */
  onArrived(fn) {
    this._listeners.push(fn);
  },

  // ---- the scrolling ----

  _onScroll(e) {
    const el = e.target === document || !e.target || e.target.nodeType !== 1 ? document.scrollingElement : e.target;
    if (!el) return;
    this._lastScroll = performance.now();
    this._scrolled.add(el);
    if (!this._scrollFrame) this._scrollFrame = requestAnimationFrame(() => this._sampleScroll());
    this._settleSoon();
  },

  /** Once a frame while lists scroll: how fast they go. */
  _sampleScroll() {
    this._scrollFrame = 0;
    const now = performance.now();
    for (const el of this._scrolled) {
      const top = el.scrollTop;
      const prev = this._samples.get(el);
      if (!prev || now - prev.t > 250) {
        this._samples.set(el, { t: now, top });
      } else if (now - prev.t >= 30) {
        // Screens a second, over at least 30 ms (single wheel steps are not a speed).
        const screens = Math.abs(top - prev.top) / Math.max(1, el.clientHeight);
        this._fast = screens / ((now - prev.t) / 1000) > 1;
        this._samples.set(el, { t: now, top });
      }
    }
    this._scrolled.clear();
  },

  /** A box whose turn may come once it is on screen: watched for that. */
  // The observer tells where a box is a moment after it is watched: until
  // then (not in _placed) its turn waits, it is not taken as off screen.
  _watch(box) {
    if (!this._io) {
      this._io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          this._placed.add(en.target);
          if (en.isIntersecting) this._visible.add(en.target);
          else this._visible.delete(en.target);
        }
        this._settleSoon();
      });
    }
    if (this._watched.has(box)) return;
    this._watched.add(box);
    this._placed.delete(box);
    this._io.observe(box);
  },

  _unwatch(box) {
    if (this._io) this._io.unobserve(box);
    this._watched.delete(box);
    this._placed.delete(box);
    this._visible.delete(box);
  },

  /** The lists are still, or nearly: what is on screen may load. */
  _settled() {
    return !this._fast || performance.now() - this._lastScroll >= 50;
  },

  _settleSoon() {
    if (this._settleTimer) return;
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      if (!this._settled()) {
        this._settleSoon();
        return;
      }
      this._fast = false;
      this._flushWaiting();
      this._flushAsk();
    }, this._settled() ? 16 : 60);
  },

  _onScreen(box) {
    return !!box && box.isConnected && this._visible.has(box);
  },

  /** Boxes that waited for the scrolling: those on screen now get their pictures. */
  _flushWaiting() {
    const shown = [];
    for (const box of this._waiting) {
      if (!box.isConnected) {
        this._waiting.delete(box);
        this._unwatch(box);
      } else if (this._onScreen(box)) {
        shown.push(box);
      }
    }
    for (const box of shown) {
      this._waiting.delete(box);
      this._unwatch(box);
      const song = Store.song(box.dataset.coverId);
      if (song) this._fill(box, song, { now: true });
    }
  },

  /** The thumbnails asked for, of the rows still on screen, in one go. */
  _flushAsk() {
    const ids = [];
    const later = [];
    for (const [id, box] of this._ask) {
      if (!box || this._onScreen(box)) {
        ids.push(id);
        if (box && !this._waiting.has(box)) this._unwatch(box);
      } else if (box.isConnected && !this._placed.has(box)) {
        // Not told where it is yet: the next flush (the observer brings one).
        later.push([id, box]);
      } else if (box.isConnected) {
        // Scrolled off before its turn: tried again once it is on screen.
        this._asked.delete(id);
        this._waiting.add(box);
        this._watch(box);
      } else {
        this._asked.delete(id);
        this._unwatch(box);
      }
    }
    this._ask = new Map(later);
    for (let i = 0; i < ids.length; i += this.ASK_MAX) {
      window.flow.wantCovers(ids.slice(i, i + this.ASK_MAX), 'small').catch(() => {});
    }
  },

  // ---- addresses ----

  /**
   * A cover file's address with `query` on it. The web player's addresses
   * may have a query of their own (a server's cover, ?t=) or a fragment (a
   * blob: address, which a query would break): then it is added after that.
   */
  _address(file, query) {
    const url = Util.fileUrl(file);
    return `${url}${/[?#]/.test(url) ? '&' : '?'}${query}`;
  },

  _pendingKey(key) {
    return String(key || '').toLowerCase();
  },

  /** The cover box of a song not saved yet (the note until its cover is found). */
  pendingEl(key, size = 'row') {
    const k = this._pendingKey(key);
    const box = h(`span.cover.cover--${size}`, { dataset: { pendingKey: k }, 'aria-hidden': 'true' });
    this._fillPending(box, k);
    return box;
  },

  _fillPending(box, k) {
    clear(box);
    const src = this._pending.get(k);
    if (!src) {
      box.appendChild(this._placeholder());
      return;
    }
    const img = h('img.cover__img', { alt: '', decoding: 'async', draggable: false });
    img.addEventListener('error', () => {
      img.remove();
      if (!box.querySelector('.cover__note')) box.appendChild(this._placeholder());
    });
    img.src = src;
    box.appendChild(img);
  },

  _setPending(key, src) {
    const k = this._pendingKey(key);
    if (this._pending.get(k) === src) return;
    this._pending.set(k, src);
    for (const box of document.querySelectorAll('.cover[data-pending-key]')) {
      if (box.dataset.pendingKey === k) this._fillPending(box, k);
    }
  },

  /** A song of the server's download whose cover the server found (version): fetched once. */
  serverPending(index, version, batchId = '') {
    const k = `server:${index}`;
    if (!version || this._serverAsked.get(k) === version) return;
    this._serverAsked.set(k, version);
    window.flow.serverDownloads('cover', { index, version, batchId }).then((file) => {
      if (file && this._serverAsked.get(k) === version) this._setPending(k, this._address(file, `v=${encodeURIComponent(version)}`));
    }).catch(() => {
      this._serverAsked.delete(k);
    });
  },

  /** The server's download batch is gone or new: its songs' covers are forgotten. */
  forgetServerPending() {
    for (const k of [...this._pending.keys()]) if (k.startsWith('server:')) this._pending.delete(k);
    this._serverAsked.clear();
  },

  /** Whether a song's covers are a Flow Server's (fetched when shown), not Local Files'. */
  _isServer(song) {
    return !!(song && !song.foreign && Store.server.on && !song.isDevice);
  },

  /** A file of a song's cover: its folder's ('server' or 'local'), size, and id there. */
  _file(song, scope, size) {
    const dir = this.dirs[scope];
    if (!dir) return '';
    const id = scope === 'local' && song.isDevice ? song.localId : song.id;
    const again = this._tries + (this._arrived.get(song.id) || 0);
    const query = `v=${encodeURIComponent(song.cover)}${again ? `&r=${again}` : ''}`;
    if (size === 'old') return this._address(`${dir}/${id}.jpg`, query);
    return this._address(`${dir}/${this.SUB[size]}/${id}.webp`, query);
  },

  /**
   * The addresses to try for a song's cover, best first: the size asked for,
   * then what stands in (the thumbnail for a big one, the big one for a
   * missing thumbnail of Local Files, a server song's Local Files copy, a
   * Local Files cover from before 4.3.1 not made into the two yet).
   */
  candidates(song, size = 'small') {
    if (!song || !song.cover || song.cover === '-') return [];
    // Another server's song (a guest in its session): its cover from there.
    if (song.foreign) return song.coverUrl ? [song.coverUrl] : [];
    const list = [];
    const add = (scope, sz) => {
      const src = this._file(song, scope, sz);
      if (src && !list.includes(src)) list.push(src);
    };
    if (this._isServer(song)) {
      if (size === 'big') add('server', 'big');
      add('server', 'small');
      // A song still on its way up may have its Local Files cover.
      add('local', 'small');
      add('local', 'big');
    } else {
      if (size === 'big') add('local', 'big');
      add('local', 'small');
      add('local', 'big');
      add('local', 'old');
    }
    return list;
  },

  /** The cover file of a song as an address ('small' or 'big'), or '' when it has none. */
  src(song, { size = 'small' } = {}) {
    return this.candidates(song, size)[0] || '';
  },

  /**
   * The best address of a song's big cover known to load now (the
   * thumbnail until the big one did); asks for the big one when it is not
   * known here. For the lock screen.
   */
  bestBig(song) {
    if (!song || !song.cover || song.cover === '-') return '';
    if (this._bigHere.has(`${song.id}:${song.cover}`)) return this.src(song, { size: 'big' });
    this.probeBig(song);
    return this.src(song);
  },

  /**
   * Whether a song's big cover loads (the song starting, or coming next):
   * when it does it is known for bestBig, when not it is asked for (fetched
   * with the high-res setting; onArrived tells).
   */
  probeBig(song) {
    if (!song || !song.cover || song.cover === '-' || song.foreign) return;
    const key = `${song.id}:${song.cover}`;
    if (this._bigHere.has(key)) return;
    const src = this.src(song, { size: 'big' });
    if (!src) return;
    const img = new Image();
    img.onload = () => {
      if (this._bigHere.has(key)) return;
      this._bigHere.add(key);
      for (const fn of this._listeners) fn([song.id], 'big');
    };
    img.onerror = () => this.askBig(song);
    img.src = src;
  },

  /** A server song's big cover asked for, once per version. */
  askBig(song) {
    if (!this._isServer(song)) return;
    const key = `${song.id}:${song.cover}`;
    if (this._askedBig.has(key)) return;
    this._askedBig.add(key);
    window.flow.wantCovers([song.id], 'big').catch(() => {});
  },

  /** The note that stands in for a cover. */
  _placeholder() {
    return h('span.cover__note', { html: Icons.library });
  },

  /**
   * A square cover for `song`, sized by its class (cover--row, cover--bar,
   * cover--big: the only one showing the 512 x 512 picture). Lazy: rows far
   * down the list load theirs when scrolled to.
   */
  el(song, size = 'row') {
    const box = h(`span.cover.cover--${size}`, { dataset: { coverId: song ? song.id : '', coverSize: size === 'big' ? 'big' : 'small' }, 'aria-hidden': 'true' });
    this._fill(box, song);
    return box;
  },

  /** Puts the song's picture (or the note, for null) into a cover box. */
  fill(box, song) {
    this._fill(box, song);
  },

  _fill(box, song, { now = false } = {}) {
    const id = song ? song.id : '';
    const sizeOf = box.dataset.coverSize === 'big' ? 'big' : 'small';
    // The same picture on its way already (a box drawn again while it loads).
    if (!now && (box._coverJob || box._coverProbe) && box.dataset.coverId === id
      && box._coverFirst === (this.candidates(song, sizeOf)[0] || '')) return;
    if (this._waiting.delete(box)) this._unwatch(box);
    this._unnear(box);
    box._coverProbe = null;
    // Another song: what was shown goes at once (the same one's stays until
    // its new picture is there).
    if (box.dataset.coverId !== id) clear(box);
    box.dataset.coverId = id;
    const size = sizeOf;
    const list = this.candidates(song, size);
    box._coverFirst = list[0] || '';
    if (!list.length) {
      this._show(box, '');
      return;
    }
    // One of its addresses loaded before: shown now (the best one: done).
    const known = list.find((src) => this._loaded.has(src)) || '';
    if (known && known === list[0]) {
      this._show(box, known);
      return;
    }
    // A server's song while the list flies by (or always where nothing is
    // kept: the web player loads each from the server): its turn comes once
    // the scrolling settles, if it is still on screen.
    if (!now && size === 'small' && this._isServer(song) && (!this._settled() || !Store.can('offline'))) {
      this._show(box, known);
      this._waiting.add(box);
      this._watch(box);
      this._settleSoon();
      return;
    }
    if (known) this._show(box, known);
    box._coverJob = { song, size, list };
    this._near(box);
  },

  /**
   * A picture (its address) or the note ('') in a box, changing it only when
   * it differs.
   */
  _show(box, src) {
    const img = box.querySelector('img.cover__img');
    if (src) {
      if (img && img.getAttribute('src') === src) return;
      clear(box);
      // A thumbnail is decoded with the frame it is put in (it loaded
      // already, and is small): drawn again, a row never shows an empty box.
      box.appendChild(h('img.cover__img', {
        alt: '', decoding: box.dataset.coverSize === 'big' ? 'async' : 'sync', draggable: false, src,
      }));
    } else if (img || !box.querySelector('.cover__note')) {
      clear(box);
      box.appendChild(this._placeholder());
    }
  },

  // A box's picture is looked for once it comes near the screen (lazy), and
  // off the page: its addresses are tried on an Image of its own, and only
  // one that loads goes into the box. A picture failing in the page would
  // make Chromium draw its broken-image stand-in and measure the list again,
  // up to three times a row, which made long lists stutter while scrolling.
  _near(box) {
    if (!this._nearIo) {
      this._nearIo = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          this._nearIo.unobserve(en.target);
          this._probe(en.target);
        }
      }, { rootMargin: '400px 0px', scrollMargin: '400px 0px' });
    }
    this._nearIo.observe(box);
  },

  _unnear(box) {
    if (this._nearIo) this._nearIo.unobserve(box);
    box._coverJob = null;
  },

  /**
   * The cover boxes in `node` (or it) leave the page for good (a long
   * list's rows scrolled away, a list drawn again): no longer watched, and
   * a picture on its way for them is not put in.
   */
  release(node) {
    if (!node || node.nodeType !== 1) return;
    const boxes = node.matches('.cover') ? [node] : node.querySelectorAll('.cover');
    for (const box of boxes) {
      this._unnear(box);
      box._coverProbe = null;
      this._waiting.delete(box);
      this._unwatch(box);
      // Its turn to ask goes to the box shown for that song now (one asking
      // from a list drawn again would wait for it forever).
      const id = box.dataset.coverId;
      if (id && this._ask.get(id) === box) {
        this._ask.delete(id);
        this._asked.delete(id);
      }
    }
  },

  _probe(box) {
    const job = box._coverJob;
    if (!job) return;
    box._coverJob = null;
    const { song, size, list } = job;
    const probe = new Image();
    box._coverProbe = probe;
    let at = 0;
    probe.onload = () => {
      if (box._coverProbe !== probe) return;
      box._coverProbe = null;
      if (this._loaded.size > 20000) this._loaded.clear();
      this._loaded.add(list[at]);
      if (size === 'big' && at === 0) this._bigHere.add(`${song.id}:${song.cover}`);
      this._show(box, list[at]);
    };
    probe.onerror = () => {
      if (box._coverProbe !== probe) return;
      if (at === 0 && size === 'big') this.askBig(song);
      at += 1;
      if (at < list.length) {
        probe.src = list[at];
        return;
      }
      box._coverProbe = null;
      this._show(box, '');
      this._missing(box, song);
    };
    probe.src = list[0];
  },

  /** No file (yet): a server song's thumbnail is asked for once the scrolling settles. */
  _missing(box, song) {
    // A box not in the page asks nothing: a list drawn again leaves its old
    // rows behind, and one of those must not take the shown row's turn. One
    // put in the page right after still asks.
    if (!box.isConnected) {
      requestAnimationFrame(() => {
        if (box.isConnected) this._askFor(box, song);
      });
      return;
    }
    this._askFor(box, song);
  },

  _askFor(box, song) {
    // Asked already from a box no longer in the page, not sent yet: this one asks instead.
    const before = this._ask.get(song.id);
    if (before && before !== box && !before.isConnected) this._asked.delete(song.id);
    if (this._isServer(song) && !this._asked.has(song.id)) {
      this._asked.add(song.id);
      this._ask.set(song.id, box);
      this._watch(box);
      this._settleSoon();
    }
  },

  /**
   * Covers that arrived ('small', 'big', or null for both): the boxes showing
   * those songs (all, for null ids) load them again.
   */
  refresh(ids, size = null) {
    const only = Array.isArray(ids) ? new Set(ids) : null;
    if (!only) {
      this._asked.clear();
      this._askedBig.clear();
      this._bigHere.clear();
      this._tries += 1;
    } else {
      for (const id of only) {
        this._arrived.set(id, (this._arrived.get(id) || 0) + 1);
        this._asked.delete(id);
        if (size !== 'small') {
          for (const key of [...this._bigHere]) if (key.startsWith(`${id}:`)) this._bigHere.delete(key);
        }
      }
    }
    for (const box of document.querySelectorAll('.cover[data-cover-id]')) {
      const id = box.dataset.coverId;
      if (!id || (only && !only.has(id))) continue;
      this._fill(box, Store.song(id), { now: true });
    }
    for (const fn of this._listeners) fn(only ? [...only] : null, size);
  },
};
