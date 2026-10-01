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
  picker: null, // the "Add to Playlists" popup beside the tray

  init() {
    const outside = (e) => {
      if (!this.tray) return;
      if (this.tray.contains(e.target) || (this.anchor && this.anchor.contains(e.target))) return;
      if (this.picker && this.picker.contains(e.target)) return;
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
      if (e.key === 'Escape' && this.tray && !Modal.top()) {
        e.stopPropagation();
        this.close();
      }
    }, true);
    // The row may be redrawn or gone.
    Store.onLibrary(() => this.close());
  },

  /** The cell: `shown` buttons, then More holding `more` (built when opened). */
  cell(shown, more) {
    const btn = iconButton('act.act--grey.act--more', Icons.more, 'More', () => {
      if (this.anchor === btn) this.close();
      else this.open(btn, more());
    });
    return h('div.actions', ...shown, btn);
  },

  open(anchor, buttons) {
    this.close();
    const tray = h('div.act-tray', { role: 'menu' }, ...buttons);
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
   */
  pickPlaylists(anchor, song) {
    if (this.picker) {
      this.picker.remove();
      this.picker = null;
      return;
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
      h('div.pl-picker__list', ...(rows.length ? rows : [h('div.pl-picker__empty', 'No playlists yet.')])),
      apply);
    document.body.appendChild(picker);
    // Left of the tray, its top level with the tray's.
    const t = this.tray ? this.tray.getBoundingClientRect() : anchor.getBoundingClientRect();
    picker.style.right = `${Math.round(window.innerWidth - t.left + 6)}px`;
    const height = picker.getBoundingClientRect().height;
    picker.style.top = `${Math.max(8, Math.min(Math.round(t.top), window.innerHeight - height - 8))}px`;
    this.picker = picker;
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
    if (this.tray) this.tray.remove();
    if (this.anchor) {
      this.anchor.classList.remove('act--open');
      this.anchor.setAttribute('aria-expanded', 'false');
    }
    this.tray = null;
    this.anchor = null;
  },
};
