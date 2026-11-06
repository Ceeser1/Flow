'use strict';

// The player bar's Sleep Timer. The popup offers 15, 30, 45 or 60 minutes or
// a time of one's own, and "Shut down my PC" 5 minutes after it runs out.
// The button is a moon. While it runs the moon turns amber (a click cancels
// it) and "Time Left" counts down
// above the timeline; over the last seconds the music fades out, then pauses.
//
// On the phone the player keeps the timer itself (it fades and pauses with
// the screen off, when this page's timers stop); here it is only shown.
//
// The shutdown is handed to Windows when the timer starts (main.js), so it
// happens even if Flow is closed by then; the timer is kept in the settings so
// a restarted Flow still shows it and can call it off. Starting, cancelling
// and running out of a timer with a shutdown each show a Windows notification.

const SleepTimer = {
  state: null,       // { endsAt, shutdownAt, ended } as in the settings
  timer: null,
  PRESETS: [15, 30, 45, 60],
  SHUTDOWN_DELAY_MS: 5 * 60 * 1000,
  FADE_MS: 10000,
  MAX_MINUTES: 24 * 60,

  init() {
    $('btnSleep').onclick = () => (this.state ? this.cancel() : this.openDialog());
    const saved = Store.settings.sleepTimer;
    const now = Date.now();
    if (saved && (saved.shutdownAt ? saved.shutdownAt > now : saved.endsAt > now)) {
      this.state = { ...saved };
      this._run();
    } else if (saved) {
      this._save(null);
    }
    this._draw();
  },

  openDialog() {
    const shutdown = h('input', { type: 'checkbox' });
    const custom = h('input.input.sleep__custom', { type: 'number', min: 1, max: this.MAX_MINUTES, step: 1, placeholder: T('sleepTimer.custom.placeholder') });
    const error = h('div.form-error');
    let modal = null;
    const go = (minutes) => {
      modal.close();
      this.start(minutes, shutdown.checked);
    };
    const apply = () => {
      const m = Math.round(Number(custom.value));
      if (!custom.value.trim() || !Number.isFinite(m) || m < 1 || m > this.MAX_MINUTES) {
        error.textContent = T('sleepTimer.enterMinutes', { max: this.MAX_MINUTES });
        custom.focus();
        return;
      }
      go(m);
    };
    custom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
    });
    const presets = this.PRESETS.map((m) => h('button.btn.sleep__preset', { type: 'button', onclick: () => go(m) }, T('common.minutes', { minutes: m })));
    modal = Modal.open({
      title: T('sleepTimer.title'),
      className: 'modal--sleep',
      sheet: document.body.classList.contains('mobile'),
      body: [
        // Only where Flow can shut the device down (not the phone).
        !Store.can('shutdown') ? null : h('label.check.sleep__shutdown', shutdown, h('span', T('sleepTimer.shutdown.option'))),
        h('div.sleep__row',
          ...presets,
          h('span.sleep__sep'),
          h('label.sleep__custom-label', h('span', T('sleepTimer.custom')), custom),
          h('button.btn.btn--primary', { type: 'button', onclick: apply }, T('common.apply'))),
        error,
      ],
    });
  },

  async start(minutes, shutdown) {
    const endsAt = Date.now() + minutes * 60000;
    let shutdownAt = null;
    if (shutdown) {
      try {
        await window.flow.scheduleShutdown(minutes * 60 + this.SHUTDOWN_DELAY_MS / 1000);
      } catch (err) {
        toast(T('sleepTimer.notStarted', { reason: err.message }), 'error');
        return;
      }
      shutdownAt = endsAt + this.SHUTDOWN_DELAY_MS;
    }
    this.state = { endsAt, shutdownAt, ended: false };
    this._save(this.state);
    this._run();
    this._draw();
    const stops = Util.fmtTimeOfDay(endsAt);
    if (shutdownAt) {
      const text = T('sleepTimer.shutdown.set', { time: stops, shutdownTime: Util.fmtTimeOfDay(shutdownAt) });
      this._notify(T('sleepTimer.shutdown.setNotice', { details: text }));
      toast(T('sleepTimer.shutdown.setToast', { details: text }), 'success');
    } else {
      toast(T('sleepTimer.set', { time: stops }), 'success');
    }
  },

  /** The amber moon clicked: the timer and any planned shutdown are off. */
  async cancel() {
    const s = this.state;
    this._stop();
    if (!s) return;
    if (s.shutdownAt) {
      try {
        await window.flow.cancelShutdown();
      } catch (err) {
        toast(T('sleepTimer.shutdown.notCancelled', { reason: err.message, command: Store.os === 'win32' ? 'shutdown /a' : 'shutdown -c' }), 'error');
        return;
      }
      this._notify(T('sleepTimer.shutdown.cancelledNotice'));
      toast(T('sleepTimer.shutdown.cancelled'), 'info');
    } else {
      toast(T('sleepTimer.cancelled'), 'info');
    }
  },

  _stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.state = null;
    Player.engine.setSleep(null);
    Player.setSleepFade(1);
    this._save(null);
    this._draw();
  },

  _run() {
    const s = this.state;
    Player.engine.setSleep(s && !s.ended ? s.endsAt : null, this.FADE_MS);
    clearInterval(this.timer);
    this.timer = setInterval(() => this._tick(), 250);
    this._tick();
  },

  _tick() {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    if (!s.ended) {
      const left = s.endsAt - now;
      if (left <= 0) {
        this._runOut();
        return;
      }
      if (!Player.engine.ownSleep) Player.setSleepFade(left < this.FADE_MS ? left / this.FADE_MS : 1);
    } else if (s.shutdownAt && now >= s.shutdownAt) {
      // Windows is shutting down by now.
      this._stop();
      return;
    }
    this._drawLeft();
  },

  /** The time is up: the music stops; with a shutdown, its 5 minutes start. */
  _runOut() {
    const s = this.state;
    // This device's music; in someone else's session that host plays on.
    Player.pauseHere();
    Player.setSleepFade(1);
    if (!s.shutdownAt) {
      this._stop();
      toast(T('sleepTimer.stopped'), 'info');
      return;
    }
    s.ended = true;
    Player.engine.setSleep(null);
    this._save(s);
    this._draw();
    this._notify(T('sleepTimer.shutdown.musicStopped', { time: Util.fmtTimeOfDay(s.shutdownAt) }));
  },

  _notify(text) {
    window.flow.notify(text).catch(() => {});
  },

  _save(state) {
    Store.saveSettings({ sleepTimer: state ? { ...state } : null });
  },

  _draw() {
    const on = !!this.state;
    $('btnSleep').innerHTML = Icons.moon;
    $('btnSleep').classList.toggle('sleep-btn--on', on);
    $('btnSleep').title = on
      ? (this.state.shutdownAt ? T('sleepTimer.shutdown.cancel.tooltip') : T('sleepTimer.cancel.tooltip'))
      : T('sleepTimer.button.tooltip');
    $('btnSleep').setAttribute('aria-label', $('btnSleep').title);
    $('player').classList.toggle('player--sleep', on);
    $('sleepLeft').hidden = !on;
    this._drawLeft();
  },

  _drawLeft() {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    const shutdownSoon = s.ended && s.shutdownAt;
    const ms = Math.max(0, (shutdownSoon ? s.shutdownAt : s.endsAt) - now);
    const total = Math.ceil(ms / 1000);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    $('sleepLeft').textContent = T(shutdownSoon ? 'sleepTimer.shutdown.in' : 'sleepTimer.timeLeft', { time: `${mm}:${ss}` });
    $('sleepLeft').classList.toggle('player__sleep-left--shutdown', !!shutdownSoon);
    $('sleepLeft').title = s.shutdownAt
      ? T('sleepTimer.shutdown.at.tooltip', { time: Util.fmtTimeOfDay(s.shutdownAt) })
      : T('sleepTimer.stopsAt.tooltip', { time: Util.fmtTimeOfDay(s.endsAt) });
  },
};
