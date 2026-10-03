'use strict';

// Song covers in the window: files in Music\FlowPlayer\Covers (the main
// process's covers.js keeps them; a Flow Server's come down in the
// background). A song's cover is <folder>\<id>.jpg, its version (song.cover)
// on the address so a new cover is a new picture. Without one, or until its
// file is there, a note stands in.
//
// Covers.el(song) is the picture at the front of every song row; the rows
// on screen without their file yet ask the main process for it (a server's
// come down first), and get it in place when it arrives (onCoversUpdated).

const Covers = {
  dirs: { local: '', server: '' },
  _asked: new Set(),
  _ask: [],
  _askTimer: null,
  _tries: 0,
  // song id -> how often its file arrived since: a new address each time, so
  // a load that failed before is not taken from Chromium's memory.
  _arrived: new Map(),

  init(dirs) {
    this.dirs = dirs || this.dirs;
    window.flow.onCoversUpdated((info) => {
      if (info.dirs) this.dirs = info.dirs;
      this.refresh(info.ids);
    });
  },

  /** The cover file of a song as a file:// address, or '' when it has none. */
  src(song, { local = false } = {}) {
    if (!song || !song.cover || song.cover === '-') return '';
    const dir = Store.server.on && !local ? this.dirs.server : this.dirs.local;
    if (!dir) return '';
    const again = this._tries + (this._arrived.get(song.id) || 0);
    return `${Util.fileUrl(`${dir}\\${song.id}.jpg`)}?v=${encodeURIComponent(song.cover)}${again ? `&r=${again}` : ''}`;
  },

  /** The note that stands in for a cover. */
  _placeholder() {
    return h('span.cover__note', { html: Icons.library });
  },

  /**
   * A square cover for `song`, sized by its class (cover--row, cover--bar,
   * cover--big). Lazy: rows far down the list load theirs when scrolled to.
   */
  el(song, size = 'row') {
    const box = h(`span.cover.cover--${size}`, { dataset: { coverId: song ? song.id : '' }, 'aria-hidden': 'true' });
    this._fill(box, song);
    return box;
  },

  /** Puts the song's picture (or the note, for null) into a cover box. */
  fill(box, song) {
    this._fill(box, song);
  },

  _fill(box, song) {
    clear(box);
    box.dataset.coverId = song ? song.id : '';
    const src = this.src(song);
    if (!src) {
      box.appendChild(this._placeholder());
      return;
    }
    const img = h('img.cover__img', { alt: '', loading: 'lazy', decoding: 'async', draggable: false });
    img.addEventListener('error', () => this._missing(box, img, song));
    img.src = src;
    box.appendChild(img);
  },

  /**
   * No file (yet): a server song's is asked for; a song still on its way up
   * may have its Local Files cover; otherwise the note.
   */
  _missing(box, img, song) {
    const local = Store.server.on && !img.dataset.local ? this.src(song, { local: true }) : '';
    if (local) {
      img.dataset.local = '1';
      img.src = local;
      return;
    }
    img.remove();
    if (!box.querySelector('.cover__note')) box.appendChild(this._placeholder());
    if (Store.server.on && song && !this._asked.has(song.id)) {
      this._asked.add(song.id);
      this._ask.push(song.id);
      clearTimeout(this._askTimer);
      this._askTimer = setTimeout(() => {
        const ids = this._ask;
        this._ask = [];
        window.flow.wantCovers(ids).catch(() => {});
      }, 100);
    }
  },

  /** Covers that arrived: the boxes showing those songs (all, for null) load them again. */
  refresh(ids) {
    const only = Array.isArray(ids) ? new Set(ids) : null;
    if (!only) {
      this._asked.clear();
      this._tries += 1;
    } else {
      for (const id of only) this._arrived.set(id, (this._arrived.get(id) || 0) + 1);
    }
    for (const box of document.querySelectorAll('.cover[data-cover-id]')) {
      const id = box.dataset.coverId;
      if (!id || (only && !only.has(id))) continue;
      this._asked.delete(id);
      this._fill(box, Store.song(id));
    }
  },
};
