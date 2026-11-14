'use strict';

// The line under Flow's name while a Flow Server is in use: which server and
// whether it can be reached, what is going up or down, and how many changes
// wait to be sent. A click opens Settings.
//
// The web player has Logout beside it, under the settings button: the
// browser forgets the server (window.flow.logout) and the page starts again
// at the connect form (welcome.js).

const ServerChip = {
  _wasOnline: null,
  _row: null,

  init() {
    $('serverChip').onclick = () => SettingsPanel.open();
    if (Store.web) this._addLogout();
    Store.onServer((st) => this.draw(st));
    this.draw(Store.server);
  },

  _addLogout() {
    const chip = $('serverChip');
    this._row = h('div.server-row');
    chip.before(this._row);
    this._row.append(chip, h('button.server-logout', {
      type: 'button',
      title: T('serverChip.logout.tooltip'),
      onclick: () => this.logout(),
    }, T('common.logout')));
  },

  async logout() {
    Player.stop();
    try {
      await window.flow.logout();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    location.reload();
  },

  /** How the server is reached, as a word: Home, Tailscale or Remote. */
  via(st) {
    return st.via === 'remote' ? (st.tailscale ? 'Tailscale' : T('serverChip.via.remote')) : T('serverChip.via.home');
  },

  /** One line for a server state, also used by Settings. */
  describe(st) {
    if (!st || !st.on) return { text: '', kind: 'off' };
    const name = st.name ? T('serverChip.serverName', { server: st.name }) : T('serverChip.theServer');
    const waiting = st.queued ? ` ${T('serverChip.changesWaiting', { changes: Util.plural(st.queued, 'change') })}` : '';
    if (st.state === 'online') {
      const via = this.via(st);
      const text = st.profile ? T('serverChip.connected.asProfile', { server: name, profile: st.profile.name, via }) : T('serverChip.connected', { server: name, via });
      return { text: text + waiting, kind: 'online' };
    }
    if (st.state === 'connecting') return { text: T('common.connecting') + waiting, kind: 'busy' };
    if (st.state === 'password') return { text: st.message || T('serverChip.needsPassword'), kind: 'error' };
    if (st.state === 'error') return { text: st.message || T('serverChip.somethingWrong'), kind: 'error' };
    return { text: T('serverChip.offline') + waiting, kind: 'offline' };
  },

  draw(st) {
    const chip = $('serverChip');
    chip.hidden = !st.on;
    if (this._row) this._row.hidden = !st.on;
    if (!st.on) {
      this._wasOnline = null;
      return;
    }
    const { text, kind } = this.describe(st);
    // Online: "Server: Pi as Ceeser (Home)", with Tailscale or Remote away from home.
    const server = st.name || T('common.server');
    const short = kind === 'online' ? (st.profile ? T('serverChip.short.serverAsProfile', { server, profile: st.profile.name, via: this.via(st) })
      : T('serverChip.short.server', { server, via: this.via(st) }))
      : kind === 'busy' ? T('common.connecting')
        : kind === 'error' ? T('serverChip.short.needsAttention') : T('serverChip.short.offline');
    const extra = st.transfer ? (st.transferUp ? T('serverChip.extra.uploading') : T('serverChip.extra.downloading'))
      : st.queued ? T('serverChip.extra.waiting', { count: st.queued }) : '';
    // Only what differs is set: a state told again leaves the line as it is.
    const cls = `server-chip server-chip--${kind}`;
    if (chip.className !== cls) chip.className = cls;
    const title = [text, st.transfer, st.note].filter(Boolean).join('\n');
    if (chip.title !== title) chip.title = title;
    setChildren(chip, [
      h('span.server-chip__dot'),
      h('span.server-chip__name', short),
      ...(extra ? [h('span.server-chip__extra', extra)] : []),
    ]);
    // Losing the server and getting it back are worth a word; the rest the chip says.
    const online = st.state === 'online';
    if (this._wasOnline === true && st.state === 'offline') toast(T('serverChip.toast.lost'), 'info');
    if (this._wasOnline === false && online) toast(T('serverChip.toast.back', { server: st.name }), 'success');
    if (st.state === 'online' || st.state === 'offline') this._wasOnline = online;
  },
};
