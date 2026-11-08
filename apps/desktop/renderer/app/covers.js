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
  // The scrolling: the last move, whether it was fast, a sample per scroller.
  _lastScroll: 0,
  _fast: false,
  _samples: new WeakMap(),
  _settleTimer: null,

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
      if ('highResCovers' in patch) setTimeout(() => this.refresh(null));
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
    const now = performance.now();
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
    this._lastScroll = now;
    this._settleSoon();
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
    if (!box || !box.isConnected) return false;
    const r = box.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  },

  /** Boxes that waited for the scrolling: those on screen now get their pictures. */
  _flushWaiting() {
    for (const box of this._waiting) {
      if (!box.isConnected) {
        this._waiting.delete(box);
        continue;
      }
      if (!this._onScreen(box)) continue;
      this._waiting.delete(box);
      const song = Store.song(box.dataset.coverId);
      if (song) this._fill(box, song, { now: true });
    }
  },

  /** The thumbnails asked for, of the rows still on screen, in one go. */
  _flushAsk() {
    const ids = [];
    for (const [id, box] of this._ask) {
      if (!box || this._onScreen(box)) ids.push(id);
      else {
        // Scrolled off before its turn: tried again once it is on screen.
        this._asked.delete(id);
        if (box.isConnected) this._waiting.add(box);
      }
    }
    this._ask.clear();
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
  serverPending(index, version) {
    const k = `server:${index}`;
    if (!version || this._serverAsked.get(k) === version) return;
    this._serverAsked.set(k, version);
    window.flow.serverDownloads('cover', { index, version }).then((file) => {
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
    clear(box);
    this._waiting.delete(box);
    box.dataset.coverId = song ? song.id : '';
    const size = box.dataset.coverSize === 'big' ? 'big' : 'small';
    const list = this.candidates(song, size);
    if (!list.length) {
      box.appendChild(this._placeholder());
      return;
    }
    // A server's song while the list flies by (or always where nothing is
    // kept: the web player loads each from the server): its turn comes once
    // the scrolling settles, if it is still on screen.
    if (!now && size === 'small' && this._isServer(song) && (!this._settled() || !Store.can('offline'))) {
      box.appendChild(this._placeholder());
      this._waiting.add(box);
      this._settleSoon();
      return;
    }
    const img = h('img.cover__img', { alt: '', loading: 'lazy', decoding: 'async', draggable: false });
    let at = 0;
    img.addEventListener('error', () => {
      if (at === 0 && size === 'big') this.askBig(song);
      at += 1;
      if (at < list.length) {
        img.src = list[at];
        return;
      }
      this._missing(box, img, song);
    });
    if (size === 'big') {
      img.addEventListener('load', () => {
        if (at === 0) this._bigHere.add(`${song.id}:${song.cover}`);
      });
    }
    img.src = list[0];
    box.appendChild(img);
  },

  /** No file (yet): the note, and a server song's thumbnail is asked for once the scrolling settles. */
  _missing(box, img, song) {
    img.remove();
    if (!box.querySelector('.cover__note')) box.appendChild(this._placeholder());
    if (this._isServer(song) && !this._asked.has(song.id)) {
      this._asked.add(song.id);
      this._ask.set(song.id, box);
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
