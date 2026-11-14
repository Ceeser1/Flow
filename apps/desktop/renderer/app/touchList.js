'use strict';

// The phone's rows (renderTable with `mobile`): in place of a table, a list of
// two-line rows (a cover or icon, the name, a line below it) with a button at
// the end, by default More (an action sheet). A tap does the row's thing; a
// long press starts choosing rows, with a bar of what can be done with them.
// The table stays in the page, empty and hidden, so its id still finds the
// list (the list is the element after it).
//
// mobile: { lead(row), title(row), sub(row), mark(row) -> an icon's html at the
//           start of the line below, tap(row), more(row) -> buttons,
//           side(row) -> a node in place of More, sheetTitle(row),
//           select: { actions: [{ icon, label, kind, run(rows) }] } }

const TouchList = {
  LONG_PRESS_MS: 450,
  // Rows chosen, per list (the table's id): survives the list being drawn again.
  chosen: new Map(),
  // Each list's rows as last drawn: { rows, rowKey, select }.
  _lists: new Map(),
  _active: null, // the table id of the list choosing now

  /**
   * Drawn again, the list stays in the page (4.6, as renderTable's table):
   * its sort row while the columns and the sort are the same, and with
   * opts.shows every row that still shows the same (rowKeeper in ui.js);
   * opts.look: what all rows share. A row that stays does what the list
   * given last says (tap, more, select).
   */
  render(table, opts) {
    const { columns, rows, sort, onSort, rowKey } = opts;
    this._lists.set(table.id, { rows, rowKey, select: opts.select, opts });
    if (table.firstChild) clear(table);
    table.hidden = true;
    let list = table.nextElementSibling;
    if (!list || !list.classList.contains('mlist')) {
      list = h('div.mlist', { id: table.id + 'List' });
      table.after(list);
    }
    const before = opts.before || null;
    const gone = (nodes) => {
      releaseCovers(nodes);
      if (opts.onRowsRemoved) opts.onRowsRemoved(nodes);
    };
    // The list as drawn before, still as it was left: it stays, and what differs is put into it.
    const was = list._drawn;
    const fits = !!was && (!was.head || was.head.parentNode === list);
    if (!fits) {
      if (before && opts.onRowsRemoved) opts.onRowsRemoved(before.nodes());
      releaseCovers([list]);
      clear(list);
    }

    const sortable = columns.filter((c) => c.sortable !== false && c.key !== 'actions');
    const headLook = onSort && sortable.length
      ? JSON.stringify([sortable.map((c) => [c.key, c.label]), sort && sort.key ? `${sort.key}:${sort.dir}` : '']) : '';
    let head = fits ? was.head : null;
    if (!fits || was.headLook !== headLook) {
      if (head) head.remove();
      head = headLook ? this._sortRow(table.id, sortable, sort) : null;
      if (head) list.prepend(head);
    }

    const chosen = this.chosen.get(table.id);
    if (chosen) {
      // Rows gone since are no longer chosen.
      const keys = new Set(rows.map(rowKey));
      for (const k of [...chosen]) if (!keys.has(k)) chosen.delete(k);
    }

    const rowLook = `${opts.select ? 1 : 0}${opts.side ? 1 : 0}${opts.more ? 1 : 0}${opts.tap ? 1 : 0}\n${opts.look || ''}`;
    // The spacers of the long list drawn before, where this one goes between again.
    const spacers = opts.scroller && fits && before && before.top.parentNode === list && before.bottom.parentNode === list
      ? { top: before.top, bottom: before.bottom } : null;
    const old = !fits ? [] : before ? before.nodes() : [...list.children].filter((n) => '_row' in n);
    const keeper = rowKeeper({
      old,
      usable: fits && was.rows === rowLook && (!opts.scroller || !!spacers),
      rowKey,
      shows: opts.shows || null,
      drawn: !!opts.drawn,
      make: (row) => this._row(table.id, row, opts),
      gone,
    });
    list._drawn = { head, headLook, rows: rowLook };
    // Rows chosen since the list was drawn stay chosen when drawn or scrolled to again.
    const rowOf = (row) => {
      const node = keeper.row(row);
      const now = this.chosen.get(table.id);
      node.classList.toggle('mrow--chosen', !!(now && now.has(rowKey(row))));
      return node;
    };

    if (opts.scroller) {
      if (!spacers) for (const n of [...list.children]) if (n !== head) n.remove();
      // Only the rows where the list shows are in the page (windowRows in ui.js).
      table._rows = windowRows({
        scroller: opts.scroller,
        holder: list,
        count: rows.length,
        makeRow: (i) => rowOf(rows[i]),
        spacer: () => h('div.mlist__space', { 'aria-hidden': 'true' }),
        height: 64,
        hint: opts.hint || {},
        onAdded: opts.onRowsAdded,
        onRemoved: gone,
        keep: spacers,
      });
      keeper.done();
    } else {
      const nodes = rows.map(rowOf);
      keeper.done();
      if (keeper.kept) {
        setChildren(list, head ? [head, ...nodes] : nodes, { alike: false });
      } else {
        // None stays: all out and all in at once.
        for (const n of [...list.children]) if (n !== head) n.remove();
        const frag = document.createDocumentFragment();
        for (const n of nodes) frag.appendChild(n);
        list.appendChild(frag);
      }
    }
    list.classList.toggle('mlist--choosing', !!chosen);
    if (chosen && chosen.size) this._drawBar();
    else if (chosen) this.stopChoosing();
  },

  /** A row. What it does when touched goes by the list as given last (a row may stay over a redraw) and its row now (node._row). */
  _row(id, row, made) {
    const opts = made;
    const now = () => {
      const l = this._lists.get(id);
      return (l && l.opts) || made;
    };
    const key = opts.rowKey(row);
    const extra = opts.rowClass ? opts.rowClass(row) : '';
    const node = h('div.mrow' + (extra ? '.' + extra.split(' ').filter(Boolean).join('.') : ''), { dataset: { id: key } });
    node._row = row;
    const sub = opts.sub ? opts.sub(row) : '';
    const mark = opts.mark ? opts.mark(row) : '';
    let end = opts.side ? opts.side(row) : null;
    const items = !end && opts.more ? opts.more(row) : null;
    if (items && items.length) {
      end = iconButton('mrow__more', Icons.more, T('common.more'), () => {
        const o = now();
        if (!o.more) return;
        actionSheet({ title: o.sheetTitle ? o.sheetTitle(node._row) : o.title(node._row), items: o.more(node._row) });
      });
    }
    node.append(...[
      h('span.mrow__check', { html: Icons.check }),
      opts.lead ? opts.lead(row) : null,
      h('div.mrow__text', h('div.mrow__title', opts.title(row)),
        sub || mark ? h('div.mrow__sub', mark ? h('span.mrow__mark', { html: mark }) : null, sub) : null),
      end,
    ].filter(Boolean));

    let pressed = null;
    let longDone = false;
    node.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || !now().select) return;
      longDone = false;
      pressed = { x: e.clientX, y: e.clientY };
      pressed.timer = setTimeout(() => {
        longDone = true;
        pressed = null;
        if (navigator.vibrate) navigator.vibrate(15);
        this._toggle(id, key, now());
      }, this.LONG_PRESS_MS);
    });
    const cancel = () => {
      if (pressed) clearTimeout(pressed.timer);
      pressed = null;
    };
    node.addEventListener('pointermove', (e) => {
      if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 10) cancel();
    });
    node.addEventListener('pointerup', cancel);
    node.addEventListener('pointercancel', cancel);
    // The WebView's own menu on a long press.
    node.addEventListener('contextmenu', (e) => e.preventDefault());
    node.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (longDone) {
        longDone = false;
        return;
      }
      const o = now();
      if (this.chosen.has(id)) this._toggle(id, key, o);
      else if (o.tap) o.tap(node._row);
    });
    return node;
  },

  /** "Sort: Added ▼": a sheet of the columns; picking one sorts by it (again: the other way, then not). */
  _sortRow(id, columns, sort) {
    const active = sort && sort.key ? columns.find((c) => c.key === sort.key) : null;
    const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    // Sorted as the list given last says (the row stays while the columns and the sort do).
    const sortBy = (key) => {
      const l = this._lists.get(id);
      if (l && l.opts.onSort) l.opts.onSort(key);
    };
    const btn = h('button.mlist__sort', {
      type: 'button',
      onclick: () => actionSheet({
        title: T('mobile.list.sortBy'),
        items: columns.map((c) => ({
          label: c.label + (active === c ? arrow : ''),
          kind: active === c ? 'on' : '',
          onClick: () => sortBy(c.key),
        })),
      }),
    }, active ? T('mobile.list.sortedBy', { column: active.label, arrow }) : T('mobile.list.sort'));
    return h('div.mlist__head', btn);
  },

  // ---- choosing rows ----

  _toggle(id, key, opts) {
    if (this._active && this._active !== id) this.stopChoosing();
    let chosen = this.chosen.get(id);
    if (!chosen) {
      chosen = new Set();
      this.chosen.set(id, chosen);
      this._active = id;
    }
    if (chosen.has(key)) chosen.delete(key);
    else chosen.add(key);
    const list = $(id + 'List');
    if (list) {
      list.classList.add('mlist--choosing');
      for (const n of list.querySelectorAll('.mrow')) n.classList.toggle('mrow--chosen', chosen.has(n.dataset.id));
    }
    if (!chosen.size) this.stopChoosing();
    else this._drawBar();
  },

  get choosing() {
    return !!this._active;
  },

  stopChoosing() {
    const active = this._active;
    this._active = null;
    if (active) {
      this.chosen.delete(active);
      const list = $(active + 'List');
      if (list) {
        list.classList.remove('mlist--choosing');
        for (const n of list.querySelectorAll('.mrow--chosen')) n.classList.remove('mrow--chosen');
      }
    }
    const bar = $('chooseBar');
    if (bar) bar.hidden = true;
    document.body.classList.remove('choosing');
  },

  /** The bar over the player while rows are chosen: how many, the actions, and X. */
  _drawBar() {
    const chosen = this._active && this.chosen.get(this._active);
    const drawn = chosen && this._lists.get(this._active);
    if (!drawn) return;
    let bar = $('chooseBar');
    if (!bar) {
      bar = h('div.choose-bar', { id: 'chooseBar' });
      document.body.appendChild(bar);
    }
    clear(bar);
    bar.hidden = false;
    document.body.classList.add('choosing');
    const keys = [...chosen];
    const rowsNow = () => drawn.rows.filter((r) => chosen.has(drawn.rowKey(r)));
    bar.append(
      iconButton('choose-bar__close', Icons.x, T('mobile.list.stopChoosing'), () => this.stopChoosing()),
      h('span.choose-bar__count', T('mobile.list.chosen', { count: keys.length })),
      h('div.choose-bar__actions', ...(drawn.select.actions || []).map((a) => h('button.choose-bar__btn' + (a.kind ? '.choose-bar__btn--' + a.kind : ''), {
        type: 'button',
        title: a.label,
        'aria-label': a.label,
        html: (a.icon || '') + `<span>${a.short || a.label}</span>`,
        onclick: async () => {
          const rows = rowsNow();
          const done = await a.run(rows);
          if (done !== false) this.stopChoosing();
        },
      }))),
    );
  },
};
