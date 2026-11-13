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
    // Only where the app can ask (the phone): the desktop showing the phone's layout (FLOW_UI=mobile) cannot.
    if (!Store.can('batteryHelp') || !window.flow.onResume) return;
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
    if (p.restricted) return { p, good: false, text: T('backgroundHelp.state.stopped') };
    if (p.unrestricted) return { p, good: true, text: T('backgroundHelp.state.allowed') };
    return { p, good: false, text: T('backgroundHelp.state.mayStop') };
  },

  open() {
    if (this._modal) return;
    this._body = h('div.bg-help');
    this._modal = Modal.open({
      title: T('settings.app.screenOff.label'),
      className: 'modal--small',
      body: [this._body],
      buttons: [{ label: T('common.close'), kind: 'primary' }],
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
    const allow = h('button.btn', { type: 'button', onclick: () => window.flow.allowBackground().catch(() => {}) }, T('backgroundHelp.allow'));
    const settings = h('button.btn', { type: 'button', onclick: () => window.flow.appSettings().catch(() => {}) }, T('backgroundHelp.appSettings'));
    clear(this._body);
    const parts = [
      h('p.bg-help__status' + (s.good ? '.bg-help__status--good' : ''), s.text),
      s.good ? null : h('p.modal__text', T('backgroundHelp.howTo')),
      h('div.bg-help__buttons', s.p.unrestricted ? null : allow, settings),
      s.p.maker === 'samsung' ? h('p.muted-text', T('backgroundHelp.samsung')) : null,
    ];
    this._body.append(...parts.filter(Boolean));
  },
};
