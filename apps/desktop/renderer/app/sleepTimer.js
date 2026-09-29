'use strict';

// The player bar's Sleep Timer. The popup offers 15, 30, 45 or 60 minutes or
// a time of one's own, and "Shut down my PC" 5 minutes after it runs out.
// While it runs the button reads "Cancel Timer" and "Time Left" counts down
// above the timeline; over the last seconds the music fades out, then pauses.
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
    const custom = h('input.input.sleep__custom', { type: 'number', min: 1, max: this.MAX_MINUTES, step: 1, placeholder: 'min' });
    const error = h('div.form-error');
    let modal = null;
    const go = (minutes) => {
      modal.close();
      this.start(minutes, shutdown.checked);
    };
    const apply = () => {
      const m = Math.round(Number(custom.value));
      if (!custom.value.trim() || !Number.isFinite(m) || m < 1 || m > this.MAX_MINUTES) {
        error.textContent = `Enter a number of minutes from 1 to ${this.MAX_MINUTES}.`;
        custom.focus();
        return;
      }
      go(m);
    };
    custom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
    });
    const presets = this.PRESETS.map((m) => h('button.btn.sleep__preset', { type: 'button', onclick: () => go(m) }, `${m} Min`));
    modal = Modal.open({
      title: 'Sleep Timer',
      className: 'modal--sleep',
      body: [
        h('label.check.sleep__shutdown', shutdown, h('span', 'Shut down my PC after the timer runs out (+5 min delay). Make sure you\'ve saved everything.')),
        h('div.sleep__row',
          ...presets,
          h('span.sleep__sep'),
          h('label.sleep__custom-label', h('span', 'Custom:'), custom),
          h('button.btn.btn--primary', { type: 'button', onclick: apply }, 'Apply')),
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
        toast(`The sleep timer was not started. ${err.message}`, 'error');
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
      const text = `The music stops at ${stops}, and your PC shuts down at ${Util.fmtTimeOfDay(shutdownAt)}.`;
      this._notify(`Sleep timer set. ${text}`);
      toast(`Sleep timer set: ${text}`, 'success');
    } else {
      toast(`Sleep timer set: the music stops at ${stops}.`, 'success');
    }
  },

  /** Cancel Timer: the timer and any planned shutdown are off. */
  async cancel() {
    const s = this.state;
    this._stop();
    if (!s) return;
    if (s.shutdownAt) {
      try {
        await window.flow.cancelShutdown();
      } catch (err) {
        toast(`The shutdown could not be cancelled: ${err.message}. Run "shutdown /a" to stop it.`, 'error');
        return;
      }
      this._notify('Sleep timer cancelled. Your PC will not shut down.');
      toast('Sleep timer cancelled, and the shutdown with it.', 'info');
    } else {
      toast('Sleep timer cancelled.', 'info');
    }
  },

  _stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.state = null;
    Player.setSleepFade(1);
    this._save(null);
    this._draw();
  },

  _run() {
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
      Player.setSleepFade(left < this.FADE_MS ? left / this.FADE_MS : 1);
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
    Player.pause();
    Player.setSleepFade(1);
    if (!s.shutdownAt) {
      this._stop();
      toast('Sleep timer: the music has stopped.', 'info');
      return;
    }
    s.ended = true;
    this._save(s);
    this._draw();
    this._notify(`The music has stopped. Your PC shuts down at ${Util.fmtTimeOfDay(s.shutdownAt)}. `
      + 'To stop that, open Flow and press "Cancel Timer".');
  },

  _notify(text) {
    window.flow.notify(text).catch(() => {});
  },

  _save(state) {
    Store.saveSettings({ sleepTimer: state ? { ...state } : null });
  },

  _draw() {
    const on = !!this.state;
    $('btnSleep').innerHTML = `${Icons.moon}<span>${on ? 'Cancel Timer' : 'Sleep Timer'}</span>`;
    $('btnSleep').classList.toggle('sleep-btn--on', on);
    $('btnSleep').title = on
      ? (this.state.shutdownAt ? 'Cancel the sleep timer and the planned shutdown' : 'Cancel the sleep timer')
      : 'Stop the music after a while';
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
    $('sleepLeft').textContent = `${shutdownSoon ? 'Shutdown in' : 'Time Left'}: ${mm}:${ss}`;
    $('sleepLeft').classList.toggle('player__sleep-left--shutdown', !!shutdownSoon);
    $('sleepLeft').title = s.shutdownAt
      ? `Your PC shuts down at ${Util.fmtTimeOfDay(s.shutdownAt)}`
      : `The music stops at ${Util.fmtTimeOfDay(s.endsAt)}`;
  },
};
