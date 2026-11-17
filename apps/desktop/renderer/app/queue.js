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
// "Continue with similar songs" (4.0, `continueWith`, set by the Player when
// Settings ask for it): once the list has played through (without shuffle
// its last song taken, with shuffle every song drawn) the automatic part goes
// on with songs like the last ones heard (autoDj.js) instead of starting the
// list over, up to DJ_AHEAD songs past the list's end. Those (`dj`) stay in
// the queue though they are not in the list. A song of the list picked by
// hand, or a list started, goes back to the list.
//
// A list made of several (a playlist group's mix, 4.5.2: `poolsOf(contextId)`
// gives its playlists' songs) is shuffled by its parts: each song drawn is a
// random song of a random one of them, so a short playlist plays as often as
// a long one; no song is drawn again until every song has been.
//
// Smarter shuffle (5.1.1, `smart`, set by the Player while Settings ask for
// it): a song drawn is, where the list allows, not by an artist of the song
// before it, and songs this profile mostly skips early are drawn less often
// (each song's `weight`, 0 to 1: they come later in the round, so in a long
// list they rarely come at all). Every song still has its turn each round.
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
      this.continueWith = null; // (seedIds, avoid) => similar song ids, or null: lists start over
      this.dj = new Set();   // songs continueWith added
      this.djOn = false;     // the list has played through: similar songs follow
      this.poolsOf = null;   // contextId => the song ids of each of its parts, or null: one list
      this.smart = null;     // id => { artists: [folded names], weight: 0..1 } or null, or null: plain shuffle
    }

    /**
     * The parts of the list playing (poolsOf), each only with songs still in
     * `ids`; null for a list of one part.
     */
    _pools(ids) {
      const pools = this.poolsOf ? this.poolsOf(this.contextId) : null;
      if (!pools || !pools.length) return null;
      const present = new Set(ids);
      const kept = pools.map((p) => p.filter((x) => present.has(x))).filter((p) => p.length);
      return kept.length ? kept : null;
    }

    /**
     * One song drawn: from a list of parts, a random part first (of those
     * with a song `ok` lets through), then a random song of it.
     */
    _draw(ids, ok) {
      const pools = this._pools(ids);
      const before = this._lastArtists();
      if (!pools) {
        const pool = ids.filter(ok);
        return pool.length ? this._choose(pool, before) : null;
      }
      let open = pools.map((p) => p.filter(ok)).filter((p) => p.length);
      if (!open.length) return null;
      // Smarter shuffle: a part with a song by someone else, where there is one.
      if (before) {
        const other = open.filter((p) => p.some((x) => !this._shares(x, before)));
        if (other.length) open = other;
      }
      return this._choose(this._pick(open), before);
    }

    /** The artists of the song the next one follows (the last queued, else the one playing); null without Smarter shuffle. */
    _lastArtists() {
      if (!this.smart) return null;
      const last = this.auto.length ? this.auto[this.auto.length - 1] : this.currentId;
      const info = last ? this.smart(last) : null;
      return info && info.artists && info.artists.length ? new Set(info.artists) : null;
    }

    _shares(id, artists) {
      const info = this.smart(id);
      return !!info && (info.artists || []).some((a) => artists.has(a));
    }

    /**
     * One song of `pool`: at random, or with Smarter shuffle not by an artist
     * of `before` where the pool has another, and drawn by each song's weight
     * times how many songs of its artist the pool still has.
     */
    _choose(pool, before) {
      if (!this.smart) return this._pick(pool);
      // A long list (All Songs of a big library): songs tried at random,
      // each taken by its weight, so a draw does not go through all of them
      // (a round's last few, where the artists' counts matter, are short).
      if (pool.length > PlayQueue.SAMPLE_OVER) {
        for (let i = 0; i < 64; i += 1) {
          const x = this._pick(pool);
          if (before && this._shares(x, before)) continue;
          const info = this.smart(x);
          const w = info && Number.isFinite(info.weight) ? info.weight : 1;
          if (this.random() < w) return x;
        }
      }
      let list = pool;
      if (before) {
        const other = pool.filter((x) => !this._shares(x, before));
        if (other.length) list = other;
      }
      // An artist with many songs left comes sooner, so the round does not
      // end on a row of theirs.
      const left = new Map();
      const infos = pool.map((x) => this.smart(x));
      for (const info of infos) {
        const a = info && info.artists && info.artists[0];
        if (a) left.set(a, (left.get(a) || 0) + 1);
      }
      const byId = new Map(pool.map((x, i) => [x, infos[i]]));
      let total = 0;
      const weights = list.map((x) => {
        const info = byId.get(x);
        const w = info && Number.isFinite(info.weight) ? Math.max(0, Math.min(1, info.weight)) : 1;
        const a = info && info.artists && info.artists[0];
        const v = w * (a ? left.get(a) : 1);
        total += v;
        return v;
      });
      if (!(total > 0)) return this._pick(list);
      let r = this.random() * total;
      for (let i = 0; i < list.length; i += 1) {
        r -= weights[i];
        if (r < 0) return list[i];
      }
      return list[list.length - 1];
    }

    /** The next similar song (continueWith), or null. */
    _similar() {
      const seeds = [...this.history.slice(-5), this.currentId, ...this.auto].filter(Boolean).slice(-5);
      const avoid = new Set([...this.history.slice(-50), this.currentId, ...this.auto, ...this.manual]);
      const id = (this.continueWith(seeds, avoid) || []).find((x) => !avoid.has(x)) || null;
      if (id) this.dj.add(id);
      return id;
    }

    /** Back to the list: the similar songs leave the queue. */
    _leaveDj() {
      this.djOn = false;
      if (!this.dj.size) return;
      this.auto = this.auto.filter((x) => !this.dj.has(x));
      this.dj.clear();
    }

    _pick(list) {
      return list[Math.floor(this.random() * list.length)];
    }

    /** The next song for the automatic part, or null when the list is used up. */
    _candidate(ids) {
      if (this.djOn) {
        if (this.continueWith) return this._similar();
        this.djOn = false;
      }
      if (this.shuffle) {
        const queued = new Set(this.auto);
        let id = this._draw(ids, (x) => !this.used.has(x) && !queued.has(x) && x !== this.currentId);
        // Smarter shuffle: what is left of the round is all by the artist just
        // queued. The next round starts now, those songs in it.
        if (id && !this.continueWith) {
          const before = this._lastArtists();
          if (before && this._shares(id, before)) {
            const next = this._draw(ids, (x) => !queued.has(x) && x !== this.currentId);
            if (next && !this._shares(next, before)) {
              this.used.clear();
              id = next;
            }
          }
        }
        if (!id && this.continueWith) {
          this.djOn = true;
          return this._similar();
        }
        if (!id) {
          // Every song has had its turn: a new round.
          this.used.clear();
          id = this._draw(ids, (x) => !queued.has(x) && x !== this.currentId)
            // A list shorter than the queue: the song playing comes round again.
            || this._draw(ids, (x) => !queued.has(x));
        }
        if (!id) return null;
        this.used.add(id);
        return id;
      }
      const last = this.cursor || this.currentId;
      let i = ids.indexOf(last);
      if (i < 0 && last !== this.currentId) i = ids.indexOf(this.currentId);
      if (this.continueWith && i >= 0 && i + 1 >= ids.length) {
        this.djOn = true;
        return this._similar();
      }
      const id = ids[(i + 1) % ids.length];
      // Once round the whole list: nothing new to add.
      return this.auto.includes(id) ? null : id;
    }

    /** Tops the automatic part up to LIMIT (or the list's length). */
    fill(ids) {
      const present = new Set(ids);
      // Songs gone from the list (deleted, or searched out) leave the queue;
      // similar songs are not the list's.
      this.auto = this.auto.filter((x) => present.has(x) || this.dj.has(x));
      for (const x of this.dj) if (x !== this.currentId && !this.auto.includes(x)) this.dj.delete(x);
      const want = Math.min(this.limit, ids.length + (this.continueWith ? PlayQueue.DJ_AHEAD : 0));
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
      this.dj.clear();
      this.djOn = false;
      const first = startId || (!ids.length ? null : (this.shuffle ? this._draw(ids, () => true) : ids[0]));
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
      if (!this.dj.has(id)) this._leaveDj();
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
      this.dj.clear();
      this.djOn = false;
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
        dj: [...this.dj],
        djOn: this.djOn,
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
      this.dj = new Set(ids(s.dj));
      this.djOn = !!s.djOn;
    }

    /** Forgets songs that no longer exist. */
    prune(exists) {
      this.manual = this.manual.filter(exists);
      this.auto = this.auto.filter(exists);
      this.history = this.history.filter(exists);
      for (const id of this.dj) if (!exists(id)) this.dj.delete(id);
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

  /**
   * How gladly Smarter shuffle draws a song, by this profile's stats of it
   * ({ plays, stops, skips }): 1 unless it was skipped early (under 30
   * seconds) twice or more, down to 0.2 for one skipped early four times or
   * more and never heard longer.
   */
  PlayQueue.shuffleWeight = (stats) => {
    const st = stats || {};
    const early = Number(st.skips) || 0;
    if (early < 2) return 1;
    const heard = (Number(st.plays) || 0) + (Number(st.stops) || 0);
    return 1 - 0.8 * (early / (early + heard)) * Math.min(1, early / 4);
  };

  // Smarter shuffle draws from a list longer than this by trying songs at random.
  PlayQueue.SAMPLE_OVER = 500;
  PlayQueue.LIMIT = 20;
  // Similar songs queued past the list's end.
  PlayQueue.DJ_AHEAD = 10;
  return PlayQueue;
}));
