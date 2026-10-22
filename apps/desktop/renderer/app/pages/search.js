'use strict';

// Search: one box, seven columns. Playlists (the built-in ones included),
// Songs, Artists, Albums, Mixes, Genres and Info whose name holds what was
// typed (Artists: those of the songs found). An empty box lists everything.
// The columns keep their width and the row scrolls sideways (mobile.css: one
// under the other).

// The columns of the songs' names: which song field, its list and count.
const SEARCH_NAMES = [
  { key: 'album', list: 'searchAlbums', count: 'searchAlbumsCount' },
  { key: 'mix', list: 'searchMixes', count: 'searchMixesCount' },
  { key: 'genre', list: 'searchGenres', count: 'searchGenresCount' },
  { key: 'subGenre', list: 'searchInfo', count: 'searchInfoCount' },
];

const SearchPage = {
  init() {
    $('searchIcon').innerHTML = Icons.search;
    const box = $('searchInput');
    box.addEventListener('input', () => this.render());
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
      h('span.result__title', p.name),
      h('span.result__meta', `${Util.plural(p.entries.length, 'song')} · ${Util.fmtClock(Store.totalDuration(p.id))}`))));

    // Songs, newest first like All Songs
    const songs = Store.library.songs.slice()
      .sort((a, b) => b.addedAt - a.addedAt)
      .filter((s) => Util.matches(q, s.title, s.artist, s.mix, s.album, s.genre, s.subGenre));
    // A song plays on a click anywhere on it: its cover, its names, Play on
    // the right; [+] before Play adds it to the queue instead. A div rather
    // than a button, as it holds buttons.
    this._fill('searchSongs', 'searchSongsCount', songs, (s) => {
      const play = () => Player.toggleSong(s.id, 'all');
      const row = h('div.result.result--song', {
        role: 'button',
        tabIndex: 0,
        title: 'Play',
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
        h('span.result__title', s.title + (s.mix ? ` (${s.mix})` : '')),
        h('span.result__meta', [s.artist, Util.fmtClock(s.duration)].filter(Boolean).join(' · '))),
      iconButton('act.act--green', Icons.plus, 'Add to Queue', (e) => {
        e.stopPropagation();
        Player.addToQueue(s.id);
      }),
      iconButton('act.act--green.result__play', Icons.play, 'Play', (e) => {
        e.stopPropagation();
        play();
      }));
      return row;
    });
    this._markPlaying();

    // Artists: the artists of the songs found, each once, with how many songs they have
    this._fill('searchArtists', 'searchArtistsCount', this._artists(songs), (a) => h('button.result', {
      type: 'button',
      title: `Show songs by ${a.name}`,
      onclick: () => Nav.openPlaylist('all', { filter: a.name }),
    },
    h('span.result__icon.result__avatar', a.name.slice(0, 1).toUpperCase()),
    h('span.result__text',
      h('span.result__title', a.name),
      h('span.result__meta', Util.plural(a.count, 'song')))));

    // Albums, Mixes, Genres and Info the same way. An album shows
    // the cover of a song on it, and its artist when all its songs share one.
    for (const col of SEARCH_NAMES) {
      this._fill(col.list, col.count, this._names(col.key, q), (n) => h('button.result', {
        type: 'button',
        title: `Show the songs with ${n.name}`,
        onclick: () => Nav.openPlaylist('all', { filter: n.name }),
      },
      col.key === 'album' ? Covers.el(n.song, 'result') : h('span.result__icon.result__avatar.result__avatar--name', n.name.slice(0, 1).toUpperCase()),
      h('span.result__text',
        h('span.result__title', n.name),
        h('span.result__meta', [col.key === 'album' && n.artists.size === 1 ? n.song.artist : '', Util.plural(n.count, 'song')]
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
  _artists(found) {
    const namesOf = (s) => {
      const parts = String(s.artist || '').split(',').map((p) => p.trim()).filter(Boolean);
      return parts.length > 1 ? [...parts, parts.join(', ')] : parts;
    };
    const shown = new Set();
    for (const s of found) for (const name of namesOf(s)) shown.add(Util.fold(name));
    const artists = new Map();
    for (const s of Store.library.songs) {
      // A name twice in one song ("A, A") counts that song once.
      for (const name of new Map(namesOf(s).map((n) => [Util.fold(n), n])).values()) {
        const key = Util.fold(name);
        if (!shown.has(key)) continue;
        const entry = artists.get(key) || { name, count: 0 };
        entry.count += 1;
        artists.set(key, entry);
      }
    }
    return [...artists.values()].sort((a, b) => Util.compareValues(a.name, b.name));
  },

  /**
   * Every name the songs have in `key` (mix, album ...) once, by
   * name, with how many songs have it, the first of them and their artists;
   * only the names holding the query.
   */
  _names(key, q) {
    const names = new Map();
    for (const s of Store.library.songs) {
      const name = String(s[key] || '').trim();
      if (!name) continue;
      const folded = Util.fold(name);
      const entry = names.get(folded) || {
        name, count: 0, song: s, artists: new Set(),
      };
      entry.count += 1;
      entry.artists.add(Util.fold(s.artist));
      names.set(folded, entry);
    }
    return [...names.values()]
      .filter((n) => Util.matches(q, n.name))
      .sort((a, b) => Util.compareValues(a.name, b.name));
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
  _fill(listId, countId, items, draw, limit = 300) {
    const list = clear($(listId));
    $(countId).textContent = items.length ? String(items.length) : '';
    if (!items.length) {
      list.appendChild(h('div.results__empty', 'No matches'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of items.slice(0, limit)) frag.appendChild(draw(item));
    if (items.length > limit) {
      frag.appendChild(h('div.results__more', `${items.length - limit} more - type more to narrow it down`));
    }
    list.appendChild(frag);
  },

  _markPlaying() {
    for (const node of document.querySelectorAll('#searchSongs .result--song')) {
      const current = node.dataset.id === Player.currentId;
      const playing = current && Player.isPlaying;
      node.classList.toggle('result--current', current);
      const btn = node.querySelector('.result__play');
      btn.innerHTML = playing ? Icons.pause : Icons.play;
      btn.title = playing ? 'Pause' : 'Play';
      btn.setAttribute('aria-label', btn.title);
      node.title = playing ? 'Pause' : 'Play';
    }
  },
};
