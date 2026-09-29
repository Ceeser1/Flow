'use strict';

// A song row's Actions: two buttons always there (Add to Queue and Play) and
// "More" (three dots), which slides the rest out to its left (Favourite,
// Details, Edit, Delete / Remove). The tray floats over the page rather than
// sitting in the cell, which cuts off anything wider than itself. One tray is
// open at a time; a click anywhere else, a scroll, Escape or any of its
// buttons closes it.

const SongActions = {
  tray: null,
  anchor: null,

  init() {
    const outside = (e) => {
      if (!this.tray) return;
      if (this.tray.contains(e.target) || (this.anchor && this.anchor.contains(e.target))) return;
      this.close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', () => this.close(), true);
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
      if (e.target.closest('button')) setTimeout(() => this.close(), 0);
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

  close() {
    if (this.tray) this.tray.remove();
    if (this.anchor) {
      this.anchor.classList.remove('act--open');
      this.anchor.setAttribute('aria-expanded', 'false');
    }
    this.tray = null;
    this.anchor = null;
  },
};
