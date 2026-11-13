'use strict';

// Shared pieces: popups, toasts, the sortable table, and the two dialogs more
// than one page uses (choosing playlists, editing a song's names).

// ---- popups ----

const Modal = {
  stack: [],

  /**
   * Opens a popup. `buttons` is [{ label, kind, onClick }], where onClick may
   * return false to keep the popup open. Resolves nothing itself: callers wrap
   * it in their own promise. `drawer` makes it a panel that slides in from the
   * right over a lighter backdrop; `sheet` one that rises from the bottom
   * (the phone's menus, mobile.css). `sticky` keeps it open on a click
   * beside it, Escape and the phone's Back: only X and its buttons close it.
   * `confirmDismiss` (async, true to close) is asked first on those three.
   * Returns { close, dismiss, el, sticky }; dismiss() is for those three.
   */
  open({
    title, body, buttons = [], className = '', onClose, focus, drawer = false, sheet = false, sticky = false, confirmDismiss = null,
  }) {
    const closeBtn = iconButton('modal__close', Icons.x, T('common.close'), () => handle.close());
    const footer = h('div.modal__footer');
    const box = h('div.modal' + (className ? '.' + className : ''), { role: 'dialog', 'aria-modal': 'true', tabIndex: -1 },
      h('div.modal__head', h('h2.modal__title', title), closeBtn),
      h('div.modal__body', body),
      footer);
    const backdrop = h('div.modal-backdrop' + (drawer ? '.modal-backdrop--drawer' : ''), box);
    if (drawer) box.classList.add('modal--drawer');
    if (sheet) {
      backdrop.classList.add('modal-backdrop--sheet');
      box.classList.add('modal--sheet');
    }
    // Opened from the player bar over the full-screen visualizer: over it too.
    if (document.body.classList.contains('viz-open')) backdrop.classList.add('modal-backdrop--over');

    let closed = false;
    let asking = false;
    const handle = {
      el: box,
      sticky,
      async dismiss() {
        if (sticky || closed || asking) return;
        if (confirmDismiss) {
          asking = true;
          try {
            if (!(await confirmDismiss())) return;
          } finally {
            asking = false;
          }
        }
        handle.close();
      },
      close(result) {
        if (closed) return;
        closed = true;
        if (drawer || sheet) {
          // Out the way it came; gone once the slide is over.
          backdrop.classList.add('modal-backdrop--out');
          setTimeout(() => backdrop.remove(), 200);
        } else {
          backdrop.remove();
        }
        Modal.stack = Modal.stack.filter((m) => m !== handle);
        if (onClose) onClose(result);
      },
    };

    for (const b of buttons) {
      const btn = h('button.btn' + (b.kind ? '.btn--' + b.kind : ''), { type: 'button' }, b.label);
      btn.addEventListener('click', async () => {
        if (!b.onClick) return handle.close();
        btn.disabled = true;
        try {
          const keep = await b.onClick(handle);
          if (keep !== false) handle.close();
        } finally {
          btn.disabled = false;
        }
      });
      if (b.align === 'left') btn.classList.add('modal__left');
      footer.appendChild(btn);
    }
    if (!buttons.length) footer.remove();

    // A press that starts inside the popup and ends on the backdrop is not a
    // click on the backdrop.
    let pressedBackdrop = false;
    backdrop.addEventListener('pointerdown', (e) => {
      pressedBackdrop = e.target === backdrop;
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && pressedBackdrop) handle.dismiss();
    });

    $('modalRoot').appendChild(backdrop);
    Modal.stack.push(handle);
    // The phone's sheets go away pulled down.
    if (sheet && typeof Mobile !== 'undefined' && Mobile.on) Mobile.swipeToClose(handle, ['down']);
    // On the phone a focused box would bring up the keyboard unasked.
    const target = focus ? box.querySelector(focus) : box.querySelector('.btn--primary, .btn--danger');
    if (target && !(sheet && target.matches('input'))) setTimeout(() => target.focus(), 0);
    return handle;
  },

  top() {
    return this.stack[this.stack.length - 1] || null;
  },
};

/**
 * Asks a yes/no question. With `checkbox` it also asks that; resolves
 * { checked } on yes and null on no.
 */
function confirmDialog({
  title, message, confirmLabel = T('common.ok'), cancelLabel = T('common.cancel'), danger = false, kind = '', checkbox = null,
}) {
  return new Promise((resolve) => {
    let box = null;
    const body = [h('p.modal__text', message)];
    if (checkbox) {
      box = h('input', { type: 'checkbox', checked: !!checkbox.checked });
      body.push(h('label.check.modal__check', box, h('span', checkbox.label)));
    }
    let answer = null;
    Modal.open({
      title,
      body,
      className: 'modal--small',
      buttons: [
        { label: cancelLabel },
        {
          label: confirmLabel,
          kind: kind || (danger ? 'danger' : 'primary'),
          onClick: () => {
            answer = { checked: box ? box.checked : false };
          },
        },
      ],
      onClose: () => resolve(answer),
    });
  });
}

/**
 * The phone's menu of actions, rising from the bottom. `items` are buttons
 * made for the desktop (iconButton: the icon and its title become the row;
 * the row clicks the button) or { icon, label, kind, onClick }. A row closes
 * the sheet, then does its thing.
 */
function actionSheet({ title, subtitle = '', items }) {
  let handle = null;
  const rows = items.filter(Boolean).map((item) => {
    const isButton = item instanceof Node;
    const label = isButton ? (item.getAttribute('aria-label') || item.title || item.textContent) : item.label;
    const icon = isButton ? item.innerHTML : (item.icon || '');
    const kind = isButton
      ? (/act--red/.test(item.className) ? 'danger' : /fav-on|dl-on/.test(item.className) ? 'on' : '')
      : (item.kind || '');
    return h('button.sheet__item' + (kind ? '.sheet__item--' + kind : ''), {
      type: 'button',
      disabled: isButton ? item.disabled : !!item.disabled,
      onclick: () => {
        handle.close();
        if (isButton) item.click();
        else item.onClick();
      },
    }, h('span.sheet__icon', { html: icon }), h('span.sheet__label', label));
  });
  handle = Modal.open({
    title,
    sheet: true,
    className: 'modal--actions',
    body: [subtitle ? h('p.sheet__subtitle', subtitle) : null, h('div.sheet__list', ...rows)],
  });
  return handle;
}

/** Asks for a line of text; resolves it, or null when cancelled. */
function promptDialog({ title, value = '', confirmLabel = T('common.ok'), maxLength = 150 }) {
  return new Promise((resolve) => {
    const input = h('input.input', { type: 'text', value, maxLength, spellcheck: false });
    let answer = null;
    const handle = Modal.open({
      title,
      className: 'modal--small',
      body: [input],
      focus: 'input',
      buttons: [
        { label: T('common.cancel') },
        { label: confirmLabel, kind: 'primary', onClick: () => { answer = input.value; } },
      ],
      onClose: () => resolve(answer),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        answer = input.value;
        handle.close();
      }
    });
  });
}

/**
 * A small form: `fields` are [{ key, label, type = 'text', value, placeholder,
 * maxLength, disabled }], each a labelled box. `submit(values)` runs on the
 * confirm button (or Enter); what it throws is shown in the popup, which stays
 * open, else it closes. Resolves what submit returned, or null when cancelled.
 */
function formDialog({ title, fields, confirmLabel = T('common.confirm'), submit }) {
  return new Promise((resolve) => {
    const error = h('div.form-error');
    const boxes = {};
    const rows = fields.map((f) => {
      const box = h('input.input', {
        type: f.type || 'text',
        value: f.value || '',
        placeholder: f.placeholder || '',
        maxLength: f.maxLength || 150,
        autocomplete: f.type === 'password' ? 'new-password' : 'off',
        disabled: !!f.disabled,
      });
      // Set here: h() leaves out props that are false.
      box.spellcheck = false;
      boxes[f.key] = box;
      return h('label.form-row', h('span.form-label', f.label), box);
    });
    let answer = null;
    const handle = Modal.open({
      title,
      className: 'modal--small.modal--form',
      body: [...rows, error],
      focus: 'input:not(:disabled)',
      buttons: [
        { label: T('common.cancel') },
        {
          label: confirmLabel,
          kind: 'primary',
          onClick: async () => {
            error.textContent = '';
            const values = Object.fromEntries(Object.entries(boxes).map(([k, box]) => [k, box.value]));
            try {
              answer = await submit(values);
              return true;
            } catch (err) {
              error.textContent = (err && err.message) || String(err);
              return false;
            }
          },
        },
      ],
      onClose: () => resolve(answer),
    });
    const confirm = handle.el.querySelector('.modal__footer .btn--primary');
    for (const box of Object.values(boxes)) {
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !confirm.disabled) confirm.click();
      });
    }
    // A box filled in already: ready to be typed over.
    const first = handle.el.querySelector('input:not(:disabled)');
    if (first && first.value) setTimeout(() => first.select(), 0);
  });
}

/**
 * The phone's row for a playlist (renderTable's `mobile`): its icon and name,
 * `sub` below, and a tap opens it.
 */
function listRowSpec(sub) {
  return {
    lead: (p) => h('span.mrow__icon', { html: listIcon(p) }),
    title: (p) => p.name,
    sub,
    tap: (p) => Nav.openPlaylist(p.id),
  };
}

// ---- toasts ----

/**
 * How long a toast stays: time to read it at an unhurried pace (about 15
 * characters a second) on top of a moment to notice it, between 4 and 20
 * seconds. Errors get 2 seconds more, and one with a button at least 8.
 */
function toastMs(message, kind, action) {
  let ms = 2000 + String(message).length * 65;
  if (kind === 'error') ms += 2000;
  if (action) ms = Math.max(ms, 8000);
  return Math.min(20000, Math.max(4000, ms));
}

/**
 * A short message at the bottom right. `action` ({ label, onClick }) adds a
 * button to it.
 */
function toast(message, kind = 'info', action = null) {
  const node = h('div.toast.toast--' + kind, h('span', message));
  const hide = () => {
    node.classList.remove('toast--in');
    setTimeout(() => node.remove(), 300);
  };
  if (action) {
    node.classList.add('toast--action');
    node.appendChild(h('button.link-btn.toast__action', {
      type: 'button',
      onclick: () => {
        hide();
        action.onClick();
      },
    }, action.label));
  }
  $('toasts').appendChild(node);
  requestAnimationFrame(() => node.classList.add('toast--in'));
  setTimeout(hide, toastMs(message, kind, action));
}

/** Runs an action and shows its error as a toast instead of throwing. */
async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast((err && err.message) || String(err), 'error');
    return undefined;
  }
}

// ---- long lists ----

/**
 * A long list drawn only where it shows: the rows on screen and a screen
 * above and below them are in the page, two spacers stand for the rest,
 * and scrolling swaps rows in and out (only those coming in are made), so
 * 100 000 rows cost what 60 do. Every row is as tall as the first one drawn.
 *
 * scroller: the element that scrolls; holder: where the rows go (after
 * what is in it already); count, makeRow(i); spacer(): an empty row of the
 * holder's kind; height: a row's height until one is measured; hint: where
 * the list is { top: the scroller's scrollTop, offset: the holder's top in
 * it, height } (a list drawn again keeps its place without measuring the
 * page while it is changing); onAdded(nodes), onRemoved(nodes).
 *
 * keep: { top, bottom }, the spacers of the list drawn before in this holder
 * (4.6): it is drawn again in place. makeRow may then hand out rows that are
 * in the page already (rowKeeper); those stay untouched where they are, the
 * new ones come in between them, and whatever else stood between the
 * spacers goes (its going is the caller's to tell).
 * Returns { stop(), offset, height, top, bottom, nodes() }.
 */
function windowRows({ scroller, holder, count, makeRow, spacer, height, hint = {}, onAdded, onRemoved, keep = null }) {
  const top = keep ? keep.top : spacer();
  const bottom = keep ? keep.bottom : spacer();
  if (!keep) holder.append(top, bottom);
  const drawn = [];
  let start = 0;
  let end = 0;
  let rowH = hint.height || height;
  let offset = Number.isFinite(hint.offset) ? hint.offset : 0;
  // How much of the list shows, as measured last (a list drawn again starts with the rows it had, not with a window's worth).
  let viewH = hint.view || 0;
  let frame = 0;
  let live = true;

  const range = (scrollTop, view) => {
    const first = Math.floor((scrollTop - offset) / rowH);
    const screen = Math.max(1, Math.ceil(view / rowH));
    const clamp = (n) => Math.max(0, Math.min(count, n));
    return [clamp(first - screen), clamp(first + screen * 2 + 1)];
  };

  function show([s, e]) {
    if (s === start && e === end) return;
    const gone = [];
    if (s >= end || e <= start) {
      gone.push(...drawn.splice(0));
      start = s;
      end = s;
    } else {
      while (start < s) {
        gone.push(drawn.shift());
        start += 1;
      }
      while (end > e) {
        gone.push(drawn.pop());
        end -= 1;
      }
    }
    for (const n of gone) n.remove();
    const added = [];
    if (s < start) {
      const fresh = [];
      for (let i = s; i < start; i += 1) fresh.push(makeRow(i));
      top.after(...fresh);
      drawn.unshift(...fresh);
      added.push(...fresh);
      start = s;
    }
    if (e > end) {
      const fresh = [];
      for (let i = end; i < e; i += 1) fresh.push(makeRow(i));
      bottom.before(...fresh);
      drawn.push(...fresh);
      added.push(...fresh);
      end = e;
    }
    top.style.height = `${start * rowH}px`;
    bottom.style.height = `${(count - end) * rowH}px`;
    if (gone.length && onRemoved) onRemoved(gone);
    if (added.length && onAdded) onAdded(added);
  }

  /** The first rows over a list drawn before: only what differs is touched. */
  function showOver([s, e]) {
    const lead = [];
    for (let n = holder.firstChild; n && n !== top; n = n.nextSibling) lead.push(n);
    const rows = [];
    for (let i = s; i < e; i += 1) rows.push(makeRow(i));
    const added = rows.filter((n) => n.parentNode !== holder);
    setChildren(holder, [...lead, top, ...rows, bottom], { alike: false });
    drawn.push(...rows);
    start = s;
    end = e;
    top.style.height = `${start * rowH}px`;
    bottom.style.height = `${(count - end) * rowH}px`;
    if (added.length && onAdded) onAdded(added);
  }

  const place = () => top.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

  // Once a frame while scrolling: where the list is now, measured.
  function update() {
    frame = 0;
    if (!live || !holder.isConnected) return;
    const view = scroller.clientHeight;
    // Hidden (another page shows): nothing to measure.
    if (!view || !top.getClientRects().length) return;
    viewH = view;
    let again = false;
    if (drawn.length) {
      const h0 = drawn[0].getBoundingClientRect().height;
      if (h0 > 0 && Math.abs(h0 - rowH) > 0.01) {
        rowH = h0;
        again = true;
      }
    }
    const was = offset;
    offset = place();
    if (Math.abs(offset - was) > 1) again = true;
    show(range(scroller.scrollTop, view));
    // Measured anew (a row's height, the list's place): once more to be sure.
    if (again) soon();
  }
  function soon() {
    if (!frame && live) frame = requestAnimationFrame(update);
  }
  scroller.addEventListener('scroll', soon, { passive: true });
  window.addEventListener('resize', soon);
  const first = range(Number.isFinite(hint.top) ? hint.top : 0, viewH || window.innerHeight);
  if (keep) showOver(first);
  else show(first);
  soon();
  return {
    top,
    bottom,
    get view() {
      return viewH;
    },
    /** The rows in the page now. */
    nodes() {
      return drawn.slice();
    },
    stop() {
      live = false;
      scroller.removeEventListener('scroll', soon);
      window.removeEventListener('resize', soon);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
    get offset() {
      return offset;
    },
    get height() {
      return rowH;
    },
  };
}

/** The cover boxes in nodes leaving the page let go (Covers watches them while their pictures come). */
function releaseCovers(nodes) {
  if (typeof Covers === 'undefined' || !Covers.release) return;
  for (const n of nodes) Covers.release(n);
}

// ---- rows that stay ----

/** Two lists of values, each the same as its turn in the other. */
function sameValues(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Two rows' data the same all the way down: the same value, or lists and
 * plain objects holding the same (what the library did not change is the
 * same object as before, so this is quick).
 */
function sameDeep(a, b, depth = 8) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || depth <= 0) return false;
  const list = Array.isArray(a);
  if (list !== Array.isArray(b)) return false;
  if (list) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!sameDeep(a[i], b[i], depth - 1)) return false;
    return true;
  }
  const proto = Object.getPrototypeOf(a);
  if (proto !== Object.getPrototypeOf(b) || (proto !== Object.prototype && proto !== null)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if (!(k in b) || !sameDeep(a[k], b[k], depth - 1)) return false;
  }
  return true;
}

/**
 * A list drawn again in place (4.6): the rows in the page (`old`, each with
 * its key as data-id) are handed out again for the rows that still show the
 * same, so only what changed is made and put into the page: the rest is not
 * touched (nothing blinks, a cover stays, the pointer's row stays lit).
 *
 * shows(row): what a row shows beyond its key, as a list of values (its
 * song, its date ...); a row drawn before with all of them the same (===)
 * stays. Without it, or with `usable` false (the columns or the list
 * changed), every row is made anew. make(row) makes one. gone(nodes) hears
 * of the old rows not used again: at once those that cannot be, one whose
 * values differ just before its row is made anew, the rest at done().
 *
 * drawn (without shows; for short lists whose rows go by much of the
 * library, a playlist's follows, groups, updates ...): every row is made,
 * and the one in the page stays when the new one came out the same (its
 * html) from the same data (sameDeep), so what its buttons were made with
 * still holds; the new one is then dropped. Not for rows with ticks, whose
 * state is not in their html; a box being typed in stays as it is.
 * Returns { row(row) -> its node, done(), kept: how many stayed }.
 */
function rowKeeper({ old, usable, rowKey, shows, drawn = false, make, gone }) {
  const byKey = new Map();
  const out = [];
  const asDrawn = drawn && !shows;
  for (const node of old) {
    const key = node.dataset.id;
    const known = asDrawn ? node._drawnAs !== undefined : !!(shows && node._shows);
    if (usable && known && !byKey.has(key)) byKey.set(key, node);
    else out.push(node);
  }
  if (out.length) gone(out);
  const keeper = {
    kept: 0,
    row(row) {
      const key = String(rowKey(row));
      const node = byKey.get(key);
      if (asDrawn) {
        const fresh = make(row);
        const html = fresh.outerHTML;
        if (node) {
          byKey.delete(key);
          if (node._drawnAs === html && sameDeep(node._row, row)) {
            node._row = row;
            keeper.kept += 1;
            releaseCovers([fresh]);
            return node;
          }
          gone([node]);
        }
        fresh._row = row;
        fresh._drawnAs = html;
        return fresh;
      }
      const values = shows ? shows(row) : null;
      if (node) {
        byKey.delete(key);
        if (sameValues(node._shows, values)) {
          // What its clicks go by: the row as it is now.
          node._row = row;
          keeper.kept += 1;
          return node;
        }
        gone([node]);
      }
      const fresh = make(row);
      fresh._row = row;
      fresh._shows = values;
      return fresh;
    },
    done() {
      if (byKey.size) gone([...byKey.values()]);
      byKey.clear();
    },
  };
  return keeper;
}

// ---- sortable table ----

/**
 * Draws a table into `table`. columns: [{ key, label, sortable = true, cls,
 * render(row), onClick(row) }]; onClick makes the whole cell clickable
 * (buttons in it keep their own clicks). `sort` is { key, dir } and onSort(key) is called with the
 * clicked column. rowKey(row) goes on each <tr> as data-id.
 *
 * scroller: the element the page scrolls in; given, only the rows where
 * the list shows are in the page (windowRows), scrollTop: where it is
 * scrolled (known from its scroll events, not measured while drawing).
 * onRowsAdded(trs), onRowsRemoved(trs): rows coming in and going (also the
 * rows of the list drawn before that are not used again).
 *
 * Drawn again, the table stays in the page (4.6): its head while the columns
 * and the sort are the same, and with shows(row) every row that still shows
 * the same (rowKeeper). `look`: what all rows share beyond the columns (the
 * list they are of, a mode); changed, every row is made anew. A row that
 * stays keeps what its cells were drawn with, so `shows` and `look` must
 * hold everything render() and rowClass() go by; its clicks (onClick,
 * onRowDblClick, onSort) are the ones given last. `drawn` instead of shows
 * (a short list): a row stays when it is made the same again (rowKeeper).
 */
function renderTable(table, {
  columns, rows, sort, onSort, rowKey, rowClass, onRowDblClick, mobile, scroller, scrollTop, onRowsAdded, onRowsRemoved, shows = null, look = '', drawn = false,
}) {
  // A list drawn before: where it was, then let go.
  const before = table._rows;
  const hint = before ? { top: scrollTop, offset: before.offset, height: before.height, view: before.view } : { top: scrollTop };
  if (before) before.stop();
  table._rows = null;
  // The phone draws the rows as a touch list instead (touchList.js).
  if (mobile && document.body.classList.contains('mobile')) {
    table._drawn = null;
    TouchList.render(table, {
      columns, rows, sort, onSort, rowKey, rowClass, scroller, hint, onRowsAdded, onRowsRemoved, shows, look, drawn, before, ...mobile,
    });
    return;
  }
  // What the clicks go by, in the head and the rows that stay too: the list as it is now.
  table._now = { onSort, onRowDblClick, columns: new Map(columns.map((c) => [c.key, c])) };
  const cols = JSON.stringify(columns.map((c) => [c.key, c.label, c.cls || '', c.sortable !== false, !!c.onClick]));
  const headLook = `${cols}\n${sort && sort.key ? `${sort.key}:${sort.dir}` : ''}`;
  const rowLook = `${cols}\n${onRowDblClick ? 1 : 0}\n${look}`;
  const gone = (trs) => {
    releaseCovers(trs);
    if (onRowsRemoved) onRowsRemoved(trs);
  };

  // The table as drawn before, still in the page: it stays, and what differs is put into it.
  const was = table._drawn;
  const fits = !!(was && was.thead.parentNode === table && was.tbody.parentNode === table);
  let thead = fits ? was.thead : null;
  let tbody = fits ? was.tbody : null;
  if (!fits) {
    if (before && onRowsRemoved) onRowsRemoved(before.nodes());
    releaseCovers([table]);
    clear(table);
    thead = h('thead');
    tbody = h('tbody');
    table.append(thead, tbody);
  }
  if (!fits || was.head !== headLook) {
    const headRow = h('tr');
    for (const col of columns) {
      const sortable = col.sortable !== false;
      const active = sortable && sort && sort.key === col.key;
      const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '';
      const th = h('th' + (col.cls ? '.' + col.cls : ''),
        sortable ? h('button.th-sort' + (active ? '.th-sort--active' : ''), {
          type: 'button',
          title: T('common.sortBy', { column: col.label }),
          onclick: () => table._now.onSort(col.key),
        }, h('span', col.label), h('span.th-arrow', arrow)) : h('span.th-plain', col.label));
      headRow.appendChild(th);
    }
    clear(thead).appendChild(headRow);
  }
  const makeRow = (row) => {
    const tr = h('tr', { dataset: { id: rowKey(row) } });
    tr._row = row;
    const extra = rowClass ? rowClass(row) : '';
    if (extra) tr.className = extra;
    for (const col of columns) {
      const content = col.render(row);
      const td = h('td' + (col.cls ? '.' + col.cls : '') + (col.onClick ? '.cell--play' : ''), content);
      if (col.onClick) {
        td.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          const c = table._now.columns.get(col.key);
          if (c && c.onClick) c.onClick(tr._row);
        });
      }
      tr.appendChild(td);
    }
    if (onRowDblClick) {
      tr.addEventListener('dblclick', (e) => {
        if (!e.target.closest('button') && table._now.onRowDblClick) table._now.onRowDblClick(tr._row);
      });
    }
    return tr;
  };
  // The spacers of the long list drawn before, where this one goes between again.
  const spacers = scroller && fits && before && before.top.parentNode === tbody && before.bottom.parentNode === tbody
    ? { top: before.top, bottom: before.bottom } : null;
  const old = !fits ? [] : before ? before.nodes() : [...tbody.children].filter((tr) => '_row' in tr);
  const keeper = rowKeeper({
    old,
    usable: fits && was.rows === rowLook && (!scroller || !!spacers),
    rowKey,
    shows,
    drawn,
    make: makeRow,
    gone,
  });
  table._drawn = { thead, tbody, head: headLook, rows: rowLook };
  if (!scroller) {
    const trs = rows.map((row) => keeper.row(row));
    keeper.done();
    if (keeper.kept) {
      setChildren(tbody, trs, { alike: false });
    } else {
      // None stays: all out and all in at once.
      clear(tbody);
      const frag = document.createDocumentFragment();
      for (const tr of trs) frag.appendChild(tr);
      tbody.appendChild(frag);
    }
    return;
  }
  if (!spacers) clear(tbody);
  table._rows = windowRows({
    scroller,
    holder: tbody,
    count: rows.length,
    makeRow: (i) => keeper.row(rows[i]),
    spacer: () => h('tr.vspace', { 'aria-hidden': 'true' }, h('td', { colSpan: columns.length })),
    height: 41,
    hint,
    onAdded: onRowsAdded,
    onRemoved: gone,
    keep: spacers,
  });
  // The rows of before that are not among the first ones now.
  keeper.done();
  if (spacers) spacers.top.firstChild.colSpan = spacers.bottom.firstChild.colSpan = columns.length;
}

/**
 * A list in `box` showing `n` entries at most (4.5.3, the Playlists page):
 * with more, the box is as tall as its first `n` (`selector`: its entries)
 * and scrolls, the column names staying on top. Only while it shows (it
 * cannot measure hidden); drawn again once shown.
 */
function limitRows(box, selector, n = 10) {
  const rows = box.querySelectorAll(selector);
  if (rows.length <= n || !box.offsetParent) {
    box.style.maxHeight = '';
    box.classList.remove('list-limit--scrolls');
    return;
  }
  const top = box.getBoundingClientRect().top - box.scrollTop;
  box.style.maxHeight = `${Math.ceil(rows[n].getBoundingClientRect().top - top)}px`;
  box.classList.add('list-limit--scrolls');
  // On a touch screen it scrolls only from its middle half: a swipe on its
  // outer quarters moves the page past it (as Administration's lists do).
  if (box._edgeSwipes) return;
  box._edgeSwipes = true;
  box.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const r = box.getBoundingClientRect();
    const x = (e.touches[0].clientX - r.left) / r.width;
    box.classList.toggle('list-limit--page', x < 0.25 || x > 0.75);
  }, { passive: false });
  const lift = (e) => {
    if (!e.touches.length) box.classList.remove('list-limit--page');
  };
  box.addEventListener('touchend', lift);
  box.addEventListener('touchcancel', lift);
}

// ---- dialogs ----

/**
 * Choose playlists. Lists in `lockedIds` already hold the song: shown faint
 * green, ticked, and cannot be changed. Offers a box to create a new list
 * right there. Resolves the chosen ids (without the locked ones), or null.
 */
function pickPlaylists({ title = T('common.addToPlaylist'), subtitle = '', lockedIds = [], selectedIds = [] }) {
  return new Promise((resolve) => {
    const locked = new Set(lockedIds);
    const selected = new Set(selectedIds.filter((id) => !locked.has(id)));
    const list = h('div.picker__list');
    const nameBox = h('input.input', { type: 'text', placeholder: T('pickPlaylists.newName.placeholder'), maxLength: 80 });
    const error = h('div.form-error');

    const draw = () => {
      clear(list);
      const lists = Store.editablePlaylists();
      if (!lists.length) {
        list.appendChild(h('div.picker__empty', T('pickPlaylists.none')));
        return;
      }
      for (const p of lists) {
        const isLocked = locked.has(p.id);
        const box = h('input', { type: 'checkbox', checked: isLocked || selected.has(p.id), disabled: isLocked });
        box.addEventListener('change', () => {
          if (box.checked) selected.add(p.id);
          else selected.delete(p.id);
        });
        list.appendChild(h('label.picker__row' + (isLocked ? '.picker__row--locked' : ''),
          box,
          h('span.picker__name', p.name),
          h('span.picker__meta', isLocked ? T('pickPlaylists.alreadyAdded') : Util.plural(p.entries.length, 'song'))));
      }
    };

    const create = async () => {
      error.textContent = '';
      try {
        const p = await window.flow.createPlaylist(nameBox.value);
        selected.add(p.id);
        nameBox.value = '';
        // The library event redraws Store before this runs on; draw again to
        // be sure the new list is in.
        setTimeout(draw, 0);
      } catch (err) {
        error.textContent = err.message;
      }
    };
    nameBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') create();
    });

    const unsubscribe = () => {
      Store._listeners = Store._listeners.filter((fn) => fn !== draw);
    };
    Store.onLibrary(draw);
    draw();

    let result = null;
    Modal.open({
      title,
      className: 'modal--picker',
      sheet: document.body.classList.contains('mobile'),
      body: [
        subtitle ? h('p.modal__subtitle', subtitle) : null,
        h('div.picker__create', nameBox, h('button.btn', { type: 'button', onclick: create }, T('common.create'))),
        error,
        list,
      ],
      buttons: [
        { label: T('common.cancel') },
        { label: T('common.save'), kind: 'primary', onClick: () => { result = [...selected]; } },
      ],
      onClose: () => {
        unsubscribe();
        resolve(result);
      },
    });
  });
}
