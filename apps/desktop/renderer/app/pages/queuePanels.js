'use strict';

// The Client queue and Server queue frames on Add Songs (4.4), under the
// link box and above the batches. A line per link waiting:
//
//   [profile] (Server queue only)  name - N songs - link    state  [Cancel]
//
// The name and count are read when the link is queued (listing.peek), so
// "Reading its name..." shows until then. The Client queue's lines are this
// window's (ClientQueue), each with Cancel. The Server queue's are every
// profile's batches on the server still waiting for their turn, and the one
// downloading now when it is another profile's (the profile's own batches
// that have their turn are panels of their own below, import.js); only the
// profile's own lines have Cancel. The Server queue shows while something
// waits there.

const QueuePanels = {
  init() {
    ClientQueue.onChange(() => this.drawClient());
    ServerImport.onChange(() => this.drawServer());
    this.drawClient();
    this.drawServer();
  },

  /** One line: the profile (server only), name, count and link, its state, Cancel. */
  _row({
    profile = '', name, count, url, state, bad = false, cancel = null,
  }) {
    const what = h('span.queue-row__what',
      profile ? h('span.queue-row__profile', profile) : null,
      h('span.queue-row__name', { title: name }, name),
      count ? h('span.queue-row__count', ` - ${count}`) : null,
      url ? h('span.queue-row__url', { title: url }, ` - ${url}`) : null);
    return h('div.queue-row',
      what,
      h('span.queue-row__state' + (bad ? '.queue-row__state--bad' : ''), { title: state }, state),
      cancel ? h('button.btn.btn--small.btn--light-red', { type: 'button', onclick: cancel }, T('common.cancel')) : null);
  },

  drawClient() {
    const panel = $('clientQueuePanel');
    if (!panel) return;
    const entries = ClientQueue.entries;
    panel.hidden = !entries.length;
    const box = clear($('clientQueueRows'));
    entries.forEach((e, i) => {
      const peek = e.peek;
      let state = i === 0 ? T('add.queue.next') : T('add.queue.waiting');
      let bad = false;
      let count = '';
      if (!peek) state = T('add.queue.readingName');
      else if (peek.error) {
        state = peek.error;
        bad = true;
      } else if (peek.count) {
        count = Util.plural(peek.count, 'song');
      }
      box.appendChild(this._row({
        name: ClientQueue.label(e),
        count,
        url: e.local ? '' : e.url,
        state,
        bad,
        cancel: () => ClientQueue.cancel(e.id),
      }));
    });
  },

  drawServer() {
    const panel = $('serverQueuePanel');
    if (!panel) return;
    const rows = ServerImport.rows.filter((r) => r.state === 'queued' || !r.own);
    panel.hidden = !rows.some((r) => r.state === 'queued');
    const box = clear($('serverQueueRows'));
    if (panel.hidden) return;
    for (const r of rows) {
      let state;
      if (r.state === 'queued') state = T('serverImport.waitingTurn', { place: r.place || 1 });
      else if (r.state === 'listing') state = T('add.queue.readingNow');
      else state = T('add.queue.downloadingNow');
      const named = !!r.name;
      box.appendChild(this._row({
        profile: r.profileName || '',
        name: named ? r.name : (r.url || ''),
        count: r.count ? Util.plural(r.count, 'song') : '',
        url: named ? r.url : '',
        state: !named && r.state === 'queued' ? `${T('add.queue.readingName')} ${state}` : state,
        cancel: r.own ? () => {
          ServerImport.touch();
          ServerImport.cancelBatch(r.id).catch((err) => toast(err.message, 'error'));
          ServerImport.rows = ServerImport.rows.filter((x) => x.id !== r.id);
          this.drawServer();
        } : null,
      }));
    }
  },
};
