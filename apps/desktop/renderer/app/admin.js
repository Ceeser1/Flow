'use strict';

// Settings' last category, for an admin profile on a Flow Server (3.5): the
// server at a glance, its profiles (a sortable table; on the phone each opens
// with a tap), every playlist with its owner (4.2.3: the owner changed there),
// the songs uploaded last, the failed sign-ins, every profile's
// server downloads and the Active Sessions, the trash, the backups (4.0;
// restored by the master admin only), the admins' rules, and for the master
// admin the server password. Each part opens and closes with a click on its
// heading (adminOpen, kept; all shut at first). Everything comes from the
// server's /api/admin (its admin.js) through window.flow.admin, fetched when
// it shows (4.3: Settings opened with it unfolded, or it unfolded; on the
// phone its screen opened), after every change made here, and with Refresh.

// The lists (profiles, uploads, failed logins, downloads, sessions, trash) show this many rows, then scroll.
const ROWS = 5;

const Admin = {
  _node: null,
  _data: null,
  _loading: false,
  _sort: { key: 'name', dir: 'asc' },
  _query: '',
  _playlistQuery: '',
  _opened: new Set(), // the phone's profiles opened with a tap
  _fits: [], // the scrolling lists' measuring, run as draw() puts them in

  /** The category: its heading and the node it is drawn into. */
  rows() {
    this._node = h('div.admin');
    this._data = null;
    return [h('h3.settings__section', T('admin.heading')), this._node];
  },

  /** Fetches everything afresh and draws it (only for an admin). */
  async load() {
    if (!this._node || !Store.server.admin || this._loading) return;
    this._loading = true;
    if (!this._data) this._drawNote(T('admin.loading'));
    const get = (route) => window.flow.admin(route).catch((err) => ({ error: (err && err.message) || String(err) }));
    try {
      const [server, profiles, playlists, uploads, signins, downloads, sessions, trash, backups, rules] = await Promise.all([
        get('server'), get('profiles'), get('playlists'), get('uploads'), get('signins'), get('downloads'), get('sessions'), get('trash'), get('backups'), get('rules'),
      ]);
      this._data = {
        server, profiles, playlists, uploads, signins, downloads, sessions, trash, backups, rules,
      };
    } finally {
      this._loading = false;
    }
    this.draw();
  },

  /**
   * `node` scrolls once it holds more than ROWS of `rows()` (measured, since a
   * long title wraps): it shows exactly that many. Measured again whenever
   * its size changes, so also when a hidden screen (the phone's) opens.
   */
  _scrollRows(node, rows) {
    node.classList.add('admin__scroll');
    const fit = () => {
      const list = rows();
      if (list.length <= ROWS) {
        node.style.maxHeight = '';
        return;
      }
      const first = list[0].getBoundingClientRect();
      if (!first.height) return;
      const top = node.getBoundingClientRect().top - node.scrollTop;
      node.style.maxHeight = `${Math.ceil(list[ROWS].getBoundingClientRect().top - top)}px`;
    };
    // Next frame: a height set inside the observer's call would be observed again at once.
    new ResizeObserver(() => requestAnimationFrame(fit)).observe(node);
    // And once as draw() puts it in, before it is painted: else it shows its full length for a frame.
    this._fits.push(fit);
    // A touch screen scrolls the list only from its middle half: a swipe on
    // its outer quarters scrolls the page (the list cannot scroll for that touch).
    // Not passive: Android then waits for this before it picks what the swipe scrolls.
    node.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const r = node.getBoundingClientRect();
      const x = (e.touches[0].clientX - r.left) / r.width;
      node.classList.toggle('admin__scroll--page', x < 0.25 || x > 0.75);
    }, { passive: false });
    const lift = (e) => { if (!e.touches.length) node.classList.remove('admin__scroll--page'); };
    node.addEventListener('touchend', lift);
    node.addEventListener('touchcancel', lift);
    return node;
  },

  /** A line's parts with a centred dot between them (the font's · sits low). */
  _parts(parts) {
    return parts.filter(Boolean).flatMap((p, i) => (i ? [h('span.admin__dot'), p] : [p]));
  },

  /** A list of items, scrolling past ROWS. */
  _list(items) {
    const list = h('ul.admin__list', ...items);
    return this._scrollRows(list, () => list.children);
  },

  _drawNote(text) {
    clear(this._node).append(h('p.settings__note', text));
  },

  /** One admin action: done, said, and everything fetched again. */
  async _do(fn, done) {
    const ok = await attempt(async () => {
      await fn();
      return true;
    });
    if (ok && done) toast(done, 'success');
    await this.load();
  },

  /** `danger`: true for a red button, or a button kind ('light-red'). */
  async _confirm(title, message, label, danger = false) {
    return !!(await confirmDialog({
      title, message, confirmLabel: label, danger: danger === true, kind: typeof danger === 'string' ? danger : '',
    }));
  },

  draw() {
    const d = this._data;
    if (!this._node || !d) return;
    const mobile = document.body.classList.contains('mobile');
    const me = Store.server.profile;
    const top = h('div.admin__top',
      me && !me.pin ? h('p.admin__warn', T('admin.noPinWarning')) : null,
      h('button.btn.btn--small', { type: 'button', onclick: () => this.load() }, T('admin.refresh')));
    // Drawn afresh after every change, in the same place: the phone's WebView
    // scrolls Settings to the top when the focused control (a rule's select
    // just picked) is taken out, so the focus leaves it first without scrolling.
    const scroller = this._node.closest('.modal__body');
    const scrolled = scroller ? scroller.scrollTop : 0;
    if (scroller && this._node.contains(document.activeElement)) {
      scroller.tabIndex = -1;
      scroller.focus({ preventScroll: true });
    }
    this._fits = [];
    // append() writes a null as the text "null": the master's block is left out instead.
    clear(this._node).append(...[
      top,
      this._block('overview', T('admin.part.overview'), this._overview(d.server)),
      this._block('profiles', T('admin.part.profiles'), this._profiles(d.profiles, mobile)),
      this._block('playlists', T('admin.part.allPlaylists'), this._playlists(d.playlists)),
      this._block('uploads', T('admin.part.recentUploads'), this._uploads(d.uploads)),
      this._block('signins', T('admin.part.failedLogins'), this._failures(d.signins)),
      this._block('downloads', T('admin.part.serverDownloads'), this._downloads(d.downloads)),
      this._block('sessions', T('common.activeSessions'), this._sessions(d.sessions)),
      this._block('trash', T('admin.part.trash'), this._trash(d.trash)),
      this._block('backups', T('common.backups'), this._backups(d.backups)),
      this._block('rules', T('admin.part.serverRules'), this._rules(d.rules, d.server.name)),
      Store.server.master ? this._block('password', T('admin.part.serverPassword'), this._password(d.server)) : null,
    ].filter(Boolean));
    for (const fit of this._fits) fit();
    if (scroller) scroller.scrollTop = scrolled;
  },

  /**
   * A part under its heading, which opens and closes it (open as left last
   * time: adminOpen, kept). A scrolling list in it measures itself once it
   * shows (_scrollRows).
   */
  _block(id, title, ...body) {
    const open = () => Store.settings.adminOpen.includes(id);
    const chevron = h('span.settings__chevron', { html: Icons.chevron });
    const head = h('button.admin__head', { type: 'button', title: T('admin.part.toggle.tooltip') }, chevron, h('span', title));
    const rows = h('div.admin__body', ...body);
    const fold = () => {
      rows.hidden = !open();
      chevron.classList.toggle('settings__chevron--down', !open());
      head.setAttribute('aria-expanded', String(open()));
    };
    head.addEventListener('click', () => {
      const now = new Set(Store.settings.adminOpen);
      if (now.has(id)) now.delete(id);
      else now.add(id);
      Store.saveSettings({ adminOpen: [...now] });
      fold();
    });
    fold();
    return h('section.admin__block', head, rows);
  },

  _failed(part) {
    return part && part.error ? h('p.settings__note', part.error) : null;
  },

  // ---- Overview ----

  _overview(o) {
    if (o.error) return this._failed(o);
    const disk = o.disk && o.disk.size > 0 ? this._disk(o.disk) : T('admin.overview.disk.unknown');
    const pairs = [
      [T('common.server'), T('admin.overview.server.value', { server: o.name, version: o.version })],
      [T('admin.overview.runningSince'), Util.fmtDate(o.startedAt)],
      [T('common.songs'), String(o.songs)],
      [T('admin.part.profiles'), String(o.profiles)],
      [T('admin.overview.musicFolder'), fmtBytes(o.musicBytes)],
      [T('admin.part.trash'), fmtBytes(o.trashBytes)],
      [T('admin.overview.disk'), disk],
      ['yt-dlp', o.ytdlp || T('admin.overview.tools.notInstalled')],
      ['ffmpeg', o.ffmpeg ? T('admin.overview.tools.installed') : T('admin.overview.tools.notInstalled')],
      [T('admin.part.serverDownloads'), o.downloads ? T('admin.overview.serverDownloads.on') : T('admin.overview.serverDownloads.off')],
      [T('admin.overview.level'), o.level ? String(o.level) : T('admin.overview.level.notChosen')],
      [T('common.password'), o.password ? T('common.yes') : T('admin.overview.password.none')],
      [T('admin.overview.masterAdmin'), o.master || T('admin.overview.masterAdmin.none')],
    ];
    return h('dl.admin__facts', ...pairs.flatMap(([k, v]) => [h('dt', k), h('dd', v)]));
  },

  /** The disk as a bar and "40.0 GB / 64.0 GB used": blue, then yellow from 50 %, orange 75, light red 90, deep red 95. */
  _disk({ free, size }) {
    const used = Math.max(0, size - free);
    const pct = Math.min(100, (used / size) * 100);
    const level = pct >= 95 ? 'crit' : pct >= 90 ? 'high' : pct >= 75 ? 'warn' : pct >= 50 ? 'mid' : 'ok';
    return h('span.admin__disk', { title: T('admin.overview.disk.tooltip', { percent: Math.round(pct), free: fmtBytes(free) }) },
      h(`span.admin__diskbar.admin__diskbar--${level}`, h('span.admin__diskfill', { style: `width: ${pct.toFixed(1)}%` })),
      T('admin.overview.disk.used', { used: fmtBytes(used), size: fmtBytes(size) }));
  },

  // ---- Profiles ----

  _lastSeen(v) {
    if (v === 'now') return T('admin.profiles.lastSeen.now');
    return v ? Util.fmtDate(v) : T('admin.profiles.lastSeen.never');
  },

  _sortValue(p, key) {
    if (key === 'name') return Util.fold(p.name);
    if (key === 'lastSeen') return p.lastSeen === 'now' ? Infinity : (p.lastSeen || 0);
    return p[key];
  },

  _badges(p, meId) {
    const marks = [
      p.id === meId ? [T('common.you.lower'), 'you'] : null,
      p.master ? [T('admin.profiles.badge.masterAdmin'), 'master'] : p.admin ? [T('admin.profiles.badge.admin'), 'admin'] : null,
      p.disabled ? [T('admin.profiles.badge.disabled'), 'off'] : null,
      p.pin ? null : [T('admin.profiles.badge.noPin'), 'nopin'],
    ].filter(Boolean);
    return marks.map(([text, kind]) => h(`span.admin__badge.admin__badge--${kind}`, text));
  },

  _profiles(list, mobile) {
    if (list.error) return this._failed(list);
    const search = h('input.input.settings__input.admin__search', {
      type: 'search', placeholder: T('admin.profiles.search.placeholder'), value: this._query, spellcheck: false, autocomplete: 'off',
    });
    const holder = h('div.admin__profiles');
    const draw = () => {
      const rows = Util.sortRows(list.profiles.filter((p) => Util.matches(this._query, p.name)), this._sort, (p, k) => this._sortValue(p, k));
      clear(holder);
      if (!rows.length) holder.append(h('p.settings__note', this._query ? T('admin.profiles.noMatch') : T('admin.profiles.none')));
      else if (mobile) holder.append(this._profileList(rows, list.me, draw));
      else holder.append(this._profileTable(rows, list.me, draw));
    };
    search.addEventListener('input', () => {
      this._query = search.value;
      draw();
    });
    draw();
    const add = h('button.btn.btn--small', { type: 'button', onclick: () => this._newProfile() }, T('admin.profiles.new.title'));
    return h('div', h('div.admin__bar', search, add), holder);
  },

  _columns() {
    return [
      { key: 'name', label: T('common.name'), cls: 'admin__col-name' },
      { key: 'createdAt', label: T('common.created'), cls: 'admin__col-date' },
      { key: 'lastSeen', label: T('admin.profiles.column.lastSeen'), cls: 'admin__col-seen' },
      { key: 'addedSongs', label: T('common.songs'), cls: 'admin__col-num' },
      { key: 'seconds', label: T('common.timeListened'), cls: 'admin__col-time' },
    ];
  },

  _profileTable(rows, meId, redraw) {
    const table = h('table.table.admin__table');
    const columns = [
      ...this._columns().map((c) => ({ ...c, render: (p) => this._cell(p, c.key, meId) })),
      {
        key: 'actions', label: T('common.actions'), sortable: false, cls: 'admin__col-actions', render: (p) => this._actions(p, meId),
      },
    ];
    renderTable(table, {
      columns,
      rows,
      sort: this._sort,
      onSort: (key) => {
        this._sort = Util.cycleSort(this._sort, key);
        redraw();
      },
      rowKey: (p) => p.id,
      rowClass: (p) => (p.disabled ? 'admin__row--off' : ''),
    });
    return this._scrollRows(h('div', table), () => table.tBodies[0] ? table.tBodies[0].rows : []);
  },

  _cell(p, key, meId) {
    if (key === 'name') return h('span.admin__name', h('span.cell-title', p.name), ...this._badges(p, meId));
    if (key === 'createdAt') return Util.fmtDay(p.createdAt);
    if (key === 'lastSeen') return this._lastSeen(p.lastSeen);
    if (key === 'addedSongs') return String(p.addedSongs);
    return Util.fmtListened(p.seconds);
  },

  /** The PC's one button (⋯): every action for the profile in a window. */
  _actions(p, meId) {
    return h('div.actions', iconButton('act.act--grey', Icons.more, T('common.actions'), () => this._moreDialog(p, meId)));
  },

  /** The phone's list: each profile's name, opening with a tap onto its numbers and buttons. */
  _profileList(rows, meId, redraw) {
    const columns = this._columns();
    const head = TouchList._sortRow(columns, this._sort, (key) => {
      this._sort = Util.cycleSort(this._sort, key);
      redraw();
    });
    const items = rows.map((p) => {
      const open = this._opened.has(p.id);
      const name = h('button.admin__pname', {
        type: 'button',
        'aria-expanded': String(open),
        onclick: () => {
          if (open) this._opened.delete(p.id);
          else this._opened.add(p.id);
          redraw();
        },
      }, h('span.admin__name', h('span.cell-title', p.name), ...this._badges(p, meId)),
      h('span.settings__chevron' + (open ? '' : '.settings__chevron--down'), { html: Icons.chevron }));
      if (!open) return h('div.admin__prow' + (p.disabled ? '.admin__row--off' : ''), name);
      const facts = h('dl.admin__facts',
        ...columns.filter((c) => c.key !== 'name').flatMap((c) => [h('dt', c.label), h('dd', this._cell(p, c.key, meId))]),
        h('dt', T('admin.profiles.loggedInOn')), h('dd', Util.plural(p.devices, 'device')));
      const buttons = this._buttons(p, meId);
      return h('div.admin__prow.admin__prow--open' + (p.disabled ? '.admin__row--off' : ''), name, facts, buttons);
    });
    const scroll = h('div', ...items);
    return h('div.admin__plist', head, this._scrollRows(scroll, () => scroll.children));
  },

  /**
   * Every action for a profile as buttons in two rows (the phone's opened
   * row, the PC's ⋯): what it did and its PIN, then what it is.
   */
  _buttons(p, meId, after = null) {
    const locked = p.id === meId || p.master;
    const btn = (label, onclick, extra = '') => h('button.btn.btn--small' + extra, {
      type: 'button',
      onclick: () => {
        if (after) after();
        onclick();
      },
    }, label);
    const first = [
      btn(T('admin.profiles.button.connectionHistory'), () => this._showIps(p)),
      !locked && p.pin ? btn(T('admin.profiles.resetPin.title'), () => this._removePin(p)) : null,
      !locked && p.devices ? btn(T('admin.profiles.logOut.title'), () => this._signOut(p)) : null,
    ].filter(Boolean);
    // Only a profile with a PIN can be made an admin: greyed out, saying why.
    const makeAdmin = Store.server.master && !p.master ? btn(p.admin ? T('admin.profiles.revokeAdmin.title') : T('admin.profiles.makeAdmin.title'), () => this._setAdmin(p)) : null;
    if (makeAdmin && !p.admin && !p.pin) {
      makeAdmin.disabled = true;
      makeAdmin.title = T('admin.profiles.button.makeAdmin.needsPin.tooltip');
    }
    const second = [
      makeAdmin,
      !locked ? btn(p.disabled ? T('admin.profiles.button.enable') : T('admin.profiles.button.disable'), () => this._disable(p)) : null,
      !locked ? btn(T('common.deleteProfile'), () => this._delete(p), '.btn--danger') : null,
    ].filter(Boolean);
    return h('div.admin__pgroups', h('div.admin__pactions', ...first), second.length ? h('div.admin__pactions', ...second) : null);
  },

  _moreDialog(p, meId) {
    let handle = null;
    handle = Modal.open({
      title: p.name,
      className: 'modal--small',
      body: [this._buttons(p, meId, () => handle.close())],
      buttons: [{ label: T('common.close') }],
    });
  },

  async _showIps(p) {
    const r = await attempt(() => window.flow.admin(`profiles/${p.id}/ips`));
    if (!r) return;
    const rows = r.ips.map((e) => h('tr', h('td', e.ip), h('td', e.device || ''), h('td', Util.fmtDate(e.at))));
    Modal.open({
      title: T('admin.profiles.history.title', { profile: p.name }),
      className: 'modal--admin-ips',
      body: [
        h('p.modal__text', T('admin.profiles.history.madeFrom'), ' ', h('strong', r.createdIp || T('admin.profiles.history.madeFrom.unknown'))),
        rows.length
          ? h('table.admin__ips', h('thead', h('tr', h('th', 'IP'), h('th', T('admin.profiles.history.column.device')), h('th', T('admin.profiles.history.column.lastTime')))), h('tbody', ...rows))
          : h('p.settings__note', T('admin.profiles.history.none')),
        h('p.settings__note', T('admin.profiles.history.newest', { count: r.ips.length })),
      ],
      buttons: [{ label: T('common.close'), kind: 'primary' }],
    });
  },

  async _delete(p) {
    const answer = await confirmDialog({
      title: T('common.deleteProfile'),
      message: T('admin.profiles.delete.text', { profile: p.name }),
      confirmLabel: T('common.delete'),
      danger: true,
      checkbox: { label: T('admin.profiles.delete.alsoSongs') },
    });
    if (!answer) return;
    let deleted = 0;
    await this._do(async () => {
      ({ deletedSongs: deleted } = await window.flow.admin(`profiles/${p.id}/delete`, { songs: answer.checked }));
    });
    toast(answer.checked ? T('admin.profiles.delete.done.withSongs', { profile: p.name, songs: Util.plural(deleted, 'song') }) : T('common.profileDeleted', { profile: p.name }), 'info');
  },

  async _removePin(p) {
    // A profile without a PIN cannot be an admin: the server takes that away too.
    const admin = p.admin ? ` ${T('admin.profiles.resetPin.text.adminToo', { profile: p.name })}` : '';
    if (!(await this._confirm(T('admin.profiles.resetPin.title'), T('admin.profiles.resetPin.text', { profile: p.name }) + admin, T('admin.profiles.resetPin.title')))) return;
    await this._do(() => window.flow.admin(`profiles/${p.id}/pin`, {}), p.admin ? T('admin.profiles.resetPin.done.noAdmin', { profile: p.name }) : T('admin.profiles.resetPin.done', { profile: p.name }));
  },

  async _signOut(p) {
    if (!(await this._confirm(T('admin.profiles.logOut.title'), T('admin.profiles.logOut.text', { profile: p.name, count: p.devices }), T('common.logout')))) return;
    await this._do(() => window.flow.admin(`profiles/${p.id}/signout`, {}), T('admin.profiles.logOut.done', { profile: p.name }));
  },

  async _disable(p) {
    const off = !p.disabled;
    if (off && !(await this._confirm(T('admin.profiles.disable.title'), T('admin.profiles.disable.text', { profile: p.name }), T('admin.profiles.button.disable'), true))) return;
    await this._do(() => window.flow.admin(`profiles/${p.id}/disable`, { disabled: off }), off ? T('admin.profiles.disable.done', { profile: p.name }) : T('admin.profiles.enable.done', { profile: p.name }));
  },

  async _setAdmin(p) {
    const on = !p.admin;
    const message = on
      ? T('admin.profiles.makeAdmin.text', { profile: p.name })
      : T('admin.profiles.revokeAdmin.text', { profile: p.name });
    if (!(await this._confirm(on ? T('admin.profiles.makeAdmin.title') : T('admin.profiles.revokeAdmin.title'), message, on ? T('admin.profiles.makeAdmin.title') : T('admin.profiles.revokeAdmin.confirm'), on ? false : 'light-red'))) return;
    await this._do(() => window.flow.admin(`profiles/${p.id}/admin`, { admin: on }), on ? T('admin.profiles.makeAdmin.done', { profile: p.name }) : T('admin.profiles.revokeAdmin.done', { profile: p.name }));
  },

  _newProfile() {
    const name = h('input.input', { type: 'text', placeholder: T('common.name'), maxLength: 40, spellcheck: false, autocomplete: 'off' });
    const pin = h('input.input', { type: 'password', placeholder: T('admin.profiles.new.pin.placeholder'), autocomplete: 'new-password' });
    Modal.open({
      title: T('admin.profiles.new.title'),
      className: 'modal--small',
      focus: 'input',
      body: [h('p.modal__text', T('admin.profiles.new.desc')), h('div.admin__form', name, pin)],
      buttons: [
        { label: T('common.cancel') },
        {
          label: T('common.create'),
          kind: 'primary',
          onClick: async () => {
            const made = await attempt(() => window.flow.admin('profiles', { name: name.value, pin: pin.value }));
            if (!made) return false;
            toast(T('admin.profiles.new.done', { profile: made.profile.name }), 'success');
            this.load();
            return true;
          },
        },
      ],
    });
  },

  // ---- All Playlists ----

  /**
   * Every playlist on the server, by name: its songs and length (a smart
   * one's are worked out by the apps), and its owner to pick, which gives it
   * to that profile (or the Default / Shared). The search finds names and
   * owners. The master's playlists only the master can give away.
   */
  _playlists(r) {
    // A server from before 4.2.3 has no such list.
    if (r.error) return /nothing here/i.test(r.error) ? h('p.settings__note', T('admin.playlists.serverTooOld')) : this._failed(r);
    if (!r.playlists.length) return h('p.settings__note', T('admin.playlists.none'));
    const ownerName = new Map(r.owners.map((o) => [o.id, o.id === 'default' ? T('settings.server.profile.pick.shared') : o.name]));
    const masters = new Set(r.owners.filter((o) => o.master).map((o) => o.id));
    const byName = r.playlists.slice().sort((a, b) => Util.fold(a.name).localeCompare(Util.fold(b.name))
      || Util.fold(ownerName.get(a.ownerId) || '').localeCompare(Util.fold(ownerName.get(b.ownerId) || '')));
    const row = (p) => {
      const select = h('select.select.admin__owner-select', { 'aria-label': T('admin.playlists.owner.ariaLabel', { playlist: p.name }) },
        ...r.owners.map((o) => h('option', { value: o.id }, ownerName.get(o.id))));
      select.value = p.ownerId;
      if (masters.has(p.ownerId) && !Store.server.master) {
        select.disabled = true;
        select.title = T('admin.playlists.owner.masterOnly.tooltip');
      }
      select.addEventListener('change', () => this._giveAway(p, select.value, ownerName.get(select.value)));
      const facts = p.smart ? [T('window.playlists.new.smart')] : [Util.plural(p.songs, 'song'), Util.fmtClock(p.seconds)];
      return h('li.admin__item.admin__item--row.admin__item--playlist',
        h('span.admin__item-main.admin__playlist', ...this._parts([h('span.admin__playlist-name', p.name), ...facts.map((f) => h('span.admin__playlist-fact', f))])),
        h('label.admin__owner', h('span', T('admin.playlists.owner')), select));
    };
    const search = h('input.input.settings__input.admin__search', {
      type: 'search', placeholder: T('admin.playlists.search.placeholder'), value: this._playlistQuery, spellcheck: false, autocomplete: 'off',
    });
    const holder = h('div');
    const draw = () => {
      const rows = byName.filter((p) => Util.matches(this._playlistQuery, p.name, ownerName.get(p.ownerId) || ''));
      clear(holder).append(rows.length ? this._list(rows.map(row)) : h('p.settings__note', T('admin.playlists.noMatch')));
    };
    search.addEventListener('input', () => {
      this._playlistQuery = search.value;
      draw();
    });
    draw();
    return h('div', h('div.admin__bar.admin__bar--top', search), holder);
  },

  /** A playlist given to another owner; a name the owner has already gets "(2)" (the server says). */
  async _giveAway(p, ownerId, ownerName) {
    let r = null;
    await this._do(async () => {
      r = await window.flow.admin('playlists/owner', { id: p.id, owner: ownerId });
    });
    if (!r) return;
    toast(r.name && r.name !== p.name
      ? T('admin.playlists.given.renamed', { playlist: p.name, profile: ownerName, name: r.name })
      : T('admin.playlists.given', { playlist: p.name, profile: ownerName }), 'success');
  },

  // ---- Recent uploads ----

  _uploads(r) {
    // A server from before 4.1 keeps no such list.
    if (r.error) return /nothing here/i.test(r.error) ? h('p.settings__note', T('admin.uploads.serverTooOld')) : this._failed(r);
    if (!r.uploads.length) return h('p.settings__note', T('admin.uploads.none'));
    return this._list(r.uploads.map((u) => {
      const name = Util.songLine(u);
      return h('li.admin__item.admin__item--row',
        h('span.admin__item-text',
          h('span.admin__item-main', name),
          h('span.admin__item-sub', { title: u.device ? T('admin.uploads.fromDevice.tooltip', { device: u.device }) : '' }, ...this._parts([T('admin.trash.addedBy', { profile: u.by }), Util.fmtDate(u.at), u.ip]))),
        h('button.btn.btn--small.btn--danger', {
          type: 'button',
          onclick: async () => {
            if (!(await this._confirm(T('common.deleteSong'), T('admin.uploads.delete.text', { song: name }), T('common.delete'), true))) return;
            await this._do(() => window.flow.admin('uploads/delete', { songId: u.songId }), T('common.songDeleted', { song: u.title }));
          },
        }, T('common.delete')));
    }));
  },

  // ---- Failed logins ----

  _failures(r) {
    if (r.error) return this._failed(r);
    if (!r.failures.length) return h('p.settings__note', T('admin.failedLogins.none'));
    const shown = r.failures.slice(0, 100);
    const rows = shown.map((f) => h('li.admin__item',
      h('span.admin__item-main', f.kind === 'pin' ? T('admin.failedLogins.wrongPin', { profile: f.profileName || T('admin.failedLogins.wrongPin.deletedProfile') }) : T('admin.failedLogins.wrongPassword')),
      h('span.admin__item-sub', ...this._parts([Util.fmtDate(f.at), f.ip, f.device]))));
    const more = r.failures.length > shown.length ? h('p.settings__note', T('admin.failedLogins.newest', { shown: shown.length, total: r.failures.length })) : null;
    const clearBtn = h('button.btn.btn--small', {
      type: 'button',
      onclick: async () => {
        if (await this._confirm(T('admin.failedLogins.clear'), T('admin.failedLogins.clear.text'), T('common.clear'))) await this._do(() => window.flow.admin('signins/clear', {}));
      },
    }, T('admin.failedLogins.clear'));
    return h('div', this._list(rows), more, h('div.admin__bar', clearBtn));
  },

  // ---- Server downloads and Active Sessions ----

  _downloads(r) {
    if (r.error) return this._failed(r);
    if (!r.batches.length) return h('p.settings__note', T('admin.downloads.none'));
    return this._list(r.batches.map((b) => h('li.admin__item.admin__item--row',
      h('span.admin__item-text',
        h('span.admin__item-main', `${b.profileName}: ${b.name || b.url || T('admin.downloads.entry.unnamed')}`),
        h('span.admin__item-sub', ...(b.state === 'listing' ? [T('common.readingLink')]
          : this._parts([T(b.failed ? 'admin.downloads.progress.withFailed' : 'admin.downloads.progress', { saved: b.saved, songs: b.songs, open: b.open, failed: b.failed }), T('admin.downloads.since', { date: Util.fmtDate(b.createdAt) })])))),
      h('button.btn.btn--small', {
        type: 'button',
        onclick: async () => {
          if (!(await this._confirm(T('admin.downloads.cancel.title'), T('admin.downloads.cancel.text', { profile: b.profileName }), T('admin.downloads.cancel.title'), true))) return;
          await this._do(() => window.flow.admin('downloads/cancel', { key: b.key }), T('common.downloadCancelled'));
        },
      }, T('common.cancel')))));
  },

  _sessions(r) {
    if (r.error) return this._failed(r);
    if (!r.sessions.length) return h('p.settings__note', T('admin.sessions.none'));
    return this._list(r.sessions.map((s) => h('li.admin__item.admin__item--row',
      h('span.admin__item-text',
        h('span.admin__item-main', s.name),
        h('span.admin__item-sub', ...this._parts([
          s.song ? Util.songLine(s.song) : T('admin.sessions.nothingPlaying'),
          s.playing ? T('admin.sessions.playing') : T('admin.sessions.paused'),
          Util.plural(s.listeners, 'listener'),
          s.shared ? '' : T('admin.sessions.notShared'),
        ]))),
      s.listeners ? h('button.btn.btn--small', {
        type: 'button',
        onclick: async () => {
          if (!(await this._confirm(T('admin.sessions.end.title'), T('admin.sessions.end.text', { session: s.name }), T('admin.sessions.end.title'), true))) return;
          await this._do(() => window.flow.admin('sessions/end', { id: s.id }), T('admin.sessions.end.done'));
        },
      }, T('admin.sessions.end')) : null)));
  },

  // ---- Trash ----

  _trash(r) {
    if (r.error) return this._failed(r);
    if (!r.items.length) return h('p.settings__note', T('admin.trash.empty.note'));
    const rows = r.items.map((t) => h('li.admin__item.admin__item--row',
      h('span.admin__item-text',
        h('span.admin__item-main', t.artist ? `${t.title} - ${t.artist}` : t.title),
        h('span.admin__item-sub', ...this._parts([t.by ? T('admin.trash.deletedBy', { profile: t.by }) : T('admin.trash.deleted'), Util.fmtDate(t.at), t.addedBy ? T('admin.trash.addedBy', { profile: t.addedBy }) : '']))),
      h('button.btn.btn--small', {
        type: 'button',
        onclick: () => this._do(() => window.flow.admin('trash/restore', { name: t.name }), T('admin.trash.restored', { song: t.title })),
      }, T('common.restore'))));
    const empty = h('button.btn.btn--small.btn--danger', {
      type: 'button',
      onclick: async () => {
        if (!(await this._confirm(T('admin.trash.emptyTrash'), T('admin.trash.emptyTrash.text', { files: Util.plural(r.items.length, 'file'), size: fmtBytes(r.bytes) }), T('admin.trash.emptyTrash'), true))) return;
        await this._do(() => window.flow.admin('trash/empty', {}), T('admin.trash.emptyTrash.done'));
      },
    }, T('admin.trash.emptyTrash'));
    return h('div', h('p.settings__note', T('admin.trash.summary', { files: Util.plural(r.items.length, 'file'), size: fmtBytes(r.bytes) })),
      this._list(rows), h('div.admin__bar', empty));
  },

  // ---- Backups ----

  _backups(r) {
    // A server from before 4.0 has none.
    if (r.error) return /nothing here/i.test(r.error) ? h('p.settings__note', T('admin.backups.serverTooOld')) : this._failed(r);
    const master = Store.server.master;
    const why = { weekly: T('admin.backups.reason.weekly'), manual: T('admin.backups.reason.manual'), restore: T('admin.backups.reason.restore') };
    const rows = r.backups.map((b) => h('li.admin__item.admin__item--row',
      h('span.admin__item-text',
        h('span.admin__item-main', Util.fmtDate(b.createdAt)),
        h('span.admin__item-sub', ...this._parts([why[b.reason] || '', Util.plural(b.songs, 'song'), Util.plural(b.playlists, 'playlist'),
          Util.plural(b.profiles, 'profile'), fmtBytes(b.size)]))),
      master ? h('button.btn.btn--small', {
        type: 'button',
        onclick: async () => {
          if (!(await this._confirm(T('common.restoreBackup'), T('admin.backups.restore.text', { date: Util.fmtDate(b.createdAt) }), T('common.restore'), 'light-red'))) return;
          await this._do(() => window.flow.admin('backups/restore', { name: b.name }), T('admin.backups.restored'));
        },
      }, T('common.restore')) : null));
    const make = h('button.btn.btn--small', {
      type: 'button',
      onclick: () => this._do(() => window.flow.admin('backups/make', {}), T('common.backupMade')),
    }, T('common.backUpNow'));
    const note = T('admin.backups.desc', { count: r.keep }) + (master ? '' : ` ${T('admin.backups.desc.onlyMaster')}`);
    return h('div', h('p.settings__note', note),
      r.backups.length ? this._list(rows) : h('p.settings__note', T('common.noBackups')), h('div.admin__bar', make));
  },

  // ---- Server rules ----

  _rules(r, serverName) {
    if (r.error) return this._failed(r);
    const select = (key, options) => {
      const node = h('select.select', ...options.map(([v, label]) => h('option', { value: v }, label)));
      node.value = r[key];
      node.addEventListener('change', () => this._do(() => window.flow.admin('rules', { [key]: node.value }), T('admin.saved')));
      return node;
    };
    // Guests from other servers (4.0): a server from before has no such rule.
    const guests = r.guests === undefined ? null : h('input', { type: 'checkbox', checked: !!r.guests });
    if (guests) guests.addEventListener('change', () => this._do(() => window.flow.admin('rules', { guests: guests.checked }), T('admin.saved')));
    // Guests find the sessions only through the network search: without it the rule does nothing.
    const unfound = !!guests && r.discovery === false;
    if (unfound) guests.disabled = true;
    return h('div.admin__rules',
      h('label.admin__rule', h('span', T('admin.rules.newProfiles')),
        select('profileCreation', [['anyone', T('admin.rules.newProfiles.everyone')], ['admins', T('admin.rules.newProfiles.onlyAdmins')]])),
      h('label.admin__rule', h('span', T('admin.rules.deleteSongs')),
        select('songDelete', [['anyone', T('admin.rules.newProfiles.everyone')], ['owner', T('admin.rules.deleteSongs.ownerAndAdmins')]])),
      guests ? h(`label.check.admin__guests${unfound ? '.admin__guests--off' : ''}`, guests,
        h('span', T('admin.rules.guests'),
          unfound ? h('span.admin__guests-note', ` ${serverName ? T('admin.rules.guests.discoveryOff', { server: serverName }) : T('admin.rules.guests.discoveryOff.unnamed')}`) : null,
          h('span.admin__item-sub', T('admin.rules.guests.desc')))) : null);
  },

  // ---- Server password (master admin) ----

  _password(o) {
    if (o.error) return this._failed(o);
    const field = (placeholder) => h('input.input', { type: 'password', placeholder, autocomplete: 'new-password' });
    const current = o.password ? field(T('admin.password.current')) : null;
    const next = field(T('admin.password.new'));
    const again = field(T('admin.password.newAgain'));
    const change = h('button.btn.btn--small.btn--primary', {
      type: 'button',
      onclick: async () => {
        if (next.value !== again.value) {
          toast(T('admin.password.notMatching'), 'error');
          return;
        }
        if (!(await this._confirm(T('admin.password.change'), T('admin.password.change.text'), T('common.change')))) return;
        await this._do(() => window.flow.changeServerPassword({ current: current ? current.value : '', password: next.value }), T('admin.password.changed'));
      },
    }, o.password ? T('admin.password.change') : T('admin.password.set'));
    const remove = o.password && !(o.level >= 3) ? h('button.btn.btn--small', {
      type: 'button',
      onclick: async () => {
        if (!(await this._confirm(T('admin.password.remove'), T('admin.password.remove.text'), T('common.remove'), true))) return;
        await this._do(() => window.flow.changeServerPassword({ current: current ? current.value : '', remove: true }), T('admin.password.removed'));
      },
    }, T('admin.password.remove')) : null;
    const rule = o.level >= 3
      ? T('admin.password.rule.internet')
      : T('admin.password.rule.short');
    return h('div',
      h('p.settings__note', T('admin.password.rule.note', { rule })),
      h('div.admin__form', current, next, again),
      h('div.admin__bar', change, remove));
  },
};
