'use strict';

// What plays next. Pure, so the tests can pin it; the window loads it as a
// plain script and gets `PlayQueue` as a global.
//
// The queue is a real list, shown in the player bar's Queue popup:
//
//   manual  songs the user added ("Add to Queue"), played first, in the order
//           they were added. They stay when another list is started.
//   auto    up to LIMIT songs from the list that is playing. Without shuffle
//           they follow the list as shown (sorted, searched) top to bottom and
//           start over at the end; with shuffle they are drawn at random, and
//           no song is drawn again until every song of the list has been
//           (`used`). Each time one is played or skipped, the next is added.
//
// Starting a list (its Play button, or a song of another list) builds a new
// automatic part. A song of the list that is playing, picked by hand, plays
// at once and leaves the queue as it is. Previous walks back through what
// actually played.
//
// Every call that may add songs is handed the list as it is shown right now
// (`ids`), so a new sort or search counts from the next song added. Without
// shuffle the list is followed from `cursor`, the last song taken from it,
// so reordering the queue by hand (move) changes nothing about what follows.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlayQueue = api;
}(typeof self !== 'undefined' ? self : this, () => {
  class PlayQueue {
    constructor(random = Math.random, limit = 20) {
      this.random = random;
      this.limit = limit;
      this.contextId = null;
      this.currentId = null;
      this.shuffle = false;
      this.manual = [];
      this.auto = [];
      this.used = new Set(); // shuffle: drawn this round
      this.cursor = null;    // no shuffle: the last song added from the list
      this.history = [];     // what played before, newest last
    }

    _pick(list) {
      return list[Math.floor(this.random() * list.length)];
    }

    /** The next song for the automatic part, or null when the list is used up. */
    _candidate(ids) {
      if (this.shuffle) {
        const queued = new Set(this.auto);
        let pool = ids.filter((x) => !this.used.has(x) && !queued.has(x) && x !== this.currentId);
        if (!pool.length) {
          // Every song has had its turn: a new round.
          this.used.clear();
          pool = ids.filter((x) => !queued.has(x) && x !== this.currentId);
          // A list shorter than the queue: the song playing comes round again.
          if (!pool.length) pool = ids.filter((x) => !queued.has(x));
        }
        if (!pool.length) return null;
        const id = this._pick(pool);
        this.used.add(id);
        return id;
      }
      const last = this.cursor || this.currentId;
      let i = ids.indexOf(last);
      if (i < 0 && last !== this.currentId) i = ids.indexOf(this.currentId);
      const id = ids[(i + 1) % ids.length];
      // Once round the whole list: nothing new to add.
      return this.auto.includes(id) ? null : id;
    }

    /** Tops the automatic part up to LIMIT (or the list's length). */
    fill(ids) {
      const present = new Set(ids);
      // Songs gone from the list (deleted, or searched out) leave the queue.
      this.auto = this.auto.filter((x) => present.has(x));
      const want = Math.min(this.limit, ids.length);
      while (this.auto.length < want) {
        const id = this._candidate(ids);
        if (!id) break;
        this.auto.push(id);
        this.cursor = id;
      }
    }

    /**
     * Starts playing a list: the automatic part is built anew after
     * `startId`, or after its first song (a random one with shuffle). The
     * songs added by hand stay. Returns the song to play.
     */
    start(contextId, ids, startId = null) {
      this.contextId = contextId;
      this.auto = [];
      this.used = new Set();
      const first = startId || (!ids.length ? null : (this.shuffle ? this._pick(ids) : ids[0]));
      if (!first) return null;
      if (this.currentId && this.currentId !== first) this._remember(this.currentId);
      this.currentId = first;
      this.used.add(first);
      this.cursor = first;
      this.fill(ids);
      return first;
    }

    /** A song of the list playing, picked by hand: it plays now, the queue stays. */
    jump(id, ids) {
      if (id !== this.currentId) {
        if (this.currentId) this._remember(this.currentId);
        this.currentId = id;
      }
      this._drop(id);
      this.used.add(id);
      this.fill(ids);
      return id;
    }

    /** What next() would give, without moving on (the song transition starts it early). */
    peek(ids) {
      this.fill(ids);
      return this.manual[0] || this.auto[0] || null;
    }

    /** Moves on to `id`: taken out of the queue, and the automatic part topped up. */
    take(id, ids) {
      if (this.manual[0] === id) this.manual.shift();
      else if (this.auto[0] === id) this.auto.shift();
      else this._drop(id);
      if (this.currentId && this.currentId !== id) this._remember(this.currentId);
      this.currentId = id;
      this.fill(ids);
      return id;
    }

    next(ids) {
      const id = this.peek(ids);
      return id ? this.take(id, ids) : null;
    }

    /**
     * The song played before this one, and this one back to the front of the
     * queue. With nothing before it, the song playing (to start it over).
     */
    prev(ids) {
      const present = new Set(ids);
      while (this.history.length) {
        const id = this.history.pop();
        if (!present.has(id)) continue;
        if (this.currentId && this.currentId !== id) {
          this.auto.unshift(this.currentId);
          while (this.auto.length > this.limit) this.used.delete(this.auto.pop());
          this.cursor = this.auto[this.auto.length - 1] || id;
        }
        this._drop(id);
        this.currentId = id;
        return id;
      }
      return this.currentId || ids[0] || null;
    }

    /** One entry of the queue, picked from the Queue popup: it plays now. */
    playAt(part, index, ids) {
      const list = part === 'manual' ? this.manual : this.auto;
      if (index < 0 || index >= list.length) return null;
      const [id] = list.splice(index, 1);
      if (this.currentId && this.currentId !== id) this._remember(this.currentId);
      this.currentId = id;
      this.used.add(id);
      this.fill(ids);
      return id;
    }

    /** "Add to Queue": after the songs added before it. */
    add(id) {
      this.manual.push(id);
    }

    /** Takes one entry out: `part` is 'manual' or 'auto'. */
    removeAt(part, index, ids) {
      const list = part === 'manual' ? this.manual : this.auto;
      if (index < 0 || index >= list.length) return;
      list.splice(index, 1);
      if (part === 'auto') this.fill(ids);
    }

    /** Drags one entry to another place in its own part ('manual' or 'auto'). */
    move(part, from, to) {
      const list = part === 'manual' ? this.manual : this.auto;
      if (from < 0 || from >= list.length || from === to) return;
      const [id] = list.splice(from, 1);
      list.splice(Math.max(0, Math.min(list.length, to)), 0, id);
    }

    clearManual() {
      this.manual = [];
    }

    /** Shuffle on or off: the automatic part is drawn again from the song playing. */
    setShuffle(on, ids = []) {
      this.shuffle = !!on;
      this.auto = [];
      this.used = new Set(this.currentId ? [this.currentId] : []);
      this.cursor = this.currentId;
      if (ids.length) this.fill(ids);
    }

    /** Everything the queue is, as plain data (a session's host sends it along). */
    snapshot() {
      return {
        contextId: this.contextId,
        currentId: this.currentId,
        shuffle: this.shuffle,
        manual: this.manual.slice(),
        auto: this.auto.slice(),
        used: [...this.used],
        cursor: this.cursor,
        history: this.history.slice(),
      };
    }

    /** Takes over a snapshot() (a new host carries on with the old one's queue). */
    restore(snap) {
      const s = snap && typeof snap === 'object' ? snap : {};
      const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
      this.contextId = typeof s.contextId === 'string' ? s.contextId : null;
      this.currentId = typeof s.currentId === 'string' ? s.currentId : null;
      this.shuffle = !!s.shuffle;
      this.manual = ids(s.manual);
      this.auto = ids(s.auto).slice(0, this.limit);
      this.used = new Set(ids(s.used));
      this.cursor = typeof s.cursor === 'string' ? s.cursor : null;
      this.history = ids(s.history).slice(-500);
    }

    /** Forgets songs that no longer exist. */
    prune(exists) {
      this.manual = this.manual.filter(exists);
      this.auto = this.auto.filter(exists);
      this.history = this.history.filter(exists);
    }

    _remember(id) {
      this.history.push(id);
      if (this.history.length > 500) this.history.shift();
    }

    /** Takes the first `id` out of the queue, wherever it is. */
    _drop(id) {
      const m = this.manual.indexOf(id);
      if (m >= 0) {
        this.manual.splice(m, 1);
        return;
      }
      const a = this.auto.indexOf(id);
      if (a >= 0) this.auto.splice(a, 1);
    }
  }

  PlayQueue.LIMIT = 20;
  return PlayQueue;
}));
