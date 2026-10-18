'use strict';

// Settings' last category, for an admin profile on a Flow Server (3.5): the
// server at a glance, its profiles (a sortable table; on the phone each opens
// with a tap), the failed sign-ins, every profile's server downloads and the
// Active Sessions, the trash, the admins' rules, and for the master admin the
// server password. Everything comes from the server's /api/admin (its
// admin.js) through window.flow.admin, fetched when Settings opens, after
// every change made here, and with Refresh.

// The lists (profiles, failed logins, downloads, sessions, trash) show this many rows, then scroll.
const ROWS = 5;

const Admin = {
  _node: null,
  _data: null,
  _loading: false,
  _sort: { key: 'name', dir: 'asc' },
  _query: '',
  _opened: new Set(), // the phone's profiles opened with a tap

  /** The category: its heading and the node it is drawn into. */
  rows() {
    this._node = h('div.admin');
    this._data = null;
    return [h('h3.settings__section', 'Administration'), this._node];
  },

  /** Fetches everything afresh and draws it (only for an admin). */
  async load() {
    if (!this._node || !Store.server.admin || this._loading) return;
    this._loading = true;
    if (!this._data) this._drawNote('Loading...');
    const get = (route) => window.flow.admin(route).catch((err) => ({ error: (err && err.message) || String(err) }));
    try {
      const [server, profiles, signins, downloads, sessions, trash, rules] = await Promise.all([
        get('server'), get('profiles'), get('signins'), get('downloads'), get('sessions'), get('trash'), get('rules'),
      ]);
      this._data = {
        server, profiles, signins, downloads, sessions, trash, rules,
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
      me && !me.pin ? h('p.admin__warn', 'Your profile has no PIN: anyone who can reach this server can log in to it and use Administration.') : null,
      h('button.btn.btn--small', { type: 'button', onclick: () => this.load() }, 'Refresh'));
    // append() writes a null as the text "null": the master's block is left out instead.
    clear(this._node).append(...[
      top,
      this._block('Overview', this._overview(d.server)),
      this._block('Profiles', this._profiles(d.profiles, mobile)),
      this._block('Failed logins', this._failures(d.signins)),
      this._block('Server downloads', this._downloads(d.downloads)),
      this._block('Active Sessions', this._sessions(d.sessions)),
      this._block('Trash', this._trash(d.trash)),
      this._block('Server rules', this._rules(d.rules)),
      Store.server.master ? this._block('Server password', this._password(d.server)) : null,
    ].filter(Boolean));
  },

  _block(title, ...body) {
    return h('section.admin__block', h('h4.admin__head', title), ...body);
  },

  _failed(part) {
    return part && part.error ? h('p.settings__note', part.error) : null;
  },

  // ---- Overview ----

  _overview(o) {
    if (o.error) return this._failed(o);
    const disk = o.disk && o.disk.size > 0 ? this._disk(o.disk) : 'unknown';
    const pairs = [
      ['Server', `${o.name} (version ${o.version})`],
      ['Running since', Util.fmtDate(o.startedAt)],
      ['Songs', String(o.songs)],
      ['Profiles', String(o.profiles)],
      ['Music folder', fmtBytes(o.musicBytes)],
      ['Trash', fmtBytes(o.trashBytes)],
      ['Disk', disk],
      ['yt-dlp', o.ytdlp || 'not installed'],
      ['ffmpeg', o.ffmpeg ? 'installed' : 'not installed'],
      ['Server downloads', o.downloads ? 'on' : 'off'],
      ['Level', o.level ? String(o.level) : 'not chosen'],
      ['Password', o.password ? 'yes' : 'none'],
      ['Master admin', o.master || 'none (set on the server: flow-server admin master <name>)'],
    ];
    return h('dl.admin__facts', ...pairs.flatMap(([k, v]) => [h('dt', k), h('dd', v)]));
  },

  /** The disk as a bar and "40.0 GB / 64.0 GB used": blue, then yellow from 50 %, orange 75, light red 90, deep red 95. */
  _disk({ free, size }) {
    const used = Math.max(0, size - free);
    const pct = Math.min(100, (used / size) * 100);
    const level = pct >= 95 ? 'crit' : pct >= 90 ? 'high' : pct >= 75 ? 'warn' : pct >= 50 ? 'mid' : 'ok';
    return h('span.admin__disk', { title: `${Math.round(pct)} % used, ${fmtBytes(free)} free` },
      h(`span.admin__diskbar.admin__diskbar--${level}`, h('span.admin__diskfill', { style: `width: ${pct.toFixed(1)}%` })),
      `${fmtBytes(used)} / ${fmtBytes(size)} used`);
  },

  // ---- Profiles ----

  _lastSeen(v) {
    if (v === 'now') return 'now';
    return v ? Util.fmtDate(v) : 'never';
  },

  _sortValue(p, key) {
    if (key === 'name') return Util.fold(p.name);
    if (key === 'lastSeen') return p.lastSeen === 'now' ? Infinity : (p.lastSeen || 0);
    return p[key];
  },

  _badges(p, meId) {
    const marks = [
      p.id === meId ? ['you', 'you'] : null,
      p.master ? ['master admin', 'master'] : p.admin ? ['admin', 'admin'] : null,
      p.disabled ? ['disabled', 'off'] : null,
      p.pin ? null : ['no PIN', 'nopin'],
    ].filter(Boolean);
    return marks.map(([text, kind]) => h(`span.admin__badge.admin__badge--${kind}`, text));
  },

  _profiles(list, mobile) {
    if (list.error) return this._failed(list);
    const search = h('input.input.settings__input.admin__search', {
      type: 'search', placeholder: 'Search profiles', value: this._query, spellcheck: false, autocomplete: 'off',
    });
    const holder = h('div.admin__profiles');
    const draw = () => {
      const rows = Util.sortRows(list.profiles.filter((p) => Util.matches(this._query, p.name)), this._sort, (p, k) => this._sortValue(p, k));
      clear(holder);
      if (!rows.length) holder.append(h('p.settings__note', this._query ? 'No profile has that name.' : 'No profiles yet.'));
      else if (mobile) holder.append(this._profileList(rows, list.me, draw));
      else holder.append(this._profileTable(rows, list.me, draw));
    };
    search.addEventListener('input', () => {
      this._query = search.value;
      draw();
    });
    draw();
    const add = h('button.btn.btn--small', { type: 'button', onclick: () => this._newProfile() }, 'New profile');
    return h('div', h('div.admin__bar', search, add), holder);
  },

  _columns() {
    return [
      { key: 'name', label: 'Name', cls: 'admin__col-name' },
      { key: 'createdAt', label: 'Created', cls: 'admin__col-date' },
      { key: 'lastSeen', label: 'Last seen', cls: 'admin__col-seen' },
      { key: 'addedSongs', label: 'Songs', cls: 'admin__col-num' },
      { key: 'seconds', label: 'Time listened', cls: 'admin__col-time' },
    ];
  },

  _profileTable(rows, meId, redraw) {
    const table = h('table.table.admin__table');
    const columns = [
      ...this._columns().map((c) => ({ ...c, render: (p) => this._cell(p, c.key, meId) })),
      {
        key: 'actions', label: 'Actions', sortable: false, cls: 'admin__col-actions', render: (p) => this._actions(p, meId),
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
    return h('div.actions', iconButton('act.act--grey', Icons.more, 'Actions', () => this._moreDialog(p, meId)));
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
        h('dt', 'Logged in on'), h('dd', Util.plural(p.devices, 'device')));
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
      btn('Connection History', () => this._showIps(p)),
      !locked && p.pin ? btn('Reset PIN', () => this._removePin(p)) : null,
      !locked && p.devices ? btn('Log out everywhere', () => this._signOut(p)) : null,
    ].filter(Boolean);
    const second = [
      Store.server.master && !p.master ? btn(p.admin ? 'Revoke Admin' : 'Make Admin', () => this._setAdmin(p)) : null,
      !locked ? btn(p.disabled ? 'Enable' : 'Disable', () => this._disable(p)) : null,
      !locked ? btn('Delete Profile', () => this._delete(p), '.btn--danger') : null,
    ].filter(Boolean);
    return h('div.admin__pgroups', h('div.admin__pactions', ...first), second.length ? h('div.admin__pactions', ...second) : null);
  },

  _moreDialog(p, meId) {
    let handle = null;
    handle = Modal.open({
      title: p.name,
      className: 'modal--small',
      body: [this._buttons(p, meId, () => handle.close())],
      buttons: [{ label: 'Close' }],
    });
  },

  async _showIps(p) {
    const r = await attempt(() => window.flow.admin(`profiles/${p.id}/ips`));
    if (!r) return;
    const rows = r.ips.map((e) => h('tr', h('td', e.ip), h('td', e.device || ''), h('td', Util.fmtDate(e.at))));
    Modal.open({
      title: `${p.name}: Connection History`,
      className: 'modal--admin-ips',
      body: [
        h('p.modal__text', 'Made from: ', h('strong', r.createdIp || 'not recorded (made before Flow 3.5)')),
        rows.length
          ? h('table.admin__ips', h('thead', h('tr', h('th', 'IP'), h('th', 'Device'), h('th', 'Last time'))), h('tbody', ...rows))
          : h('p.settings__note', 'No connections recorded yet.'),
        h('p.settings__note', `The newest ${r.ips.length} of up to 100.`),
      ],
      buttons: [{ label: 'Close', kind: 'primary' }],
    });
  },

  async _delete(p) {
    const answer = await confirmDialog({
      title: 'Delete Profile',
      message: `Do you really want to delete the profile ${p.name}?`,
      confirmLabel: 'Delete',
      danger: true,
      checkbox: { label: 'Also delete all songs that belong to this profile' },
    });
    if (!answer) return;
    let deleted = 0;
    await this._do(async () => {
      ({ deletedSongs: deleted } = await window.flow.admin(`profiles/${p.id}/delete`, { songs: answer.checked }));
    });
    toast(answer.checked ? `Profile "${p.name}" and ${Util.plural(deleted, 'song')} deleted` : `Profile "${p.name}" deleted`, 'info');
  },

  async _removePin(p) {
    if (!(await this._confirm('Reset PIN', `Reset the PIN of ${p.name}? It then has none: anyone can log in to it, and set a new one in Settings under Profile with Change PIN.`, 'Reset PIN'))) return;
    await this._do(() => window.flow.admin(`profiles/${p.id}/pin`, {}), `${p.name} has no PIN now`);
  },

  async _signOut(p) {
    if (!(await this._confirm('Log out everywhere', `Log ${p.name} out on all ${Util.plural(p.devices, 'device')}? They stay on the server, without a profile.`, 'Log out'))) return;
    await this._do(() => window.flow.admin(`profiles/${p.id}/signout`, {}), `${p.name} logged out everywhere`);
  },

  async _disable(p) {
    const off = !p.disabled;
    if (off && !(await this._confirm('Disable profile', `Disable ${p.name}? Nobody can log in to it until it is enabled again; its devices are logged out. Nothing of it is deleted.`, 'Disable', true))) return;
    await this._do(() => window.flow.admin(`profiles/${p.id}/disable`, { disabled: off }), off ? `${p.name} disabled` : `${p.name} enabled`);
  },

  async _setAdmin(p) {
    const on = !p.admin;
    const message = on
      ? `Make ${p.name} an admin? It can then see and change everything here except the server password.`
      : `Revoke admin from ${p.name}? It then no longer sees Administration.`;
    if (!(await this._confirm(on ? 'Make Admin' : 'Revoke Admin', message, on ? 'Make Admin' : 'Revoke', on ? false : 'light-red'))) return;
    await this._do(() => window.flow.admin(`profiles/${p.id}/admin`, { admin: on }), on ? `${p.name} is an admin now` : `${p.name} is no admin any more`);
  },

  _newProfile() {
    const name = h('input.input', { type: 'text', placeholder: 'Name', maxLength: 40, spellcheck: false, autocomplete: 'off' });
    const pin = h('input.input', { type: 'password', placeholder: 'PIN (optional)', autocomplete: 'new-password' });
    Modal.open({
      title: 'New profile',
      className: 'modal--small',
      focus: 'input',
      body: [h('p.modal__text', 'A profile for someone else. You stay logged in as yourself.'), h('div.admin__form', name, pin)],
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Create',
          kind: 'primary',
          onClick: async () => {
            const made = await attempt(() => window.flow.admin('profiles', { name: name.value, pin: pin.value }));
            if (!made) return false;
            toast(`Profile "${made.profile.name}" made`, 'success');
            this.load();
            return true;
          },
        },
      ],
    });
  },

  // ---- Failed logins ----

  _failures(r) {
    if (r.error) return this._failed(r);
    if (!r.failures.length) return h('p.settings__note', 'None.');
    const shown = r.failures.slice(0, 100);
    const rows = shown.map((f) => h('li.admin__item',
      h('span.admin__item-main', f.kind === 'pin' ? `Wrong PIN for ${f.profileName || 'a deleted profile'}` : 'Wrong server password'),
      h('span.admin__item-sub', ...this._parts([Util.fmtDate(f.at), f.ip, f.device]))));
    const more = r.failures.length > shown.length ? h('p.settings__note', `The newest ${shown.length} of ${r.failures.length}.`) : null;
    const clearBtn = h('button.btn.btn--small', {
      type: 'button',
      onclick: async () => {
        if (await this._confirm('Clear the list', 'Forget every failed login?', 'Clear')) await this._do(() => window.flow.admin('signins/clear', {}));
      },
    }, 'Clear the list');
    return h('div', this._list(rows), more, h('div.admin__bar', clearBtn));
  },

  // ---- Server downloads and Active Sessions ----

  _downloads(r) {
    if (r.error) return this._failed(r);
    if (!r.batches.length) return h('p.settings__note', 'No server downloads running.');
    return this._list(r.batches.map((b) => h('li.admin__item.admin__item--row',
      h('span.admin__item-text',
        h('span.admin__item-main', `${b.profileName}: ${b.name || b.url || 'a download'}`),
        h('span.admin__item-sub', ...(b.state === 'listing' ? ['Reading the link...']
          : this._parts([`${b.saved} of ${b.songs} saved, ${b.open} still open${b.failed ? `, ${b.failed} failed` : ''}`, `since ${Util.fmtDate(b.createdAt)}`])))),
      h('button.btn.btn--small', {
        type: 'button',
        onclick: async () => {
          if (!(await this._confirm('Cancel download', `Cancel ${b.profileName}'s server download, with every song in it not saved yet?`, 'Cancel download', true))) return;
          await this._do(() => window.flow.admin('downloads/cancel', { key: b.key }), 'Download cancelled');
        },
      }, 'Cancel'))));
  },

  _sessions(r) {
    if (r.error) return this._failed(r);
    if (!r.sessions.length) return h('p.settings__note', 'Nothing is playing on the server right now.');
    return this._list(r.sessions.map((s) => h('li.admin__item.admin__item--row',
      h('span.admin__item-text',
        h('span.admin__item-main', s.name),
        h('span.admin__item-sub', ...this._parts([
          s.song ? Util.songLine(s.song) : 'nothing playing',
          s.playing ? 'playing' : 'paused',
          Util.plural(s.listeners, 'listener'),
          s.shared ? '' : 'not shared',
        ]))),
      s.listeners ? h('button.btn.btn--small', {
        type: 'button',
        onclick: async () => {
          if (!(await this._confirm('End session', `End "${s.name}"? Everyone listening along is out; the host plays on alone.`, 'End session', true))) return;
          await this._do(() => window.flow.admin('sessions/end', { id: s.id }), 'Session ended');
        },
      }, 'End') : null)));
  },

  // ---- Trash ----

  _trash(r) {
    if (r.error) return this._failed(r);
    if (!r.items.length) return h('p.settings__note', 'The trash is empty. Deleted songs stay in it for 30 days.');
    const rows = r.items.map((t) => h('li.admin__item.admin__item--row',
      h('span.admin__item-text',
        h('span.admin__item-main', t.artist ? `${t.title} - ${t.artist}` : t.title),
        h('span.admin__item-sub', ...this._parts([t.by ? `Deleted by ${t.by}` : 'Deleted', Util.fmtDate(t.at), t.addedBy ? `Added by ${t.addedBy}` : '']))),
      h('button.btn.btn--small', {
        type: 'button',
        onclick: () => this._do(() => window.flow.admin('trash/restore', { name: t.name }), `"${t.title}" is back`),
      }, 'Restore')));
    const empty = h('button.btn.btn--small.btn--danger', {
      type: 'button',
      onclick: async () => {
        if (!(await this._confirm('Empty trash', `Delete all ${Util.plural(r.items.length, 'file')} in the trash for good (${fmtBytes(r.bytes)})?`, 'Empty trash', true))) return;
        await this._do(() => window.flow.admin('trash/empty', {}), 'Trash emptied');
      },
    }, 'Empty trash');
    return h('div', h('p.settings__note', `${Util.plural(r.items.length, 'file')}, ${fmtBytes(r.bytes)}. Each one is deleted for good 30 days after it was deleted.`),
      this._list(rows), h('div.admin__bar', empty));
  },

  // ---- Server rules ----

  _rules(r) {
    if (r.error) return this._failed(r);
    const select = (key, options) => {
      const node = h('select.select', ...options.map(([v, label]) => h('option', { value: v }, label)));
      node.value = r[key];
      node.addEventListener('change', () => this._do(() => window.flow.admin('rules', { [key]: node.value }), 'Saved'));
      return node;
    };
    return h('div.admin__rules',
      h('label.admin__rule', h('span', 'Who may make new profiles'),
        select('profileCreation', [['anyone', 'Everyone'], ['admins', 'Only admins']])),
      h('label.admin__rule', h('span', 'Who may delete songs for everyone'),
        select('songDelete', [['anyone', 'Everyone'], ['owner', 'Only who added it, and admins']])));
  },

  // ---- Server password (master admin) ----

  _password(o) {
    if (o.error) return this._failed(o);
    const field = (placeholder) => h('input.input', { type: 'password', placeholder, autocomplete: 'new-password' });
    const current = o.password ? field('Current password') : null;
    const next = field('New password');
    const again = field('New password again');
    const change = h('button.btn.btn--small.btn--primary', {
      type: 'button',
      onclick: async () => {
        if (next.value !== again.value) {
          toast('The two new passwords do not match.', 'error');
          return;
        }
        if (!(await this._confirm('Change password', 'Change the server password? Every other device has to enter the new one.', 'Change'))) return;
        await this._do(() => window.flow.changeServerPassword({ current: current ? current.value : '', password: next.value }), 'Password changed');
      },
    }, o.password ? 'Change password' : 'Set password');
    const remove = o.password && !(o.level >= 3) ? h('button.btn.btn--small', {
      type: 'button',
      onclick: async () => {
        if (!(await this._confirm('Remove password', 'Remove the server password? Anyone who can reach the server can then use it.', 'Remove', true))) return;
        await this._do(() => window.flow.changeServerPassword({ current: current ? current.value : '', remove: true }), 'Password removed');
      },
    }, 'Remove password') : null;
    const rule = o.level >= 3
      ? 'Reachable from the internet: at least 8 characters with a lower-case letter, an upper-case letter and a number.'
      : 'At least 4 characters.';
    return h('div',
      h('p.settings__note', `${rule} Every other device has to enter the new password once; this one carries on.`),
      h('div.admin__form', current, next, again),
      h('div.admin__bar', change, remove));
  },
};
