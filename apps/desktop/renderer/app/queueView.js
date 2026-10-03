'use strict';

// The Queue drawer (the Queue button next to "from [playlist]"): it slides in
// from the right with the song playing, the songs added by hand ("Add to
// Queue") and the next ones from the list playing (queue.js). A click on an
// entry plays it now, its x takes it out, and a song can be dragged up or
// down to another place in its own part (the grab handle shows in front of
// the song under the pointer). It follows the player while it is open.

const QueueView = {
  modal: null,
  listEl: null,
  drag: null,          // the drag in progress
  _pending: false,     // a redraw asked for during a drag
  _justDragged: false, // swallows the click that ends a drag

  open() {
    if (this.modal) return;
    this.listEl = h('div.queue');
    const redraw = () => this.draw();
    this.modal = Modal.open({
      title: 'Queue',
      className: 'modal--queue',
      drawer: true,
      body: [this.listEl],
      onClose: () => {
        Player._listeners = Player._listeners.filter((fn) => fn !== redraw);
        Store._listeners = Store._listeners.filter((fn) => fn !== redraw);
        this.modal = null;
        this.listEl = null;
        this.drag = null;
      },
    });
    Player.onChange(redraw);
    Store.onLibrary(redraw);
    this.draw();
  },

  draw() {
    const box = this.listEl;
    if (!box) return;
    // Not under a song being dragged: once it is dropped.
    if (this.drag) {
      this._pending = true;
      return;
    }
    // Topped up first, so the list is the one Next will follow.
    // (In another device's session the host's queue is shown as it is.)
    if (Player.contextId && !Player.remote) Player.queue.fill(Player.idsOf(Player.contextId));
    clear(box);
    const q = Player.queue;

    const current = Player.currentId ? Store.song(Player.currentId) : null;
    box.appendChild(h('div.queue__head', 'Now playing'));
    box.appendChild(current
      ? this._row(current, { now: true })
      : h('div.queue__empty', 'Nothing is playing.'));

    const manual = q.manual.map((id) => Store.song(id));
    if (manual.some(Boolean)) {
      box.appendChild(h('div.queue__head',
        h('span', 'Next in queue'),
        h('button.link-btn.queue__clear', { type: 'button', onclick: () => Player.clearQueue() }, 'Clear')));
      manual.forEach((song, i) => {
        if (song) box.appendChild(this._row(song, { part: 'manual', index: i }));
      });
    }

    const listName = Player.listName();
    const auto = q.auto.map((id) => Store.song(id));
    if (listName && auto.some(Boolean)) {
      box.appendChild(h('div.queue__head',
        h('span', `Next from ${listName}`),
        q.shuffle ? h('span.queue__note', 'shuffled') : null));
      auto.forEach((song, i) => {
        if (song) box.appendChild(this._row(song, { part: 'auto', index: i }));
      });
    } else if (!manual.some(Boolean)) {
      box.appendChild(h('div.queue__empty', 'The queue is empty. Play a playlist, or add songs with "Add to Queue".'));
    }
  },

  _row(song, { now = false, part = null, index = 0 }) {
    const text = h('span.queue__text',
      h('span.queue__title', song.title + (song.mix ? ` (${song.mix})` : '')),
      h('span.queue__artist', song.artist || ''));
    if (now) {
      return h('div.queue__row.queue__row--now',
        h('span.queue__grab'),
        h('span.queue__icon', { html: Player.isPlaying ? Icons.pulse : Icons.pause }),
        Covers.el(song),
        text,
        h('span.queue__dur', Util.fmtClock(song.duration)));
    }
    const row = h('div.queue__row', {
      title: `Play "${song.title}" now, or drag it to another place`,
      dataset: { part, index: String(index) },
      onclick: (e) => {
        if (this._justDragged || e.target.closest('button')) return;
        Player.playFromQueue(part, index);
      },
    },
    h('span.queue__grab', h('img', { src: '../images/grab.png', alt: '' })),
    h('span.queue__num', String(index + 1)),
    Covers.el(song),
    text,
    h('span.queue__dur', Util.fmtClock(song.duration)),
    iconButton('act.act--red.queue__remove', Icons.x, 'Remove from the queue', () => Player.removeFromQueue(part, index)));
    row.addEventListener('pointerdown', (e) => this._press(e, row));
    return row;
  },

  // ---- dragging ----
  //
  // The song follows the pointer; the others of its part slide out of the way
  // to show where it will land. Positions are taken once at the start, in the
  // list's own coordinates, so scrolling while dragging (near the top or
  // bottom edge) keeps them right.

  _press(e, row) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const body = row.closest('.modal__body');
    const part = row.dataset.part;
    const rows = [...this.listEl.querySelectorAll(`.queue__row[data-part="${part}"]`)];
    const from = rows.indexOf(row);
    const start = { y: e.clientY, scroll: body.scrollTop };
    // Captured at once, so a quick flick still reaches the row.
    row.setPointerCapture(e.pointerId);
    let active = false;
    let target = from;

    const offsetOf = (dy) => dy + body.scrollTop - start.scroll;
    const tops = rows.map((r) => r.offsetTop);
    const step = rows.length > 1 ? tops[1] - tops[0] : row.offsetHeight;

    const move = (ev) => {
      let dy = offsetOf(ev.clientY - start.y);
      if (!active) {
        if (Math.abs(dy) < 4) return;
        active = true;
        this.drag = { part };
        row.classList.add('queue__row--dragging');
        this.listEl.classList.add('queue--dragging');
      }
      // Near an edge: scroll that way.
      const r = body.getBoundingClientRect();
      if (ev.clientY < r.top + 40) body.scrollTop -= 10;
      else if (ev.clientY > r.bottom - 40) body.scrollTop += 10;
      dy = offsetOf(ev.clientY - start.y);
      // No further than the first and last song of its part.
      dy = Math.max(tops[0] - tops[from], Math.min(tops[rows.length - 1] - tops[from], dy));
      row.style.transform = `translateY(${dy}px)`;
      // Past a song once its middle is reached, the held song's middle
      // counting: held against the last (or first) song, that one is passed.
      const centre = tops[from] + dy + row.offsetHeight / 2;
      target = from;
      rows.forEach((other, i) => {
        const mid = tops[i] + other.offsetHeight / 2;
        if (i > from && centre >= mid) target += 1;
        if (i < from && centre <= mid) target -= 1;
      });
      rows.forEach((other, i) => {
        if (i === from) return;
        let shift = 0;
        if (from < target && i > from && i <= target) shift = -step;
        if (target < from && i >= target && i < from) shift = step;
        other.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };

    const up = () => {
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', up);
      row.removeEventListener('pointercancel', up);
      if (!active) return;
      this.drag = null;
      this._justDragged = true;
      setTimeout(() => {
        this._justDragged = false;
      }, 0);
      this.listEl.classList.remove('queue--dragging');
      if (target !== from) {
        Player.moveInQueue(part, Number(rows[from].dataset.index), Number(rows[target].dataset.index));
      } else {
        this._pending = true;
      }
      if (this._pending) {
        this._pending = false;
        this.draw();
      }
    };

    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', up);
    row.addEventListener('pointercancel', up);
  },
};
