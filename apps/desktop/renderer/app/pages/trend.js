'use strict';

// Your listening trend: the lists made from how you listen (smartLists.js).
// A main entry in the menu, its lists under it closed until opened. They fill
// themselves and cannot be changed by hand, so they have no actions.

const TrendPage = {
  sort: { key: null, dir: null },

  init() {
    Store.onLibrary(() => {
      if (Nav.page === 'trend') this.render();
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
      rowKey: (p) => p.id,
      onSort: (key) => {
        this.sort = Util.cycleSort(this.sort, key);
        this.render();
      },
      onRowDblClick: (p) => Nav.openPlaylist(p.id),
      columns: [
        {
          key: 'name',
          label: 'Name',
          cls: 'col-name',
          render: (p) => h('button.link-cell', { type: 'button', onclick: () => Nav.openPlaylist(p.id) },
            h('span.link-cell__icon', { html: listIcon(p) }),
            h('span.link-cell__name', p.name)),
        },
        { key: 'desc', label: 'Made from', cls: 'col-owner', render: (p) => h('span.muted-text', p.desc || '') },
        { key: 'songs', label: 'Songs', cls: 'col-num', render: (p) => String(p.entries.length) },
        { key: 'duration', label: 'Duration', cls: 'col-num', render: (p) => Util.fmtClock(Store.totalDuration(p.id)) },
        // Your own time listening to it, as the list playing.
        { key: 'listened', label: 'Listen Duration', cls: 'col-listened', render: (p) => Util.fmtClock(Store.listenedTo(p.id)) },
      ],
      mobile: listRowSpec((p) => [p.desc || '', Util.plural(p.entries.length, 'song')].filter(Boolean).join(' · ')),
    });
  },
};
