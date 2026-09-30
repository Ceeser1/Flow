'use strict';

// Followed Playlists: the playlists other profiles share and this one follows.
// A main entry in the menu, there only while at least one is followed. They
// can be opened and played but only their owner changes them, so the one
// action is Unfollow.

const FollowedPage = {
  sort: { key: null, dir: null },

  init() {
    Store.onLibrary(() => {
      if (Nav.page === 'followed') this.render();
    });
  },

  show() {
    this.render();
  },

  _value(p, key) {
    if (key === 'name') return p.name;
    if (key === 'songs') return p.entries.length;
    if (key === 'duration') return Store.totalDuration(p.id);
    return '';
  },

  render() {
    const followed = Store.followedPlaylists();
    // Nothing followed (any more): back to the Playlists page, where they are found.
    if (!followed.length) {
      Nav.show('playlists');
      return;
    }
    $('followedCount').textContent = Util.plural(followed.length, 'playlist');
    renderTable($('followedTable'), {
      rows: Util.sortRows(followed, this.sort, (p, k) => this._value(p, k)),
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
            h('span.link-cell__name', p.name),
            p.ownerName ? h('span.link-cell__by', `by ${p.ownerName}`) : null),
        },
        { key: 'songs', label: 'Songs', cls: 'col-num', render: (p) => String(p.entries.length) },
        { key: 'duration', label: 'Duration', cls: 'col-num', render: (p) => Util.fmtClock(Store.totalDuration(p.id)) },
        {
          key: 'actions',
          label: 'Actions',
          sortable: false,
          cls: 'col-actions',
          render: (p) => h('div.actions', h('button.btn.btn--small', {
            type: 'button',
            title: `Stop following "${p.name}"`,
            onclick: () => attempt(() => window.flow.setFollowing(p.id, false)),
          }, 'Unfollow')),
        },
      ],
    });
  },
};
