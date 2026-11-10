'use strict';

// A smart playlist's rules (4.0, playlistRules.js): made on the Playlists page
// ("Smart Playlist"), changed with Edit Rules on its page or in its row. Its
// name, whether all or any of the conditions must be met, each condition (a
// field, how it compares, a value), the order and at most how many songs;
// how many songs match is counted as it is changed.

const RulesEditor = {
  /** `playlist`: the smart playlist to change, or null for a new one (named `name`). Resolves the playlist, or null. */
  open({ playlist = null, name = '' } = {}) {
    return new Promise((resolve) => {
      const rules = playlist && playlist.rules
        ? JSON.parse(JSON.stringify(playlist.rules))
        : { match: 'all', conditions: [{ field: 'genre', op: 'is', value: '' }], sort: 'added', limit: 0 };
      const nameBox = h('input.input', { type: 'text', value: playlist ? playlist.name : name, placeholder: T('common.name'), maxLength: 80 });
      nameBox.spellcheck = false;
      const select = (options, value, onChange) => {
        const node = h('select.select', ...options.map(([v, label]) => h('option', { value: v }, label)));
        node.value = value;
        node.addEventListener('change', () => onChange(node.value));
        return node;
      };
      const match = select([['all', T('rules.editor.match.all')], ['any', T('rules.editor.match.any')]], rules.match, (v) => {
        rules.match = v;
        count();
      });
      const list = h('div.rules__list');
      const counted = h('div.rules__count');
      const error = h('div.form-error');

      const count = () => {
        const n = PlaylistRules.evaluate(Store.library.songs, rules).length;
        counted.textContent = T('rules.editor.matchesNow', { songs: Util.plural(n, 'song'), count: n });
      };

      const row = (c) => {
        const kind = () => PlaylistRules.kindOf(c.field);
        const value = () => {
          if (kind() === 'bool') {
            return select([['yes', T('common.yes')], ['no', T('rules.editor.no')]], c.value === false ? 'no' : 'yes', (v) => {
              c.value = v === 'yes';
              count();
            });
          }
          const box = h('input.input.rules__value', {
            type: kind() === 'text' ? 'text' : 'number',
            value: String(c.value ?? ''),
            min: kind() === 'text' ? undefined : 0,
            placeholder: kind() === 'date' ? T('rules.editor.days.placeholder') : '',
          });
          box.spellcheck = false;
          box.addEventListener('input', () => {
            c.value = kind() === 'text' ? box.value : Number(box.value) || 0;
            count();
          });
          return box;
        };
        const node = h('div.rules__row');
        const draw = () => {
          const field = select(PlaylistRules.FIELDS.map((f) => [f.id, f.label]), c.field, (v) => {
            const before = kind();
            c.field = v;
            // Another kind of field: its own ways of comparing, and a value of its kind.
            if (kind() !== before) {
              c.op = PlaylistRules.OPS[kind()][0][0];
              c.value = kind() === 'text' ? '' : kind() === 'bool' ? true : (kind() === 'date' ? 30 : 1);
            }
            draw();
            count();
          });
          const op = select(PlaylistRules.OPS[kind()], c.op, (v) => {
            c.op = v;
            count();
          });
          const remove = iconButton('icon-btn.rules__remove', Icons.x, T('rules.editor.removeCondition'), () => {
            rules.conditions = rules.conditions.filter((x) => x !== c);
            node.remove();
            count();
          });
          clear(node).append(field, op, value(), remove);
        };
        draw();
        return node;
      };

      for (const c of rules.conditions) list.appendChild(row(c));
      const add = h('button.link-btn.rules__add', {
        type: 'button',
        onclick: () => {
          if (rules.conditions.length >= 12) return;
          const c = { field: 'artist', op: 'contains', value: '' };
          rules.conditions.push(c);
          list.appendChild(row(c));
          count();
        },
      }, T('rules.editor.addCondition'));
      const sort = select(PlaylistRules.SORTS, rules.sort, (v) => {
        rules.sort = v;
      });
      const limit = h('input.input.rules__limit', { type: 'number', min: 0, value: String(rules.limit || ''), placeholder: T('rules.editor.atMost.placeholder') });
      limit.addEventListener('input', () => {
        rules.limit = Math.max(0, Math.floor(Number(limit.value) || 0));
        count();
      });
      count();

      let answer = null;
      Modal.open({
        title: playlist ? T('rules.editor.title.edit', { playlist: playlist.name }) : T('rules.editor.title.new'),
        className: 'modal--rules',
        body: [
          h('label.form-row', h('span.form-label', T('common.name')), nameBox),
          h('div.rules__match', h('span', T('rules.editor.match.before')), match, h('span', T('rules.editor.match.after'))),
          list,
          add,
          h('div.rules__end',
            h('label.rules__field', h('span', T('rules.editor.order')), sort),
            h('label.rules__field', h('span', T('rules.editor.atMost')), limit, h('span', T('rules.editor.atMost.songs')))),
          counted,
          h('p.settings__note', T('rules.editor.desc')),
          error,
        ],
        focus: playlist ? null : 'input',
        buttons: [
          { label: T('common.cancel') },
          {
            label: playlist ? T('common.save') : T('common.create'),
            kind: 'primary',
            onClick: async () => {
              error.textContent = '';
              try {
                const clean = { ...rules, conditions: rules.conditions.filter((c) => PlaylistRules.kindOf(c.field) !== 'text' || String(c.value).trim()) };
                if (playlist) {
                  if (nameBox.value.trim() && nameBox.value.trim() !== playlist.name) await window.flow.renamePlaylist(playlist.id, nameBox.value);
                  await window.flow.setPlaylistRules(playlist.id, clean);
                  answer = Store.playlist(playlist.id) || playlist;
                } else {
                  answer = await window.flow.createSmartPlaylist(nameBox.value, clean);
                }
                return true;
              } catch (err) {
                // Stays open, saying why.
                error.textContent = err.message;
                return false;
              }
            },
          },
        ],
        onClose: () => resolve(answer),
      });
    });
  },
};
