'use strict';

// Collaborative playlists (5.4.0, a Flow Server's; core libraryModel.js and
// profiles.js keep them). The owner of a shared playlist turns its
// collaboration on in its head ("Collaboration Playlist", green when on);
// beside it a button shows how many are in it, the owner counted, and the
// requests waiting ("1 (+1)"). That button opens the pop-up: the requests
// with Approve and Decline, then everyone in it with the songs they added and
// removed, and (the owner's) Remove. The others ask on the Playlists page
// (Request Collab: white, amber while asked, green once in); once approved a
// playlist is followed and its songs are theirs to add and remove too, its
// name, sharing and collaboration stay the owner's. A member leaves with Exit
// collaboration in the playlist's head. On the phone the head's are icons in
// the playlist's row of buttons. The icon is images/collab.png, coloured by
// its button (Icons.collab).

const Collab = {
  // The pop-up while it is open: { handle, id, draw }.
  popup: null,

  /** The owner's own shared playlist, which can be (or is) a collaboration: its collab, or null. */
  ownOf(p) {
    if (!p || p.isShared || !p.shared || p.favourites || p.isRuled || !Store.canCollab()) return null;
    return p.collab || { on: false, members: [], requests: [], counts: {} };
  },

  /** Whether a playlist (own or another's) is a collaboration now: its songs say who added them. */
  isOn(p) {
    if (!p || !Store.canCollab()) return false;
    if (p.isShared) return !!(p.collab && p.collab.on);
    return !!(p.shared && p.collab && p.collab.on);
  },

  /** Who owns a playlist: another's owner, or this profile. */
  ownerId(p) {
    return p.isShared ? p.ownerId : Store.uploaderId();
  },

  /** A profile's name as shown here. */
  nameOf(id) {
    return Store.profileName(id) || T('collab.unknown');
  },

  /** Who put a row's song into a collaborative playlist: a name, or '' for none to show. */
  addedBy(p, row) {
    if (!this.isOn(p)) return '';
    return this.nameOf(row.addedBy || this.ownerId(p));
  },

  /**
   * Everyone in a collaboration: [{ id, added, removed, owner }], the owner
   * first. The owner's own playlist knows them by id; a member gets them with
   * their counts from the server.
   */
  people(p) {
    if (!p.isShared) {
      const c = this.ownOf(p);
      if (!c) return [];
      const count = (id) => ({ id, added: (c.counts[id] || {}).added || 0, removed: (c.counts[id] || {}).removed || 0 });
      return [{ ...count(this.ownerId(p)), owner: true }, ...c.members.map(count)];
    }
    const list = (p.collab && p.collab.members) || [];
    return list.map((m, i) => ({ ...m, owner: i === 0 }));
  },

  // ---- the playlist's head ----

  /**
   * The head's collaboration buttons, for the playlist shown: the owner's
   * switch and count; a member's count and Exit collaboration. None for
   * anything else.
   */
  drawHead(p) {
    const box = $('plCollabBox');
    const toggle = $('plCollab');
    const count = $('plCollabCount');
    const exit = $('plCollabExit');
    const own = this.ownOf(p);
    const member = !!(p && p.isShared && p.canEdit);
    const mobile = Store.uiMode === 'mobile';
    toggle.hidden = !own;
    count.hidden = !(own && own.on) && !member;
    exit.hidden = !member;
    if (box) box.hidden = toggle.hidden && count.hidden && exit.hidden;
    if (own) {
      const on = !!own.on;
      toggle.classList.toggle('toggle--on', on);
      toggle.setAttribute('aria-pressed', String(on));
      toggle.title = T(on ? 'collab.toggle.on.tooltip' : 'collab.toggle.off.tooltip');
      toggle.setAttribute('aria-label', T('collab.toggle'));
      setHtml(toggle, mobile ? Icons.collab : `<span class="toggle__box">${on ? Icons.check : ''}</span>${Icons.collab}<span>${T('collab.toggle')}</span>`);
    }
    if (!count.hidden) {
      const people = this.people(p).length;
      const asking = own ? own.requests.length : 0;
      setHtml(count, `${Icons.collab}<span class="collab-count__n">${people}</span>${asking ? `<span class="collab-count__asking">(+${asking})</span>` : ''}`);
      count.title = own
        ? T('collab.count.tooltip', { people: Util.plural(people, 'collaborator'), requests: Util.plural(asking, 'request') })
        : T('collab.count.member.tooltip', { people: Util.plural(people, 'collaborator') });
      count.setAttribute('aria-label', count.title);
      count.classList.toggle('collab-count--asking', asking > 0);
    }
    if (member) {
      exit.title = T('collab.exit.tooltip');
      exit.setAttribute('aria-label', T('collab.exit'));
      setHtml(exit, mobile ? Icons.collab : `${Icons.collab}<span>${T('collab.exit')}</span>`);
    }
    if (this.popup && p && this.popup.id === p.id) this.popup.draw();
  },

  /** The owner's switch: on (it must be shared) or off; the phone's icon asks first, as Share does there. */
  async toggle(p) {
    const own = this.ownOf(p);
    if (!own) return;
    const on = !own.on;
    if (Store.uiMode === 'mobile') {
      const ok = await confirmDialog(on ? {
        title: T('collab.toggle'),
        message: T('collab.on.text', { playlist: p.name }),
        confirmLabel: T('common.confirm'),
      } : {
        title: T('collab.off.title'),
        message: T('collab.off.text', { playlist: p.name }),
        confirmLabel: T('common.confirm'),
      });
      if (!ok) return;
    }
    attempt(() => window.flow.setPlaylistCollab(p.id, on));
  },

  /** A member leaves (asked first: only the owner can let it back in). */
  async exit(p) {
    const ok = await confirmDialog({
      title: T('collab.exit'),
      message: T('collab.exit.text', { playlist: p.name, profile: p.ownerName }),
      confirmLabel: T('collab.exit.confirm'),
      danger: true,
    });
    if (!ok) return;
    attempt(async () => {
      await window.flow.leaveCollab(p.id);
      toast(T('collab.exit.done', { playlist: p.name }), 'success');
    });
  },

  // ---- the pop-up ----

  /** Who asks and who is in it: the owner answers and removes, a member only looks. */
  open(p) {
    if (!p) return;
    const id = p.id;
    const body = h('div.collab');
    const draw = () => {
      const now = Store.playlist(id);
      clear(body);
      if (!now) return;
      const own = this.ownOf(now);
      if (own) {
        body.appendChild(h('h3.collab__head', T('collab.requests')));
        if (!own.requests.length) body.appendChild(h('div.collab__empty', T('collab.requests.none')));
        for (const who of own.requests) {
          body.appendChild(h('div.collab__row.collab__row--ask',
            h('span.collab__name', this.nameOf(who)),
            h('span.collab__acts',
              iconButton('act.act--green', Icons.check, T('collab.approve'), () => attempt(() => window.flow.answerCollab(id, who, true))),
              iconButton('act.act--red', Icons.x, T('collab.decline'), () => attempt(() => window.flow.answerCollab(id, who, false))))));
        }
      }
      body.appendChild(h('h3.collab__head', T('collab.people')));
      body.appendChild(h('div.collab__row.collab__row--labels',
        h('span.collab__name', ''),
        h('span.collab__num', T('collab.added')),
        h('span.collab__num', T('collab.removed')),
        own ? h('span.collab__acts', '') : null));
      for (const m of this.people(now)) {
        body.appendChild(h('div.collab__row',
          h('span.collab__name', this.nameOf(m.id), m.owner ? h('span.collab__tag', T('collab.owner')) : null),
          h('span.collab__num', String(m.added)),
          h('span.collab__num', String(m.removed)),
          own ? h('span.collab__acts', m.owner ? null
            : iconButton('act.act--red', Icons.x, T('collab.remove'), () => attempt(() => window.flow.removeCollaborator(id, m.id)))) : null));
      }
    };
    draw();
    if (this.popup) this.popup.handle.close();
    const listener = () => {
      if (this.popup && this.popup.id === id) draw();
    };
    Store.onLibrary(listener);
    const handle = Modal.open({
      title: T('collab.title', { playlist: p.name }),
      body: [body],
      className: 'modal--collab',
      sheet: Store.uiMode === 'mobile',
      onClose: () => {
        Store._listeners = Store._listeners.filter((f) => f !== listener);
        if (this.popup && this.popup.handle === handle) this.popup = null;
      },
    });
    this.popup = { handle, id, draw };
  },

  // ---- the Playlists page ----

  /** A shared playlist's Request Collab: white to ask, amber while asked (again: taken back), green once in. Null when it is no collaboration. */
  requestButton(p) {
    if (!p || !p.isShared || !Store.canCollab() || !p.collab || !p.collab.on) return null;
    const me = p.collab.me;
    const cls = me === 'member' ? '.act--collab-member' : me === 'requested' ? '.act--collab-asked' : '.act--collab';
    const label = me === 'member' ? T('collab.request.member') : me === 'requested' ? T('collab.request.asked') : T('collab.request');
    return iconButton(`act${cls}`, Icons.collab, label, () => this.request(p));
  },

  /** The phone's sheet line of the same. */
  sheetItem(p) {
    if (!p || !p.isShared || !Store.canCollab() || !p.collab || !p.collab.on) return null;
    const me = p.collab.me;
    const label = me === 'member' ? T('collab.people') : me === 'requested' ? T('collab.request.withdraw') : T('collab.request');
    return { icon: Icons.collab, label, onClick: () => this.request(p) };
  },

  /** Asks, takes the request back, or (a member) shows who is in it. */
  request(p) {
    const me = p.collab && p.collab.me;
    if (me === 'member') {
      this.open(Store.playlist(p.id) || p);
      return;
    }
    attempt(async () => {
      await window.flow.requestCollab(p.id, me !== 'requested');
      toast(me === 'requested' ? T('collab.request.withdrawn', { playlist: p.name }) : T('collab.request.sent', { playlist: p.name, profile: p.ownerName }), 'success');
    });
  },
};
