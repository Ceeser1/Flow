'use strict';

// Playing with the screen off (the phone: caps.batteryHelp). Android may stop
// an app in the background to save battery, Samsung's phones more readily
// than most. This help says how Android treats Flow now, asks Android to let
// Flow run in the background (its own question), opens Flow's page in
// Android's settings (Battery: Unrestricted), and on a Samsung names its
// sleeping apps. It shows by itself once, the first time music plays while
// Android still limits Flow; Settings > App opens it any time.

const BackgroundHelp = {
  _modal: null,

  init() {
    if (!Store.can('batteryHelp')) return;
    window.flow.onResume(() => {
      if (this._modal) this._draw();
    });
    const first = () => {
      if (!Player.isPlaying || Store.settings.batteryHelpShown) return;
      Store.saveSettings({ batteryHelpShown: true });
      window.flow.power().then((p) => {
        if (!p.unrestricted || p.restricted) this.open();
      }).catch(() => {});
    };
    Player.onChange(first);
  },

  /** How Android treats Flow, in words: { text, good }. */
  async status() {
    const p = await window.flow.power();
    if (p.restricted) return { p, good: false, text: 'Android has stopped Flow from running in the background. The music stops soon after the screen goes off.' };
    if (p.unrestricted) return { p, good: true, text: 'Flow may run in the background: the music plays on with the screen off.' };
    return { p, good: false, text: 'Android may stop Flow in the background to save battery, and with it the music.' };
  },

  open() {
    if (this._modal) return;
    this._body = h('div.bg-help');
    this._modal = Modal.open({
      title: 'Playing with the screen off',
      className: 'modal--small',
      body: [this._body],
      buttons: [{ label: 'Close', kind: 'primary' }],
      onClose: () => {
        this._modal = null;
      },
    });
    this._draw();
  },

  async _draw() {
    let s;
    try {
      s = await this.status();
    } catch {
      return;
    }
    if (!this._modal) return;
    const allow = h('button.btn', { type: 'button', onclick: () => window.flow.allowBackground().catch(() => {}) }, 'Allow background use');
    const settings = h('button.btn', { type: 'button', onclick: () => window.flow.appSettings().catch(() => {}) }, 'Flow\'s app settings');
    clear(this._body);
    const parts = [
      h('p.bg-help__status' + (s.good ? '.bg-help__status--good' : ''), s.text),
      s.good ? null : h('p.modal__text', 'So the music never stops with the screen off, let Flow run in the background: '
        + 'tap Allow background use and answer Allow. Or in Flow\'s app settings, set Battery to Unrestricted.'),
      h('div.bg-help__buttons', s.p.unrestricted ? null : allow, settings),
      s.p.maker === 'samsung' ? h('p.muted-text', 'On a Samsung phone also: Settings > Battery > Background usage limits. '
        + 'Flow must not be in Sleeping apps or Deep sleeping apps; add it to Never sleeping apps, '
        + 'or turn off Put unused apps to sleep.') : null,
    ];
    this._body.append(...parts.filter(Boolean));
  },
};
