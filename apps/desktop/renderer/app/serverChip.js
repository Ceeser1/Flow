'use strict';

// The line under Flow's name while a Flow Server is in use: which server and
// whether it can be reached, what is going up or down, and how many changes
// wait to be sent. A click opens Settings.

const ServerChip = {
  _wasOnline: null,

  init() {
    $('serverChip').onclick = () => SettingsPanel.open();
    Store.onServer((st) => this.draw(st));
    this.draw(Store.server);
  },

  /** One line for a server state, also used by Settings. */
  describe(st) {
    if (!st || !st.on) return { text: '', kind: 'off' };
    const name = st.name ? `"${st.name}"` : 'the server';
    const waiting = st.queued ? ` · ${Util.plural(st.queued, 'change')} waiting` : '';
    if (st.state === 'online') {
      const where = st.via === 'remote' ? 'remote' : 'home';
      return { text: `Connected to ${name} (${where})${waiting}`, kind: 'online' };
    }
    if (st.state === 'connecting') return { text: `Connecting...${waiting}`, kind: 'busy' };
    if (st.state === 'password') return { text: st.message || 'The server needs its PIN or password.', kind: 'error' };
    if (st.state === 'error') return { text: st.message || 'Something is wrong with the server.', kind: 'error' };
    return { text: `Offline: the server cannot be reached${waiting}`, kind: 'offline' };
  },

  draw(st) {
    const chip = $('serverChip');
    chip.hidden = !st.on;
    if (!st.on) {
      this._wasOnline = null;
      return;
    }
    const { text, kind } = this.describe(st);
    const short = kind === 'online' ? (st.name || 'Server')
      : kind === 'busy' ? 'Connecting...'
        : kind === 'error' ? 'Server: needs attention' : 'Server offline';
    const extra = st.transfer ? (st.transfer.startsWith('Up') ? 'uploading' : 'downloading')
      : st.queued ? `${st.queued} waiting` : '';
    chip.className = `server-chip server-chip--${kind}`;
    chip.title = [text, st.transfer, st.note].filter(Boolean).join('\n');
    clear(chip).append(
      h('span.server-chip__dot'),
      h('span.server-chip__name', short),
      extra ? h('span.server-chip__extra', extra) : '',
    );
    // Losing the server and getting it back are worth a word; the rest the chip says.
    const online = st.state === 'online';
    if (this._wasOnline === true && st.state === 'offline') toast('The server cannot be reached. Downloaded songs still play; changes wait until it is back.', 'info');
    if (this._wasOnline === false && online) toast(`Connected to "${st.name}" again`, 'success');
    if (st.state === 'online' || st.state === 'offline') this._wasOnline = online;
  },
};
