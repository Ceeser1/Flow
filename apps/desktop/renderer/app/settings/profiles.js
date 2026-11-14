'use strict';

// Settings > Flow Server: Switch server and the profiles (a part of SettingsPanel, settingsPanel.js).

extend(SettingsPanel, {
  // ---- Switch server ----

  /**
   * "Switch server": a dropdown of the servers used on this device, the one
   * in use picked. Picking another only shows where it was reached and as
   * whom; Switch then connects to it (with that address, its password and its
   * profile), and ✕ forgets it. The pencil names the picked one on this
   * device: Switch becomes the box for it and the pencil a tick. Its own row,
   * usable with Use a Flow Server unticked: Switch ticks it (for the one last
   * in use too).
   */
  _switchRow() {
    this._switch = { picked: '', busy: '', key: '', editing: '' };
    this._switchNode = h('div.settings__control.switch-control');
    const row = this._row({
      label: T('settings.server.switch.label'),
      desc: T('settings.server.switch.desc'),
      show: () => this._knownServers().length > 0,
      right: this._switchNode,
    });
    this._switchRowEl = row;
    return row;
  },

  _knownServers() {
    return Store.server.servers || [];
  },

  /** Drawn afresh only when the list, the pick or a switch under way changed. */
  _drawSwitch(force = false) {
    const node = this._switchNode;
    if (!node) return;
    const list = this._knownServers();
    if (this._switchRowEl) this._switchRowEl.hidden = !list.length;
    const p = this._switch;
    const current = list.find((x) => x.current);
    // Back to the one in use once the picked one is gone or became it.
    if (!list.some((x) => x.id === p.picked) || (current && current.id === p.picked)) p.picked = current ? current.id : '';
    // A name being typed is not lost to a status update.
    if (p.editing && !force) return;
    const names = Store.settings.serverNames || {};
    const key = JSON.stringify([list, p.picked, p.busy, Store.settings.serverOn, names]);
    if (!force && key === p.key) return;
    p.key = key;
    clear(node);
    if (!list.length) return;
    const off = !Store.settings.serverOn;
    const picked = list.find((x) => x.id === p.picked) || list[0];
    const other = !picked.current;
    const named = (x) => Util.serverName(names, x.id, x.name);
    const select = h('select.select.switch-select', { disabled: !!p.busy || !!p.editing },
      ...list.map((x) => h('option', { value: x.id }, x.current ? T('settings.server.switch.inUse', { server: named(x).label }) : named(x).label)));
    select.value = picked.id;
    select.addEventListener('change', () => {
      p.picked = select.value;
      this._drawSwitch(true);
    });
    const forget = iconButton('act.act--grey', Icons.x, T('settings.server.switch.forget.tooltip', { server: named(picked).name }), () => this._forgetServer(picked));
    forget.disabled = !!p.busy || !other || !!p.editing;
    let edit;
    let action;
    if (p.editing) {
      const done = (text) => {
        p.editing = '';
        if (text !== null) this._renameServer(picked.id, picked.name, text);
        this._drawSwitch(true);
      };
      ({ input: action, tick: edit } = this._nameBox(named(picked), done, 'switch-name'));
    } else {
      edit = iconButton('act.act--grey', Icons.pencil, T(`common.renameServer.tooltip.${Store.hereKey}`, { server: named(picked).name }), () => {
        p.editing = picked.id;
        this._drawSwitch(true);
      });
      edit.disabled = !!p.busy;
      action = h('button.btn.btn--small', {
        type: 'button', disabled: !!p.busy || !(other || off), onclick: () => this._switchTo(picked),
      }, p.busy ? T('common.connecting') : T('settings.server.switch.button'));
    }
    node.append(
      h('span.settings__note.switch-where', [picked.address, picked.profile ? T('settings.server.switch.asProfile', { profile: picked.profile }) : ''].filter(Boolean).join(' · ')),
      select,
      edit,
      action,
      forget,
    );
  },

  /**
   * The box a Flow Server is named in (Switch server, Statistics) and its
   * tick: Enter, the tick or leaving the box keeps the name, Escape keeps
   * the old one. done(text), or done(null) for Escape; once.
   */
  _nameBox(name, done, cls) {
    const input = h(`input.input.server-name.${cls}`, {
      type: 'text', maxLength: 80, spellcheck: false, value: name.name, placeholder: name.original, 'aria-label': T('settings.server.switch.rename.ariaLabel', { server: name.original }),
      // Escape is the box's (Keys leaves Settings open).
      dataset: { ownEscape: '' },
    });
    let over = false;
    const finish = (text) => {
      if (over) return;
      over = true;
      done(text);
    };
    input.addEventListener('keydown', (e) => {
      // Only the box's: a row it sits in does not react to them.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(input.value));
    const tick = iconButton('act.act--green', Icons.check, T('settings.server.switch.rename.keep'), (e) => {
      e.stopPropagation();
      finish(input.value);
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return { input, tick };
  },

  /**
   * Names a Flow Server on this device (empty, or its own name: its own
   * again). Switch server and Statistics both show it.
   */
  _renameServer(id, own, text) {
    const names = { ...(Store.settings.serverNames || {}) };
    const name = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name || name === own) delete names[id];
    else names[id] = name;
    Store.saveSettings({ serverNames: names });
    // A box open in the other place stays as it is (drawn when it is done).
    if (!this._switch || !this._switch.editing) this._drawSwitch(true);
    Stats.draw();
  },

  async _switchTo(s) {
    // The one last in use, Use a Flow Server unticked: ticking it is all.
    if (s.current) {
      Store.saveSettings({ serverOn: true });
      this._refreshAll();
      return;
    }
    this._switch.busy = s.id;
    this._drawSwitch();
    const ok = await attempt(async () => {
      await window.flow.switchServer(s.id);
      return true;
    });
    this._switch.busy = '';
    // Not switched: the one in use is picked again.
    if (!ok) this._switch.picked = '';
    this._drawSwitch();
    if (ok) toast(T('settings.server.switch.switching', { server: Util.serverName(Store.settings.serverNames, s.id, s.name).name }), 'success');
  },

  async _forgetServer(s) {
    const ok = await confirmDialog({
      title: T('settings.server.switch.forget.title'),
      message: T(`settings.server.switch.forget.text.${Store.hereKey}`, { server: Util.serverName(Store.settings.serverNames, s.id, s.name).name }),
      confirmLabel: T('settings.server.switch.forget.confirm'),
      danger: true,
    });
    if (!ok) return;
    await attempt(() => window.flow.forgetServer(s.id));
  },

  // ---- Profiles ----

  /**
   * "Profile": signed in to one of the server's profiles, or to none. Not
   * signed in: the server's profiles and "+ New" (which opens the Create new
   * Profile window; not there while only admins make profiles), a PIN, and
   * Login. Signed in: who, Logout, and ⋯, whose tray holds Edit Name, Change
   * PIN and Delete Profile; the first two ask in a window, with the current PIN.
   */
  _profileRow() {
    this._prof = { picked: '', busy: false, key: '' };
    this._profileNode = h('div.settings__control.profile-control');
    return this._row({
      label: T('common.profile'),
      desc: T('settings.server.profile.desc'),
      sub: true,
      when: () => Store.settings.serverOn,
      right: this._profileNode,
    });
  },

  /** Drawn afresh only when something it shows changed: typing is not lost to a status update. */
  _drawProfile(force = false) {
    const node = this._profileNode;
    if (!node) return;
    const st = Store.server;
    const p = this._prof;
    const ready = !!(st.on && st.state === 'online' && st.profilesSupported && Array.isArray(st.profiles));
    // "Only admins make profiles": no "+ New" while not signed in to an admin.
    const mayCreate = !(st.rules && st.rules.createProfiles === false);
    const key = JSON.stringify([ready, st.on, st.state, st.profilesSupported, st.profile, st.profiles, mayCreate, p.picked, p.busy]);
    if (!force && key === p.key) return;
    p.key = key;
    // The ⋯ tray belongs to the row about to be drawn anew.
    if (SongActions.anchor && node.contains(SongActions.anchor)) SongActions.close();
    clear(node);
    if (!ready) {
      let text = '';
      if (st.profile) text = T('settings.server.profile.loggedIn', { profile: st.profile.name });
      else if (st.on && st.state === 'online' && !st.profilesSupported) text = T('settings.server.profile.updateServer');
      else if (st.on) text = T('settings.server.profile.onlyWhileConnected');
      node.append(h('span.settings__note', text));
      // Logout works away from the server too (it is told at the next connection).
      if (st.on && st.profile) node.append(this._logoutButton(st.profile));
      return;
    }
    if (st.profile) this._drawSignedIn(node, st.profile);
    else this._drawSignIn(node, st.profiles, mayCreate);
  },

  _drawSignedIn(node, profile) {
    const p = this._prof;
    const btn = (label, onclick, extra = '') => h('button.btn.btn--small' + extra, { type: 'button', disabled: p.busy, onclick }, label);
    // Square, as in a song's More menu, and like it slides its tray out to the
    // left over the row (closed by any of its buttons, or a click elsewhere).
    const more = iconButton('act.act--grey', Icons.more, T('common.more'), () => {
      if (SongActions.anchor === more) {
        SongActions.close();
        return;
      }
      SongActions.open(more, [
        btn(T('settings.server.profile.editName'), () => this._editProfileName(profile)),
        btn(T('settings.server.profile.changePin'), () => this._changeProfilePin(profile)),
        btn(T('common.deleteProfile'), () => this._deleteProfile(profile), '.btn--danger'),
      ], 'act-tray--settings');
    });
    more.disabled = p.busy;
    node.append(
      h('span.profile-who', T('settings.server.profile.loggedInAs.prefix'), ' ', h('strong', profile.name)),
      this._logoutButton(profile),
      more,
    );
  },

  _logoutButton(profile) {
    return h('button.btn.btn--small', {
      type: 'button',
      disabled: this._prof.busy,
      onclick: () => this._profileDo(async () => {
        await window.flow.profileLogout();
        toast(T('settings.server.profile.loggedOut', { profile: profile.name }), 'info');
      }),
    }, T('common.logout'));
  },

  /** The current PIN box: none to type while the profile has none. */
  _currentPinField(profile) {
    return {
      key: 'pin', label: T('settings.server.profile.rename.currentPin'), type: 'password', disabled: !profile.pin, placeholder: profile.pin ? '' : T('settings.server.profile.rename.currentPin.placeholder'),
    };
  },

  _editProfileName(profile) {
    return formDialog({
      title: T('settings.server.profile.rename.title'),
      confirmLabel: T('common.confirm'),
      fields: [
        this._currentPinField(profile),
        { key: 'name', label: T('settings.server.profile.rename.newName'), value: profile.name, maxLength: 40 },
      ],
      submit: async ({ pin, name }) => {
        const renamed = await window.flow.profileRename(name, pin);
        toast(T('settings.server.profile.rename.done', { profile: renamed.name }), 'success');
      },
    });
  },

  _changeProfilePin(profile) {
    // An admin keeps a PIN (only a profile with one is an admin); the master's has 4 characters.
    let hint = T('settings.server.profile.changePin.hint.empty');
    if (profile.master) hint = T('settings.server.profile.changePin.hint.length');
    else if (profile.admin) hint = T('settings.server.profile.changePin.hint.admin');
    return formDialog({
      title: T('settings.server.profile.changePin'),
      confirmLabel: T('common.confirm'),
      fields: [
        this._currentPinField(profile),
        { key: 'newPin', label: T('settings.server.profile.changePin.newPin'), type: 'password', placeholder: hint },
        { key: 'confirm', label: T('settings.server.profile.changePin.confirmPin'), type: 'password' },
      ],
      submit: async ({ pin, newPin, confirm }) => {
        if (newPin !== confirm) throw new Error(T('settings.server.profile.create.error.notSame'));
        if (!newPin && profile.admin) throw new Error(T('settings.server.profile.changePin.error.adminNeedsPin'));
        if (!newPin && !profile.pin) throw new Error(T('settings.server.profile.changePin.error.enterPin'));
        const now = await window.flow.profilePin(pin, newPin);
        toast(now.pin ? T('settings.server.profile.changePin.done') : T('settings.server.profile.changePin.removed'), 'success');
      },
    });
  },

  _newProfileDialog() {
    // The server's first profile becomes its admin, so it needs a PIN.
    const first = !(Store.server.profiles || []).length;
    return formDialog({
      title: T('settings.server.profile.create.title'),
      confirmLabel: T('common.create'),
      fields: [
        { key: 'name', label: T('settings.server.profile.create.name'), maxLength: 40 },
        { key: 'pin', label: T('settings.server.profile.create.pin'), type: 'password', placeholder: first ? T('settings.server.profile.create.pin.placeholder.firstIsAdmin') : T('settings.server.profile.create.pin.placeholder.optional') },
        { key: 'confirm', label: T('settings.server.profile.create.confirmPin'), type: 'password' },
      ],
      submit: async ({ name, pin, confirm }) => {
        if (pin !== confirm) throw new Error(T('settings.server.profile.create.error.notSame'));
        if (first && !pin) throw new Error(T('settings.server.profile.create.error.firstNeedsPin'));
        const made = await window.flow.profileCreate(name, pin);
        toast(T('settings.server.profile.create.done', { profile: made.name, profile: made.name }), 'success');
      },
    });
  },

  _drawSignIn(node, profiles, mayCreate) {
    const p = this._prof;
    if (p.picked && !profiles.some((x) => x.id === p.picked)) p.picked = '';
    const picked = profiles.find((x) => x.id === p.picked) || null;
    const select = h('select.select.profile-select', { disabled: p.busy },
      h('option', { value: '' }, T('settings.server.profile.pick.shared')),
      ...profiles.map((x) => h('option', { value: x.id }, x.name)),
      mayCreate ? h('option', { value: '+new' }, T('settings.server.profile.pick.new')) : null);
    select.value = p.picked;
    select.addEventListener('change', () => {
      if (select.value === '+new') {
        // Back to what was picked; the new one is asked for in a window.
        select.value = p.picked;
        this._newProfileDialog();
        return;
      }
      p.picked = select.value;
      this._drawProfile(true);
    });
    const pin = h('input.input.settings__input.profile-pin', {
      type: 'password',
      placeholder: picked && !picked.pin ? T('settings.server.profile.pin.placeholder.none') : 'PIN',
      autocomplete: 'new-password',
      spellcheck: false,
      disabled: p.busy || !(picked && picked.pin),
    });
    const go = () => {
      if (!picked) return undefined;
      return this._profileDo(async () => {
        const now = await window.flow.profileLogin(picked.id, pin.value);
        toast(T('settings.server.profile.loggedIn', { profile: now.name }), 'success');
      });
    };
    pin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    node.append(select, pin,
      h('button.btn.btn--small', { type: 'button', disabled: p.busy || !picked, onclick: go }, T('settings.server.profile.login')));
    if (picked && picked.pin) requestAnimationFrame(() => pin.focus());
  },

  /** One profile action: the row waits for it, and says what went wrong. */
  async _profileDo(fn) {
    const p = this._prof;
    if (p.busy) return;
    p.busy = true;
    this._drawProfile(true);
    try {
      await attempt(fn);
    } finally {
      p.busy = false;
      this._drawProfile(true);
    }
  },

  async _deleteProfile(profile) {
    const answer = await confirmDialog({
      title: T('common.deleteProfile'),
      message: T('settings.server.profile.delete.text', { profile: profile.name }),
      confirmLabel: T('common.delete'),
      danger: true,
    });
    if (!answer) return;
    await this._profileDo(async () => {
      await window.flow.profileDelete();
      toast(T('common.profileDeleted', { profile: profile.name }), 'info');
    });
  },

  _syncNow() {
    return attempt(async () => {
      const r = await window.flow.syncNow();
      toast(r.sent ? T('settings.server.synced.withChanges', { changes: Util.plural(r.sent, 'change') }) : T('settings.server.synced'), 'success');
    });
  },
});
