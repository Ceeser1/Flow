'use strict';

// Settings' Statistics (3.6), right above Administration. Current Profile:
// whose listens count now (a hint line saying why), with Logout and the
// profile's ⋯ as in Flow Server > Profile. All tracked Profiles: every
// profile used on this app and its Private Statistics, one picked to show,
// each but the one in use removable. Your Statistics for ...: the picked
// one's numbers and its Activity, a bar per month back to when it was made.
// The numbers come from statistics.js; drawn when Settings opens, and again
// a moment after the status or the Private Statistics change (every listen
// changes them).

const Stats = {
  _node: null,
  _picked: null, // the source shown (statistics.js ids); null: the one in use
  _private: null, // window.flow.privateStatistics()
  _timer: null,
  _busy: false,
  _listening: false,

  /** The category: its heading and the node it is drawn into. */
  rows() {
    this._node = h('div.stats');
    this._picked = null;
    return [h('h3.settings__section', 'Statistics'), this._node];
  },

  /** Fetches the Private Statistics and draws (Settings opened). */
  async load() {
    if (!this._listening) {
      this._listening = true;
      window.flow.onPrivateStatistics((data) => {
        this._private = data;
        this.soon();
      });
    }
    this.draw();
    try {
      this._private = await window.flow.privateStatistics();
    } catch {
      // Drawn without them.
    }
    this.draw();
  },

  /** Drawn again in a moment: a playing song changes the numbers often. */
  soon() {
    if (!this._node || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.draw();
    }, 500);
  },

  draw() {
    if (!this._node || !this._node.isConnected) return;
    const mobile = document.body.classList.contains('mobile');
    const st = Store.server;
    const list = Statistics.sources(st, this._private);
    const current = list.find((x) => x.current);
    const shown = list.find((x) => x.id === this._picked) || current;
    // Where the graph was scrolled to stays (it opens at the newest month).
    const old = this._node.querySelector('.stats__scroll');
    const scrolled = old ? old.scrollLeft : 0;
    // The ⋯ tray belongs to the row about to be drawn anew.
    if (SongActions.anchor && this._node.contains(SongActions.anchor)) SongActions.close();
    clear(this._node).append(
      this._block('Current Profile', this._hints(st), this._currentRow(st, current)),
      this._block('All tracked Profiles', this._list(list, shown, mobile)),
      this._block(`Your Statistics for ${shown.name}`,
        h('dl.admin__facts.stats__facts', ...Statistics.facts(shown).flatMap(([k, v]) => [h('dt', k), h('dd', v)])),
        h('h5.stats__sub', 'Activity'),
        this._graph(shown, mobile)),
    );
    const scroller = this._node.querySelector('.stats__scroll');
    if (scroller) scroller.scrollLeft = scrolled;
  },

  _block(title, ...body) {
    return h('section.stats__block', h('h4.stats__head', title), ...body);
  },

  // ---- Current Profile ----

  _hints(st) {
    return h('div.stats__hints', ...Statistics.hints(st).map((x) => h(`p.stats__hint.stats__hint--${x.kind}`, x.text)));
  },

  _currentRow(st, current) {
    const online = st.on && st.state === 'online';
    const profile = st.on ? st.profile : null;
    const btn = (label, onclick, extra = '') => h('button.btn.btn--small' + extra, { type: 'button', disabled: this._busy, onclick }, label);
    const logout = btn('Logout', () => this._do(async () => {
      await window.flow.profileLogout();
      toast(`Logged out of "${profile.name}"`, 'info');
    }));
    // Private is no profile to leave.
    logout.disabled = this._busy || !profile;
    const parts = [h('span.profile-who', 'Profile - ', h('strong', current.name)), logout];
    // The same tray as Flow Server > Profile's ⋯: only while the server can be reached.
    if (profile && online) {
      const more = iconButton('act.act--grey', Icons.more, 'More', () => {
        if (SongActions.anchor === more) {
          SongActions.close();
          return;
        }
        SongActions.open(more, [
          btn('Edit Name', () => SettingsPanel._editProfileName(profile)),
          btn('Change PIN', () => SettingsPanel._changeProfilePin(profile)),
          btn('Delete Profile', () => SettingsPanel._deleteProfile(profile), '.btn--danger'),
        ], 'act-tray--settings');
      });
      more.disabled = this._busy;
      parts.push(more);
    }
    return h('div.stats__current.profile-control', ...parts);
  },

  async _do(fn) {
    if (this._busy) return;
    this._busy = true;
    this.draw();
    try {
      await attempt(fn);
    } finally {
      this._busy = false;
      this.draw();
    }
  },

  // ---- All tracked Profiles ----

  _list(list, shown, mobile) {
    const head = h('div.stats__trow.stats__trow--head',
      h('span.stats__tcell', 'Server'), h('span.stats__tcell', 'Profile'), h('span.stats__tcell.stats__tact', 'Action'));
    const rows = list.map((x) => {
      const remove = h('button.btn.btn--small', {
        type: 'button',
        disabled: !x.removable,
        title: x.current ? 'In use: log out of it first' : (x.id === Statistics.PRIVATE ? 'This app\'s own: it always counts' : ''),
        onclick: (e) => {
          e.stopPropagation();
          this._remove(x);
        },
      }, 'Remove');
      const row = h('div.stats__trow' + (x === shown ? '.stats__trow--on' : ''), {
        role: 'button',
        tabIndex: 0,
        'aria-pressed': String(x === shown),
        onclick: () => {
          this._picked = x.id;
          this.draw();
        },
        onkeydown: (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          this._picked = x.id;
          this.draw();
        },
      },
      h('span.stats__tcell', x.id === Statistics.PRIVATE ? (mobile ? 'This app' : 'This app, every server') : x.server),
      h('span.stats__tcell', h('span.cell-title', x.profile), x.current ? h('span.admin__badge.admin__badge--you', 'in use') : null),
      h('span.stats__tcell.stats__tact', remove));
      return row;
    });
    const body = h('div.stats__tbody', ...rows);
    return h('div.stats__table', head, Admin._scrollRows(body, () => body.children));
  },

  async _remove(x) {
    const answer = await confirmDialog({
      title: 'Remove tracked Profile',
      message: `Remove "${x.profile}" on ${x.server} from this app? Its statistics kept here are deleted, with its listens `
        + 'not sent to the server yet, and it is no longer kept up to date. What the server has stays: logging in to it '
        + 'again brings its statistics back.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!answer) return;
    await this._do(async () => {
      await window.flow.removeTrackedProfile(x.serverId, x.profileId);
      if (this._picked === x.id) this._picked = null;
      toast(`"${x.profile}" removed`, 'info');
    });
  },

  // ---- Activity ----

  _hours(hours) {
    if (!(hours > 0)) return '';
    if (hours < 0.1) return '<0.1 h';
    return hours >= 10 ? `${Math.round(hours)} h` : `${hours.toFixed(1)} h`;
  },

  _graph(src, mobile) {
    const months = Statistics.months(src.statistics, src.createdAt, Date.now());
    // Newest first in the row, laid out from the right (row-reverse): the
    // graph opens on the current month without scrolling, hidden or not.
    const cols = months.slice().reverse().map((m, i, all) => {
      const bar = h('span.stats__bar');
      bar.style.height = `${Math.round(m.share * 100)}%`;
      // The year under January and under the oldest month.
      const year = m.key.endsWith('-01') || i === all.length - 1 ? m.year : '';
      return h('div.stats__month', { title: `${m.name} ${m.year}: ${this._hours(m.hours) || 'nothing'} listened` },
        h('span.stats__hours', this._hours(m.hours)),
        h('span.stats__barbox', bar),
        h('span.stats__mname', mobile ? m.short : m.name),
        h('span.stats__year', year));
    });
    return h('div.stats__scroll', ...cols);
  },
};
