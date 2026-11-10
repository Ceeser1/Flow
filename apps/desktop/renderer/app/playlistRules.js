'use strict';

// Smart playlists (4.0): a playlist with rules holds the songs that match
// them, worked out here from the library as it is (Store.setLibrary), in the
// rules' order, read-only like the listening trend lists. The rules as kept
// (libraryModel.js cleanRules): { match: 'all' | 'any', conditions: [{ field,
// op, value }], sort, limit }. Pure, so the tests can pin it; the window
// loads it as a plain script and gets `PlaylistRules` as a global.

(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./smartLists') : root.SmartLists, (typeof module === 'object' && module.exports ? require('./i18n').t : root.T));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlaylistRules = api;
}(typeof self !== 'undefined' ? self : this, (SmartLists, T) => {
  const DAY = 24 * 60 * 60 * 1000;

  // The same fields and kinds as libraryModel.js RULE_FIELDS (a test keeps them alike).
  const FIELDS = [
    { id: 'artist', label: T('common.artist'), kind: 'text' },
    { id: 'title', label: T('common.title'), kind: 'text' },
    { id: 'album', label: T('common.album'), kind: 'text' },
    { id: 'genre', label: T('common.genre'), kind: 'text' },
    { id: 'info', label: T('common.info'), kind: 'text' },
    { id: 'mix', label: T('common.mix'), kind: 'text' },
    { id: 'added', label: T('common.added'), kind: 'date' },
    { id: 'lastPlayed', label: T('rules.field.lastPlayed'), kind: 'date' },
    { id: 'length', label: T('rules.field.length'), kind: 'number' },
    { id: 'plays', label: T('rules.field.timesPlayed'), kind: 'number' },
    { id: 'fullListens', label: T('rules.field.timesHeardToEnd'), kind: 'number' },
    { id: 'favourite', label: T('common.favourite'), kind: 'bool' },
  ];
  const OPS = {
    text: [['contains', T('rules.op.contains')], ['notContains', T('rules.op.notContains')], ['is', T('rules.op.is')], ['isNot', T('rules.op.isNot')], ['startsWith', T('rules.op.startsWith')]],
    number: [['gt', T('rules.op.moreThan')], ['lt', T('rules.op.lessThan')]],
    date: [['within', T('rules.op.inLastDays')], ['notWithin', T('rules.op.notInLastDays')]],
    bool: [['is', T('rules.op.is')]],
  };
  const SORTS = [
    ['added', T('rules.sort.newest')], ['title', T('rules.sort.title')], ['artist', T('rules.sort.artist')],
    ['plays', T('rules.sort.mostPlayed')], ['lastPlayed', T('rules.sort.lastPlayed')], ['length', T('rules.sort.longest')],
  ];

  const kindOf = (field) => (FIELDS.find((f) => f.id === field) || {}).kind || '';
  const fold = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const stats = (s) => s.stats || {};

  /** A song's value for a field. */
  function valueOf(s, field) {
    switch (field) {
      case 'info': return s.subGenre || '';
      case 'added': return s.addedAt || 0;
      case 'lastPlayed': return stats(s).lastPlayedAt || 0;
      case 'length': return (s.duration || 0) / 60;
      case 'plays': return stats(s).sessions || 0;
      case 'fullListens': return stats(s).plays || 0;
      case 'favourite': return !!s.favouriteAt;
      default: return s[field] || '';
    }
  }

  /** Whether `s` meets one condition, at the time `now`. */
  function meets(s, c, now) {
    const kind = kindOf(c.field);
    const v = valueOf(s, c.field);
    if (kind === 'text') {
      const want = fold(c.value);
      // An artist line names each of its artists ("A, B", "A feat. B").
      const values = c.field === 'artist' ? [fold(v), ...SmartLists.artistsOf(v).map(fold)] : [fold(v)];
      if (c.op === 'contains') return values[0].includes(want);
      if (c.op === 'notContains') return !values[0].includes(want);
      if (c.op === 'is') return values.includes(want);
      if (c.op === 'isNot') return !values.includes(want);
      if (c.op === 'startsWith') return values.some((x) => x.startsWith(want));
      return false;
    }
    if (kind === 'number') return c.op === 'gt' ? v > Number(c.value) : v < Number(c.value);
    if (kind === 'date') {
      const recent = v > 0 && now - v <= Number(c.value) * DAY;
      return c.op === 'within' ? recent : !recent;
    }
    if (kind === 'bool') return v === (c.value !== false);
    return false;
  }

  const ORDER = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    title: (a, b) => fold(a.title).localeCompare(fold(b.title)),
    artist: (a, b) => fold(a.artist).localeCompare(fold(b.artist)) || fold(a.title).localeCompare(fold(b.title)),
    plays: (a, b) => (stats(b).sessions || 0) - (stats(a).sessions || 0),
    lastPlayed: (a, b) => (stats(b).lastPlayedAt || 0) - (stats(a).lastPlayedAt || 0),
    length: (a, b) => (b.duration || 0) - (a.duration || 0),
  };

  /** The songs of `songs` the rules pick, in their order, at most their limit. */
  function evaluate(songs, rules, now = Date.now()) {
    if (!rules) return [];
    const conds = rules.conditions || [];
    const any = rules.match === 'any';
    const picked = songs.filter((s) => !conds.length
      || (any ? conds.some((c) => meets(s, c, now)) : conds.every((c) => meets(s, c, now))));
    picked.sort((a, b) => (ORDER[rules.sort] || ORDER.added)(a, b) || (b.addedAt || 0) - (a.addedAt || 0));
    return rules.limit > 0 ? picked.slice(0, rules.limit) : picked;
  }

  /** The rules in a line ("Genre is Trip Hop and Added in the last 30 days"). */
  function describe(rules) {
    const conds = (rules && rules.conditions) || [];
    if (!conds.length) return T('rules.describe.everySong');
    const parts = conds.map((c) => {
      const f = FIELDS.find((x) => x.id === c.field);
      const kind = kindOf(c.field);
      const op = (OPS[kind].find(([id]) => id === c.op) || [, ''])[1];
      if (kind === 'bool') {
        const name = T(`rules.field.${c.field}.lower`);
        return c.value !== false ? name : T('rules.describe.not', { field: name });
      }
      if (kind === 'date') return T('rules.describe.date', { field: f.label, op: op.replace('...', String(c.value)) });
      if (c.field === 'length') return T('rules.describe.minutes', { field: T('common.length'), op, value: c.value });
      if (kind === 'number') return T('rules.describe.number', { field: f.label, op, value: c.value });
      return T('rules.describe.text', { field: f.label, op, value: c.value });
    });
    const line = parts.join(` ${T(rules.match === 'any' ? 'common.or' : 'rules.describe.and')} `);
    return rules.limit > 0 ? T('rules.describe.atMost', { rules: line, limit: rules.limit }) : line;
  }

  return {
    FIELDS, OPS, SORTS, kindOf, evaluate, meets, describe,
  };
}));
