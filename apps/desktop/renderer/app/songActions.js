'use strict';

// A song row's Actions: two buttons always there (Add to Queue and Play) and
// "More" (three dots), which slides the rest out to its left (Download,
// Favourite, Song Details, Edit, Delete / Remove). The tray floats over the page rather than
// sitting in the cell, which cuts off anything wider than itself. One tray is
// open at a time; a click anywhere else, a scroll, Escape or any of its
// buttons closes it.

const SongActions = {
  tray: null,
  anchor: null,
  picker: null, // the "Add to Playlists" popup beside the tray (or above the player's button)
  pickerAnchor: null, // the player's button it opened from

  init() {
    const outside = (e) => {
      if (!this.tray && !this.picker) return;
      if ((this.tray && this.tray.contains(e.target)) || (this.anchor && this.anchor.contains(e.target))) return;
      if (this.picker && this.picker.contains(e.target)) return;
      if (this.pickerAnchor && this.pickerAnchor.contains(e.target)) return;
      this.close();
    };
    document.addEventListener('pointerdown', outside, true);
    // Scrolling the picker's own list is no reason to close it.
    document.addEventListener('scroll', (e) => {
      if (this.picker && this.picker.contains(e.target)) return;
      this.close();
    }, true);
    window.addEventListener('resize', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.tray || this.picker) && !Modal.top()) {
        e.stopPropagation();
        this.close();
      }
    }, true);
    // The row may be redrawn or gone. The player's popup holds its song itself.
    Store.onLibrary(() => {
      if (!this.pickerAnchor) this.close();
    });
  },

  /** The cell: `shown` buttons, then More holding `more` (built when opened). */
  cell(shown, more) {
    const btn = iconButton('act.act--grey.act--more', Icons.more, 'More', () => {
      if (this.anchor === btn) this.close();
      else this.open(btn, more());
    });
    return h('div.actions', ...shown, btn);
  },

  /** `className`: another class for the tray (act-tray--settings: over the Settings window). */
  open(anchor, buttons, className = '') {
    this.close();
    const tray = h('div.act-tray' + (className ? '.' + className : ''), { role: 'menu' }, ...buttons);
    // Any of its buttons does its thing and closes it.
    tray.addEventListener('click', (e) => {
      const button = e.target.closest('button');
      if (button && !button.dataset.keepOpen) setTimeout(() => this.close(), 0);
    });
    document.body.appendChild(tray);
    const r = anchor.getBoundingClientRect();
    const pad = 4;
    tray.style.top = `${Math.round(r.top - pad - 1)}px`;
    tray.style.right = `${Math.round(window.innerWidth - r.left + 4)}px`;
    anchor.classList.add('act--open');
    anchor.setAttribute('aria-expanded', 'true');
    this.tray = tray;
    this.anchor = anchor;
    requestAnimationFrame(() => tray.classList.add('act-tray--in'));
  },

  /**
   * The tray's "Add to Playlists" button (the leftmost): opens a popup to its
   * left instead of closing the tray. See pickPlaylists.
   */
  playlistButton(song) {
    const btn = iconButton('act.act--green', Icons.playlists, 'Add to Playlists', () => this.pickPlaylists(btn, song));
    btn.dataset.keepOpen = '1';
    return btn;
  },

  /**
   * Your playlists as a list with a box each (ticked: the song is in it) and
   * Apply below, ten rows high before it scrolls. Apply puts the song into
   * the newly ticked playlists and takes it out of the newly unticked ones,
   * then closes the popup and the tray; so does a click anywhere else.
   * `above`: opened from the player's button, over it and naming the song.
   */
  pickPlaylists(anchor, song, { above = false } = {}) {
    if (document.body.classList.contains('mobile')) return this._pickPlaylistsSheet(song);
    if (this.picker) {
      const again = this.pickerAnchor === anchor;
      this.picker.remove();
      this.picker = null;
      this.pickerAnchor = null;
      if (again || !above) return;
    }
    const lists = Store.sortedPlaylists();
    const had = new Set(lists.filter((p) => p.entries.some((e) => e.songId === song.id)).map((p) => p.id));
    const boxes = new Map();
    const rows = lists.map((p) => {
      const box = h('input', { type: 'checkbox', checked: had.has(p.id) });
      boxes.set(p.id, box);
      return h('label.check.pl-picker__row', { title: p.name }, box, h('span', p.name));
    });
    const apply = h('button.btn.btn--primary.btn--small', {
      type: 'button',
      disabled: !lists.length,
      onclick: () => this._applyPlaylists(song, had, boxes),
    }, 'Apply');
    const picker = h('div.pl-picker', { role: 'dialog', 'aria-label': 'Add to Playlists' },
      h('div.pl-picker__title', 'Add to Playlists'),
      above ? h('div.pl-picker__song', { title: Util.songLine(song) }, Util.songLine(song)) : null,
      h('div.pl-picker__list', ...(rows.length ? rows : [h('div.pl-picker__empty', 'No playlists yet.')])),
      apply);
    document.body.appendChild(picker);
    this.picker = picker;
    if (above) {
      // Over the player's button, from its left edge (kept in the window).
      const r = anchor.getBoundingClientRect();
      const width = picker.getBoundingClientRect().width;
      picker.style.left = `${Math.max(8, Math.min(Math.round(r.left), window.innerWidth - width - 8))}px`;
      picker.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
      this.pickerAnchor = anchor;
      return;
    }
    // Left of the tray, its top level with the tray's.
    const t = this.tray ? this.tray.getBoundingClientRect() : anchor.getBoundingClientRect();
    picker.style.right = `${Math.round(window.innerWidth - t.left + 6)}px`;
    const height = picker.getBoundingClientRect().height;
    picker.style.top = `${Math.max(8, Math.min(Math.round(t.top), window.innerHeight - height - 8))}px`;
  },

  /** The phone's Add to Playlists: the same list with boxes, as a sheet with Apply. */
  _pickPlaylistsSheet(song) {
    const lists = Store.sortedPlaylists();
    const had = new Set(lists.filter((p) => p.entries.some((e) => e.songId === song.id)).map((p) => p.id));
    const boxes = new Map();
    const rows = lists.map((p) => {
      const box = h('input', { type: 'checkbox', checked: had.has(p.id) });
      boxes.set(p.id, box);
      return h('label.check.picker__row', box, h('span.picker__name', p.name),
        h('span.picker__meta', Util.plural(p.entries.length, 'song')));
    });
    Modal.open({
      title: 'Add to Playlists',
      sheet: true,
      className: 'modal--picker',
      body: [h('p.modal__subtitle', Util.songLine(song)),
        h('div.picker__list', ...(rows.length ? rows : [h('div.picker__empty', 'No playlists yet.')]))],
      buttons: [
        { label: 'Cancel' },
        { label: 'Apply', kind: 'primary', onClick: () => { this._applyPlaylists(song, had, boxes); } },
      ],
    });
  },

  async _applyPlaylists(song, had, boxes) {
    const add = [];
    const remove = [];
    for (const [id, box] of boxes) {
      if (box.checked && !had.has(id)) add.push(id);
      if (!box.checked && had.has(id)) remove.push(id);
    }
    this.close();
    if (!add.length && !remove.length) return;
    await attempt(async () => {
      if (add.length) await window.flow.addSongToPlaylists(song.id, add);
      for (const id of remove) await window.flow.removeFromPlaylist(id, song.id);
      toast('Playlists updated', 'success');
    });
  },

  close() {
    if (this.picker) this.picker.remove();
    this.picker = null;
    this.pickerAnchor = null;
    if (this.tray) this.tray.remove();
    if (this.anchor) {
      this.anchor.classList.remove('act--open');
      this.anchor.setAttribute('aria-expanded', 'false');
    }
    this.tray = null;
    this.anchor = null;
  },
};
