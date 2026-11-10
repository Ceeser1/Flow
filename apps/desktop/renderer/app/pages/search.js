'use strict';

// Search: one box, seven columns. Playlists (the built-in ones included),
// Songs, Artists, Albums, Genres, Info and Mixes whose name holds what was
// typed (Artists: those of the songs found). An empty box lists everything.
// The columns keep their width and the row scrolls sideways (mobile.css: one
// under the other).

// The columns of the songs' names: which song field, its list and count.
const SEARCH_NAMES = [
  { key: 'album', list: 'searchAlbums', count: 'searchAlbumsCount' },
  { key: 'genre', list: 'searchGenres', count: 'searchGenresCount' },
  { key: 'subGenre', list: 'searchInfo', count: 'searchInfoCount' },
  { key: 'mix', list: 'searchMixes', count: 'searchMixesCount' },
];

// A name longer than 40 characters is cut to 37 and "...", the whole name in its tooltip.
const shortName = (text) => (text.length > 40 ? text.slice(0, 37) + '...' : text);
const fullName = (text) => (text && text.length > 40 ? text : undefined);

const SearchPage = {
  init() {
    $('searchIcon').innerHTML = Icons.search;
    const box = $('searchInput');
    // Typed fast, the results are drawn once a frame with what is in the box then.
    let typed = 0;
    box.addEventListener('input', () => {
      if (typed) return;
      typed = requestAnimationFrame(() => {
        typed = 0;
        this.render();
      });
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && box.value) {
        box.value = '';
        this.render();
        e.stopPropagation();
      }
    });
    // Phone: All, Playlists, Songs, Artists ..., so the artists are not
    // seven long lists down. The PC shows its columns side by side and hides the row.
    for (const btn of $('searchFilter').children) {
      btn.addEventListener('click', () => this._showPart(btn.dataset.part));
    }
    Store.onLibrary(() => {
      if (Nav.page === 'search') this.render();
    });
    Store.onSettings((patch) => {
      if ('showTrend' in patch && Nav.page === 'search') this.render();
    });
    Player.onChange(() => {
      if (Nav.page === 'search') this._markPlaying();
    });
  },

  show() {
    this.render();
    const box = $('searchInput');
    box.focus();
    box.select();
  },

  render() {
    const q = $('searchInput').value;

    // Playlists, the listening trend lists only while they are shown (Settings)
    const trend = Store.settings.showTrend !== false;
    const lists = [...Store.builtInPlaylists(), ...Store.sortedPlaylists()]
      .filter((p) => (trend || !SmartLists.isSmart(p.id)) && Util.matches(q, p.name));
    this._fill('searchPlaylists', 'searchPlaylistsCount', lists, (p) => h('button.result', {
      type: 'button',
      onclick: () => Nav.openPlaylist(p.id),
    },
    h('span.result__icon', { html: listIcon(p) }),
    h('span.result__text',
      h('span.result__title', { title: fullName(p.name) }, shortName(p.name)),
      h('span.result__meta', `${Util.plural(p.entries.length, 'song')} · ${Util.fmtClock(Store.totalDuration(p.id))}`))));

    // Songs, newest first like All Songs
    const idx = this._index();
    const words = Util.queryWords(q);
    const songs = words.length ? idx.newest.filter((s) => Util.hasWords(Util.songHay(s), words)) : idx.newest;
    // A song plays on a click anywhere on it: its cover, its names, Play on
    // the right; [+] before Play adds it to the queue instead. A div rather
    // than a button, as it holds buttons.
    this._fill('searchSongs', 'searchSongsCount', songs, (s) => {
      const play = () => Player.toggleSong(s.id, 'all');
      const name = s.title + (s.mix ? ` (${s.mix})` : '');
      const row = h('div.result.result--song', {
        role: 'button',
        tabIndex: 0,
        title: T('common.play'),
        dataset: { id: s.id },
        onclick: play,
        onkeydown: (e) => {
          if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          play();
        },
      },
      Covers.el(s, 'result'),
      h('span.result__text',
        h('span.result__title', { title: fullName(name) }, shortName(name)),
        h('span.result__meta', { title: fullName(s.artist) }, [s.artist && shortName(s.artist), Util.fmtClock(s.duration)].filter(Boolean).join(' · '))),
      iconButton('act.act--green', Icons.plus, T('common.addToQueue'), (e) => {
        e.stopPropagation();
        Player.addToQueue(s.id);
      }),
      iconButton('act.act--green.result__play', Icons.play, T('common.play'), (e) => {
        e.stopPropagation();
        play();
      }));
      return row;
    });
    this._markPlaying();

    // Artists: the artists of the songs found, each once, with how many songs they have
    this._fill('searchArtists', 'searchArtistsCount', this._artists(songs, words), (a) => h('button.result', {
      type: 'button',
      title: T('search.artist.tooltip', { artist: a.name }),
      // All Songs with only this artist's songs (its own search is for titles).
      onclick: () => Nav.openPlaylist('all', { filter: '', field: { key: 'artist', value: a.name } }),
    },
    h('span.result__icon.result__avatar', a.name.slice(0, 1).toUpperCase()),
    h('span.result__text',
      h('span.result__title', { title: fullName(a.name) }, shortName(a.name)),
      h('span.result__meta', Util.plural(a.count, 'song')))));

    // Albums, Genres, Info and Mixes the same way. An album shows
    // the cover of a song on it, and its artist when all its songs share one.
    for (const col of SEARCH_NAMES) {
      this._fill(col.list, col.count, this._names(col.key, words), (n) => h('button.result', {
        type: 'button',
        title: T('search.tag.tooltip', { name: n.name }),
        onclick: () => Nav.openPlaylist('all', { filter: '', field: { key: col.key, value: n.name } }),
      },
      col.key === 'album' ? Covers.el(n.song, 'result') : h('span.result__icon.result__avatar.result__avatar--name', n.name.slice(0, 1).toUpperCase()),
      h('span.result__text',
        h('span.result__title', { title: fullName(n.name) }, shortName(n.name)),
        h('span.result__meta', [col.key === 'album' && n.artists.size === 1 ? shortName(n.song.artist) : '', Util.plural(n.count, 'song')]
          .filter(Boolean).join(' · ')))));
    }
  },

  /**
   * The artists of the songs `found`: a song's artists one by one (its
   * artist split at the commas, as Flow writes several) and, for a song of
   * several, all of them together, so "Broiler, Tessa Odden" lists Broiler,
   * Tessa Odden and the two of them. Each once, by name, with how many songs
   * of the library are theirs.
   */
  _artists(found, words) {
    const idx = this._index();
    // Every song found: every artist.
    if (!words.length || found.length === idx.newest.length) return idx.artists;
    const shown = new Set();
    for (const s of found) for (const key of idx.artistKeys.get(s) || []) shown.add(key);
    return idx.artists.filter((a) => shown.has(a.key));
  },

  /**
   * Every name the songs have in `key` (mix, album ...) once, by
   * name, with how many songs have it, the first of them and their artists;
   * only the names holding the words searched for.
   */
  _names(key, words) {
    const all = this._index().names[key];
    return words.length ? all.filter((n) => Util.hasWords(n.folded, words)) : all;
  },

  /**
   * The library looked through once (not at every letter typed, a long one
   * takes a while): its songs newest first; the artists, each with how many
   * songs of the library are theirs, and each song's; every album, genre,
   * info and mix with its count, first song and artists. A to Z.
   */
  _index() {
    const lib = Store.library;
    if (this._idx && this._idx.lib === lib) return this._idx;
    const namesOf = (s) => {
      const parts = String(s.artist || '').split(',').map((p) => p.trim()).filter(Boolean);
      return parts.length > 1 ? [...parts, parts.join(', ')] : parts;
    };
    const byName = (a, b) => Util.compareValues(a.name, b.name);
    const artists = new Map();
    const artistKeys = new Map();
    for (const s of lib.songs) {
      // A name twice in one song ("A, A") counts that song once.
      const keys = [];
      for (const name of namesOf(s)) {
        const key = Util.fold(name);
        if (keys.includes(key)) continue;
        keys.push(key);
        const entry = artists.get(key) || { name, key, count: 0 };
        entry.count += 1;
        artists.set(key, entry);
      }
      artistKeys.set(s, keys);
    }
    const names = {};
    for (const col of SEARCH_NAMES) {
      const found = new Map();
      for (const s of lib.songs) {
        const name = String(s[col.key] || '').trim();
        if (!name) continue;
        const folded = Util.fold(name);
        const entry = found.get(folded) || {
          name, folded, count: 0, song: s, artists: new Set(),
        };
        entry.count += 1;
        entry.artists.add(Util.fold(s.artist));
        found.set(folded, entry);
      }
      names[col.key] = [...found.values()].sort(byName);
    }
    this._idx = {
      lib,
      newest: lib.songs.slice().sort((a, b) => b.addedAt - a.addedAt),
      artists: [...artists.values()].sort(byName),
      artistKeys,
      names,
    };
    return this._idx;
  },

  _showPart(part) {
    for (const btn of $('searchFilter').children) {
      btn.classList.toggle('search-filter__btn--on', btn.dataset.part === part);
    }
    for (const col of $('searchResults').children) {
      col.classList.toggle('results__col--off', part !== 'all' && col.dataset.part !== part);
    }
    $('pages').scrollTop = 0;
  },

  // Long lists are cut off: nobody scrolls through 5000 buttons, they type more.
  // The first ones of each column are drawn at once, the rest right after (a
  // letter typed meanwhile starts over), so typing never waits for them.
  _fill(listId, countId, items, draw, limit = 300) {
    const list = $(listId);
    releaseCovers([list]);
    clear(list);
    list._job = (list._job || 0) + 1;
    const job = list._job;
    $(countId).textContent = items.length ? String(items.length) : '';
    if (!items.length) {
      list.appendChild(h('div.results__empty', T('search.noMatches')));
      return;
    }
    const shown = items.length > limit ? items.slice(0, limit) : items;
    const end = items.length > limit ? h('div.results__more', T('search.more', { count: items.length - limit })) : null;
    let at = 0;
    const part = (ms) => {
      const started = performance.now();
      const frag = document.createDocumentFragment();
      while (at < shown.length && (at < 24 || performance.now() - started < ms)) {
        frag.appendChild(draw(shown[at]));
        at += 1;
      }
      if (end) list.insertBefore(frag, end);
      else list.appendChild(frag);
    };
    if (end) list.appendChild(end);
    part(0);
    const more = () => {
      if (list._job !== job || !list.isConnected) return;
      part(6);
      if (listId === 'searchSongs') this._markPlaying();
      if (at < shown.length) setTimeout(more, 0);
    };
    if (at < shown.length) setTimeout(more, 0);
  },

  _markPlaying() {
    for (const node of document.querySelectorAll('#searchSongs .result--song')) {
      const current = node.dataset.id === Player.currentId;
      const playing = current && Player.isPlaying;
      // Only the rows that change (each starts as Play).
      if (!!node._playing === playing && !!node._current === current) continue;
      node._playing = playing;
      node._current = current;
      node.classList.toggle('result--current', current);
      const btn = node.querySelector('.result__play');
      btn.innerHTML = playing ? Icons.pause : Icons.play;
      btn.title = playing ? T('common.pause') : T('common.play');
      btn.setAttribute('aria-label', btn.title);
      node.title = playing ? T('common.pause') : T('common.play');
    }
  },
};
