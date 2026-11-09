'use strict';

// Playlist groups (4.5): folders of playlists, in the menu below the single
// playlists and on the Playlists page below Your Playlists. A playlist is in
// one group at most; deleting a group leaves its playlists single. Each
// profile has its own (with a Flow Server that keeps them, Store.canGroup).
//
// Here: making, renaming and deleting a group, "Move to group" (a playlist's
// own, or several chosen at once on the phone), "Add playlists" into a group,
// a group's Update all, which groups are open (the menu and the page share
// it, per device), and dragging: on the computer and in the web player a
// playlist is dragged from the menu or the Playlists page onto a group, or
// back onto the single playlists. The phone has no dragging (a long press
// already chooses rows there), only Move to group.

const Groups = {
  DRAG_TYPE: 'application/x-flow-playlist',
  dragging: null, // the playlist being dragged: { id, from (its group id or '') }

  isOpen(id) {
    return (Store.settings.openGroups || []).includes(id);
  },

  toggle(id) {
    const open = (Store.settings.openGroups || []).filter((g) => g !== id);
    if (!this.isOpen(id)) open.push(id);
    Store.saveSettings({ openGroups: open });
  },

  /** Opens a group (a playlist was just put into it), without closing one. */
  open(id) {
    if (!this.isOpen(id)) Store.saveSettings({ openGroups: [...(Store.settings.openGroups || []), id] });
  },

  /** A group's songs and length, all its playlists together. */
  totals(id) {
    let songs = 0;
    let seconds = 0;
    for (const p of Store.playlistsInGroup(id)) {
      songs += Store.songCount(p);
      seconds += Store.durationOf(p);
    }
    return { songs, seconds };
  },

  /** Its imported playlists: the ones Update all reads again. */
  updatable(id) {
    return Store.playlistsInGroup(id).filter((p) => p.source && /^https?:\/\//i.test(p.source.url || '') && !p.isRuled);
  },

  /** Whether a link can be read again here at all (yt-dlp here, or a Flow Server that downloads). */
  canUpdate() {
    return (Store.can('downloadHere') && DownloadsHelp.here) || ServerImport.available;
  },

  // ---- making, renaming, deleting ----

  /** Makes a group; with `playlistIds` they go into it at once. Resolves the group, or null. */
  async create(name, playlistIds = []) {
    const g = await window.flow.createGroup(name);
    if (!g) return null;
    this.open(g.id);
    if (playlistIds.length) await window.flow.setPlaylistGroup(playlistIds, g.id);
    return g;
  },

  async rename(g) {
    const name = await promptDialog({ title: T('groups.rename.title'), value: g.name, confirmLabel: T('playlists.rename'), maxLength: 80 });
    if (name === null || name.trim() === g.name) return;
    attempt(() => window.flow.renameGroup(g.id, name));
  },

  async remove(g) {
    const count = Store.playlistsInGroup(g.id).length;
    const answer = await confirmDialog({
      title: T('groups.delete.title'),
      message: count ? T('groups.delete.text', { group: g.name, playlists: Util.plural(count, 'playlist'), count }) : T('groups.delete.textEmpty', { group: g.name }),
      confirmLabel: T('common.delete'),
      danger: true,
    });
    if (!answer) return;
    await attempt(async () => {
      await window.flow.deleteGroup(g.id);
      toast(T('groups.delete.done', { group: g.name }), 'success');
    });
  },

  // ---- moving playlists ----

  /** Puts playlists into a group ('' out of theirs), and says so. */
  async move(playlistIds, groupId) {
    const ids = playlistIds.filter((id) => {
      const p = Store.playlist(id);
      return p && !p.isFavourites && !p.favourites && (p.group || '') !== (groupId || '');
    });
    if (!ids.length) return;
    await attempt(async () => {
      await window.flow.setPlaylistGroup(ids, groupId || '');
      const g = groupId ? Store.group(groupId) : null;
      if (g) this.open(g.id);
      const one = ids.length === 1 ? Store.playlist(ids[0]) : null;
      let text;
      if (g) text = one ? T('groups.moved', { playlist: one.name, group: g.name }) : T('groups.movedMany', { playlists: Util.plural(ids.length, 'playlist'), group: g.name });
      else text = one ? T('groups.movedOut', { playlist: one.name }) : T('groups.movedOutMany', { playlists: Util.plural(ids.length, 'playlist') });
      toast(text, 'success');
    });
  },

  /**
   * "Move to group": the groups to choose from (the one they are all in
   * already greyed), "No group" for those in one, and a new group by name.
   */
  chooseFor(playlistIds) {
    const lists = playlistIds.map((id) => Store.playlist(id)).filter((p) => p && !p.isFavourites && !p.favourites);
    if (!lists.length) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const same = lists.every((p) => (p.group || '') === (lists[0].group || '')) ? lists[0].group || '' : null;
      const pick = (groupId) => {
        done = true;
        handle.close();
        this.move(lists.map((p) => p.id), groupId).then(() => resolve(true));
      };
      const rows = Store.groups().map((g) => h('button.group-pick__row' + (same === g.id ? '.group-pick__row--here' : ''), {
        type: 'button',
        disabled: same === g.id,
        onclick: () => pick(g.id),
      }, h('span.group-pick__icon', { html: Icons.folder }), h('span.group-pick__name', g.name),
      h('span.group-pick__count', Util.plural(Store.playlistsInGroup(g.id).length, 'playlist'))));
      if (lists.some((p) => p.group && Store.group(p.group))) {
        rows.push(h('button.group-pick__row.group-pick__row--out', { type: 'button', onclick: () => pick('') },
          h('span.group-pick__icon', { html: Icons.x }), h('span.group-pick__name', T('groups.pick.none'))));
      }
      const input = h('input.input', { type: 'text', maxLength: 80, placeholder: T('groups.pick.newName'), autocomplete: 'off' });
      const error = h('div.form-error');
      const makeNew = async () => {
        try {
          const g = await this.create(input.value, lists.map((p) => p.id));
          if (!g) return;
          done = true;
          handle.close();
          toast(lists.length === 1 ? T('groups.moved', { playlist: lists[0].name, group: g.name })
            : T('groups.movedMany', { playlists: Util.plural(lists.length, 'playlist'), group: g.name }), 'success');
          resolve(true);
        } catch (err) {
          error.textContent = err.message;
          input.focus();
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') makeNew();
      });
      input.addEventListener('input', () => {
        error.textContent = '';
      });
      const handle = Modal.open({
        title: lists.length === 1 ? T('groups.pick.title', { playlist: lists[0].name }) : T('groups.pick.titleMany', { playlists: Util.plural(lists.length, 'playlist') }),
        className: 'modal--group-pick',
        body: [
          rows.length ? h('div.group-pick__list', rows) : h('p.muted-text', T('groups.pick.noGroups')),
          h('div.group-pick__new', input, h('button.btn.btn--primary', { type: 'button', onclick: makeNew }, T('groups.pick.create'))),
          error,
        ],
        buttons: [{ label: T('common.cancel') }],
        onClose: () => {
          if (!done) resolve(false);
        },
      });
    });
  },

  /** "Add playlists" of a group: every playlist not in it, ticked ones go in. */
  addTo(g) {
    const lists = Store.sortedPlaylists().filter((p) => p.group !== g.id);
    if (!lists.length) {
      toast(T('groups.add.none', { group: g.name }), 'info');
      return;
    }
    const boxes = lists.map((p) => {
      const box = h('input', { type: 'checkbox' });
      const from = Store.groupOf(p);
      return {
        p,
        box,
        row: h('label.check.group-add__row', box,
          h('span.group-add__icon', { html: listIcon(p) }),
          h('span.group-add__name', p.name),
          from ? h('span.group-add__from', T('groups.add.inGroup', { group: from.name })) : null),
      };
    });
    const go = h('button.btn.btn--primary', { type: 'button' }, T('groups.add.button', { count: 0 }));
    const draw = () => {
      const n = boxes.filter((b) => b.box.checked).length;
      go.textContent = T('groups.add.button', { count: n });
      go.disabled = !n;
    };
    for (const b of boxes) b.box.addEventListener('change', draw);
    draw();
    const handle = Modal.open({
      title: T('groups.add.title', { group: g.name }),
      className: 'modal--group-add',
      body: h('div.group-add__list', boxes.map((b) => b.row)),
      buttons: [{ label: T('common.cancel') }],
    });
    go.onclick = () => {
      const ids = boxes.filter((b) => b.box.checked).map((b) => b.p.id);
      handle.close();
      this.move(ids, g.id);
    };
    handle.el.querySelector('.modal__footer').appendChild(go);
  },

  // ---- dragging (the computer and the web player; not the phone) ----

  canDrag() {
    return !document.body.classList.contains('mobile') && Store.canGroup() && Store.groups().length > 0;
  },

  /** Lets a playlist's row or menu entry be dragged onto a group. */
  draggable(el, p) {
    if (!p || p.isFavourites || p.favourites || !Store.playlist(p.id) || !this.canDrag()) return;
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      this.dragging = { id: p.id, from: p.group || '' };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(this.DRAG_TYPE, p.id);
      // Some text too, or a browser may not start the drag at all.
      e.dataTransfer.setData('text/plain', p.name);
      document.body.classList.add('dragging-playlist');
    });
    el.addEventListener('dragend', () => this._endDrag());
  },

  _endDrag() {
    this.dragging = null;
    document.body.classList.remove('dragging-playlist');
    for (const n of document.querySelectorAll('.drop-target')) n.classList.remove('drop-target');
  },

  /**
   * A place a dragged playlist can be dropped: into group `groupId`, or ''
   * out of its group. The innermost place under the pointer takes it.
   */
  dropTarget(el, groupId) {
    const wants = () => !!this.dragging && this.dragging.from !== groupId;
    el.addEventListener('dragover', (e) => {
      if (!this.dragging) return;
      e.stopPropagation();
      if (!wants()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!el.classList.contains('drop-target')) {
        for (const n of document.querySelectorAll('.drop-target')) n.classList.remove('drop-target');
        el.classList.add('drop-target');
      }
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
    });
    el.addEventListener('drop', (e) => {
      if (!this.dragging) return;
      e.stopPropagation();
      e.preventDefault();
      const id = this.dragging.id;
      const ok = wants();
      this._endDrag();
      if (ok) this.move([id], groupId);
    });
  },
};
