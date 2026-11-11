'use strict';

// Playlist groups (4.5): folders of playlists, in the menu as Playlist Groups
// between Playlists and Followed Playlists (4.5.1) and on the Playlists page
// below Your Playlists. Since 4.5.3 a playlist can be in several groups (it
// stays in Your Playlists too); deleting a group leaves its playlists in
// their other groups, or single. Each profile has its own (with a Flow Server
// that keeps them, Store.canGroup). Playlists you follow can go into them
// too (4.5.1, Store.canGroupFollowed): your groups hold them for you, the
// playlists stay their owners'. A shared playlist not followed yet that is
// put into a group is followed with it.
//
// Here: making, renaming and deleting a group, "Move to group" (a playlist's
// own, or several chosen at once on the phone), "Add playlists" into a group,
// a group's Update all, which groups are open (the menu and the page share
// it, per device), and dragging: on the computer and in the web player a
// playlist is dragged from the menu or the Playlists page onto a group, or
// back onto the single playlists. The phone has no dragging (a long press
// already chooses rows there), only Move to group.
//
// 4.5.3: a group of yours can be shared (its playlists with it), and one
// another profile shares can be followed; a playlist inside a group you
// follow can be unfollowed there, for that group only.

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

  /** Its imported playlists of your own: the ones Update all reads again (a followed one is its owner's). */
  updatable(id) {
    return Store.playlistsInGroup(id).filter((p) => !p.isShared && p.source && /^https?:\/\//i.test(p.source.url || '') && !p.isRuled);
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
    if (playlistIds.length) await window.flow.addToGroup(playlistIds, g.id);
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

  // ---- sharing and following (4.5.3) ----

  /**
   * Shares a group of yours with the other profiles, its playlists with it
   * (and each put into it later), or no longer: then its playlists stay
   * shared, each can be stopped on its own page.
   */
  async setShared(g, on) {
    const own = Store.playlistsInGroup(g.id).filter((p) => !p.isShared);
    const newly = on ? own.filter((p) => !p.shared && !p.isRuled).length : 0;
    await attempt(async () => {
      await window.flow.setGroupShared(g.id, on);
      let text;
      if (!on) text = own.some((p) => p.shared) ? T('groups.unshared.listsStay', { group: g.name }) : T('groups.unshared', { group: g.name });
      else text = newly ? T('groups.shared.withLists', { group: g.name, playlists: Util.plural(newly, 'playlist'), count: newly }) : T('groups.shared', { group: g.name });
      toast(text, 'success');
    });
  },

  /** Follows a group another profile shares, or no longer. */
  async setFollowing(g, on) {
    await attempt(async () => {
      await window.flow.setGroupFollowing(g.id, on);
      toast(T(on ? 'groups.followed' : 'groups.unfollowed', { group: g.name, profile: g.ownerName }), 'success');
    });
  },

  /**
   * A playlist followed or not inside a group you follow (4.5.3): for that
   * group only (followed by itself, or in another group, it stays).
   */
  async setFollowingIn(groupId, p, on) {
    const g = Store.sharedGroups().find((x) => x.id === groupId);
    await attempt(async () => {
      await window.flow.setGroupPlaylistFollowed(groupId, p.id, on);
      toast(T(on ? 'groups.inGroup.followed' : 'groups.inGroup.unfollowed', { playlist: p.name, group: g ? g.name : '' }), 'success');
    });
  },

  // ---- putting playlists into groups (several at once, 4.5.3) ----

  /** The groups of yours a playlist is in (4.5.3: several). */
  groupsOf(p) {
    return Store.groupsOf(p);
  },

  /**
   * Puts playlists into one more group, keeping their other groups, and says
   * so (`made`: a group just made, maybe not listed yet). A shared one not
   * followed yet is followed first (4.5.1).
   */
  async add(playlistIds, groupId, made = null) {
    const ids = playlistIds.filter((id) => {
      const p = Store.playlist(id);
      return Store.canBeGrouped(p) && !(p.groups || []).includes(groupId);
    });
    if (!ids.length) return;
    await attempt(async () => {
      const toFollow = ids.filter((id) => Store.playlist(id).isShared && !Store.isFollowing(id));
      for (const id of toFollow) await window.flow.setFollowing(id, true);
      await window.flow.addToGroup(ids, groupId);
      const g = Store.group(groupId) || made;
      if (g) this.open(g.id);
      const one = ids.length === 1 ? Store.playlist(ids[0]) : null;
      const name = g ? g.name : '';
      let text;
      if (one && toFollow.length) text = T('groups.followedMoved', { playlist: one.name, group: name });
      else text = one ? T('groups.moved', { playlist: one.name, group: name }) : T('groups.movedMany', { playlists: Util.plural(ids.length, 'playlist'), group: name });
      toast(text, 'success');
    });
  },

  /** Takes playlists out of one of their groups; their other groups keep them. */
  async removeFrom(playlistIds, groupId) {
    const ids = playlistIds.filter((id) => {
      const p = Store.playlist(id);
      return p && (p.groups || []).includes(groupId);
    });
    if (!ids.length) return;
    await attempt(async () => {
      await window.flow.removeFromGroup(ids, groupId);
      const g = Store.group(groupId);
      const one = ids.length === 1 ? Store.playlist(ids[0]) : null;
      const name = g ? g.name : '';
      toast(one ? T('groups.movedOut', { playlist: one.name, group: name })
        : T('groups.movedOutMany', { playlists: Util.plural(ids.length, 'playlist'), group: name }), 'success');
    });
  },

  /**
   * "Add to group": every group with a tick, ticked for those the playlists
   * are all in (half for some of them); Done puts them into the groups
   * ticked and out of those unticked. A new group by name is made and
   * ticked at once.
   */
  chooseFor(playlistIds) {
    const lists = playlistIds.map((id) => Store.playlist(id)).filter((p) => Store.canBeGrouped(p));
    if (!lists.length) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const rows = new Map(); // group id -> { box, was }
      const list = h('div.group-pick__list');
      const row = (g) => {
        const inside = lists.filter((p) => (p.groups || []).includes(g.id)).length;
        const was = inside === lists.length ? true : inside ? null : false;
        const box = h('input', { type: 'checkbox', checked: was === true });
        box.indeterminate = was === null;
        rows.set(g.id, { box, was, g });
        return h('label.group-pick__row.check', box,
          h('span.group-pick__icon', { html: Icons.folder }), h('span.group-pick__name', g.name),
          h('span.group-pick__count', Util.plural(Store.playlistsInGroup(g.id).length, 'playlist')));
      };
      for (const g of Store.groups()) list.appendChild(row(g));
      const none = h('p.muted-text', T('groups.pick.noGroups'));
      none.hidden = rows.size > 0;
      const input = h('input.input', { type: 'text', maxLength: 80, placeholder: T('groups.pick.newName'), autocomplete: 'off' });
      const error = h('div.form-error');
      const makeNew = async () => {
        try {
          const g = await this.create(input.value, []);
          if (!g) return;
          input.value = '';
          const node = row(g);
          rows.get(g.id).box.checked = true;
          list.appendChild(node);
          none.hidden = true;
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
      const apply = async () => {
        done = true;
        handle.close();
        const ids = lists.map((p) => p.id);
        for (const { box, was, g } of rows.values()) {
          if (box.indeterminate) continue;
          if (box.checked && was !== true) await this.add(ids, g.id, g);
          else if (!box.checked && was !== false) await this.removeFrom(ids, g.id);
        }
        resolve(true);
      };
      const handle = Modal.open({
        title: lists.length === 1 ? T('groups.pick.title', { playlist: lists[0].name }) : T('groups.pick.titleMany', { playlists: Util.plural(lists.length, 'playlist') }),
        className: 'modal--group-pick',
        body: [
          list,
          none,
          h('div.group-pick__new', input, h('button.btn', { type: 'button', onclick: makeNew }, T('groups.pick.create'))),
          error,
        ],
        buttons: [{ label: T('common.cancel') }],
        onClose: () => {
          if (!done) resolve(false);
        },
      });
      const ok = h('button.btn.btn--primary.group-pick__done', { type: 'button', onclick: apply }, T('groups.pick.done'));
      handle.el.querySelector('.modal__footer').appendChild(ok);
    });
  },

  /** "Add playlists" of a group: every playlist not in it (followed ones too, 4.5.1), ticked ones go in. */
  addTo(g) {
    const followed = Store.canGroupFollowed() ? Store.followedPlaylists() : [];
    const lists = [...Store.sortedPlaylists(), ...followed].filter((p) => !(p.groups || []).includes(g.id));
    if (!lists.length) {
      toast(T('groups.add.none', { group: g.name }), 'info');
      return;
    }
    const boxes = lists.map((p) => {
      const box = h('input', { type: 'checkbox' });
      const from = Store.groupsOf(p).map((x) => x.name).join(', ');
      return {
        p,
        box,
        row: h('label.check.group-add__row', box,
          h('span.group-add__icon', { html: listIcon(p) }),
          h('span.group-add__name', p.name),
          p.isShared && p.ownerName ? h('span.group-add__from', T('common.byOwner', { profile: p.ownerName })) : null,
          from ? h('span.group-add__from', T('groups.add.inGroup', { group: from })) : null),
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
      this.add(ids, g.id);
    };
    handle.el.querySelector('.modal__footer').appendChild(go);
  },

  // ---- dragging (the computer and the web player; not the phone) ----

  canDrag() {
    return !document.body.classList.contains('mobile') && Store.canGroup() && Store.groups().length > 0;
  },

  /**
   * Lets a playlist's row or menu entry be dragged onto a group (into it as
   * well, 4.5.3: its other groups keep it). `from`: the group it is dragged
   * out of ('' for a place in no group); dropped where no group is, it leaves that one.
   */
  draggable(el, p, from = '') {
    if (!Store.canBeGrouped(p) || !this.canDrag()) return;
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      this.dragging = { id: p.id, from, groups: [...(p.groups || [])] };
      e.dataTransfer.effectAllowed = 'copyMove';
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
   * A place a dragged playlist can be dropped: into group `groupId` (one it
   * is not in yet), or '' out of the group it was dragged from. The
   * innermost place under the pointer takes it.
   */
  dropTarget(el, groupId) {
    const wants = () => {
      const d = this.dragging;
      if (!d) return false;
      return groupId ? !d.groups.includes(groupId) : !!d.from;
    };
    el.addEventListener('dragover', (e) => {
      if (!this.dragging) return;
      e.stopPropagation();
      if (!wants()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = groupId ? 'copy' : 'move';
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
      const { id, from } = this.dragging;
      const ok = wants();
      this._endDrag();
      if (!ok) return;
      if (groupId) this.add([id], groupId);
      else this.removeFrom([id], from);
    });
  },
};
