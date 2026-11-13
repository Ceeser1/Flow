'use strict';

// An import on Add Songs (ImportBatch, pages/import.js): the checklist, with its name, playlists, warnings and the boxes for all rows.

extend(ImportBatch, {
  // ---- the checklist ----

  _newItems() {
    return this.listing ? this.listing.items.filter((it) => !it.existing) : [];
  },

  _knownItems() {
    return this.listing ? this.listing.items.filter((it) => it.existing && !it.inTarget) : [];
  },

  /** The playlist an Update goes into, while it exists and the import keeps its name. */
  _updateTarget() {
    const u = this.updating;
    const p = u && Store.playlist(u.id);
    return p && (!this.name || this._finalName() === u.name) ? p : null;
  },

  /** A playlist of the same name, which the songs would be added to (see merge); an Update's own. */
  _takenPlaylist() {
    if (!this._makesPlaylist()) return null;
    const target = this._updateTarget();
    if (target) return target;
    const name = this._finalName().toLowerCase();
    return Store.library.playlists.find((p) => !p.isRuled && !p.favourites && p.name.toLowerCase() === name) || null;
  },

  /**
   * Local files, picked uploads and one song (see optionalList) only make a
   * playlist when "Create new Playlist" is ticked; a playlist's songs unless
   * "Create new Playlist" is unticked (then they only go to All Songs, each
   * still knowing the playlist it came from: sourcePlaylistUrl).
   */
  _makesPlaylist() {
    return this.optionalList ? this.createList : this.keepList;
  },

  _finalName() {
    return this.name.replace(/\s+/g, ' ').trim() || (this.listing ? this.listing.name : '') || T('common.importedPlaylist');
  },

  _resetName(name) {
    // An Update keeps the playlist's own name, whatever its source calls itself now.
    this.name = (this.updating && Store.playlist(this.updating.id) ? this.updating.name : name) || '';
    this.editingName = false;
    this.createList = false;
    this.keepList = true;
    this.playlistIds = [];
    this.merge = true;
  },

  /**
   * The name in the head, changeable until the songs are saved. A playlist's
   * is text with a pencil, which turns it into a box with Apply and Cancel
   * (Enter and Escape do the same). Local files have "Create new Playlist"
   * in front: unticked the name is only the list's label, ticked it is a box
   * with the name the playlist gets. A playlist's has "Create new Playlist" after
   * it (ticked): unticked its songs only go to All Songs. An Update has none:
   * its songs go into the playlist updated.
   */
  _drawName() {
    const box = this._nameEl;
    if (!box) return;
    clear(box);
    // Once a song is saved the playlist exists: it is renamed on its own page.
    const fixed = this.state === 'saving' || this._saved();
    if (this.optionalList) {
      const tick = h('input', { type: 'checkbox', checked: this.createList, disabled: fixed });
      tick.addEventListener('change', () => {
        this.createList = tick.checked;
        this._drawName();
        this._drawWarnings();
        const input = box.querySelector('input[type="text"]');
        if (input) {
          input.focus();
          input.select();
        }
      });
      box.appendChild(h('label.check.import__create', tick, h('span', T('import.playlist.createNew'))));
      if (this.createList) {
        const input = h('input.input.import__name-box', {
          type: 'text', maxLength: 75, spellcheck: false, value: this.name, disabled: fixed, 'aria-label': T('import.playlist.name.ariaLabel'),
        });
        input.addEventListener('input', () => {
          this.name = input.value;
          this._drawWarnings();
        });
        box.appendChild(input);
      } else {
        box.appendChild(h('span.import__heading', this.name));
      }
      return;
    }
    const keepTick = () => {
      if (this.updating) return [];
      const tick = h('input', { type: 'checkbox', checked: this.keepList, disabled: fixed });
      tick.addEventListener('change', () => {
        this.keepList = tick.checked;
        this._drawWarnings();
      });
      return [h('label.check.import__create', tick, h('span', T('import.playlist.createNew')))];
    };
    if (this.editingName && !fixed) {
      const hint = h('span.import__name-hint', { hidden: !this._nameHint }, this._nameHint);
      const input = h('input.input.import__name-box', {
        type: 'text', maxLength: 75, spellcheck: false, value: this._nameDraft, 'aria-label': T('import.playlist.name.ariaLabel'),
      });
      input.addEventListener('input', () => {
        this._nameDraft = input.value;
        this._nameHint = '';
        hint.hidden = true;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._applyName();
        } else if (e.key === 'Escape') {
          // Only ends the editing; nothing else on the page reacts to it.
          e.preventDefault();
          e.stopPropagation();
          this._cancelName();
        }
      });
      box.append(input,
        h('button.btn.btn--small.btn--light-green', { type: 'button', onclick: () => this._applyName() }, T('common.apply')),
        h('button.btn.btn--small', { type: 'button', onclick: () => this._cancelName() }, T('common.cancel')),
        ...keepTick(),
        hint);
      requestAnimationFrame(() => input.focus());
      return;
    }
    box.append(h('span.import__heading', this.name));
    if (!fixed) box.append(iconButton('icon-btn.import__rename', Icons.pencil, T('common.renamePlaylist'), () => this._editName()));
    box.append(...keepTick());
  },

  _editName() {
    this.editingName = true;
    this._nameDraft = this.name;
    this._nameHint = '';
    this._drawName();
    requestAnimationFrame(() => {
      const input = this._nameEl && this._nameEl.querySelector('input');
      if (input) input.select();
    });
  },

  _applyName() {
    const name = this._nameDraft.replace(/\s+/g, ' ').trim();
    if (!name) {
      this._nameHint = T('import.playlist.needsName');
      this._drawName();
      return;
    }
    this.name = name;
    this.editingName = false;
    this._drawName();
    this._drawWarnings();
  },

  _cancelName() {
    this.editingName = false;
    this._nameHint = '';
    this._drawName();
  },

  /** Add to Playlist for a whole batch: existing playlists every song joins. */
  async choosePlaylists() {
    const chosen = await pickPlaylists({
      subtitle: this._makesPlaylist() ? T('import.playlist.everySongOf', { playlist: this._finalName() }) : T('import.playlist.everySongOfImport'),
      selectedIds: this.playlistIds,
    });
    if (chosen === null || this.ended) return;
    this.playlistIds = chosen;
    this._drawPlaylistButton();
  },

  /** The footer's Add to Playlist, with the playlists picked. */
  _drawPlaylistButton() {
    const p = this.p;
    this.playlistIds = this.playlistIds.filter((id) => Store.playlist(id));
    const names = this.playlistIds.map((id) => Store.playlist(id).name);
    p.addToPlaylist.innerHTML = Icons.plus + `<span>${names.length ? T('add.addToPlaylist.count', { count: names.length }) : T('common.addToPlaylist')}</span>`;
    p.addToPlaylist.title = names.length ? names.join(', ') : T(this.oneSong ? 'add.addToPlaylist.song.tooltip' : 'add.addToPlaylist.import.tooltip');
    p.playlistNames.textContent = names.length ? names.join(', ') : '';
  },

  render() {
    if (!this.listing || this.ended) return;
    this._drawHead();
    this._drawWarnings();
    this._drawList();
    this._drawCount();
  },

  /** The link (or links) it came from, for the head; '' for local files and picks. */
  _url() {
    const l = this.listing;
    if (!l) return this._title || '';
    if (l.local || l.search) return '';
    return l.sourceUrl || '';
  },

  /**
   * The head: where it is from, its name (with the pencil), how many songs,
   * its link; opened also its notes (a list cut short, links that failed)
   * and the hint how to trim.
   */
  _drawHead() {
    const head = clear(this.p.source);
    const l = this.listing;
    this._nameEl = null;
    if (!l) {
      if (this._title) head.appendChild(h('span.import-batch__url', { title: this._title }, this._title));
      return;
    }
    const kind = String(l.source || '').toLowerCase();
    const source = SOURCE_NAMES[kind] || l.source || T('common.playlist');
    // A server's batch whose site is not known yet: its Server tag says enough.
    if (!(this.server && kind === 'server')) head.appendChild(h('span.import__badge', source));
    // Downloaded by the server: told apart from this computer's.
    if (this.server) head.appendChild(h('span.import__badge.import__badge--server', T('import.batch.onServer')));
    this._nameEl = h('span.import__name');
    head.appendChild(this._nameEl);
    this._drawName();
    let count = this.state === 'review' ? l.items.length : this.included.length;
    // A server's batch being read: the count its quick read gave.
    if (this.state === 'listing' && this._peekCount) count = this._peekCount;
    head.appendChild(h('span.import-batch__count', Util.plural(count, 'song')));
    const url = this._url();
    if (url) head.appendChild(h('span.import-batch__url', { title: url }, url));
    if (this.collapsed) return;
    const notes = h('div.import-batch__notes');
    if (Array.isArray(l.links) && l.links.length > 1) {
      notes.appendChild(h('span.muted-text', T('import.list.fromLinks', { links: Util.plural(l.links.length, 'link') })));
      for (const part of l.links) {
        const text = this._linkNote(part);
        if (text) notes.appendChild(h('span.import__warn-text', text));
      }
      if (l.truncated === 'server') notes.appendChild(h('span.import__warn-text', T('import.list.serverFirst500')));
    } else if (l.truncated === 'files') {
      notes.appendChild(h('span.import__warn-text', T('import.list.folderHasMore', { count: l.items.length })));
    } else if (l.truncated === 'spotify') {
      notes.appendChild(h('span.import__warn-text', l.sourceTotal > l.items.length
        ? T('import.list.spotifyFirstOfTotal', { count: l.items.length, total: l.sourceTotal })
        : T('import.list.spotifyFirst100')));
    } else if (l.truncated === 'amazon') {
      notes.appendChild(h('span.import__warn-text', T('import.list.amazonFirstN', { count: l.items.length })));
    } else if (l.truncated === 'mix') {
      notes.appendChild(h('span.import__warn-text', T('import.list.mixFirst50')));
    }
    if (this.state !== 'review') {
      const hint = this._wholeOnly()
        ? T('import.list.hint.phone')
        : T(`import.list.hint.trimOrRename.${this.local ? 'ready' : 'downloaded'}${Store.uiMode === 'mobile' ? '.touch' : ''}`);
      notes.appendChild(h('span.muted-text', hint));
    }
    if (notes.childNodes.length) head.appendChild(notes);
  },

  /** The note for one of several links read as one: it failed, or was cut short; '' when it is fine. */
  _linkNote(part) {
    const name = part.name || part.url;
    if (part.error) return T('import.list.link.failed', { link: part.url, reason: part.error });
    if (part.truncated === 'spotify') {
      return part.sourceTotal > part.listed
        ? T('import.list.link.spotifyFirstOfTotal', { name, count: part.listed, total: part.sourceTotal })
        : T('import.list.link.spotifyFirstN', { name, count: part.listed });
    }
    if (part.truncated === 'amazon') return T('import.list.link.amazonFirstN', { name, count: part.listed });
    if (part.truncated === 'mix') return T('import.list.link.mixFirst50', { name });
    return '';
  },

  _drawWarnings() {
    if (this.ended) return;
    const box = clear(this.p.warnings);
    const rows = [];
    const taken = this.state === 'saving' || this._saved() ? null : this._takenPlaylist();
    if (taken && taken === this._updateTarget()) {
      rows.push(h('div.import__warning',
        h('span.import__warn-icon', '!'),
        h('div', T('import.playlist.updating', { playlist: taken.name }))));
    } else if (taken) {
      const tick = h('input', { type: 'checkbox', checked: this.merge });
      tick.addEventListener('change', () => {
        this.merge = tick.checked;
      });
      rows.push(h('div.import__warning',
        h('span.import__warn-icon', '!'),
        h('div',
          h('div', T('common.playlistExists', { playlist: taken.name })),
          h('label.check', tick,
            h('span', T('import.playlist.exists.addToIt', { playlist: taken.name }))))));
    }
    const known = this.state === 'review' ? this._knownItems() : [];
    if (known.length) {
      const list = h('div.import__known');
      for (const it of known) {
        const tick = h('input', { type: 'checkbox', checked: this.keepKnown.has(it.index) });
        tick.addEventListener('change', () => {
          if (tick.checked) this.keepKnown.add(it.index);
          else this.keepKnown.delete(it.index);
          this._drawCount();
        });
        list.appendChild(h('label.check.import__known-row', tick,
          h('span', it.title),
          h('span.muted-text', ` ${T('import.known.inLibraryAs', { song: Util.songLine(it.existing) })}`)));
      }
      rows.push(h('div.import__warning',
        h('span.import__warn-icon', '!'),
        h('div.import__warn-body',
          h('div', T('import.known.note', { songs: Util.plural(known.length, 'song'), count: known.length })),
          list)));
    }
    box.hidden = !rows.length;
    for (const r of rows) box.appendChild(r);
  },

  _drawList() {
    if (this.ended) return;
    const list = clear(this.p.list);
    list.classList.toggle('import__list--frames', this.state !== 'review');
    this._failSummaryEl = null;
    if (this.state === 'review') {
      const items = this._newItems();
      if (!items.length) {
        const target = this._updateTarget();
        list.appendChild(h('div.import__empty', target && !this._knownItems().length
          ? T('import.known.nothingNew', { playlist: target.name })
          : T('import.known.allInLibrary')));
        return;
      }
      const frag = document.createDocumentFragment();
      for (const it of items) frag.appendChild(this._checkRow(it));
      list.appendChild(frag);
      return;
    }
    // Folded: the frames are drawn when it is opened.
    if (this.collapsed) return;
    // The frames. The open one keeps its editor: it is moved, not redrawn.
    // Clearing the list took the editor out of the document with the old
    // frame, so it is put back by reference. So is the Album and Genre box
    // above them, with what is typed into it.
    const typing = this._bulkEl && this._bulkEl.contains(document.activeElement) ? document.activeElement : null;
    const frag = document.createDocumentFragment();
    if (!this.oneSong && this.included.some((it) => !it.existingId)) frag.appendChild(this._drawBulk());
    this._failSummaryEl = h('div.import__summary', { hidden: true });
    frag.appendChild(this._failSummaryEl);
    for (const it of this.included) frag.appendChild(this._frame(it));
    list.appendChild(frag);
    if (typing) typing.focus();
    this._drawFailSummary();
    if (this.openIndex !== null && AddPage.embedded) {
      const body = list.querySelector(`[data-index="${this.openIndex}"] .import__frame-body`);
      if (body) {
        body.prepend(AddPage.editorEl);
        requestAnimationFrame(() => AddPage._redraw());
      } else {
        // The frame is gone: keep what was set and close the editor.
        this._closeEditor(true);
      }
    }
  },

  /**
   * Above the frames: one Album, Genre and Info for every new
   * song of the import that has none, each with its Apply (clickable once something is
   * typed). Songs still downloading get them as they arrive (_giveBulk).
   * Made once per import and kept, so a redraw keeps what is typed.
   */
  _drawBulk() {
    if (this._bulkEl) return this._bulkEl;
    const field = (key, label, placeholder) => {
      const input = h('input.input.import__bulk-input', {
        type: 'text', maxLength: 150, spellcheck: false, placeholder, 'aria-label': label,
      });
      const apply = h('button.btn.btn--small.btn--light-green', { type: 'button', disabled: true }, T('common.apply'));
      input.addEventListener('input', () => {
        apply.disabled = !input.value.trim();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          e.preventDefault();
          apply.click();
        }
      });
      apply.onclick = () => this._applyBulk(key, input.value);
      return h('label.import__bulk-field', h('span.import__bulk-label', T('import.bulk.field', { field: label })), input, apply);
    };
    this._bulkEl = h('div.import__bulk',
      h('div.import__bulk-text', T('import.bulk.intro')),
      h('div.import__bulk-row',
        field('album', BULK.album.label, T('import.bulk.album.placeholder')),
        field('genre', BULK.genre.label, 'Hardstyle'),
        field('subGenre', BULK.subGenre.label, T('common.infoPlaceholder'))),
      h('div.import__bulk-note.muted-text',
        T('import.bulk.note')));
    return this._bulkEl;
  },

  /** A new song's empty album, genre or info from the box above the frames, once its names are there. */
  _giveBulk(it) {
    if (!it.meta || it.existingId) return false;
    let given = false;
    for (const key of Object.keys(BULK)) {
      if (this.bulkInfo[key] && !String(it.meta[key] || '').trim()) {
        it.meta = { ...it.meta, [key]: this.bulkInfo[key] };
        given = true;
      }
    }
    return given;
  },

  /** Apply in the box above the frames: every new song without an album (genre, info) gets this one. */
  _applyBulk(key, value) {
    const v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!v || this.state === 'saving') return;
    this.bulkInfo[key] = v;
    // The open frame's box: closing it reads the names back from there.
    let given = 0;
    if (this.openIndex !== null) {
      const box = $(BULK[key].box);
      if (box && !box.value.trim()) {
        box.value = v;
        given += 1;
      }
    }
    const open = (it) => !it.existingId && !['saving', 'saved', 'discarded', 'failed', 'cancelled'].includes(it.state);
    let coming = 0;
    for (const it of this.included) {
      if (!open(it) || it.index === this.openIndex) continue;
      if (it.state !== 'ready') {
        coming += 1;
        continue;
      }
      if (this._giveBulk(it)) {
        given += 1;
        this._redrawFrame(it);
      }
    }
    toast(T(coming ? 'import.bulk.given.alsoComing' : 'import.bulk.given', {
      field: BULK[key].label, value: v, songs: Util.plural(given, 'song'), coming: Util.plural(coming, 'song'),
    }), 'success');
  },

  /**
   * Local files that could not be opened, as one line per reason instead of
   * a frame each: a folder can hold hundreds of files that only look like
   * audio by their name.
   */
  _drawFailSummary() {
    const box = this._failSummaryEl;
    if (!box) return;
    const failed = this.local ? this.included.filter((it) => it.state === 'failed') : [];
    clear(box);
    box.hidden = !failed.length;
    if (!failed.length) return;
    const byReason = new Map();
    for (const it of failed) {
      const r = it.reason || T('import.song.failed');
      if (!byReason.has(r)) byReason.set(r, { titles: [], noAudio: false });
      byReason.get(r).titles.push(it.title);
      if (it.noAudio) byReason.get(r).noAudio = true;
    }
    for (const [reason, { titles, noAudio }] of byReason) {
      const n = titles.length;
      const text = noAudio
        ? T('import.files.noAudio', { files: Util.plural(n, 'file'), count: n })
        : T('import.files.notOpened', { files: Util.plural(n, 'file'), count: n, reason });
      const more = n > 20 ? `\n${T('import.files.andMore', { count: n - 20 })}` : '';
      box.appendChild(h('div.import__sub.import__sub--bad', { title: titles.slice(0, 20).join('\n') + more }, text));
    }
  },

  _checkRow(it) {
    const usable = it.status === 'ok';
    const tick = h('input', { type: 'checkbox', checked: this.checked.has(it.index), disabled: !usable });
    tick.addEventListener('change', () => {
      if (tick.checked) this.checked.add(it.index);
      else this.checked.delete(it.index);
      this._drawCount();
    });
    const text = h('div.import__text', h('div.import__title', { title: it.title }, it.title));
    const sub = this._matchLine(it);
    if (sub) text.appendChild(sub);
    return h('label.import__row' + (usable ? '' : '.import__row--off'), { dataset: { index: String(it.index) } },
      tick,
      h('span.import__num', String(it.index + 1)),
      text,
      h('span.import__dur', it.duration ? Util.fmtClock(it.duration) : ''));
  },

  /**
   * For a Spotify (Deezer, Amazon Music) song: the upload it was matched to,
   * on YouTube or the site it was found on instead.
   */
  _matchLine(it) {
    if (it.status === 'unavailable') return h('div.import__sub.import__sub--bad', it.note || T('import.match.notAvailable'));
    const m = it.match;
    if (!m) {
      return it.status === 'notfound' ? h('div.import__sub.import__sub--bad', T('import.match.notFound', { reason: it.note || T('import.match.notFound.noMatch') })) : null;
    }
    const site = m.site || 'YouTube';
    const diff = Math.round((m.duration || 0) - (it.duration || 0));
    const off = diff === 0 ? T('import.match.sameLength') : `${diff > 0 ? '+' : ''}${diff} s`;
    const link = h('button.link-btn.import__link', {
      type: 'button',
      title: T('import.match.openToCheck.tooltip', { site }),
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.flow.openUrl(m.url || `https://www.youtube.com/watch?v=${m.id}`);
      },
    }, m.title || site);
    const parts = [h('span', `${T('import.match.site', { site })} `), link,
      h('span', ` · ${m.channel || '?'} · ${Util.fmtClock(m.duration)} (${off})`)];
    if (it.status === 'notfound') parts.unshift(h('span.import__flag.import__flag--bad', T('import.match.notFound.flag')));
    else if (m.quality === 'shaky') parts.unshift(h('span.import__flag', T('import.match.check.flag')));
    return h('div.import__sub', ...parts);
  },

  _selectAll(on) {
    for (const it of this._newItems()) {
      if (it.status !== 'ok') continue;
      if (on) this.checked.add(it.index);
      else this.checked.delete(it.index);
    }
    this._drawList();
    this._drawCount();
  },

  _drawCount() {
    if (this.state !== 'review') return;
    const usable = this._newItems().filter((it) => it.status === 'ok');
    const chosen = usable.filter((it) => this.checked.has(it.index));
    const seconds = chosen.reduce((sum, it) => sum + (it.duration || 0), 0);
    const kbps = Store.settings.alwaysMp3 ? Number(Store.settings.mp3Quality) || 192 : 160;
    const mb = (kbps * 1000 / 8) * seconds / 1e6;
    let text = T('common.selected', { chosen: chosen.length, total: usable.length });
    if (chosen.length) text += ` ${T('import.selection.size', { mb: mb < 10 ? mb.toFixed(1) : Math.round(mb) })}`;
    const known = this._knownItems().filter((it) => this.keepKnown.has(it.index)).length;
    if (known) text += ` ${T('import.selection.fromLibrary', { count: known })}`;
    this.p.count.textContent = text;
    this.p.selected.disabled = !chosen.length && !known;
    this.p.everything.disabled = !usable.length && !this._knownItems().length;
  },
});
