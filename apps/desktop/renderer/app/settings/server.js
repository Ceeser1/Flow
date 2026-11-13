'use strict';

// Settings > Flow Server: Use a Flow Server, Media Management and the Jam session rows (a part of SettingsPanel, settingsPanel.js).

extend(SettingsPanel, {
  // ---- Use a Flow Server ----

  /**
   * The Flow Server rows: on/off with its state, the two addresses (home
   * first, then remote), the password and the profile under it, then Switch
   * server on its own.
   */
  _serverRows() {
    const on = () => Store.settings.serverOn;
    this._serverNode = h('div.settings__desc.server-state');
    // Share (the server in use as a QR code) and, on a phone, Scan in front of it (qrShare.js).
    this._shareNode = h('div.settings__control.share-control');
    const main = this._row({
      key: 'serverOn',
      right: this._shareNode,
      label: T('settings.server.use.label'),
      desc: T('settings.server.use.desc') + ' '
        + (Store.can('localFiles') ? T('settings.server.use.desc.localFilesUploaded') : T('settings.server.use.desc.browserOnlyServer')),
    });
    main.querySelector('.settings__left').appendChild(this._serverNode);
    this._syncBtn = h('button.btn.btn--small', { type: 'button', onclick: () => this._syncNow() }, T('settings.server.syncNow'));
    const rows = [
      h('h3.settings__section', 'Flow Server'),
      main,
      this._row({
        key: 'serverHomeOn',
        label: T('settings.server.home.label'),
        desc: T('settings.server.home.desc'),
        sub: true,
        when: on,
        right: this._textField({
          key: 'serverHome', placeholder: '192.168.0.63:7878', when: on, address: true,
        }),
      }),
      this._row({
        key: 'serverRemoteOn',
        label: T('settings.server.remote.label'),
        desc: T('settings.server.remote.desc'),
        sub: true,
        when: on,
        right: this._textField({
          key: 'serverRemote', placeholder: T('settings.server.remote.placeholder'), when: on, address: true,
        }),
      }),
      this._row({
        label: T('settings.server.password.label'),
        // The web player keeps it in the browser's session (apps/web/src/storage.js).
        desc: Store.web ? T('settings.server.password.keptInBrowser') : T('settings.server.password.keptEncrypted'),
        sub: true,
        when: on,
        right: this._secretField(on),
      }),
      this._profileRow(),
      this._switchRow(),
    ];
    return rows;
  },

  // ---- Media Management ----

  /**
   * Where the songs and covers are kept, what goes up to a Flow Server, and
   * how downloads are made. The browser-cookie and SponsorBlock rows only
   * where yt-dlp runs (the phone's Download (Server) still takes its MP3 choice).
   */
  _mediaRows() {
    const server = () => Store.settings.serverOn;
    const here = Store.can('downloadHere');
    const sync = this._row({
      key: 'serverAutoSync',
      label: T('settings.server.syncLocal.label'),
      desc: T('settings.server.syncLocal.desc'),
      when: server,
      right: this._syncBtn,
    });
    // The button beside the box works whether or not the box is ticked.
    sync.classList.add('settings__row--keep');
    // The web player keeps no songs, downloads or covers: only what it plays from the server.
    const keeps = Store.can('localFiles');
    let storage = null;
    if (Store.can('musicFolder')) storage = this._savedSongsRow();
    else if (Store.can('offline')) storage = this._storageRow();
    return [
      h('h3.settings__section', T('settings.media.heading')),
      storage,
      keeps ? this._coversRow() : null,
      this._highResRow(keeps),
      this._row({
        key: 'lyricsOn',
        label: T('settings.media.lyrics.label'),
        desc: T('settings.media.lyrics.desc'),
      }),
      this._lyricsRow(),
      Store.can('backups') ? this._backupsRow() : null,
      !Store.can('offline') ? null : this._row({
        key: 'serverMetered',
        label: T('settings.media.meteredDownloads.label'),
        desc: T('settings.media.meteredDownloads.desc'),
        when: server,
        show: () => !!Store.settings.serverRemote && Store.settings.serverRemoteOn !== false,
      }),
      !keeps ? null : this._row({
        key: 'serverKeepFiles',
        label: T('settings.media.keepLocalAfterUpload.label'),
        desc: T('settings.media.keepLocalAfterUpload.desc'),
        when: server,
      }),
      keeps ? sync : null,
      here ? this._row({
        key: 'useCookies',
        label: T('settings.media.cookies.label'),
        desc: T('settings.media.cookies.desc'),
        right: this._cookieBrowser(),
      }) : null,
      here ? this._row({
        key: 'shareCookies',
        label: T('settings.media.shareCookies.label'),
        desc: T('settings.media.shareCookies.desc'),
        sub: true,
        when: () => Store.settings.useCookies,
        show: server,
      }) : null,
      // 4.4: on every app, for the client's downloads and the server's; mirrored under Add Songs' link box.
      this._row({
        key: 'autoComplete',
        label: T('settings.media.autoComplete.label'),
        desc: T('settings.media.autoComplete.desc'),
      }),
      this._row({
        key: 'autoFinish',
        label: T('settings.media.autoFinish.label'),
        desc: T('settings.media.autoFinish.desc'),
        sub: true,
        when: () => Store.settings.autoComplete,
      }),
      here ? this._row({
        key: 'sponsorBlock',
        label: T('settings.media.sponsorBlock.label'),
        desc: T('settings.media.sponsorBlock.desc'),
      }) : null,
      here ? this._row({
        key: 'sponsorBlockIntros',
        label: T('settings.media.sponsorBlock.intros.label'),
        desc: T('settings.media.sponsorBlock.intros.desc'),
        sub: true,
        when: () => Store.settings.sponsorBlock,
      }) : null,
      // A phone converts nothing itself: the server does, for its uploads and Download (Server).
      this._row({
        key: 'alwaysMp3',
        label: here ? T('settings.media.convertMp3.desktop.label') : T('settings.media.convertMp3.server.label'),
        desc: here ? T('settings.media.convertMp3.keepFormat.desc') : this._serverMp3Desc(keeps),
        right: this._mp3Quality(),
      }),
      this._row({
        key: 'keepMp3',
        label: T('settings.media.convertMp3.ignoreMp3.label'),
        desc: T('settings.media.convertMp3.ignoreMp3.desc'),
        sub: true,
        when: () => Store.settings.alwaysMp3,
      }),
    ];
  },

  /** What "Upload songs to the server as MP3" does where the server converts (the phone; the web player: only its downloads). */
  _serverMp3Desc(keeps) {
    if (!keeps) return T('settings.media.convertMp3.server.desc.web');
    return T('settings.media.convertMp3.server.desc.phone');
  },

  // ---- Jam session ----

  /** Active Sessions through the Flow Server: who may see and join what plays here. */
  _jamRows() {
    const on = () => Store.settings.serverOn;
    // Filled in only while there is no server to jam through (empty when the
    // categories are made, so folding it keeps working by its title).
    const note = h('span.settings__section-note');
    this._jamNote = () => {
      note.textContent = on() && Store.server.state === 'online' ? '' : T('settings.media.needsServer');
    };
    this._refresh.push(this._jamNote);
    return [
      h('h3.settings__section', T('settings.jam.heading'), note),
      this._row({
        key: 'sessionShare',
        label: T('settings.jam.share.label'),
        desc: T('settings.jam.share.desc'),
        when: on,
      }),
      this._row({
        key: 'sessionAutoAccept',
        label: T('settings.jam.autoAccept.label'),
        desc: T('settings.jam.autoAccept.desc'),
        sub: true,
        when: () => on() && Store.settings.sessionShare,
      }),
      this._row({
        key: 'sessionAllowVolume',
        label: T('settings.jam.guestVolume.label'),
        desc: T('settings.jam.guestVolume.desc'),
        when: on,
      }),
      this._outputDelayRow(on),
    ];
  },

  /** Output delay, as in the player's output menu: for the output playing now (only with the Flow Server, for jams). */
  _outputDelayRow(on) {
    const c = Output.delayControl('settings__slider', 'settings__value');
    const which = h('span');
    // Redrawn when the output or its delay changes (one listener, set up in init).
    this._delayFill = () => {
      c.sync();
      const label = Output.builtin ? T('settings.jam.outputDelay.phoneSpeaker') : Output.label();
      which.textContent = label ? ` ${T('settings.jam.outputDelay.keptPerOutput', { output: label })}` : '';
    };
    this._delayFill();
    this._refresh.push(() => { c.slider.disabled = !on() || !Store.settings.outputDelayOn; });
    return this._row({
      key: 'outputDelayOn',
      label: T('output.delay.heading'),
      desc: h('span', Output.DELAY_NOTE, which),
      right: h('div.settings__control', c.slider, c.value),
      when: on,
    });
  },

  /**
   * A text box saved when left (or on Enter). address: a Flow Server's, which
   * gets https:// in front where it means https (Util.serverAddress).
   */
  _textField({
    key, placeholder, when, address = false,
  }) {
    const input = h('input.input.settings__input', {
      type: 'text', value: Store.settings[key] || '', placeholder, spellcheck: false, autocomplete: 'off',
    });
    input.addEventListener('change', () => {
      const v = input.value.trim();
      // A shared server's link (qrShare.js) pasted into an address: connected to.
      if (/^flow:\/\/connect/i.test(v)) {
        input.value = Store.settings[key] || '';
        QrShare.connect(v);
        return;
      }
      const done = address ? Util.serverAddress(v) : v;
      input.value = done;
      if (done !== (Store.settings[key] || '')) Store.saveSettings({ [key]: done });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    this._refresh.push(() => {
      if (when) input.disabled = !when();
      // Filled in by Flow itself (the Remote address).
      if (document.activeElement !== input) input.value = Store.settings[key] || '';
    });
    return input;
  },

  /**
   * The password: never shown. A saved one is shown as dots, to be replaced or
   * emptied (emptied and left, it is forgotten). Saved (encrypted) when left.
   */
  _secretField(when) {
    const MASK = '••••••';
    const input = h('input.input.settings__input', {
      type: 'password', placeholder: T('common.password'), autocomplete: 'new-password', spellcheck: false,
    });
    let stored = !!Store.server.hasSecret;
    const draw = () => {
      if (document.activeElement !== input) input.value = stored ? MASK : '';
    };
    input.addEventListener('focus', () => {
      if (input.value === MASK) input.select();
    });
    input.addEventListener('change', () => attempt(async () => {
      if (input.value === MASK) return;
      await window.flow.setServerSecret(input.value);
      stored = !!input.value;
      draw();
    }));
    input.addEventListener('blur', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    draw();
    const sync = () => {
      stored = !!Store.server.hasSecret;
      draw();
    };
    this._syncSecret = sync;
    this._refresh.push(() => {
      input.disabled = !when();
      sync();
    });
    return input;
  },

  _drawServer() {
    if (!this._serverNode) return;
    const st = Store.server;
    const s = Store.settings;
    let text;
    let kind = 'off';
    if (!s.serverOn) text = '';
    else if (s.serverHomeOn === false && s.serverRemoteOn === false) text = T('settings.server.state.bothUnticked');
    else if (st.searching && !s.serverHome && s.serverHomeOn !== false) text = T('settings.server.state.looking');
    else if (!(s.serverHomeOn !== false && s.serverHome) && !(s.serverRemoteOn !== false && s.serverRemote)) text = T('settings.server.state.notFound');
    else ({ text, kind } = ServerChip.describe(st));
    const lines = [text, st.on ? st.transfer : '', st.on ? st.note : ''].filter(Boolean);
    clear(this._serverNode);
    this._serverNode.className = `settings__desc server-state server-state--${kind}`;
    for (const line of lines) this._serverNode.appendChild(h('div', line));
    if (this._syncBtn) {
      this._syncBtn.disabled = st.state !== 'online' || !!st.syncing;
      this._syncBtn.textContent = st.syncing ? T('settings.server.syncing') : T('settings.server.syncNow');
    }
    if (this._syncSecret) this._syncSecret();
    this._drawProfile();
    this._drawSwitch();
    this._drawShare();
  },

  _drawShare() {
    if (!this._shareNode) return;
    const online = Store.server.on && Store.server.state === 'online';
    clear(this._shareNode).append(...[
      Store.can('scanQr') ? h('button.btn.btn--small', { type: 'button', title: T('settings.server.scan.tooltip'), onclick: () => QrShare.scan() }, T('settings.server.scan.button')) : null,
      online ? h('button.btn.btn--small', { type: 'button', title: T('settings.server.share.tooltip'), onclick: () => QrShare.open() }, T('common.share')) : null,
    ].filter(Boolean));
  },
});
