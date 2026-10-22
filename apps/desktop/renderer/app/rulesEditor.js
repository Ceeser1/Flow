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
      const nameBox = h('input.input', { type: 'text', value: playlist ? playlist.name : name, placeholder: 'Name', maxLength: 80 });
      nameBox.spellcheck = false;
      const select = (options, value, onChange) => {
        const node = h('select.select', ...options.map(([v, label]) => h('option', { value: v }, label)));
        node.value = value;
        node.addEventListener('change', () => onChange(node.value));
        return node;
      };
      const match = select([['all', 'all'], ['any', 'any']], rules.match, (v) => {
        rules.match = v;
        count();
      });
      const list = h('div.rules__list');
      const counted = h('div.rules__count');
      const error = h('div.form-error');

      const count = () => {
        const n = PlaylistRules.evaluate(Store.library.songs, rules).length;
        counted.textContent = `${Util.plural(n, 'song')} ${n === 1 ? 'matches' : 'match'} now`;
      };

      const row = (c) => {
        const kind = () => PlaylistRules.kindOf(c.field);
        const value = () => {
          if (kind() === 'bool') {
            return select([['yes', 'yes'], ['no', 'no']], c.value === false ? 'no' : 'yes', (v) => {
              c.value = v === 'yes';
              count();
            });
          }
          const box = h('input.input.rules__value', {
            type: kind() === 'text' ? 'text' : 'number',
            value: String(c.value ?? ''),
            min: kind() === 'text' ? undefined : 0,
            placeholder: kind() === 'date' ? 'days' : '',
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
          const remove = iconButton('icon-btn.rules__remove', Icons.x, 'Take this condition out', () => {
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
      }, '+ Add condition');
      const sort = select(PlaylistRules.SORTS, rules.sort, (v) => {
        rules.sort = v;
      });
      const limit = h('input.input.rules__limit', { type: 'number', min: 0, value: String(rules.limit || ''), placeholder: 'no limit' });
      limit.addEventListener('input', () => {
        rules.limit = Math.max(0, Math.floor(Number(limit.value) || 0));
        count();
      });
      count();

      let answer = null;
      Modal.open({
        title: playlist ? `Rules of ${playlist.name}` : 'New smart playlist',
        className: 'modal--rules',
        body: [
          h('label.form-row', h('span.form-label', 'Name'), nameBox),
          h('div.rules__match', h('span', 'Songs that match'), match, h('span', 'of these:')),
          list,
          add,
          h('div.rules__end',
            h('label.rules__field', h('span', 'Order'), sort),
            h('label.rules__field', h('span', 'At most'), limit, h('span', 'songs'))),
          counted,
          h('p.settings__note', 'A smart playlist fills itself from your library and keeps up as it changes. Its songs cannot be added or taken out by hand.'),
          error,
        ],
        focus: playlist ? null : 'input',
        buttons: [
          { label: 'Cancel' },
          {
            label: playlist ? 'Save' : 'Create',
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
