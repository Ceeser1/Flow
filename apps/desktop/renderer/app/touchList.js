'use strict';

// The phone's rows (renderTable with `mobile`): in place of a table, a list of
// two-line rows (a cover or icon, the name, a line below it) with a button at
// the end, by default More (an action sheet). A tap does the row's thing; a
// long press starts choosing rows, with a bar of what can be done with them.
// The table stays in the page, empty and hidden, so its id still finds the
// list (the list is the element after it).
//
// mobile: { lead(row), title(row), sub(row), tap(row), more(row) -> buttons,
//           side(row) -> a node in place of More, sheetTitle(row),
//           select: { actions: [{ icon, label, kind, run(rows) }] } }

const TouchList = {
  LONG_PRESS_MS: 450,
  // Rows chosen, per list (the table's id): survives the list being drawn again.
  chosen: new Map(),
  // Each list's rows as last drawn: { rows, rowKey, select }.
  _lists: new Map(),
  _active: null, // the table id of the list choosing now

  render(table, opts) {
    const { columns, rows, sort, onSort, rowKey } = opts;
    this._lists.set(table.id, { rows, rowKey, select: opts.select });
    clear(table);
    table.hidden = true;
    let list = table.nextElementSibling;
    if (!list || !list.classList.contains('mlist')) {
      list = h('div.mlist', { id: table.id + 'List' });
      table.after(list);
    }
    clear(list);

    const sortable = columns.filter((c) => c.sortable !== false && c.key !== 'actions');
    if (onSort && sortable.length) list.appendChild(this._sortRow(sortable, sort, onSort));

    const chosen = this.chosen.get(table.id);
    if (chosen) {
      // Rows gone since are no longer chosen.
      const keys = new Set(rows.map(rowKey));
      for (const k of [...chosen]) if (!keys.has(k)) chosen.delete(k);
    }

    const frag = document.createDocumentFragment();
    for (const row of rows) frag.appendChild(this._row(table.id, row, opts, chosen));
    list.appendChild(frag);
    list.classList.toggle('mlist--choosing', !!chosen);
    if (chosen && chosen.size) this._drawBar();
    else if (chosen) this.stopChoosing();
  },

  _row(id, row, opts, chosen) {
    const key = opts.rowKey(row);
    const extra = opts.rowClass ? opts.rowClass(row) : '';
    const node = h('div.mrow' + (extra ? '.' + extra.split(' ').filter(Boolean).join('.') : ''), { dataset: { id: key } });
    const sub = opts.sub ? opts.sub(row) : '';
    let end = opts.side ? opts.side(row) : null;
    const items = !end && opts.more ? opts.more(row) : null;
    if (items && items.length) {
      end = iconButton('mrow__more', Icons.more, 'More', () => {
        actionSheet({ title: opts.sheetTitle ? opts.sheetTitle(row) : opts.title(row), items: opts.more(row) });
      });
    }
    node.append(...[
      h('span.mrow__check', { html: Icons.check }),
      opts.lead ? opts.lead(row) : null,
      h('div.mrow__text', h('div.mrow__title', opts.title(row)), sub ? h('div.mrow__sub', sub) : null),
      end,
    ].filter(Boolean));
    if (chosen && chosen.has(key)) node.classList.add('mrow--chosen');

    let pressed = null;
    let longDone = false;
    node.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || !opts.select) return;
      longDone = false;
      pressed = { x: e.clientX, y: e.clientY };
      pressed.timer = setTimeout(() => {
        longDone = true;
        pressed = null;
        if (navigator.vibrate) navigator.vibrate(15);
        this._toggle(id, key, opts);
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
      if (this.chosen.has(id)) this._toggle(id, key, opts);
      else if (opts.tap) opts.tap(row);
    });
    return node;
  },

  /** "Sort: Added ▼": a sheet of the columns; picking one sorts by it (again: the other way, then not). */
  _sortRow(columns, sort, onSort) {
    const active = sort && sort.key ? columns.find((c) => c.key === sort.key) : null;
    const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const btn = h('button.mlist__sort', {
      type: 'button',
      onclick: () => actionSheet({
        title: 'Sort by',
        items: columns.map((c) => ({
          label: c.label + (active === c ? arrow : ''),
          kind: active === c ? 'on' : '',
          onClick: () => onSort(c.key),
        })),
      }),
    }, active ? `Sorted by ${active.label}${arrow}` : 'Sort');
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
      iconButton('choose-bar__close', Icons.x, 'Stop choosing', () => this.stopChoosing()),
      h('span.choose-bar__count', `${keys.length} chosen`),
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
