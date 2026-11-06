'use strict';

// The phone's first start: with no songs and no Flow Server yet, a screen
// over everything looks for a Flow Server on the network (@flow/core's
// discovery, through "Use a Flow Server" turned on with no Home address) and
// connects to the one it finds. Found none: the address (and the password, if
// the server has one) is typed in. Once connected, a server with profiles
// opens Settings' Flow Server screen to pick one. "Songs on this phone"
// opens Add Songs' file picker instead; "Not now" leaves an empty Flow;
// Settings connects later. "Scan a QR code" connects to a server another
// app shares (qrShare.js).
//
// Only in the phone's layout; the desktop starts with Local Files.
//
// The web player (apps/web) has nothing without a server, so it shows the
// form in both layouts, straight away (a browser cannot search the network),
// and again when the server asks for its password once more: the browser
// keeps it only while it is open (apps/web/src/env.js).

const Welcome = {
  el: null,
  _phase: '', // searching | form | connecting
  _searchSeen: false,
  _timer: null,
  _skipped: false,

  init() {
    if (Store.web) {
      this._initWeb();
      return;
    }
    if (!document.body.classList.contains('mobile')) return;
    const s = Store.settings;
    if (s.serverHome || s.serverRemote || Store.library.songs.length) return;
    this._build();
    Store.onServer((st) => this._onServer(st));
    this.search();
  },

  _initWeb() {
    Store.onServer((st) => this._onServer(st));
    const s = Store.settings;
    if (s.serverHome || s.serverRemote) {
      // The server may have asked for its password before the window started.
      this._onServer(Store.server);
      return;
    }
    this._build();
    this._showForm(T('welcome.enterAddress'));
    this._address.focus();
  },

  _build() {
    const web = Store.web;
    this._status = h('p.welcome__status');
    this._address = h('input.input.welcome__input', {
      type: 'text', placeholder: web ? 'https://music.example.com' : '192.168.0.20:7878', inputMode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
    });
    this._password = h('input.input.welcome__input', { type: 'password', placeholder: T('welcome.password.placeholder'), autocomplete: 'off' });
    this._connectBtn = h('button.btn.btn--primary.welcome__connect', { type: 'button', onclick: () => this.connect() }, T('welcome.connect'));
    this._address.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._password.focus();
    });
    this._password.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.connect();
    });
    this._form = h('div.welcome__form',
      h('label.welcome__label', h('span', T('welcome.serverAddress')), this._address),
      h('label.welcome__label', h('span', T('common.password')), this._password),
      this._connectBtn,
      Store.can('scanQr') ? h('button.btn.welcome__again', { type: 'button', onclick: () => this.scan() }, T('welcome.scanQr')) : null,
      h('p.welcome__hint', web ? this._webHint() : T('welcome.serverShowsAddress')),
      web ? null : h('button.btn.welcome__again', { type: 'button', onclick: () => this.search() }, T('welcome.lookAgain')),
      web ? null : h('button.btn.welcome__again', { type: 'button', onclick: () => this.localFiles() }, T('welcome.phone.addLocalSongs')));
    this.el = h('div.welcome', { role: 'dialog', 'aria-label': T('welcome.title') },
      h('div.welcome__inner',
        h('img.welcome__icon', { src: 'assets/icon.png', alt: '' }),
        h('h1.welcome__title', T('welcome.title')),
        h('p.welcome__text', web
          ? T('welcome.web.intro')
          : T('welcome.phone.intro')),
        this._status,
        this._form),
      h('button.welcome__skip', { type: 'button', onclick: () => this.skip() }, T('common.notNow')));
    document.body.appendChild(this.el);
  },

  /** Looks for a Flow Server on the network; one found is connected to by itself. */
  search() {
    this._phase = 'searching';
    this._searchSeen = false;
    this._draw(T('welcome.looking'), true);
    Store.saveSettings({ serverOn: true, serverHome: '' });
    // Discovery takes a few seconds; one that never started (no network) ends here.
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (this._phase === 'searching' && !Store.server.searching) this._showForm(T('welcome.noneAnswered'));
    }, 6000);
  },

  connect() {
    // "ceeser.de/flow" is https://ceeser.de/flow (Util.serverAddress).
    const address = Util.serverAddress(this._address.value);
    this._address.value = address;
    if (!address) {
      this._draw(T('welcome.enterAddress.example'), false, true);
      this._address.focus();
      return;
    }
    this._phase = 'connecting';
    this._address.blur();
    this._password.blur();
    this._draw(T('welcome.connectingTo', { address }), true);
    const pw = this._password.value;
    attempt(async () => {
      if (pw) await window.flow.setServerSecret(pw);
      await Store.saveSettings({ serverOn: true, serverHome: address });
    });
  },

  /** Another app's Share, scanned: connected to as when typed in. */
  async scan() {
    let text;
    try {
      text = await window.flow.scanQr();
    } catch (err) {
      if (!err.cancelled) this._draw(err.message, false, true);
      return;
    }
    if (!text) return;
    this._phase = 'connecting';
    this._draw(T('welcome.connecting'), true);
    try {
      const { name } = await window.flow.connectLink(text);
      this._draw(T('welcome.connectingToName', { server: name }), true);
    } catch (err) {
      this._showForm(err.message, true);
    }
  },

  /** No server: the songs on the phone, picked on Add Songs. */
  localFiles() {
    this.skip();
    Nav.show('add');
    AddPage.openLocal(false);
  },

  skip() {
    clearTimeout(this._timer);
    this._skipped = true;
    if (Store.server.state !== 'online') Store.saveSettings({ serverOn: false });
    this.close();
  },

  /** The web player's word on addresses: from an https page a browser opens no plain http ones. */
  _webHint() {
    if (location.protocol !== 'https:') return T('welcome.phone.addressHint');
    return T('welcome.web.addressHint');
  },

  /** An address the browser will not open from this https page (plain http, not this computer). */
  _blockedHere(address) {
    const a = Util.serverAddress(address);
    if (location.protocol !== 'https:' || /^https:\/\//i.test(a)) return false;
    return !/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(a);
  },

  close() {
    if (!this.el) return;
    clearTimeout(this._timer);
    this.el.remove();
    this.el = null;
    this._phase = '';
  },

  _onServer(st) {
    // The web player signed in before, but this browser no longer has the password.
    if (!this.el && Store.web && !this._skipped && st.state === 'password') {
      this._build();
      this._showForm(T('welcome.hasPassword'));
      this._password.focus();
      return;
    }
    if (!this.el) return;
    if (this._phase === 'searching') {
      if (st.searching) {
        this._searchSeen = true;
        return;
      }
      if (Store.settings.serverHome) {
        this._phase = 'connecting';
        this._draw(st.name ? T('welcome.found', { server: st.name }) : T('welcome.found.unnamed'), true);
      } else if (this._searchSeen) {
        this._showForm(T('welcome.noneAnswered'));
        return;
      }
    }
    if (this._phase !== 'connecting') return;
    if (st.state === 'online') {
      this._done(st);
    } else if (st.state === 'password') {
      this._showForm(this._password.value ? T('welcome.wrongPassword') : T('welcome.hasPassword'), true);
      this._password.focus();
    } else if (st.state === 'offline') {
      const address = Store.settings.serverHome;
      let why = T('welcome.phone.noAnswer.why');
      if (Store.web) {
        why = this._blockedHere(address)
          ? T('welcome.web.noAnswer.httpsOnly')
          : T('welcome.noAnswer.why');
      }
      this._showForm(T('welcome.noAnswer', { address, why }), true);
    } else if (st.state === 'error') {
      this._showForm(st.message || T('welcome.couldNotUse'), true);
    }
  },

  _showForm(text, error = false) {
    this._phase = 'form';
    if (!this._address.value) this._address.value = Store.settings.serverHome || Store.settings.serverRemote || '';
    this._draw(text, false, error);
  },

  /** Connected: Flow opens; a server with profiles first asks which one is this phone's. */
  _done(st) {
    this.close();
    toast(st.name ? T('welcome.connected', { server: st.name }) : T('welcome.connected.unnamed'), 'success');
    const askProfile = (s) => s.profilesSupported && Array.isArray(s.profiles) && s.profiles.length && !s.profile;
    const open = () => {
      SettingsPanel.open();
      SettingsPanel._openScreen('Flow Server');
    };
    if (askProfile(st)) open();
    else if (st.profilesSupported && !st.profile && !Array.isArray(st.profiles)) {
      // The profiles may come a moment after the connection.
      setTimeout(() => {
        if (askProfile(Store.server)) open();
      }, 1500);
    }
  },

  _draw(text, busy, error = false) {
    this._status.textContent = text;
    this._status.classList.toggle('welcome__status--busy', busy);
    this._status.classList.toggle('welcome__status--error', error);
    this._form.hidden = this._phase !== 'form';
    this._connectBtn.disabled = this._phase === 'connecting';
  },
};
