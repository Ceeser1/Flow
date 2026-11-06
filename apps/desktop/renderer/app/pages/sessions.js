'use strict';

// Active Sessions: what the devices on this Flow Server play right now, each
// a session that can be joined (with its host's OK). A main entry in the
// menu, there only while another device plays or this one has company. The
// session state itself lives in Session (session.js). Below them, "Nearby,
// on other servers": the sessions of other Flow Servers on this network that
// take guests (4.0), each joined as a guest, with that server's songs to
// queue and play along with while in.

// Other servers' sessions are looked for again this often while the page shows.
const NEARBY_PAGE_MS = 15000;

const SessionsPage = {
  sort: { key: null, dir: null },
  _ticker: null,

  init() {
    Session.onChange(() => {
      if (Nav.page === 'sessions') this.render();
    });
  },

  /**
   * opts.sessionId (a session chosen in the menu): its row is brought into
   * view and lit for 2 s (kept through the redraws meanwhile).
   */
  show(opts = {}) {
    clearTimeout(this._litTimer);
    Session.lookNearby();
    clearInterval(this._nearbyTimer);
    this._nearbyTimer = setInterval(() => {
      if (Nav.page !== 'sessions') {
        clearInterval(this._nearbyTimer);
        return;
      }
      Session.lookNearby();
    }, NEARBY_PAGE_MS);
    this._lit = opts.sessionId || null;
    this.render();
    if (!this._lit) return;
    const row = [...document.querySelectorAll('#page-sessions [data-id]')]
      .find((node) => node.dataset.id === this._lit && node.offsetParent);
    if (row) row.scrollIntoView({ block: 'nearest' });
    this._litTimer = setTimeout(() => {
      this._lit = null;
      if (Nav.page === 'sessions') this.render();
    }, 2000);
  },

  _value(s, key) {
    if (key === 'name') return s.name;
    if (key === 'song') return s.song ? s.song.title : '';
    if (key === 'listeners') return s.listeners;
    return '';
  },

  _isOwn(s) {
    return s.host.client === Store.server.clientId;
  },

  /** "Title - Artist", with "Paused: " in front while it is. */
  _songText(s) {
    const vars = { title: s.song.title, artist: s.song.artist };
    if (!s.song.artist) return s.playing ? s.song.title : `${T('common.paused')} ${s.song.title}`;
    return s.playing ? `${s.song.title} - ${s.song.artist}` : T('sessions.song.pausedWithArtist', vars);
  },

  /** Who listens, for the Listeners cell's tooltip. */
  _listeners(s) {
    return s.members.slice(1).map((m) => Session._who(m)).join('\n');
  },

  render() {
    // An answer that never came (the stream was down when it ran out).
    if (Session.request && Date.now() > Session.request.expiresAt + 3000) Session.request = null;
    const rows = Session.available ? Session.list : [];
    $('sessionsCount').textContent = Util.plural(rows.length, 'session');
    this._drawMine();
    $('sessionsEmpty').hidden = rows.length > 0;
    $('sessionsEmpty').textContent = Session.available
      ? T('sessions.page.noneOnServer')
      : T('sessions.page.needsServer');
    $('sessionsTable').hidden = !rows.length;
    renderTable($('sessionsTable'), {
      rows: Util.sortRows(rows, this.sort, (s, k) => this._value(s, k)),
      sort: this.sort,
      rowKey: (s) => s.id,
      rowClass: (s) => [
        Session.mine && Session.mine.session.id === s.id ? 'row--current' : '',
        this._lit === s.id ? 'row--lit' : '',
      ].filter(Boolean).join(' '),
      onSort: (key) => {
        this.sort = Util.cycleSort(this.sort, key);
        this.render();
      },
      columns: [
        {
          key: 'name',
          label: T('sessions.column.name'),
          cls: 'col-name',
          render: (s) => h('span.session-name',
            h('span.link-cell__icon', { html: Icons.sessions }),
            h('span.link-cell__name', s.name),
            this._isOwn(s) ? h('span.session-tag', T('common.you')) : null),
        },
        {
          key: 'song',
          label: T('common.song'),
          cls: 'col-song',
          render: (s) => (s.song
            ? h('span.session-song',
              s.playing ? h('span.menu__playing', { html: Icons.speaker, title: T('common.playing') }) : h('span.muted-text', `${T('common.paused')} `),
              Covers.el(Store.song(s.song.id) || s.song),
              h('span.cell-title', s.song.title),
              s.song.artist ? h('span.muted-text', ` - ${s.song.artist}`) : null)
            : h('span.muted-text', T('common.nothingLoaded'))),
        },
        {
          key: 'listeners',
          label: T('sessions.column.listeners'),
          cls: 'col-num',
          render: (s) => h('span', { title: this._listeners(s) || T('sessions.listeners.nobody') }, String(s.listeners)),
        },
        {
          key: 'actions',
          label: T('common.actions'),
          sortable: false,
          cls: 'col-actions',
          render: (s) => h('div.actions', ...this._actions(s)),
        },
      ],
      mobile: {
        lead: () => h('span.mrow__icon', { html: Icons.sessions }),
        title: (s) => (this._isOwn(s) ? T('sessions.nameYou', { session: s.name }) : s.name),
        sub: (s) => [
          s.song ? this._songText(s) : T('common.nothingLoaded'),
          Util.plural(s.listeners, 'listener'),
        ].join(' · '),
        side: (s) => (this._isOwn(s) ? h('span') : h('div.actions.mrow__side', ...this._actions(s))),
      },
    });
    this._drawNearby();
    this._tick();
  },

  /** The sessions of other servers on this network, one block for each server. */
  _drawNearby() {
    const box = clear($('sessionsNearby'));
    const servers = Store.can('guests') ? Session.nearby.filter((n) => n.sessions.length || (Session.guest && Session.guest.serverId === n.id)) : [];
    box.hidden = !servers.length;
    if (!servers.length) return;
    box.append(h('div.section-head', h('h2.section-head__title', T('sessions.nearby.heading'))),
      h('p.muted-text', T('sessions.nearby.desc')));
    for (const n of servers) {
      const list = h('div.nearby__list');
      for (const s of n.sessions) {
        list.appendChild(h('div.nearby__row' + (this._lit === s.id ? '.row--lit' : ''), { dataset: { id: s.id } },
          h('span.nearby__icon', { html: Icons.sessions }),
          h('span.nearby__text',
            h('span.nearby__name', s.name),
            h('span.nearby__song.muted-text', s.song ? this._songText(s) : T('common.nothingLoaded'))),
          h('div.actions', ...this._nearbyActions(s, n))));
      }
      if (!n.sessions.length) list.appendChild(h('div.muted-text', T('sessions.nearby.nothingPlays')));
      const joined = Session.guest && Session.guest.serverId === n.id && Session.mine;
      box.append(h('div.nearby__server',
        h('div.nearby__head', h('span', T('sessions.nearby.onServer', { server: n.name })),
          joined && Store.foreign.size ? h('button.btn.btn--small', { type: 'button', onclick: () => Nav.openPlaylist(GUEST_ID) }, T('common.songsOn', { server: n.name })) : null),
        list));
    }
  },

  _nearbyActions(s, n) {
    const here = Session.guest && Session.guest.serverId === n.id;
    if (here && Session.mine && Session.mine.session.id === s.id) {
      return [
        h('span.session-joined', { html: `${Icons.check}<span>${T('common.joined')}</span>` }),
        h('button.btn.btn--small', { type: 'button', onclick: () => attempt(() => Session.leave()) }, T('common.leave')),
      ];
    }
    const req = Session.request;
    if (req && req.sessionId === s.id) {
      const left = Math.max(0, Math.ceil((req.expiresAt - Date.now()) / 1000));
      return [
        h('span.muted-text', { title: T('sessions.join.waiting.tooltip') }, T('sessions.join.waiting', { seconds: left })),
        h('button.btn.btn--small', { type: 'button', onclick: () => attempt(() => Session.cancelJoin()) }, T('common.cancel')),
      ];
    }
    const wait = Session.cooldownLeft(s.id);
    if (wait) return [h('button.btn.btn--small', { type: 'button', disabled: true, title: T('sessions.join.declined.tooltip') }, T('sessions.join.askAgain', { seconds: wait }))];
    if (s.members.length >= 8) return [h('span.muted-text', T('sessions.join.full'))];
    return [h('button.btn.btn--small.btn--primary', {
      type: 'button',
      title: T('sessions.nearby.joinAsGuest.tooltip', { session: s.name }),
      onclick: () => this._join(s, n.id),
    }, T('sessions.nearby.joinAsGuest'))];
  },

  _actions(s) {
    const mine = Session.mine && Session.mine.session.id === s.id;
    if (this._isOwn(s)) return [h('span.muted-text', T('sessions.yourSession'))];
    if (mine) {
      return [
        h('span.session-joined', { html: `${Icons.check}<span>${T('common.joined')}</span>` }),
        h('button.btn.btn--small', { type: 'button', title: T('sessions.leave.tooltip', { session: s.name }), onclick: () => this._leave() }, T('common.leave')),
      ];
    }
    const req = Session.request;
    if (req && req.sessionId === s.id) {
      const left = Math.max(0, Math.ceil((req.expiresAt - Date.now()) / 1000));
      return [
        h('span.muted-text', { title: T('sessions.join.waiting.tooltip') }, T('sessions.join.waiting', { seconds: left })),
        h('button.btn.btn--small', { type: 'button', onclick: () => attempt(() => Session.cancelJoin()) }, T('common.cancel')),
      ];
    }
    const wait = Session.cooldownLeft(s.id);
    if (wait) {
      return [h('button.btn.btn--small', { type: 'button', disabled: true, title: T('sessions.join.declined.tooltip') }, T('sessions.join.askAgain', { seconds: wait }))];
    }
    if (s.members.length >= 8) return [h('span.muted-text', T('sessions.join.full'))];
    return [h('button.btn.btn--small.btn--primary', {
      type: 'button',
      title: T('sessions.join.tooltip', { session: s.name }),
      onclick: () => this._join(s),
    }, T('sessions.join'))];
  },

  async _join(s, serverId = null) {
    // This app's own session with company goes on without it.
    if (Session.isHost && Session.mine.session.members.length > 1) {
      const next = Session.mine.session.members[1];
      const ok = await confirmDialog({
        title: T('sessions.joinOther.title'),
        message: T('sessions.joinOther.text', { session: s.name, device: Session._who(next) }),
        confirmLabel: T('sessions.joinOther.confirm'),
      });
      if (!ok) return;
    }
    attempt(() => Session.join(s.id, serverId));
  },

  async _leave() {
    const host = Session.isHost;
    if (host) {
      const next = Session.mine.session.members[1];
      const ok = await confirmDialog({
        title: T('sessions.leaveOwn.title'),
        message: T('sessions.leaveOwn.text', { device: Session._who(next) }),
        confirmLabel: T('common.leave'),
      });
      if (!ok) return;
    }
    attempt(() => Session.leave());
  },

  /** This app's own place: in someone's session, or hosting one others listen to. */
  _drawMine() {
    const box = clear($('sessionsMine'));
    const m = Session.available || Session.guest ? Session.mine : null;
    const others = m ? m.session.members.filter((x) => x.client !== Store.server.clientId) : [];
    if (!m || (m.host && !others.length)) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const names = others.map((x) => Session._who(x));
    const text = m.host
      ? T('sessions.state.hosting', { names: names.join(', ') })
      : T('sessions.state.member', { session: m.session.name });
    box.append(
      h('span.sessions-mine__icon', { html: Icons.sessions }),
      h('span.sessions-mine__text', text),
      h('button.btn', { type: 'button', onclick: () => this._leave() }, T('common.leaveSession')),
    );
    if (m.host) box.append(this._volumeBox());
  },

  /** The host's choice: devices in the session may change this one's volume. */
  _volumeBox() {
    const box = h('input', { type: 'checkbox', checked: !!Store.settings.sessionAllowVolume });
    box.addEventListener('change', () => Store.saveSettings({ sessionAllowVolume: box.checked }));
    return h('label.check.sessions-mine__volume', box, h('span', T('sessions.mayChangeVolume')));
  },

  /** Counts down a request or a wait while this page shows one. */
  _tick() {
    const counting = Session.request || Session.cooldowns.size;
    if (counting && Nav.page === 'sessions') {
      if (!this._ticker) {
        this._ticker = setInterval(() => {
          if (Nav.page !== 'sessions') {
            clearInterval(this._ticker);
            this._ticker = null;
            return;
          }
          this.render();
        }, 1000);
      }
    } else if (this._ticker) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
  },
};
