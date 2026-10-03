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
   * right over a lighter backdrop. Returns { close, el }.
   */
  open({ title, body, buttons = [], className = '', onClose, focus, drawer = false }) {
    const closeBtn = iconButton('modal__close', Icons.x, 'Close', () => handle.close());
    const footer = h('div.modal__footer');
    const box = h('div.modal' + (className ? '.' + className : ''), { role: 'dialog', 'aria-modal': 'true' },
      h('div.modal__head', h('h2.modal__title', title), closeBtn),
      h('div.modal__body', body),
      footer);
    const backdrop = h('div.modal-backdrop' + (drawer ? '.modal-backdrop--drawer' : ''), box);
    if (drawer) box.classList.add('modal--drawer');
    // Opened from the player bar over the full-screen visualizer: over it too.
    if (document.body.classList.contains('viz-open')) backdrop.classList.add('modal-backdrop--over');

    let closed = false;
    const handle = {
      el: box,
      close(result) {
        if (closed) return;
        closed = true;
        if (drawer) {
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
      if (e.target === backdrop && pressedBackdrop) handle.close();
    });

    $('modalRoot').appendChild(backdrop);
    Modal.stack.push(handle);
    const target = focus ? box.querySelector(focus) : box.querySelector('.btn--primary, .btn--danger');
    if (target) setTimeout(() => target.focus(), 0);
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
function confirmDialog({ title, message, confirmLabel = 'OK', danger = false, checkbox = null }) {
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
        { label: 'Cancel' },
        {
          label: confirmLabel,
          kind: danger ? 'danger' : 'primary',
          onClick: () => {
            answer = { checked: box ? box.checked : false };
          },
        },
      ],
      onClose: () => resolve(answer),
    });
  });
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

// ---- sortable table ----

/**
 * Draws a table into `table`. columns: [{ key, label, sortable = true, cls,
 * render(row), onClick(row) }]; onClick makes the whole cell clickable
 * (buttons in it keep their own clicks). `sort` is { key, dir } and onSort(key) is called with the
 * clicked column. rowKey(row) goes on each <tr> as data-id.
 */
function renderTable(table, { columns, rows, sort, onSort, rowKey, rowClass, onRowDblClick }) {
  clear(table);
  const headRow = h('tr');
  for (const col of columns) {
    const sortable = col.sortable !== false;
    const active = sortable && sort && sort.key === col.key;
    const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '';
    const th = h('th' + (col.cls ? '.' + col.cls : ''),
      sortable ? h('button.th-sort' + (active ? '.th-sort--active' : ''), {
        type: 'button',
        title: 'Sort by ' + col.label,
        onclick: () => onSort(col.key),
      }, h('span', col.label), h('span.th-arrow', arrow)) : h('span.th-plain', col.label));
    headRow.appendChild(th);
  }
  const tbody = h('tbody');
  const frag = document.createDocumentFragment();
  for (const row of rows) {
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
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  table.appendChild(h('thead', headRow));
  table.appendChild(tbody);
}

// ---- dialogs ----

/**
 * Choose playlists. Lists in `lockedIds` already hold the song: shown faint
 * green, ticked, and cannot be changed. Offers a box to create a new list
 * right there. Resolves the chosen ids (without the locked ones), or null.
 */
function pickPlaylists({ title = 'Add to Playlist', subtitle = '', lockedIds = [], selectedIds = [] }) {
  return new Promise((resolve) => {
    const locked = new Set(lockedIds);
    const selected = new Set(selectedIds.filter((id) => !locked.has(id)));
    const list = h('div.picker__list');
    const nameBox = h('input.input', { type: 'text', placeholder: 'New playlist name', maxLength: 80 });
    const error = h('div.form-error');

    const draw = () => {
      clear(list);
      const lists = Store.sortedPlaylists();
      if (!lists.length) {
        list.appendChild(h('div.picker__empty', 'No playlists yet. Create one above.'));
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
          h('span.picker__meta', isLocked ? 'Already added' : Util.plural(p.entries.length, 'song'))));
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
      body: [
        subtitle ? h('p.modal__subtitle', subtitle) : null,
        h('div.picker__create', nameBox, h('button.btn', { type: 'button', onclick: create }, 'Create')),
        error,
        list,
      ],
      buttons: [
        { label: 'Cancel' },
        { label: 'Save', kind: 'primary', onClick: () => { result = [...selected]; } },
      ],
      onClose: () => {
        unsubscribe();
        resolve(result);
      },
    });
  });
}
