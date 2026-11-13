'use strict';

// Your listening trend: the lists made from how you listen (smartLists.js).
// A main entry in the menu, its lists under it closed until opened. They fill
// themselves and cannot be changed by hand, so they have no actions.

const TrendPage = {
  sort: { key: null, dir: null },

  init() {
    // Its lists follow what was listened to: drawn again for a listen too, not for a cover or loudness.
    Store.onLibrary((lib, change) => {
      if (Nav.page === 'trend' && (!change.quiet() || change.field('stats'))) this.render();
    });
  },

  show() {
    this.render();
  },

  _value(p, key) {
    if (key === 'name') return p.name;
    if (key === 'desc') return p.desc || '';
    if (key === 'songs') return p.entries.length;
    if (key === 'duration') return Store.totalDuration(p.id);
    if (key === 'listened') return Store.listenedTo(p.id);
    return '';
  },

  render() {
    const lists = Store.smartPlaylists();
    $('trendCount').textContent = Util.plural(lists.length, 'list');
    renderTable($('trendTable'), {
      rows: Util.sortRows(lists, this.sort, (p, k) => this._value(p, k)),
      sort: this.sort,
      // A row stays when it is drawn the same again (4.6).
      drawn: true,
      rowKey: (p) => p.id,
      onSort: (key) => {
        this.sort = Util.cycleSort(this.sort, key);
        this.render();
      },
      onRowDblClick: (p) => Nav.openPlaylist(p.id),
      columns: [
        {
          key: 'name',
          label: T('common.name'),
          cls: 'col-name',
          render: (p) => h('button.link-cell', { type: 'button', onclick: () => Nav.openPlaylist(p.id) },
            h('span.link-cell__icon', { html: listIcon(p) }),
            h('span.link-cell__name', p.name)),
        },
        { key: 'desc', label: T('trend.column.madeFrom'), cls: 'col-owner', render: (p) => h('span.muted-text', p.desc || '') },
        { key: 'songs', label: T('common.songs'), cls: 'col-num', render: (p) => String(p.entries.length) },
        { key: 'duration', label: T('common.duration'), cls: 'col-num', render: (p) => Util.fmtClock(Store.totalDuration(p.id)) },
        // Your own time listening to it, as the list playing.
        { key: 'listened', label: T('common.listenDuration'), cls: 'col-listened', render: (p) => Util.fmtClock(Store.listenedTo(p.id)) },
      ],
      mobile: listRowSpec((p) => [p.desc || '', Util.plural(p.entries.length, 'song')].filter(Boolean).join(' · ')),
    });
  },
};
