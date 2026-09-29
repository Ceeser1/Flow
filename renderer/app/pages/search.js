'use strict';

// Search: one box, three columns. Playlists (the built-in ones included), Songs and
// Artists whose name holds what was typed. An empty box lists everything.

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
    Store.onLibrary(() => {
      if (Nav.page === 'search') this.render();
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

    // Playlists
    const lists = [...Store.builtInPlaylists(), ...Store.sortedPlaylists()]
      .filter((p) => Util.matches(q, p.name));
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
      .filter((s) => Util.matches(q, s.title, s.artist, s.mix));
    this._fill('searchSongs', 'searchSongsCount', songs, (s) => h('button.result.result--song', {
      type: 'button',
      title: 'Play',
      dataset: { id: s.id },
      onclick: () => Player.toggleSong(s.id, 'all'),
    },
    h('span.result__icon.result__play', { html: Icons.play }),
    h('span.result__text',
      h('span.result__title', s.title + (s.mix ? ` (${s.mix})` : '')),
      h('span.result__meta', [s.artist, Util.fmtClock(s.duration)].filter(Boolean).join(' · ')))));
    this._markPlaying();

    // Artists: every artist name once, with how many songs they have
    const artists = new Map();
    for (const s of Store.library.songs) {
      const name = (s.artist || '').trim();
      if (!name) continue;
      const key = Util.fold(name);
      const entry = artists.get(key) || { name, count: 0 };
      entry.count += 1;
      artists.set(key, entry);
    }
    const artistRows = [...artists.values()]
      .filter((a) => Util.matches(q, a.name))
      .sort((a, b) => Util.compareValues(a.name, b.name));
    this._fill('searchArtists', 'searchArtistsCount', artistRows, (a) => h('button.result', {
      type: 'button',
      title: `Show songs by ${a.name}`,
      onclick: () => Nav.openPlaylist('all', { filter: a.name }),
    },
    h('span.result__icon.result__avatar', a.name.slice(0, 1).toUpperCase()),
    h('span.result__text',
      h('span.result__title', a.name),
      h('span.result__meta', Util.plural(a.count, 'song')))));
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
      node.querySelector('.result__play').innerHTML = playing ? Icons.pause : Icons.play;
      node.title = playing ? 'Pause' : 'Play';
    }
  },
};
