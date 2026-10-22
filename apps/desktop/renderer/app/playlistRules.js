'use strict';

// Smart playlists (4.0): a playlist with rules holds the songs that match
// them, worked out here from the library as it is (Store.setLibrary), in the
// rules' order, read-only like the listening trend lists. The rules as kept
// (libraryModel.js cleanRules): { match: 'all' | 'any', conditions: [{ field,
// op, value }], sort, limit }. Pure, so the tests can pin it; the window
// loads it as a plain script and gets `PlaylistRules` as a global.

(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./smartLists') : root.SmartLists);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlaylistRules = api;
}(typeof self !== 'undefined' ? self : this, (SmartLists) => {
  const DAY = 24 * 60 * 60 * 1000;

  // The same fields and kinds as libraryModel.js RULE_FIELDS (a test keeps them alike).
  const FIELDS = [
    { id: 'artist', label: 'Artist', kind: 'text' },
    { id: 'title', label: 'Title', kind: 'text' },
    { id: 'album', label: 'Album', kind: 'text' },
    { id: 'genre', label: 'Genre', kind: 'text' },
    { id: 'info', label: 'Info', kind: 'text' },
    { id: 'mix', label: 'Mix', kind: 'text' },
    { id: 'added', label: 'Added', kind: 'date' },
    { id: 'lastPlayed', label: 'Last played', kind: 'date' },
    { id: 'length', label: 'Length (minutes)', kind: 'number' },
    { id: 'plays', label: 'Times played', kind: 'number' },
    { id: 'fullListens', label: 'Times heard to the end', kind: 'number' },
    { id: 'favourite', label: 'Favourite', kind: 'bool' },
  ];
  const OPS = {
    text: [['contains', 'contains'], ['notContains', 'does not contain'], ['is', 'is'], ['isNot', 'is not'], ['startsWith', 'starts with']],
    number: [['gt', 'more than'], ['lt', 'less than']],
    date: [['within', 'in the last ... days'], ['notWithin', 'not in the last ... days']],
    bool: [['is', 'is']],
  };
  const SORTS = [
    ['added', 'Newest first'], ['title', 'Title, A to Z'], ['artist', 'Artist, A to Z'],
    ['plays', 'Most played first'], ['lastPlayed', 'Last played first'], ['length', 'Longest first'],
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
    if (!conds.length) return 'Every song';
    const parts = conds.map((c) => {
      const f = FIELDS.find((x) => x.id === c.field);
      const kind = kindOf(c.field);
      const op = (OPS[kind].find(([id]) => id === c.op) || [, ''])[1];
      if (kind === 'bool') return `${c.value !== false ? '' : 'not '}${f.label.toLowerCase()}`;
      if (kind === 'date') return `${f.label} ${op.replace('...', String(c.value))}`;
      if (kind === 'number') return `${f.label.replace(' (minutes)', '')} ${op} ${c.value}${c.field === 'length' ? ' min' : ''}`;
      return `${f.label} ${op} "${c.value}"`;
    });
    const line = parts.join(rules.match === 'any' ? ' or ' : ' and ');
    return rules.limit > 0 ? `${line} (at most ${rules.limit})` : line;
  }

  return {
    FIELDS, OPS, SORTS, kindOf, evaluate, meets, describe,
  };
}));
