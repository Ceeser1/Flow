'use strict';

// What changed between two versions of a library-shaped value, as a patch
// small enough to send to the window or to add to the end of a file, and the
// patch applied again (4.3.3).
//
// spec names the parts compared item by item, by their path:
//   'songs': 'list'          an array of objects with an id
//   'stats.songs': 'map'     an object of values by key
// Anything else is compared whole (an object on the way to a list or map,
// such as 'library' for 'library.songs', is walked into).
//
// A patch is a list of steps:
//   ['set', path, value]                       the value at path, whole
//   ['del', path]                              the key at path gone
//   ['list', path, { put, gone, order }]       put: whole items (new or changed);
//                                              gone: ids; order: every id, only
//                                              when it is not the old order with
//                                              the new ones at the end
//   ['map', path, { put, gone }]               put: { key: value }; gone: keys
//
// Values are plain JSON (undefined counts as missing).

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
    const out = {};
    for (const k in v) if (v[k] !== undefined) out[k] = clone(v[k]);
    return out;
  }

  /** The paths walked into on the way to a list or map: 'library' for 'library.songs'. */
  function prefixesOf(spec) {
    const out = new Set();
    for (const p of Object.keys(spec)) {
      const parts = p.split('.');
      for (let i = 1; i < parts.length; i += 1) out.add(parts.slice(0, i).join('.'));
    }
    return out;
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
      ic.see(item);
      const old = before.get(id);
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

  function mapStep(was, now, ignore, known) {
    const old = isObj(was) ? was : {};
    const ic = itemCompare(known || fieldsOf(Object.values(old)), ignore);
    const put = {};
    let n = 0;
    for (const k in now) {
      const v = now[k];
      if (v === undefined) continue;
      ic.see(v);
      const o = old[k];
      if (o === undefined || !ic.alike(o, v)) {
        put[k] = clone(v);
        n += 1;
      }
    }
    const gone = [];
    for (const k in old) if (old[k] !== undefined && now[k] === undefined) gone.push(k);
    return n || gone.length ? { put, gone } : null;
  }

  /**
   * The steps from `was` to `now` (an empty list: nothing changed). known:
   * { path: Set } of the fields the items of `was`'s lists and maps have
   * (createDiffer keeps them; left out, they are looked up).
   */
  function diff(was, now, spec = {}, { ignore = null, known = null } = {}) {
    const skip = ignore ? new Set(ignore) : null;
    const prefixes = prefixesOf(spec);
    const steps = [];
    const walk = (a, b, at) => {
      for (const k in b) {
        const p = at ? `${at}.${k}` : k;
        const v = b[k];
        if (v === undefined) continue;
        const kind = spec[p];
        const old = a ? a[k] : undefined;
        const fields = known ? known.get(p) || known.set(p, new Set()).get(p) : null;
        if (kind === 'list' && Array.isArray(v)) {
          const s = listStep(old, v, skip, fields);
          if (s) steps.push(['list', p, s]);
        } else if (kind === 'map' && isObj(v)) {
          const s = mapStep(old, v, skip, fields);
          if (s) steps.push(['map', p, s]);
        } else if (prefixes.has(p) && isObj(v) && isObj(old)) {
          walk(old, v, p);
        } else if (!same(old, v)) {
          steps.push(['set', p, clone(v)]);
        }
      }
      if (a) for (const k in a) if (a[k] !== undefined && (b[k] === undefined)) steps.push(['del', at ? `${at}.${k}` : k]);
    };
    walk(isObj(was) ? was : null, now, '');
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
    for (const [kind, p, arg] of steps || []) {
      const parts = p.split('.');
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

  /** The value at a dotted path, or undefined. */
  function at(value, p) {
    let v = value;
    for (const k of p.split('.')) v = isObj(v) ? v[k] : undefined;
    return v;
  }

  /**
   * Keeps a copy of the value last told, to tell only what changed since.
   * next(value): the steps from the value told last ([] when alike, null when
   * none was: the first time, or after reset()); `value` is the one told now.
   */
  function createDiffer(spec, { ignore = null } = {}) {
    let last = null;
    let known = new Map();
    const keep = (value) => {
      last = clone(value);
      known = new Map();
      for (const [p, kind] of Object.entries(spec)) {
        const v = at(last, p);
        if (kind === 'list' && Array.isArray(v)) known.set(p, fieldsOf(v));
        if (kind === 'map' && isObj(v)) known.set(p, fieldsOf(Object.values(v)));
      }
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
        const steps = diff(last, value, spec, { ignore, known });
        if (steps.length) apply(last, steps, { inPlace: true });
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
    same, clone, diff, apply, createDiffer, plainCompare,
  };
}));
