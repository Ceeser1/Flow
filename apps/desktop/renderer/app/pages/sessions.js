'use strict';

// Active Sessions: what the devices on this Flow Server play right now, each
// a session that can be joined (with its host's OK). A main entry in the
// menu, there only while another device plays or this one has company. The
// session state itself lives in Session (session.js).

const SessionsPage = {
  sort: { key: null, dir: null },
  _ticker: null,

  init() {
    Session.onChange(() => {
      if (Nav.page === 'sessions') this.render();
    });
  },

  show() {
    this.render();
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
      ? 'Nothing is playing on the server right now. Sessions show up here as soon as a device plays something.'
      : 'Active Sessions need a connection to a Flow Server that has them (version 2.8 or later).';
    $('sessionsTable').hidden = !rows.length;
    renderTable($('sessionsTable'), {
      rows: Util.sortRows(rows, this.sort, (s, k) => this._value(s, k)),
      sort: this.sort,
      rowKey: (s) => s.id,
      rowClass: (s) => (Session.mine && Session.mine.session.id === s.id ? 'row--current' : ''),
      onSort: (key) => {
        this.sort = Util.cycleSort(this.sort, key);
        this.render();
      },
      columns: [
        {
          key: 'name',
          label: 'Session name',
          cls: 'col-name',
          render: (s) => h('span.session-name',
            h('span.link-cell__icon', { html: Icons.sessions }),
            h('span.link-cell__name', s.name),
            this._isOwn(s) ? h('span.session-tag', 'You') : null),
        },
        {
          key: 'song',
          label: 'Song',
          cls: 'col-song',
          render: (s) => (s.song
            ? h('span.session-song',
              s.playing ? h('span.menu__playing', { html: Icons.speaker, title: 'Playing' }) : h('span.muted-text', 'Paused: '),
              Covers.el(Store.song(s.song.id) || s.song),
              h('span.cell-title', s.song.title),
              s.song.artist ? h('span.muted-text', ` - ${s.song.artist}`) : null)
            : h('span.muted-text', 'Nothing loaded')),
        },
        {
          key: 'listeners',
          label: 'Listeners',
          cls: 'col-num',
          render: (s) => h('span', { title: this._listeners(s) || 'Nobody has joined yet' }, String(s.listeners)),
        },
        {
          key: 'actions',
          label: 'Actions',
          sortable: false,
          cls: 'col-actions',
          render: (s) => h('div.actions', ...this._actions(s)),
        },
      ],
      mobile: {
        lead: () => h('span.mrow__icon', { html: Icons.sessions }),
        title: (s) => (this._isOwn(s) ? `${s.name} (you)` : s.name),
        sub: (s) => [
          s.song ? `${s.playing ? '' : 'Paused: '}${s.song.title}${s.song.artist ? ` - ${s.song.artist}` : ''}` : 'Nothing loaded',
          Util.plural(s.listeners, 'listener'),
        ].join(' · '),
        side: (s) => (this._isOwn(s) ? h('span') : h('div.actions.mrow__side', ...this._actions(s))),
      },
    });
    this._tick();
  },

  _actions(s) {
    const mine = Session.mine && Session.mine.session.id === s.id;
    if (this._isOwn(s)) return [h('span.muted-text', 'Your session')];
    if (mine) {
      return [
        h('span.session-joined', { html: `${Icons.check}<span>Joined</span>` }),
        h('button.btn.btn--small', { type: 'button', title: `Leave ${s.name}`, onclick: () => this._leave() }, 'Leave'),
      ];
    }
    const req = Session.request;
    if (req && req.sessionId === s.id) {
      const left = Math.max(0, Math.ceil((req.expiresAt - Date.now()) / 1000));
      return [
        h('span.muted-text', { title: 'The host is asked to let you in' }, `Waiting ${left} s`),
        h('button.btn.btn--small', { type: 'button', onclick: () => attempt(() => Session.cancelJoin()) }, 'Cancel'),
      ];
    }
    const wait = Session.cooldownLeft(s.id);
    if (wait) {
      return [h('button.btn.btn--small', { type: 'button', disabled: true, title: 'The host declined' }, `Ask again in ${wait} s`)];
    }
    if (s.members.length >= 8) return [h('span.muted-text', 'Full')];
    return [h('button.btn.btn--small.btn--primary', {
      type: 'button',
      title: `Ask to join ${s.name}`,
      onclick: () => this._join(s),
    }, 'Join')];
  },

  async _join(s) {
    // This app's own session with company goes on without it.
    if (Session.isHost && Session.mine.session.members.length > 1) {
      const next = Session.mine.session.members[1];
      const ok = await confirmDialog({
        title: 'Join another session',
        message: `You host a session others listen to. If ${s.name} lets you in, ${Session._who(next)} hosts yours from then on and the music stops here.`,
        confirmLabel: 'Ask to join',
      });
      if (!ok) return;
    }
    attempt(() => Session.join(s.id));
  },

  async _leave() {
    const host = Session.isHost;
    if (host) {
      const next = Session.mine.session.members[1];
      const ok = await confirmDialog({
        title: 'Leave your session',
        message: `${Session._who(next)} carries on playing it, and the music stops here.`,
        confirmLabel: 'Leave',
      });
      if (!ok) return;
    }
    attempt(() => Session.leave());
  },

  /** This app's own place: in someone's session, or hosting one others listen to. */
  _drawMine() {
    const box = clear($('sessionsMine'));
    const m = Session.available ? Session.mine : null;
    const others = m ? m.session.members.filter((x) => x.client !== Store.server.clientId) : [];
    if (!m || (m.host && !others.length)) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const names = others.map((x) => Session._who(x));
    const text = m.host
      ? `You host this session. Listening: ${names.join(', ')}.`
      : `You are in ${m.session.name}. What you press plays there.`;
    box.append(
      h('span.sessions-mine__icon', { html: Icons.sessions }),
      h('span.sessions-mine__text', text),
      h('button.btn', { type: 'button', onclick: () => this._leave() }, 'Leave session'),
    );
    if (m.host) box.append(this._volumeBox());
  },

  /** The host's choice: devices in the session may change this one's volume. */
  _volumeBox() {
    const box = h('input', { type: 'checkbox', checked: !!Store.settings.sessionAllowVolume });
    box.addEventListener('change', () => Store.saveSettings({ sessionAllowVolume: box.checked }));
    return h('label.check.sessions-mine__volume', box, h('span', 'They may change my volume'));
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
