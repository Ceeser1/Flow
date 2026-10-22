'use strict';

// Settings' Statistics (3.6), right above Administration. All tracked
// Profiles: every profile used on this app and its Private Statistics, one
// picked to show (the one in use at first), each but the one in use
// removable. Statistics for profile: the picked
// one's numbers (with its streaks and longest sessions) and its Activity, a
// bar per month back to when it was made, or per day (Monthly / Daily; a
// month clicked opens its days).
// A server's pencil names it on this device, as Switch server's does.
// The numbers come from statistics.js; drawn when Settings opens, and again
// a moment after the status or the Private Statistics change (every listen
// changes them).

const Stats = {
  _node: null,
  _picked: null, // the source shown (statistics.js ids); null: the one in use
  _editing: null, // the row whose server is being named (its id)
  _mode: 'monthly', // Activity's graph: 'monthly' or 'daily'
  _month: null, // the month Daily shows ('YYYY-MM': one clicked in Monthly; null: this one)
  _private: null, // window.flow.privateStatistics()
  _timer: null,
  _busy: false,
  _listening: false,

  /** The category: its heading and the node it is drawn into. */
  rows() {
    this._node = h('div.stats');
    this._picked = null;
    this._editing = null;
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

  draw(force = false) {
    if (!this._node || !this._node.isConnected) return;
    // Not while a server's name is typed: drawn again when it is done.
    if (this._editing && !force) return;
    const mobile = document.body.classList.contains('mobile');
    const st = Store.server;
    const list = Statistics.sources(st, this._private);
    const current = list.find((x) => x.current);
    const shown = list.find((x) => x.id === this._picked) || current;
    // Where the graph was scrolled to stays (it opens at the newest month,
    // or day), also through a redraw; not when it shows something else.
    const old = this._node.querySelector('.stats__scroll');
    const scrolled = old && old.dataset.shows === this._shows() ? old.scrollLeft : 0;
    clear(this._node).append(
      this._block('All tracked Profiles', this._list(list, shown, mobile)),
      this._block(Statistics.title(shown, Store.settings.serverNames),
        // Two columns side by side; one list on phones.
        h('div.stats__facts', ...Statistics.facts(shown).map((rows) => h('dl.admin__facts', ...rows.flatMap(([k, v]) => [h('dt', k), h('dd', v)])))),
        this._activityHead(),
        this._graph(shown, mobile)),
    );
    const scroller = this._node.querySelector('.stats__scroll');
    if (scroller) scroller.scrollLeft = scrolled;
  },

  /** What the graph shows: Monthly, or Daily and its month. */
  _shows() {
    return this._mode === 'daily' ? `daily ${this._month || ''}` : 'monthly';
  },

  _block(title, ...body) {
    return h('section.stats__block', h('h4.stats__head', title), ...body);
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
      x.id === Statistics.PRIVATE ? h('span.stats__tcell', mobile ? 'This app' : 'This app, every server') : this._serverCell(x),
      h('span.stats__tcell', h('span.cell-title', x.profile), x.current ? h('span.admin__badge.admin__badge--you', 'in use') : null),
      h('span.stats__tcell.stats__tact', remove));
      return row;
    });
    const body = h('div.stats__tbody', ...rows);
    return h('div.stats__table', head, Admin._scrollRows(body, () => body.children));
  },

  /** The server's name as given on this device, its own in brackets, and the pencil (or the box and its tick). */
  _serverCell(x) {
    const name = Util.serverName(Store.settings.serverNames, x.serverId, x.server);
    if (this._editing === x.id) {
      const { input, tick } = SettingsPanel._nameBox(name, (text) => {
        this._editing = null;
        if (text !== null) SettingsPanel._renameServer(x.serverId, x.server, text);
        this.draw();
      }, 'stats__name');
      return h('span.stats__tcell', input, tick);
    }
    const edit = iconButton('act.act--grey.stats__rename', Icons.pencil, `Rename "${name.name}" on ${Store.here}`, (e) => {
      e.stopPropagation();
      this._editing = x.id;
      this.draw(true);
    });
    edit.disabled = this._busy;
    return h('span.stats__tcell',
      h('span.cell-title', name.name),
      name.renamed ? h('span.stats__own', `(${name.original})`) : null,
      edit);
  },

  async _remove(x) {
    const answer = await confirmDialog({
      title: 'Remove tracked Profile',
      message: `Remove "${x.profile}" on ${Util.serverName(Store.settings.serverNames, x.serverId, x.server).name} from this app? Its statistics kept here are deleted, with its listens `
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

  /** Activity's heading, Monthly / Daily on its right. */
  _activityHead() {
    const mode = (name, label) => h('button.stats__mode' + (this._mode === name ? '.stats__mode--on' : ''), {
      type: 'button',
      'aria-pressed': String(this._mode === name),
      onclick: () => {
        if (this._mode === name) return;
        this._mode = name;
        // Daily opens at the current month.
        this._month = null;
        this.draw();
      },
    }, label);
    return h('div.stats__ahead', h('h4.stats__head', 'Activity'),
      h('div.stats__modes', mode('monthly', 'Monthly'), mode('daily', 'Daily')));
  },

  /** A line's number: 0.5 h, 10 h. */
  _step(hours, step) {
    return `${step < 1 ? hours.toFixed(1) : Math.round(hours)} h`;
  },

  /**
   * Activity, Monthly: every month from January of the year it was made, each
   * year's total after its December and the current year's after this month
   * (in red); a month clicked opens Daily for it. Daily: the days of one
   * month (the current one up to today), its total after them. Lines in whole steps (Statistics.scale) for the
   * highest month or day, the bars against the top one, a total's full at
   * most. Names as Oct and Mon on phones.
   */
  _graph(src, mobile) {
    const daily = this._mode === 'daily';
    const items = daily
      ? Statistics.daily(src.statistics, this._month, Date.now())
      : Statistics.timeline(src.statistics, src.createdAt, Date.now());
    const scale = Statistics.scale(Math.max(0, ...items.filter((x) => !x.isTotal).map((x) => x.hours)));
    const col = (m) => {
      const share = scale.top ? Math.min(1, m.hours / scale.top) : 0;
      const bar = this._bar(share, mobile ? 136 : 156, m.isTotal ? '.stats__bar--year' : '');
      const hours = this._hours(m.hours) || (m.isTotal ? '0 h' : '');
      let title = `${m.title || `${m.name} ${m.year}`}: ${hours || 'nothing'} listened`;
      if (m.isYear) title = `${m.year}: ${hours} listened`;
      const open = !daily && !m.isTotal;
      if (open) title += ' - click for its days';
      return h('div.stats__month' + (m.isTotal ? '.stats__month--year' : '') + (open ? '.stats__month--open' : ''), {
        title,
        dataset: { key: m.key },
        onclick: open ? () => {
          this._mode = 'daily';
          this._month = m.key;
          this.draw();
        } : null,
      },
      h('span.stats__hours', hours),
      h('span.stats__barbox', bar),
      h('span.stats__mname', mobile ? m.short : m.name));
    };
    // Newest first in the row, laid out from the right (row-reverse): the
    // graph opens on the current month (or today) without scrolling, hidden or not.
    const scroller = h('div.stats__scroll', { dataset: { shows: this._shows() } }, ...items.slice().reverse().map(col));
    // Each line starts at its number on the left and runs to the right, behind the bars.
    const lines = scale.lines.map((hours) => {
      const line = h('div.stats__gline', h('span.stats__gnum', this._step(hours, scale.step)), h('span.stats__grule'));
      line.style.bottom = `${Math.round((hours / scale.top) * 1000) / 10}%`;
      return line;
    });
    return h('div.stats__graph', h('div.stats__grid', ...lines), scroller);
  },

  /**
   * A bar `share` of its box (`box` px high) tall. One too low for its round
   * top (nothing listened: 1px) is flat: the corners drew stray pixels.
   */
  _bar(share, box, cls = '') {
    const bar = h('span.stats__bar' + cls + (share * box < 4 ? '.stats__bar--flat' : ''));
    bar.style.height = `${Math.round(share * 1000) / 10}%`;
    return bar;
  },
};
