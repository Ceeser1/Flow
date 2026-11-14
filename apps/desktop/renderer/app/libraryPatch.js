// Copied from packages/core/src/libraryPatch.js by scripts/build-strings.js: change that one.
'use strict';

// What changed between two versions of a library-shaped value, as a patch
// small enough to send to the window or to add to the end of a file, and the
// patch applied again (4.3.3).
//
// spec names the parts compared item by item, by their path:
//   'songs': 'list'             an array of objects with an id
//   'stats.songs': 'map'        an object of values by key
//   'profiles.*.songs': 'map'   '*' stands for any one key
// Anything else is compared whole (an object on the way to a list or map,
// such as 'library' for 'library.songs', is walked into).
//
// A patch is a list of steps, each path an array of keys (['library', 'songs']):
//   ['set', path, value]                       the value at path, whole
//   ['del', path]                              the key at path gone
//   ['list', path, { put, gone, order }]       put: whole items (new or changed);
//                                              gone: ids; order: every id, only
//                                              when it is not the old order with
//                                              the new ones at the end
//   ['map', path, { put, gone }]               put: { key: value }; gone: keys
//
// Values are plain JSON (undefined counts as missing).
//
// Locked rows (4.6): a song or playlist that was saved or sent is locked for
// good (lock(): frozen all the way down), and whoever changes it puts a copy
// in its place (libraryModel.js songToChange, listToChange). So what was told
// last need not be a copy of every row: createDiffer's `rows` keeps the rows
// themselves, and a row that is still the same one has not changed. A write
// to a locked row throws instead of going unnoticed.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LibraryPatch = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** Two JSON values alike (undefined as missing). */
  function same(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) if (!same(a[i], b[i])) return false;
      return true;
    }
    if (Array.isArray(b)) return false;
    let n = 0;
    for (const k in a) {
      if (a[k] === undefined) continue;
      n += 1;
      if (!same(a[k], b[k])) return false;
    }
    for (const k in b) if (b[k] !== undefined) n -= 1;
    return n === 0;
  }

  /** Two items of a list or map alike, the `ignore` fields left out. */
  function sameItem(a, b, ignore) {
    if (!ignore || !isObj(a) || !isObj(b)) return same(a, b);
    let n = 0;
    for (const k in a) {
      if (a[k] === undefined || ignore.has(k)) continue;
      n += 1;
      if (!same(a[k], b[k])) return false;
    }
    for (const k in b) if (b[k] !== undefined && !ignore.has(k)) n -= 1;
    return n === 0;
  }

  /** A copy of a JSON value (undefined left out). */
  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      const out = new Array(v.length);
      for (let i = 0; i < v.length; i += 1) out[i] = v[i] === undefined ? null : clone(v[i]);
      return out;
    }
    // Copied whole, then gone through (4.6): made a field at a time, the copy
    // of an object with many fields is kept as a table by the engine, three
    // times the size of the object it copies and slower to compare.
    const out = { ...v };
    for (const k in out) {
      const x = out[k];
      if (x === undefined) delete out[k];
      else if (x !== null && typeof x === 'object') out[k] = clone(x);
    }
    return out;
  }

  /**
   * Locks a row for good, all the way down (4.6): it can no longer be written
   * to, so it is told from a changed one by being the same object. What is
   * locked already is locked all the way down (only lock() locks rows).
   */
  function lock(v) {
    if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v;
    Object.freeze(v);
    if (Array.isArray(v)) for (let i = 0; i < v.length; i += 1) lock(v[i]);
    else for (const k in v) lock(v[k]);
    return v;
  }

  // A list's items have mostly the same fields: compared by a function made
  // for them, field by field (100 000 songs: a few tens of ms instead of 160).
  const made = new Map();
  // Tests: as in a page that runs no code made from text.
  let noCode = false;

  /** For items with (some of) the fields `fields`: { count(x): how many of them x has, equal(a, b): those not ignored alike }. */
  function fieldsCompare(fields, ignore) {
    const sig = `${fields.join('\u0001')}\u0002${ignore ? [...ignore].join('\u0001') : ''}`;
    let c = made.get(sig);
    if (c) return c;
    const name = (k) => JSON.stringify(k);
    const shown = fields.filter((k) => !ignore || !ignore.has(k));
    try {
      if (noCode) throw new Error('no code from text');
      /* eslint-disable no-new-func */
      c = {
        count: new Function('x', `return 0${fields.map((k) => ` + (${name(k)} in x)`).join('')};`),
        equal: new Function('a', 'b', 'same', `return true${shown.map((k) => ` && (a[${name(k)}] === b[${name(k)}] || same(a[${name(k)}], b[${name(k)}]))`).join('')};`),
      };
      /* eslint-enable no-new-func */
    } catch {
      // A page that runs no code made from text (the phone's and the web
      // player's script-src 'self'): the same, a field at a time.
      c = {
        count: (x) => {
          let n = 0;
          for (let i = 0; i < fields.length; i += 1) if (fields[i] in x) n += 1;
          return n;
        },
        equal: (a, b, eq) => {
          for (let i = 0; i < shown.length; i += 1) {
            const k = shown[i];
            if (a[k] !== b[k] && !eq(a[k], b[k])) return false;
          }
          return true;
        },
      };
    }
    if (made.size > 200) made.clear();
    made.set(sig, c);
    return c;
  }

  /** The fields of the items of a list (or map's values), all of them. */
  function fieldsOf(items) {
    const out = new Set();
    for (const x of items) if (isObj(x)) for (const k in x) out.add(k);
    return out;
  }

  /**
   * known: every field the kept items have (a Set, grown with the new ones'),
   * so that two items alike in all of them are alike.
   */
  function itemCompare(known, ignore) {
    let fc = fieldsCompare([...known], ignore);
    return {
      /** An item of the new value: its fields one more time known. */
      see(item) {
        if (!isObj(item) || fc.count(item) === Object.keys(item).length) return;
        for (const k in item) known.add(k);
        fc = fieldsCompare([...known], ignore);
      },
      alike(old, item) {
        if (!isObj(old) || !isObj(item)) return sameItem(old, item, ignore);
        return fc.equal(old, item, same);
      },
    };
  }

  function listStep(was, now, ignore, known) {
    const wasArr = Array.isArray(was) ? was : [];
    const put = [];
    const at = [];
    const ic = itemCompare(known || fieldsOf(wasArr), ignore);
    // Mostly the same items in the same order: compared side by side, the
    // ids looked up only from where they part.
    let i = 0;
    const end = Math.min(wasArr.length, now.length);
    for (; i < end; i += 1) {
      const old = wasArr[i];
      const item = now[i];
      if (!old || !item || old.id !== item.id) break;
      // The row itself, kept and locked (4.6): alike.
      if (old === item) continue;
      ic.see(item);
      if (!ic.alike(old, item)) {
        put.push(item);
        at.push(i);
      }
    }
    const done = (step) => {
      if (!step) return null;
      step.put = step.put.map(clone);
      return step;
    };
    if (i === now.length && i === wasArr.length) return done(put.length ? { put, gone: [], at } : null);
    const before = new Map();
    for (let j = i; j < wasArr.length; j += 1) {
      const item = wasArr[j];
      if (item && item.id !== undefined) before.set(item.id, item);
    }
    const ids = new Set();
    for (let j = i; j < now.length; j += 1) {
      const item = now[j];
      const id = item && item.id;
      ids.add(id);
      const old = before.get(id);
      if (old === item) continue;
      ic.see(item);
      if (old === undefined || !ic.alike(old, item)) {
        put.push(item);
        at.push(j);
      }
    }
    const gone = [];
    for (const id of before.keys()) if (!ids.has(id)) gone.push(id);
    // The order kept as it was (the old ones in their order, then the new): no order sent.
    const expected = [];
    for (let j = i; j < wasArr.length; j += 1) if (wasArr[j] && ids.has(wasArr[j].id)) expected.push(wasArr[j].id);
    for (let j = i; j < now.length; j += 1) if (!before.has(now[j].id)) expected.push(now[j].id);
    let order;
    for (let j = i; j < now.length; j += 1) {
      if (expected[j - i] !== now[j].id) {
        order = now.map((x) => x.id);
        break;
      }
    }
    if (!put.length && !gone.length && !order) return null;
    const step = { put, gone, at };
    if (order) step.order = order;
    return done(step);
  }

  /**
   * size (4.6, createDiffer): { n } how many keys `was` holds, when known;
   * set to how many `now` holds. With it `was` is gone through for keys no
   * longer there only when some are missing.
   */
  function mapStep(was, now, ignore, known, size = null) {
    const old = isObj(was) ? was : {};
    const ic = itemCompare(known || fieldsOf(Object.values(old)), ignore);
    const put = {};
    let n = 0;
    let had = 0;
    let has = 0;
    for (const k in now) {
      const v = now[k];
      if (v === undefined) continue;
      has += 1;
      const o = old[k];
      if (o !== undefined) had += 1;
      // The same value, or the row itself (4.6): alike.
      if (o === v) continue;
      ic.see(v);
      if (o === undefined || !ic.alike(o, v)) {
        put[k] = clone(v);
        n += 1;
      }
    }
    const gone = [];
    if (!size || size.n === undefined || had < size.n) {
      for (const k in old) if (old[k] !== undefined && now[k] === undefined) gone.push(k);
    }
    if (size) size.n = has;
    return n || gone.length ? { put, gone } : null;
  }

  /**
   * The spec made ready: kindOf(path) ('list', 'map' or undefined) and
   * walkInto(path) (a step on the way to one), for paths as arrays; '*' in
   * the spec stands for any one key ('profiles.*.songs').
   */
  function compile(spec) {
    const rules = Object.entries(spec || {}).map(([p, kind]) => ({ parts: p.split('.'), kind }));
    const fits = (parts, path, n) => {
      for (let i = 0; i < n; i += 1) if (parts[i] !== '*' && parts[i] !== path[i]) return false;
      return true;
    };
    return {
      kindOf(path) {
        for (const r of rules) if (r.parts.length === path.length && fits(r.parts, path, path.length)) return r.kind;
        return undefined;
      },
      walkInto(path) {
        return rules.some((r) => r.parts.length > path.length && fits(r.parts, path, path.length));
      },
    };
  }

  /**
   * The steps from `was` to `now` (an empty list: nothing changed). known:
   * a Map (path -> Set) of the fields the items of `was`'s lists and maps
   * have, kept by createDiffer between calls (filled in when missing).
   */
  function diff(was, now, spec = {}, { ignore = null, known = null, sizes = null } = {}) {
    const skip = ignore ? new Set(ignore) : null;
    const rules = compile(spec);
    const steps = [];
    // The fields of a list's or map's items, listed the first time only (items(): them, made when asked for).
    const fieldsAt = (key, items) => {
      if (!known) return null;
      let f = known.get(key);
      if (!f) known.set(key, (f = fieldsOf(items())));
      return f;
    };
    const sizeAt = (key) => {
      if (!sizes) return null;
      let s = sizes.get(key);
      if (!s) sizes.set(key, (s = { n: undefined }));
      return s;
    };
    const walk = (a, b, at) => {
      for (const k in b) {
        const v = b[k];
        if (v === undefined) continue;
        const old = a ? a[k] : undefined;
        // The same value, or (4.6) a kept map of rows that is still the one it was: nothing to look at.
        if (old === v) continue;
        const p = [...at, k];
        const kind = rules.kindOf(p);
        if (kind === 'list' && Array.isArray(v)) {
          const s = listStep(old, v, skip, fieldsAt(p.join('\u0001'), () => (Array.isArray(old) ? old : [])));
          if (s) steps.push(['list', p, s]);
        } else if (kind === 'map' && isObj(v)) {
          const key = p.join('\u0001');
          const s = mapStep(old, v, skip, fieldsAt(key, () => (isObj(old) ? Object.values(old) : [])), sizeAt(key));
          if (s) steps.push(['map', p, s]);
        } else if (isObj(v) && isObj(old) && rules.walkInto(p)) {
          walk(old, v, p);
        } else if (!same(old, v)) {
          steps.push(['set', p, clone(v)]);
        }
      }
      if (a) for (const k in a) if (a[k] !== undefined && b[k] === undefined) steps.push(['del', [...at, k]]);
    };
    walk(isObj(was) ? was : null, now, []);
    return steps;
  }

  function applyList(arr, s, inPlace) {
    let out = Array.isArray(arr) ? (inPlace ? arr : arr.slice()) : [];
    if (s.gone && s.gone.length) {
      const gone = new Set(s.gone);
      out = out.filter((x) => !(x && gone.has(x.id)));
    }
    if (s.put && s.put.length) {
      // Where each is now (s.at), else looked up.
      let pos = null;
      const hint = s.at || [];
      for (let n = 0; n < s.put.length; n += 1) {
        const item = s.put[n];
        const v = clone(item);
        const h = hint[n];
        if (h !== undefined && out[h] && out[h].id === item.id) {
          out[h] = v;
          continue;
        }
        if (!pos) {
          pos = new Map();
          for (let i = 0; i < out.length; i += 1) if (out[i]) pos.set(out[i].id, i);
        }
        const i = pos.get(item.id);
        if (i === undefined) {
          pos.set(item.id, out.length);
          out.push(v);
        } else {
          out[i] = v;
        }
      }
    }
    if (s.order) {
      const byId = new Map(out.map((x) => [x.id, x]));
      out = [];
      for (const id of s.order) if (byId.has(id)) out.push(byId.get(id));
    }
    return out;
  }

  function applyMap(obj, s, inPlace) {
    const out = isObj(obj) ? (inPlace ? obj : { ...obj }) : {};
    for (const k of s.gone || []) delete out[k];
    for (const k in s.put || {}) out[k] = clone(s.put[k]);
    return out;
  }

  /**
   * `value` with the steps applied. inPlace: changed itself (a copy only the
   * caller holds); otherwise a new value whose untouched parts are the old
   * ones (the same songs, so what the window keeps for each stays).
   */
  function apply(value, steps, { inPlace = false } = {}) {
    const root = isObj(value) ? (inPlace ? value : { ...value }) : {};
    for (const [kind, path, arg] of steps || []) {
      const parts = Array.isArray(path) ? path : String(path).split('.');
      let at = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const k = parts[i];
        const next = isObj(at[k]) ? at[k] : {};
        at[k] = inPlace ? next : { ...next };
        at = at[k];
      }
      const k = parts[parts.length - 1];
      if (kind === 'set') at[k] = clone(arg);
      else if (kind === 'del') delete at[k];
      else if (kind === 'list') at[k] = applyList(at[k], arg, inPlace);
      else if (kind === 'map') at[k] = applyMap(at[k], arg, inPlace);
    }
    return root;
  }

  /**
   * Keeps a copy of the value last told, to tell only what changed since.
   * next(value): the steps from the value told last ([] when alike, null when
   * none was: the first time, or after reset()); `value` is the one told now.
   *
   * rows (4.6): paths of the spec ('songs', 'profiles.*.playlists') whose
   * rows are kept themselves instead of copied, and locked: a row that is
   * still the same one is alike without a look, any other is compared as
   * ever. Whoever owns the value must change such a row by putting another in
   * its place (a write to a locked one throws). A list of rows is the
   * owner's to add to and take from; a map of rows is kept itself and locked
   * too (one that is still the same map is not gone through at all), so its
   * owner puts another map in its place to change it. The rest is copied as before.
   */
  function createDiffer(spec, { ignore = null, rows = null } = {}) {
    let last = null;
    let known = new Map();
    let sizes = new Map();
    const byRow = rows && rows.length ? compile(Object.fromEntries(rows.map((p) => [p, 'rows']))) : null;
    // What is kept of the value at `path`: a copy, but of `rows` the list (or map) with the rows themselves, locked.
    const taken = (v, path) => {
      if (v === null || typeof v !== 'object') return v;
      if (byRow.kindOf(path)) {
        if (!Array.isArray(v)) return lock(v);
        const out = v.slice();
        for (let i = 0; i < out.length; i += 1) lock(out[i]);
        return out;
      }
      if (!isObj(v) || !byRow.walkInto(path)) return clone(v);
      const out = {};
      for (const k in v) if (v[k] !== undefined) out[k] = taken(v[k], [...path, k]);
      return out;
    };
    // The rows of `v` (the value told now, at `path`) taken into `mine`, what is kept there: those not kept yet are locked.
    const adopt = (mine, v, path) => {
      for (const k in v) {
        const x = v[k];
        if (x === null || typeof x !== 'object') continue;
        const p = [...path, k];
        if (byRow.kindOf(p)) {
          const was = mine[k] !== null && typeof mine[k] === 'object' ? mine[k] : null;
          if (Array.isArray(x)) {
            const out = x.slice();
            for (let i = 0; i < out.length; i += 1) if (!was || was[i] !== out[i]) lock(out[i]);
            mine[k] = out;
          } else if (was !== x) mine[k] = lock(x);
        } else if (isObj(x) && byRow.walkInto(p)) {
          if (!isObj(mine[k])) mine[k] = {};
          adopt(mine[k], x, p);
        }
      }
    };
    const keep = (value) => {
      last = byRow ? taken(value, []) : clone(value);
      known = new Map();
      sizes = new Map();
    };
    return {
      /** Whether a value was told yet. */
      started: () => last !== null,
      /** `value` is what was told now (null: none, the next is told whole). */
      reset(value) {
        if (value === undefined || value === null) last = null;
        else keep(value);
      },
      next(value) {
        if (last === null) {
          keep(value);
          return null;
        }
        const steps = diff(last, value, spec, { ignore, known, sizes });
        if (!byRow) {
          if (steps.length) apply(last, steps, { inPlace: true });
          return steps;
        }
        // The rows are taken as they are now; what changed in the rest is copied in.
        const rest = steps.filter(([kind, path]) => (kind !== 'list' && kind !== 'map') || !byRow.kindOf(path));
        if (rest.length) apply(last, rest, { inPlace: true });
        adopt(last, value, []);
        return steps;
      },
    };
  }

  /** Tests: compare as a page that runs no code made from text does (true), or as usual. */
  function plainCompare(on) {
    noCode = !!on;
    made.clear();
  }

  return {
    same, clone, lock, diff, apply, createDiffer, plainCompare,
  };
}));
