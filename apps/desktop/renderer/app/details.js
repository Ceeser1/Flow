'use strict';

// A song's Details: its cover, its names, the playlists it is in, how it has been
// listened to, and where it was downloaded from. Playlist membership changes straight away: a lit button is a
// list the song is in, and clicking it takes the song out (clicking again puts
// it back, until the popup is closed). "Add to Playlists" opens the usual
// picker for the lists it is not in yet.

const SongDetails = {
  open(songId) {
    if (!Store.song(songId)) return;
    // Every list the song was in when the popup opened keeps its button, lit
    // or not, so a mistaken click can be undone.
    const shown = new Set(Store.library.playlists
      .filter((p) => p.entries.some((e) => e.songId === songId))
      .map((p) => p.id));

    const body = h('div.details');
    let modal = null;
    // Its lyrics (4.0.1), fetched once: { state: 'loading' | 'ready' | 'error', data, error }.
    const lyrics = { state: 'loading', data: null, error: '' };

    const draw = () => {
      const song = Store.song(songId);
      if (!song) {
        if (modal) modal.close();
        return;
      }
      clear(body);
      body.appendChild(this._head(song));
      body.appendChild(this._playlists(song, shown));
      body.appendChild(this._stats(song));
      body.appendChild(this._source(song));
      if (window.flow.lyrics) body.appendChild(this._lyrics(song, lyrics, load));
    };
    const load = async () => {
      lyrics.state = 'loading';
      draw();
      try {
        const data = await window.flow.lyrics(songId);
        Object.assign(lyrics, { state: 'ready', data, error: '' });
      } catch (err) {
        Object.assign(lyrics, { state: 'error', data: null, error: (err && err.message) || 'The lyrics could not be fetched.' });
      }
      draw();
    };

    const redraw = () => draw();
    Store.onLibrary(redraw);
    draw();
    if (window.flow.lyrics) load();
    // On the phone a full-screen panel from the right, like the Queue, swiped away to either side.
    modal = Modal.open({
      title: 'Song Details',
      className: 'modal--details',
      drawer: Mobile.on,
      body,
      buttons: Mobile.on ? [] : [{ label: 'Close', kind: 'primary' }],
      onClose: () => {
        Store._listeners = Store._listeners.filter((fn) => fn !== redraw);
      },
    });
    if (Mobile.on) Mobile.swipeToClose(modal, ['left', 'right']);
  },

  _head(song) {
    const meta = [song.artist, Util.fmtClock(song.duration)].filter(Boolean).join('  ·  ');
    // Under them its Album, Mix, Genre and Info, each named, "-" for one it has not.
    const tag = (label, value) => h('span.details__tag', h('span.details__tag-label', label), value || '-');
    return h('section.details__section.details__head',
      Covers.el(song, 'big'),
      h('h3.details__title', { title: song.title }, song.title),
      h('div.details__meta', meta),
      h('div.details__tags',
        tag('Album', song.album), tag('Mix', song.mix), tag('Genre', song.genre), tag('Info', song.subGenre)));
  },

  _playlists(song, shown) {
    const inList = new Set(Store.library.playlists
      .filter((p) => p.entries.some((e) => e.songId === song.id))
      .map((p) => p.id));
    for (const id of inList) shown.add(id);

    const chips = h('div.details__chips');
    const lists = Store.sortedPlaylists().filter((p) => shown.has(p.id));
    if (!lists.length) chips.appendChild(h('span.muted-text', 'Not in any playlist yet.'));
    for (const p of lists) {
      const on = inList.has(p.id);
      chips.appendChild(h('button.chip' + (on ? '.chip--on' : ''), {
        type: 'button',
        title: on ? `In ${p.name}: click to take it out` : `Click to put it back into ${p.name}`,
        html: `<span class="chip__box">${on ? Icons.check : ''}</span>`,
        onclick: () => attempt(async () => {
          if (on) {
            await window.flow.removeFromPlaylist(p.id, song.id);
            toast(`Removed from ${p.name}`, 'success');
          } else {
            await window.flow.addSongToPlaylists(song.id, [p.id]);
            toast(`Added to ${p.name}`, 'success');
          }
        }),
      }, h('span', p.name)));
    }

    const add = h('button.btn.btn--green', {
      type: 'button',
      html: Icons.plus + '<span>Add to Playlists</span>',
      onclick: async () => {
        const chosen = await pickPlaylists({ subtitle: Util.songLine(song), lockedIds: [...inList] });
        if (!chosen || !chosen.length) return;
        await attempt(async () => {
          const n = await window.flow.addSongToPlaylists(song.id, chosen);
          toast(`Added to ${Util.plural(n, 'playlist')}`, 'success');
        });
      },
    });

    return h('section.details__section',
      h('h4.details__heading', 'Playlists'),
      chips,
      h('div.details__row', add));
  },

  /** The page the song was downloaded from, and the playlist it came in with if any. */
  _source(song) {
    const link = (url) => h('button.link-btn.details__url', {
      type: 'button', title: 'Open in the browser', onclick: () => window.flow.openUrl(url),
    }, url);
    const row = (label, value) => [h('div.details__label', label), h('div.details__value', value)];
    return h('section.details__section',
      h('h4.details__heading', 'Source'),
      h('div.details__grid',
        ...row('Direct Url', song.sourceUrl ? link(song.sourceUrl) : h('span.muted-text', 'Not known (the file was added to Local Files by hand)')),
        ...(song.sourcePlaylistUrl ? row('Playlist Url', link(song.sourcePlaylistUrl)) : [])));
  },

  /**
   * Its lyrics, the words without times (4.0.1), and under them Edit Lyrics
   * (or Add Lyrics without any): written ones are kept for good, on the
   * server for a server's song. `reload` fetches them again.
   */
  _lyrics(song, lyrics, reload) {
    const section = h('section.details__section', h('h4.details__heading', 'Lyrics'));
    if (lyrics.state === 'loading') {
      section.appendChild(h('div.details__lyrics.details__lyrics--none', 'Looking for the lyrics...'));
      return section;
    }
    if (lyrics.state === 'error') {
      section.append(h('div.details__lyrics.details__lyrics--none', lyrics.error),
        h('div.details__row', h('button.btn.btn--small', { type: 'button', onclick: reload }, 'Try again')));
      return section;
    }
    const data = lyrics.data;
    const words = data && data.found ? String(data.plain || '').trim() : '';
    section.appendChild(words
      ? h('div.details__lyrics', words)
      : h('div.details__lyrics.details__lyrics--none', data && data.instrumental ? 'Instrumental' : 'No lyrics found for this song.'));
    if (words) section.appendChild(h('div.lyrics__source.details__lyrics-source', LyricsEdit.sourceLine(data)));
    if (!LyricsEdit.available) return section;
    const title = LyricsEdit.heading(song);
    const onSave = async (lines) => {
      await window.flow.setLyrics(song.id, lines);
      Lyrics.forget(song.id);
      toast(lines ? `Lyrics of "${title}" saved` : `Your lyrics of "${title}" removed`, 'success');
      reload();
    };
    section.appendChild(h('div.details__row', words
      ? h('button.btn.btn--light-green', {
        type: 'button', onclick: () => LyricsEdit.edit({ title, data, duration: song.duration, onSave }),
      }, 'Edit Lyrics')
      : h('button.btn.btn--light-green', { type: 'button', onclick: () => LyricsEdit.add({ title, onSave }) }, 'Add Lyrics')));
    return section;
  },

  _stats(song) {
    const st = song.stats || {};
    const plays = st.plays || 0;
    const sessions = st.sessions || 0;
    const last = st.lastPlayedAt;
    const avg = sessions ? (st.listened || 0) / sessions : 0;
    const share = avg && song.duration ? ` (${Math.round((avg / song.duration) * 100)}% of the song)` : '';

    const row = (label, value) => [h('div.details__label', label), h('div.details__value', value)];
    // With a Flow Server that has profiles: the one that uploaded the song or had the server download it.
    const by = Store.canShare() ? (song.addedBy && Store.profileName(song.addedBy)) || 'Not known' : null;
    return h('section.details__section',
      h('h4.details__heading', 'Statistics'),
      h('div.details__grid',
        ...row('Added', Util.fmtDate(song.addedAt)),
        ...(by ? row('Added by', by) : []),
        ...row('Last listened', last ? `${Util.fmtDate(last)}  (${Util.fmtAgo(last)})` : 'Never'),
        ...row('Times played (>5 seconds)', String(sessions)),
        ...row('Average listen duration', sessions ? Util.fmtClock(avg) + share : '-'),
        // Short enough for one line each on the phone.
        ...row('Listened > 80% duration', `${plays}x`),
        ...row('Listened < 80% duration', `${st.stops || 0}x`),
        ...row('Skipped early < 30s', `${st.skips || 0}x`)));
  },
};
