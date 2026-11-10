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
 * Returns { stop(), offset, height }.
 */
function windowRows({ scroller, holder, count, makeRow, spacer, height, hint = {}, onAdded, onRemoved }) {
  const top = spacer();
  const bottom = spacer();
  holder.append(top, bottom);
  const drawn = [];
  let start = 0;
  let end = 0;
  let rowH = hint.height || height;
  let offset = Number.isFinite(hint.offset) ? hint.offset : 0;
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

  const place = () => top.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

  // Once a frame while scrolling: where the list is now, measured.
  function update() {
    frame = 0;
    if (!live || !holder.isConnected) return;
    const view = scroller.clientHeight;
    // Hidden (another page shows): nothing to measure.
    if (!view || !top.getClientRects().length) return;
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
  show(range(Number.isFinite(hint.top) ? hint.top : 0, window.innerHeight));
  soon();
  return {
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
 * onRowsAdded(trs), onRowsRemoved(trs): rows coming in and going.
 */
function renderTable(table, {
  columns, rows, sort, onSort, rowKey, rowClass, onRowDblClick, mobile, scroller, scrollTop, onRowsAdded, onRowsRemoved,
}) {
  // A list drawn before: where it was, then let go.
  const before = table._rows;
  const hint = before ? { top: scrollTop, offset: before.offset, height: before.height } : { top: scrollTop };
  if (before) before.stop();
  table._rows = null;
  // The phone draws the rows as a touch list instead (touchList.js).
  if (mobile && document.body.classList.contains('mobile')) {
    TouchList.render(table, {
      columns, rows, sort, onSort, rowKey, rowClass, scroller, hint, onRowsAdded, onRowsRemoved, ...mobile,
    });
    return;
  }
  releaseCovers([table]);
  clear(table);
  const headRow = h('tr');
  for (const col of columns) {
    const sortable = col.sortable !== false;
    const active = sortable && sort && sort.key === col.key;
    const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '';
    const th = h('th' + (col.cls ? '.' + col.cls : ''),
      sortable ? h('button.th-sort' + (active ? '.th-sort--active' : ''), {
        type: 'button',
        title: T('common.sortBy', { column: col.label }),
        onclick: () => onSort(col.key),
      }, h('span', col.label), h('span.th-arrow', arrow)) : h('span.th-plain', col.label));
    headRow.appendChild(th);
  }
  const tbody = h('tbody');
  const makeRow = (row) => {
    const tr = h('tr', { dataset: { id: rowKey(row) } });
    const extra = rowClass ? rowClass(row) : '';
    if (extra) tr.className = extra;
    for (const col of columns) {
      const content = col.render(row);
      const td = h('td' + (col.cls ? '.' + col.cls : '') + (col.onClick ? '.cell--play' : ''), content);
      if (col.onClick) {
        td.addEventListener('click', (e) => {
          if (!e.target.closest('button')) col.onClick(row);
        });
      }
      tr.appendChild(td);
    }
    if (onRowDblClick) {
      tr.addEventListener('dblclick', (e) => {
        if (!e.target.closest('button')) onRowDblClick(row);
      });
    }
    return tr;
  };
  table.appendChild(h('thead', headRow));
  table.appendChild(tbody);
  if (!scroller) {
    const frag = document.createDocumentFragment();
    for (const row of rows) frag.appendChild(makeRow(row));
    tbody.appendChild(frag);
    return;
  }
  table._rows = windowRows({
    scroller,
    holder: tbody,
    count: rows.length,
    makeRow: (i) => makeRow(rows[i]),
    spacer: () => h('tr.vspace', { 'aria-hidden': 'true' }, h('td', { colSpan: columns.length })),
    height: 41,
    hint,
    onAdded: onRowsAdded,
    onRemoved: (trs) => {
      releaseCovers(trs);
      if (onRowsRemoved) onRowsRemoved(trs);
    },
  });
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
