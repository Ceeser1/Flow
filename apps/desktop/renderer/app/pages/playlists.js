'use strict';

// Playlists: both tables also show when each was created and how long you
// have listened to it; "Shared Playlists" (All Songs, and the playlists
// other profiles share, which can be followed or not; the section can be
// closed, All Songs stays); "Your Playlists" below, a line above it, a new
// one made by the box at its head's right (4.5.4; on the phone under it), as
// is a new group at Playlist Groups'. Each search is under its head. Favourites is
// always the first row of those, whatever the sort, and has no actions. The
// listening trend lists have their own page (trend.js).
//
// Playlist Groups (4.5, groups.js) below: a box to make one, then each group
// as a head (open or closed as in the menu: its name, playlists, songs and
// length, Update all, Add playlists, Rename, Delete) with its playlists' table
// under it while open. Since 4.5.3 a playlist can be in several groups and
// Your Playlists lists them all (the setting "Playlists added to groups hide
// in the menu", mirrored under the Playlist Groups head, only touches the
// menu). On the computer a playlist's row can be dragged onto a group (into
// it too), or out of a group's table onto Your Playlists (out of that group);
// every playlist also has Add to group. Since 4.5.1 the
// playlists others share can go into groups too (a Flow Server that keeps
// that): followed ones show in their group, and one not followed yet is
// followed as it goes in (dragged from Shared Playlists, or its folder).
//
// 4.5.3: each list shows 10 entries at most and scrolls in its box after
// that (the groups count as entries of theirs), and each category has a
// search of its own (names; for shared ones their owner's too; a group's by
// its name or its playlists', opened to show those found). A group of yours
// can be shared (its head's Share): the other profiles find it at the top of
// their Shared Playlists, A to Z after All Songs, as a row that opens (its
// arrow or its name) to show its playlists, with Follow Group at the right.
// A group followed shows at the bottom of the menu's Playlist Groups.

const PlaylistsPage = {
  sort: { key: null, dir: null },
  renaming: null, // id of the row being renamed
  _drawing: false,
  // What each category's search box holds (while the app runs).
  filters: { shared: '', yours: '', groups: '' },

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
    // The setting of Settings › General, mirrored here (4.5.3).
    $('groupedHideInMenu').addEventListener('change', () => Store.saveSettings({ groupedHideInMenu: $('groupedHideInMenu').checked }));
    Store.onSettings((patch) => {
      if ('groupedHideInMenu' in patch) $('groupedHideInMenu').checked = Store.settings.groupedHideInMenu !== false;
    });
    this._initSearch('sharedSearch', 'shared');
    this._initSearch('playlistsSearch', 'yours');
    this._initSearch('groupsSearch', 'groups');
    // Dropped on Your Playlists: out of its group.
    Groups.dropTarget($('playlistsSingle'), '');
    // And on Shared Playlists (4.5.1), as a followed one leaves its group.
    Groups.dropTarget($('sharedTable'), '');
    $('sharedHead').onclick = () => {
      Store.saveSettings({ sharedGroupOpen: Store.settings.sharedGroupOpen === false });
      this._loadShared();
      this.render();
    };
    // Not for what it does not show (a song's cover, loudness, a listen that changed no list's time).
    Store.onLibrary((lib, change) => {
      if (Nav.page === 'playlists' && !change.quiet()) this.render();
    });
    Store.onServer(() => {
      if (Nav.page === 'playlists') this.render();
    });
    this._drawSmartButton();
    Store.onServer(() => this._drawSmartButton());
  },

  /** A category's search box (4.5.3): its list redrawn as it is typed in, Escape empties it. */
  _initSearch(id, key) {
    const input = $(id);
    input.previousElementSibling.innerHTML = Icons.search;
    let typed = 0;
    input.addEventListener('input', () => {
      this.filters[key] = input.value;
      if (typed) return;
      typed = requestAnimationFrame(() => {
        typed = 0;
        this.render();
      });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.stopPropagation();
        input.value = '';
        this.filters[key] = '';
        this.render();
      }
    });
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
      // Made here it opens, for playlists to be dragged in (4.5.4: only here).
      Groups.open(g.id);
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

  // ---- searching (4.5.3) ----

  _words(key) {
    return Util.queryWords(this.filters[key]);
  },

  /** Whether a playlist (or a group) is found by the words: its name, or its owner's. */
  _found(p, words) {
    return !words.length || Util.hasWords(Util.fold(`${p.name} ${p.ownerName || ''}`), words);
  },

  render() {
    // Not while a playlist is dragged onto a group (4.5.4): once it is dropped.
    if (Groups.holdWhileDragging('playlists', () => {
      if (Nav.page === 'playlists') this.render();
    })) return;
    // The lists' own scrolling, kept over the redraw.
    const scrolled = new Map([...document.querySelectorAll('#page-playlists .list-limit')].map((n) => [n.id || n.dataset.group, n.scrollTop]));

    // Your Playlists: all of them, also those in groups (4.5.3).
    const singles = Store.sortedPlaylists();
    const yours = this._words('yours');
    const lists = Util.sortRows(singles.filter((p) => this._found(p, yours)), this.sort, (p, k) => this._value(p, k));
    const fav = Store.favouritesPlaylist();
    const rows = [...(this._found(fav, yours) ? [fav] : []), ...lists];
    $('playlistsCount').textContent = Util.plural(singles.length, 'playlist');
    $('playlistsNoMatch').hidden = !yours.length || rows.length > 0;

    // Shared Playlists: All Songs always, the shared groups and the shared ones only while open.
    const open = Store.settings.sharedGroupOpen !== false;
    const sharedWords = this._words('shared');
    const sharedAll = Store.sharedPlaylists();
    const shared = Util.sortRows(sharedAll.filter((p) => this._found(p, sharedWords)), this.sort, (p, k) => this._value(p, k));
    const all = Store.allSongsPlaylist();
    const sharedRows = [...(this._found(all, sharedWords) ? [all] : []), ...(open ? [...this._sharedGroupRows(sharedWords), ...shared] : [])];
    $('sharedHead').className = `section-head__btn${open ? ' section-head__btn--open' : ''}`;
    $('sharedHead').setAttribute('aria-expanded', String(open));
    $('sharedHead').title = open ? T('playlists.shared.hide.tooltip') : T('playlists.shared.show.tooltip');
    // Its arrow and name are put in once: open or closed shows by its class.
    if (!$('sharedHead').firstChild) $('sharedHead').append(h('span.menu__chevron', { html: Icons.chevron }), h('span', T('playlists.shared.heading')));
    const groupCount = Store.sharedGroups().length;
    $('sharedCount').textContent = Store.canShare()
      ? [Util.plural(sharedAll.length, 'shared playlist'), groupCount ? Util.plural(groupCount, 'shared group') : ''].filter(Boolean).join(' · ') : '';
    // Searching the shared ones only while they show.
    $('sharedSearch').parentNode.hidden = !Store.canShare() || !open;
    $('sharedNoMatch').hidden = !sharedWords.length || sharedRows.length > 0;

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

    // At most 10 entries each, then the list scrolls in its box (4.5.3).
    const ROWS = 'tbody > tr, .mlist > .mrow';
    limitRows($('sharedBox'), ROWS);
    limitRows($('playlistsBox'), ROWS);
    for (const node of document.querySelectorAll('#groupsList .group__lists')) limitRows(node, ROWS);
    limitRows($('groupsList'), ':scope > .group');
    for (const node of document.querySelectorAll('#page-playlists .list-limit')) {
      const top = scrolled.get(node.id || node.dataset.group);
      if (top) node.scrollTop = top;
    }

    // The rename box as it comes: its row stays over later redraws (4.6), and
    // what is being typed in it is then left alone.
    const input = document.querySelector('#page-playlists .rename-input');
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  },

  /**
   * The groups others share (4.5.3), A to Z, each as a row, with its
   * playlists under it while open (by the table's sort). Searching: those
   * found by name, or by a playlist inside (then open, showing those found).
   */
  _sharedGroupRows(words) {
    const out = [];
    for (const g of Store.sharedGroups()) {
      const lists = Store.listsOfSharedGroup(g);
      const byName = this._found(g, words);
      const inside = byName ? lists : lists.filter((p) => this._found(p, words));
      if (!byName && !inside.length) continue;
      const open = Groups.isOpen(g.id) || (!byName && words.length > 0);
      out.push({
        isGroupRow: true, id: `sgroup:${g.id}`, name: g.name, group: g, lists, open,
      });
      if (!open) continue;
      for (const p of Util.sortRows(inside, this.sort, (x, k) => this._value(x, k))) {
        out.push({ ...p, rowKey: `sgroup:${g.id}:${p.id}`, inSharedGroup: g.id });
      }
    }
    return out;
  },

  /** A shared group's row opened or closed (the same as its folder in the menu, once followed). */
  _toggleSharedGroup(g) {
    Groups.toggle(g.id);
    this.render();
    Nav.drawMenu();
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

  /** On the computer each playlist's row can be dragged onto a group (4.5); `from`: the group whose table it is in. */
  _dragRows(table, from = '') {
    if (!Groups.canDrag()) return;
    for (const tr of table.querySelectorAll('tbody tr[data-id]')) Groups.draggable(tr, Store.playlist(tr.dataset.id), from);
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
    $('groupsSearchBox').hidden = !groups.length;
    $('groupedHideInMenu').checked = Store.settings.groupedHideInMenu !== false;
    const words = this._words('groups');
    // Each group's block stays in the page when it is drawn the same again
    // from the same data (4.6): only a group something changed in is put in anew.
    const box = $('groupsList');
    const was = new Map([...box.children].filter((n) => n._drawnAs !== undefined).map((n) => [n.dataset.group, n]));
    const blocks = [];
    let shown = 0;
    for (const g of groups) {
      const inside = Store.playlistsInGroup(g.id);
      // Searching (4.5.3): found by its name (all of it), or by playlists inside (those, opened).
      const byName = this._found(g, words);
      const found = byName ? inside : inside.filter((p) => this._found(p, words));
      if (!byName && !found.length) continue;
      shown += 1;
      const open = Groups.isOpen(g.id) || (!byName && words.length > 0);
      const { songs, seconds } = Groups.totals(g.id);
      const sub = [Util.plural(inside.length, 'playlist'), Util.plural(songs, 'song'), Util.fmtClock(seconds),
        g.shared && Store.canShareGroups() ? T('groups.sharedMark') : ''].filter(Boolean).join(' · ');
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
        if (found.length) {
          const lists = h('div.group__lists.list-limit', { dataset: { group: g.id } });
          const table = h('table.table.table--playlists', { id: `groupTable-${g.id}` });
          lists.appendChild(table);
          block.appendChild(lists);
          const sorted = Util.sortRows(found, this.sort, (p, k) => this._value(p, k));
          this._drawTable(table, sorted, (p) => this._actions(p), null, (p) => this._moreButtons(p), this._select());
          this._dragRows(table, g.id);
        } else {
          block.appendChild(h('p.muted-text.group__empty', T(Store.uiMode === 'mobile' ? 'groups.empty.phone' : 'groups.empty')));
        }
      }
      const html = block.outerHTML;
      const data = [g, found, open, inside.length, songs, seconds];
      const old = was.get(g.id);
      if (old && old._drawnAs === html && sameDeep(old._data, data)) {
        blocks.push(old);
        continue;
      }
      block._drawnAs = html;
      block._data = data;
      Groups.dropTarget(block, g.id);
      blocks.push(block);
    }
    setChildren(box, blocks, { alike: false });
    $('groupsNoMatch').hidden = !words.length || shown > 0 || !groups.length;
  },

  /** A group's Update all (its imported playlists), Add playlists, Share (4.5.3), Rename and Delete. */
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
    buttons.push(iconButton('act.act--green', Icons.plus, T('groups.add.tooltip', { group: g.name }), () => Groups.addTo(g)));
    if (Store.canShareGroups()) {
      const btn = iconButton('act' + (g.shared ? '.act--blue.act--on' : '.act--grey'), Icons.share,
        T(g.shared ? 'groups.share.on.tooltip' : 'groups.share.tooltip', { group: g.name }), () => Groups.setShared(g, !g.shared));
      btn.setAttribute('aria-pressed', String(!!g.shared));
      buttons.push(btn);
    }
    buttons.push(
      iconButton('act.act--grey', Icons.pencil, T('groups.rename.tooltip', { group: g.name }), () => Groups.rename(g)),
      iconButton('act.act--red', Icons.x, T('groups.delete.tooltip', { group: g.name }), () => Groups.remove(g)),
    );
    return buttons;
  },

  /** A shared group's row (4.5.3): its playlists' songs and length together. */
  _groupTotals(row) {
    let songs = 0;
    let seconds = 0;
    for (const p of row.lists) {
      songs += Store.songCount(p);
      seconds += Store.durationOf(p);
    }
    return { songs, seconds };
  },

  _drawTable(table, rows, actions, side = null, more = null, select = undefined) {
    const spec = listRowSpec((p) => [Util.plural(Store.songCount(p), 'song'), Util.fmtClock(Store.durationOf(p)),
      p.ownerName ? T('common.byOwner', { profile: p.ownerName }) : ''].filter(Boolean).join(' · '));
    // A shared group's row (4.5.3) and its playlists' under it.
    const isGroup = (p) => !!p.isGroupRow;
    renderTable(table, {
      rows,
      sort: this.sort,
      // A row stays when it is drawn the same again (4.6).
      drawn: true,
      rowKey: (p) => p.rowKey || p.id,
      rowClass: (p) => {
        if (isGroup(p)) return 'row--sgroup';
        if (p.inSharedGroup) return 'row--in-sgroup';
        return p.isAll || p.isFavourites ? 'row--pinned' : '';
      },
      onSort: (key) => {
        this.sort = Util.cycleSort(this.sort, key);
        this.render();
      },
      onRowDblClick: (p) => (isGroup(p) ? this._toggleSharedGroup(p.group) : Nav.openPlaylist(p.id)),
      columns: [
        { key: 'name', label: T('common.name'), cls: 'col-name', render: (p) => (isGroup(p) ? this._sharedGroupCell(p) : this._nameCell(p)) },
        { key: 'songs', label: T('common.songs'), cls: 'col-num', render: (p) => String(isGroup(p) ? this._groupTotals(p).songs : Store.songCount(p)) },
        { key: 'duration', label: T('common.duration'), cls: 'col-num', render: (p) => Util.fmtClock(isGroup(p) ? this._groupTotals(p).seconds : Store.durationOf(p)) },
        // Listen Duration: your own time listening to it, as the list playing.
        // Created: the lists the app keeps itself have no date.
        { key: 'listened', label: T('common.listenDuration'), cls: 'col-listened', render: (p) => (isGroup(p) ? '' : Util.fmtClock(Store.listenedTo(p.id))) },
        { key: 'created', label: T('common.created'), cls: 'col-date', render: (p) => (p.createdAt && !p.isFavourites ? Util.fmtDate(p.createdAt) : '') },
        { key: 'actions', label: T('common.actions'), sortable: false, cls: 'col-actions', render: actions },
      ],
      mobile: {
        ...spec,
        lead: (p) => {
          if (isGroup(p)) return this._sharedGroupLead(p);
          // Inside a shared group: its followed icon there (4.5.3).
          return p.inSharedGroup ? h('span.mrow__icon', { html: listIcon(p, p.inSharedGroup) }) : spec.lead(p);
        },
        sub: (p) => (isGroup(p)
          ? [Util.plural(p.lists.length, 'playlist'), T('common.byOwner', { profile: p.group.ownerName })].join(' · ') : spec.sub(p)),
        tap: (p) => (isGroup(p) ? this._toggleSharedGroup(p.group) : spec.tap(p)),
        side,
        more: more && ((p) => more(p)),
        select,
      },
    });
  },

  /** A shared group's name (4.5.3): its arrow and its name open and close it; whose it is. */
  _sharedGroupCell(row) {
    const g = row.group;
    const title = row.open ? T('groups.hide.tooltip', { group: g.name }) : T('groups.show.tooltip', { group: g.name });
    const toggle = () => this._toggleSharedGroup(g);
    return h('div.sgroup',
      h('button.sgroup__toggle', {
        type: 'button', title, 'aria-label': title, 'aria-expanded': String(row.open), onclick: toggle,
      }, h('span.menu__chevron' + (row.open ? '.menu__chevron--open' : ''), { html: Icons.chevron })),
      h('button.link-cell.sgroup__name', { type: 'button', title, onclick: toggle },
        h('span.link-cell__icon', { html: Store.isFollowingGroup(g.id) ? Icons.folderFollowed : Icons.folder }),
        h('span.link-cell__name', g.name),
        h('span.link-cell__by', T('common.byOwner', { profile: g.ownerName }))));
  },

  /** On the phone a shared group's row starts with its arrow and folder (4.5.3). */
  _sharedGroupLead(row) {
    return h('span.mrow__icon.sgroup__lead',
      h('span.menu__chevron' + (row.open ? '.menu__chevron--open' : ''), { html: Icons.chevron }),
      h('span', { html: Store.isFollowingGroup(row.group.id) ? Icons.folderFollowed : Icons.folder }));
  },

  _nameCell(p) {
    if (this.renaming === p.id) {
      // Its Escape is its own (4.5.4): the window's blurred it first, and a blur saves.
      const input = h('input.input.rename-input', {
        type: 'text', value: p.name, maxLength: 80, 'data-own-escape': true,
      });
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
      h('span.link-cell__icon', { html: listIcon(p, p.inSharedGroup) }),
      h('span.link-cell__name', p.name),
      p.ownerName ? h('span.link-cell__by', T('common.byOwner', { profile: p.ownerName })) : null);
  },

  /**
   * A shared playlist can only be changed by whoever shared it, so its Actions
   * are Follow and Unfollow, and (4.5.1) Move to group, which follows one
   * not followed yet. All Songs has none; a shared group (4.5.3) has Follow
   * Group or Unfollow Group; a playlist of yours inside one, none.
   */
  _sharedActions(p) {
    if (p.isAll || (p.inSharedGroup && !p.isShared)) return h('span.muted', '');
    if (p.isGroupRow) return h('div.actions', this._followGroupButton(p.group));
    return h('div.actions', this._followButton(p), this._sharedGroupButton(p));
  },

  /**
   * Inside a group you follow (4.5.3) a playlist's Follow and Unfollow are
   * that group's: unfollowed there it leaves only that group (the same one
   * in another group you follow stays). Followed by itself (its row below, or
   * outside a group you follow) it is under Followed Playlists.
   */
  _inFollowedGroup(p) {
    return !!p.inSharedGroup && Store.isFollowingGroup(p.inSharedGroup);
  },

  _followButton(p) {
    if (this._inFollowedGroup(p)) return this._followInGroupButton(p);
    const on = Store.isFollowing(p.id);
    return h('button.btn.btn--small' + (on ? '' : '.btn--primary'), {
      type: 'button',
      title: on ? T('common.unfollow.tooltip', { playlist: p.name }) : T('playlists.follow.tooltip', { playlist: p.name }),
      onclick: () => attempt(() => window.flow.setFollowing(p.id, !on)),
    }, on ? T('common.unfollow') : T('common.follow'));
  },

  /** A playlist's Follow or Unfollow inside a group you follow (4.5.3): for that group only. */
  _followInGroupButton(p) {
    const g = Store.sharedGroups().find((x) => x.id === p.inSharedGroup);
    const on = Store.isFollowingInGroup(p.inSharedGroup, p.id);
    const group = g ? g.name : '';
    return h('button.btn.btn--small' + (on ? '' : '.btn--primary'), {
      type: 'button',
      title: on ? T('groups.inGroup.unfollow.tooltip', { playlist: p.name, group }) : T('groups.inGroup.follow.tooltip', { playlist: p.name, group }),
      onclick: () => Groups.setFollowingIn(p.inSharedGroup, p, !on),
    }, on ? T('common.unfollow') : T('common.follow'));
  },

  /** Follow Group or Unfollow Group (4.5.3), for a group another profile shares. */
  _followGroupButton(g) {
    const on = Store.isFollowingGroup(g.id);
    return h('button.btn.btn--small' + (on ? '' : '.btn--primary'), {
      type: 'button',
      title: on ? T('groups.unfollow.tooltip', { group: g.name }) : T('groups.follow.tooltip', { group: g.name, profile: g.ownerName }),
      onclick: () => Groups.setFollowing(g, !on),
    }, on ? T('groups.unfollow') : T('groups.follow'));
  },

  /** A shared playlist's Move to group (4.5.1), where the server keeps followed ones in groups. */
  _sharedGroupButton(p) {
    if (!Store.canGroupFollowed()) return null;
    return iconButton('act.act--grey', Icons.folder, T('groups.moveTo'), () => Groups.chooseFor([p.id]));
  },

  /** The phone's sheet of a shared playlist: Follow or Unfollow, and Move to group (4.5.1); of a shared group, Follow Group (4.5.3). */
  _sharedMore(p) {
    if (p.isAll || (p.inSharedGroup && !p.isShared)) return null;
    if (p.isGroupRow) {
      const g = p.group;
      const on = Store.isFollowingGroup(g.id);
      return [{
        icon: on ? Icons.x : Icons.plus, label: on ? T('groups.unfollow') : T('groups.follow'), kind: on ? 'danger' : '', onClick: () => Groups.setFollowing(g, !on),
      }];
    }
    if (this._inFollowedGroup(p)) {
      const in_ = Store.isFollowingInGroup(p.inSharedGroup, p.id);
      return [{
        icon: in_ ? Icons.x : Icons.plus, label: in_ ? T('common.unfollow') : T('common.follow'), kind: in_ ? 'danger' : '', onClick: () => Groups.setFollowingIn(p.inSharedGroup, p, !in_),
      }];
    }
    const on = Store.isFollowing(p.id);
    return [
      { icon: on ? Icons.x : Icons.plus, label: on ? T('common.unfollow') : T('common.follow'), kind: on ? 'danger' : '', onClick: () => attempt(() => window.flow.setFollowing(p.id, !on)) },
      this._sharedGroupButton(p),
    ];
  },

  _actions(p) {
    if (p.isFavourites) return h('span.muted', '');
    // A followed playlist in a group (4.5.1): Move to group and Unfollow.
    if (p.isShared) return h('div.actions', this._sharedGroupButton(p), this._followButton(p));
    return h('div.actions', ...this._moreButtons(p));
  },


  /** Add Songs, Rename and Delete; on the phone in a sheet, where Rename asks in a dialog. */
  _moreButtons(p) {
    if (p.isFavourites) return null;
    if (p.isShared) {
      return [this._sharedGroupButton(p),
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
      iconButton('act.act--red', Icons.x, T('playlists.delete.tooltip'), () => this.remove(p)),
    ];
  },

  async renameDialog(p) {
    const name = await promptDialog({ title: T('common.renamePlaylist'), value: p.name, confirmLabel: T('playlists.rename'), maxLength: 80 });
    if (name === null || name.trim() === p.name) return;
    attempt(() => window.flow.renamePlaylist(p.id, name));
  },

  /** The phone's Follow / Unfollow at the end of a shared playlist's row (Follow Group for a shared group's, 4.5.3). */
  _sharedSide(p) {
    if (p.isAll || (p.inSharedGroup && !p.isShared)) return h('span');
    if (p.isGroupRow) return this._followGroupButton(p.group);
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
