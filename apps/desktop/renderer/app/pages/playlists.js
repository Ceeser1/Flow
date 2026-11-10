'use strict';

// Playlists: create one at the top; both tables also show when each was created
// and how long you have listened to it; "Shared Playlists" (All Songs, and the
// playlists other profiles share, which can be followed or not; the section
// can be closed, All Songs stays); "Your Playlists" below. Favourites is
// always the first row of those, whatever the sort, and has no actions. The
// listening trend lists have their own page (trend.js).
//
// Playlist Groups (4.5, groups.js) below: a box to make one, then each group
// as a head (open or closed as in the menu: its name, playlists, songs and
// length, Update all, Add playlists, Rename, Delete) with its playlists' table
// under it while open. Your Playlists lists only the playlists in no group.
// On the computer a playlist's row can be dragged onto a group, or back onto
// Your Playlists; every playlist also has Move to group. Since 4.5.1 the
// playlists others share can go into groups too (a Flow Server that keeps
// that): followed ones show in their group, and one not followed yet is
// followed as it goes in (dragged from Shared Playlists, or its folder).

const PlaylistsPage = {
  sort: { key: null, dir: null },
  renaming: null, // id of the row being renamed
  _drawing: false,

  init() {
    const box = $('newPlaylistName');
    $('newPlaylistBtn').onclick = () => this.create();
    // A smart playlist (4.0): named in the box or in its rules' popup.
    $('newSmartBtn').onclick = async () => {
      const p = await RulesEditor.open({ name: $('newPlaylistName').value });
      if (!p) return;
      $('newPlaylistName').value = '';
      toast(T('playlists.smartCreated', { playlist: p.name }), 'success');
      this._whenListed(p.id, () => Nav.openPlaylist(p.id));
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.create();
    });
    box.addEventListener('input', () => {
      $('newPlaylistError').textContent = '';
    });
    $('newGroupBtn').onclick = () => this.createGroup();
    $('newGroupName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.createGroup();
    });
    $('newGroupName').addEventListener('input', () => {
      $('newGroupError').textContent = '';
    });
    // Dropped on Your Playlists: out of its group.
    Groups.dropTarget($('playlistsSingle'), '');
    // And on Shared Playlists (4.5.1), as a followed one leaves its group.
    Groups.dropTarget($('sharedTable'), '');
    $('sharedHead').onclick = () => {
      Store.saveSettings({ sharedGroupOpen: Store.settings.sharedGroupOpen === false });
      this._loadShared();
      this.render();
    };
    Store.onLibrary(() => {
      if (Nav.page === 'playlists') this.render();
    });
    Store.onServer(() => {
      if (Nav.page === 'playlists') this.render();
    });
    this._drawSmartButton();
    Store.onServer(() => this._drawSmartButton());
  },

  /** Smart playlists: here, or on a Flow Server that keeps their rules (4.0). */
  _drawSmartButton() {
    $('newSmartBtn').hidden = !!Store.server.on && !Store.server.smartPlaylists;
  },

  /** opts.at 'groups': scrolled to Playlist Groups (the menu's entry, 4.5.1). */
  show(opts = {}) {
    this.renaming = null;
    this._loadShared();
    this.render();
    if (opts.at === 'groups' && !$('groupsSection').hidden) $('groupsSection').scrollIntoView({ block: 'start' });
  },

  /**
   * The playlists others share come by their details when they show (4.3):
   * the page opened, or the section opened; never in the background.
   */
  _loadShared() {
    if (Store.settings.sharedGroupOpen === false || !Store.canShare() || Store.server.state !== 'online' || !window.flow.loadShared) return;
    window.flow.loadShared().catch(() => {});
  },

  async create() {
    const box = $('newPlaylistName');
    try {
      const p = await window.flow.createPlaylist(box.value);
      box.value = '';
      $('newPlaylistError').textContent = '';
      toast(T('playlists.created', { playlist: p.name }), 'success');
      // Straight on to filling it: All Songs, adding songs to it.
      this._whenListed(p.id, () => Nav.openPlaylist('all', { pickFor: p.id }));
    } catch (err) {
      $('newPlaylistError').textContent = err.message;
      box.focus();
    }
  },

  async createGroup() {
    const box = $('newGroupName');
    try {
      const g = await Groups.create(box.value);
      box.value = '';
      $('newGroupError').textContent = '';
      toast(T('groups.created', { group: g.name }), 'success');
      this.render();
    } catch (err) {
      $('newGroupError').textContent = err.message;
      box.focus();
    }
  },

  /**
   * Runs `fn` once the library has playlist `id`: at once, or with the
   * library event that brings it (with a Flow Server it may come after the
   * answer). Given up after a few seconds, or once another page is open.
   */
  _whenListed(id, fn) {
    if (Store.playlist(id)) {
      fn();
      return;
    }
    const until = Date.now() + 5000;
    const check = () => {
      if (Date.now() > until || Nav.page !== 'playlists') return true;
      if (!Store.playlist(id)) return false;
      fn();
      return true;
    };
    const listener = () => {
      if (check()) Store._listeners = Store._listeners.filter((f) => f !== listener);
    };
    Store.onLibrary(listener);
  },

  _value(p, key) {
    if (key === 'name') return p.name;
    if (key === 'songs') return Store.songCount(p);
    if (key === 'duration') return Store.durationOf(p);
    if (key === 'created') return p.createdAt || 0;
    if (key === 'listened') return Store.listenedTo(p.id);
    return '';
  },

  render() {
    // Your Playlists: those in no group (4.5).
    const singles = Store.singlePlaylists();
    const lists = Util.sortRows(singles, this.sort, (p, k) => this._value(p, k));
    const rows = [Store.favouritesPlaylist(), ...lists];
    $('playlistsCount').textContent = Util.plural(singles.length, 'playlist');

    // Shared Playlists: All Songs always, the shared ones only while open.
    const open = Store.settings.sharedGroupOpen !== false;
    const shared = Util.sortRows(Store.sharedPlaylists(), this.sort, (p, k) => this._value(p, k));
    const sharedRows = [Store.allSongsPlaylist(), ...(open ? shared : [])];
    $('sharedHead').className = `section-head__btn${open ? ' section-head__btn--open' : ''}`;
    $('sharedHead').setAttribute('aria-expanded', String(open));
    $('sharedHead').title = open ? T('playlists.shared.hide.tooltip') : T('playlists.shared.show.tooltip');
    clear($('sharedHead')).append(h('span.menu__chevron', { html: Icons.chevron }), h('span', T('playlists.shared.heading')));
    $('sharedCount').textContent = Store.canShare() ? Util.plural(shared.length, 'shared playlist') : '';

    // Clearing the table takes the rename box out, which blurs it, and a blur
    // must not start another redraw in the middle of this one.
    this._drawing = true;
    try {
      // On the phone Follow is at the end of the row, or with Move to group (4.5.1) in its More.
      const grouping = Store.canGroupFollowed();
      this._drawTable($('sharedTable'), sharedRows, (p) => this._sharedActions(p), grouping ? null : (p) => this._sharedSide(p),
        grouping ? (p) => this._sharedMore(p) : null);
      this._dragRows($('sharedTable'));
      this._drawTable($('playlistsTable'), rows, (p) => this._actions(p), null, (p) => this._moreButtons(p), this._select());
      this._dragRows($('playlistsTable'));
      this._drawGroups();
    } finally {
      this._drawing = false;
    }

    const input = document.querySelector('#page-playlists .rename-input');
    if (input) {
      input.focus();
      input.select();
    }
  },

  /** The phone's bar of chosen playlists: Move to group (4.5). */
  _select() {
    if (!Store.canGroup()) return undefined;
    return {
      actions: [{
        icon: Icons.folder,
        label: T('groups.moveTo'),
        run: (rows) => Groups.chooseFor(rows.map((p) => p.id)),
      }],
    };
  },

  /** On the computer each playlist's row can be dragged onto a group (4.5). */
  _dragRows(table) {
    if (!Groups.canDrag()) return;
    for (const tr of table.querySelectorAll('tbody tr[data-id]')) Groups.draggable(tr, Store.playlist(tr.dataset.id));
  },

  /** Playlist Groups (4.5): each group's head, and its playlists while it is open. */
  _drawGroups() {
    const section = $('groupsSection');
    section.hidden = !Store.canGroup();
    if (section.hidden) return;
    const groups = Store.groups();
    $('groupsCount').textContent = groups.length ? Util.plural(groups.length, 'group') : '';
    const hint = Store.uiMode === 'mobile' ? 'groups.hint.phone' : 'groups.hint';
    $('groupsHint').textContent = groups.length ? T(hint) : T('groups.hint.none');
    const box = clear($('groupsList'));
    for (const g of groups) {
      const open = Groups.isOpen(g.id);
      const inside = Store.playlistsInGroup(g.id);
      const { songs, seconds } = Groups.totals(g.id);
      const sub = [Util.plural(inside.length, 'playlist'), Util.plural(songs, 'song'), Util.fmtClock(seconds)].join(' · ');
      const head = h('div.group__head',
        h('button.group__toggle', {
          type: 'button',
          'aria-expanded': String(open),
          title: open ? T('groups.hide.tooltip', { group: g.name }) : T('groups.show.tooltip', { group: g.name }),
          onclick: () => {
            Groups.toggle(g.id);
            this.render();
            Nav.drawMenu();
          },
        },
        h('span.menu__chevron' + (open ? '.menu__chevron--open' : ''), { html: Icons.chevron }),
        h('span.group__icon', { html: Icons.folder }),
        h('span.group__text', h('span.group__name', g.name), h('span.group__sub', sub))),
        h('div.actions', ...this._groupButtons(g)));
      const block = h('div.group' + (open ? '.group--open' : ''), { dataset: { group: g.id } }, head);
      if (open) {
        if (inside.length) {
          const table = h('table.table.table--playlists', { id: `groupTable-${g.id}` });
          block.appendChild(table);
          const sorted = Util.sortRows(inside, this.sort, (p, k) => this._value(p, k));
          this._drawTable(table, sorted, (p) => this._actions(p), null, (p) => this._moreButtons(p), this._select());
          this._dragRows(table);
        } else {
          block.appendChild(h('p.muted-text.group__empty', T(Store.uiMode === 'mobile' ? 'groups.empty.phone' : 'groups.empty')));
        }
      }
      Groups.dropTarget(block, g.id);
      box.appendChild(block);
    }
  },

  /** A group's Update all (its imported playlists), Add playlists, Rename and Delete. */
  _groupButtons(g) {
    const buttons = [];
    const updatable = Groups.updatable(g.id);
    if (updatable.length && Groups.canUpdate()) {
      const busy = PlaylistUpdate.isGroupChecking(g.id);
      buttons.push(iconButton('act.act--blue' + (busy ? '.pl-update--busy' : ''), Icons.refresh,
        busy ? T('groups.updateAll.checking.tooltip', { group: g.name })
          : T('groups.updateAll.tooltip', { group: g.name, playlists: Util.plural(updatable.length, 'playlist'), count: updatable.length }),
        () => PlaylistUpdate.checkAll(g, Groups.updatable(g.id))));
    }
    buttons.push(
      iconButton('act.act--green', Icons.plus, T('groups.add.tooltip', { group: g.name }), () => Groups.addTo(g)),
      iconButton('act.act--grey', Icons.pencil, T('groups.rename.tooltip', { group: g.name }), () => Groups.rename(g)),
      iconButton('act.act--red', Icons.x, T('groups.delete.tooltip', { group: g.name }), () => Groups.remove(g)),
    );
    return buttons;
  },

  _drawTable(table, rows, actions, side = null, more = null, select = undefined) {
    renderTable(table, {
      rows,
      sort: this.sort,
      rowKey: (p) => p.id,
      rowClass: (p) => (p.isAll || p.isFavourites ? 'row--pinned' : ''),
      onSort: (key) => {
        this.sort = Util.cycleSort(this.sort, key);
        this.render();
      },
      onRowDblClick: (p) => Nav.openPlaylist(p.id),
      columns: [
        { key: 'name', label: T('common.name'), cls: 'col-name', render: (p) => this._nameCell(p) },
        { key: 'songs', label: T('common.songs'), cls: 'col-num', render: (p) => String(Store.songCount(p)) },
        { key: 'duration', label: T('common.duration'), cls: 'col-num', render: (p) => Util.fmtClock(Store.durationOf(p)) },
        // Listen Duration: your own time listening to it, as the list playing.
        // Created: the lists the app keeps itself have no date.
        { key: 'listened', label: T('common.listenDuration'), cls: 'col-listened', render: (p) => Util.fmtClock(Store.listenedTo(p.id)) },
        { key: 'created', label: T('common.created'), cls: 'col-date', render: (p) => (p.createdAt && !p.isFavourites ? Util.fmtDate(p.createdAt) : '') },
        { key: 'actions', label: T('common.actions'), sortable: false, cls: 'col-actions', render: actions },
      ],
      mobile: {
        ...listRowSpec((p) => [Util.plural(Store.songCount(p), 'song'), Util.fmtClock(Store.durationOf(p)),
          p.ownerName ? T('common.byOwner', { profile: p.ownerName }) : ''].filter(Boolean).join(' · ')),
        side,
        more: more && ((p) => more(p)),
        select,
      },
    });
  },

  _nameCell(p) {
    if (this.renaming === p.id) {
      const input = h('input.input.rename-input', { type: 'text', value: p.name, maxLength: 80 });
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        const name = input.value;
        this.renaming = null;
        if (save && name.trim() !== p.name) {
          try {
            await window.flow.renamePlaylist(p.id, name);
          } catch (err) {
            toast(err.message, 'error');
            this.renaming = p.id;
          }
        }
        this.render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener('blur', () => {
        if (!this._drawing) finish(true);
      });
      return input;
    }
    return h('button.link-cell', { type: 'button', onclick: () => Nav.openPlaylist(p.id) },
      h('span.link-cell__icon', { html: listIcon(p) }),
      h('span.link-cell__name', p.name),
      p.ownerName ? h('span.link-cell__by', T('common.byOwner', { profile: p.ownerName })) : null);
  },

  /**
   * A shared playlist can only be changed by whoever shared it, so its Actions
   * are Follow and Unfollow, and (4.5.1) Move to group, which follows one
   * not followed yet. All Songs has none.
   */
  _sharedActions(p) {
    if (p.isAll) return h('span.muted', '');
    return h('div.actions', this._followButton(p), this._sharedGroupButton(p));
  },

  _followButton(p) {
    const on = Store.isFollowing(p.id);
    return h('button.btn.btn--small' + (on ? '' : '.btn--primary'), {
      type: 'button',
      title: on ? T('common.unfollow.tooltip', { playlist: p.name }) : T('playlists.follow.tooltip', { playlist: p.name }),
      onclick: () => attempt(() => window.flow.setFollowing(p.id, !on)),
    }, on ? T('common.unfollow') : T('common.follow'));
  },

  /** A shared playlist's Move to group (4.5.1), where the server keeps followed ones in groups. */
  _sharedGroupButton(p) {
    if (!Store.canGroupFollowed()) return null;
    return iconButton('act.act--grey', Icons.folder, T('groups.moveTo'), () => Groups.chooseFor([p.id]));
  },

  /** The phone's sheet of a shared playlist: Follow or Unfollow, and Move to group (4.5.1). */
  _sharedMore(p) {
    if (p.isAll) return null;
    const on = Store.isFollowing(p.id);
    return [
      { icon: on ? Icons.x : Icons.plus, label: on ? T('common.unfollow') : T('common.follow'), kind: on ? 'danger' : '', onClick: () => attempt(() => window.flow.setFollowing(p.id, !on)) },
      this._sharedGroupButton(p),
    ];
  },

  _actions(p) {
    if (p.isFavourites) return h('span.muted', '');
    // A followed playlist in a group (4.5.1): Move to group, Remove from group and Unfollow.
    if (p.isShared) return h('div.actions', this._sharedGroupButton(p), this._removeFromGroupButton(p), this._followButton(p));
    return h('div.actions', ...this._moreButtons(p));
  },

  /**
   * In a group's table (4.5.1): the red folder, out of the group. Yours goes
   * back to Your Playlists, a followed one to Followed Playlists.
   */
  _removeFromGroupButton(p) {
    if (!Store.groupOf(p)) return null;
    return iconButton('act.act--red', Icons.folder, T('groups.removeFrom'), () => Groups.move([p.id], ''));
  },

  /** Add Songs, Rename and Delete; on the phone in a sheet, where Rename asks in a dialog. */
  _moreButtons(p) {
    if (p.isFavourites) return null;
    if (p.isShared) {
      return [this._sharedGroupButton(p), this._removeFromGroupButton(p),
        iconButton('act.act--red', Icons.x, T('common.unfollow'), () => attempt(() => window.flow.setFollowing(p.id, false)))];
    }
    return [
      // A smart playlist's songs come from its rules.
      p.isRuled
        ? iconButton('act.act--green', Icons.pulse, T('common.editRules'), () => RulesEditor.open({ playlist: Store.playlist(p.id) }))
        : iconButton('act.act--green', Icons.plus, T('common.addSongs'), () => Nav.openPlaylist('all', { pickFor: p.id })),
      // Into a group, another one or out of it (4.5).
      Store.canGroup() ? iconButton('act.act--grey', Icons.folder, T('groups.moveTo'), () => Groups.chooseFor([p.id])) : null,
      iconButton('act.act--grey', Icons.pencil, T('playlists.rename'), () => {
        if (document.body.classList.contains('mobile')) {
          this.renameDialog(p);
          return;
        }
        this.renaming = p.id;
        this.render();
      }),
      // In a group (4.5.1): out of it, before Delete.
      this._removeFromGroupButton(p),
      iconButton('act.act--red', Icons.x, T('common.delete'), () => this.remove(p)),
    ];
  },

  async renameDialog(p) {
    const name = await promptDialog({ title: T('common.renamePlaylist'), value: p.name, confirmLabel: T('playlists.rename'), maxLength: 80 });
    if (name === null || name.trim() === p.name) return;
    attempt(() => window.flow.renamePlaylist(p.id, name));
  },

  /** The phone's Follow / Unfollow at the end of a shared playlist's row. */
  _sharedSide(p) {
    if (p.isAll) return h('span');
    return this._followButton(p);
  },

  async remove(p) {
    const answer = await confirmDialog({
      title: T('playlists.delete.title'),
      message: T('playlists.delete.text', { playlist: p.name }),
      confirmLabel: T('common.delete'),
      danger: true,
      // A smart playlist's songs are other lists' and the library's.
      checkbox: p.isRuled ? null : { label: T('playlists.delete.alsoSongs'), checked: false },
    });
    if (!answer) return;
    const withSongs = !p.isRuled && !!answer.checked;
    await attempt(async () => {
      const r = await window.flow.deletePlaylist(p.id, withSongs);
      let text = T('playlists.delete.done', { playlist: p.name });
      if (withSongs && !r) text = T('playlists.delete.done.onServer', { playlist: p.name });
      else if (withSongs) {
        text = r.deleted ? T('playlists.delete.done.withSongs', { playlist: p.name, songs: Util.plural(r.deleted, 'song') })
          : T('playlists.delete.done.noneOnly', { playlist: p.name });
        if (r.kept) text += `. ${T('playlists.delete.done.kept', { songs: Util.plural(r.kept, 'song'), count: r.kept })}`;
      }
      toast(text, 'success');
    });
  },
};
