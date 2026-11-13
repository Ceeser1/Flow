'use strict';

// The phone's Alarm Clock (5.0, Android): the button beside the Sleep Timer
// in Now Playing opens a window with a time and the days Mon to Sun. At that
// time Flow starts playing and fades the music in from 0 to 100 % over a
// minute; a notification on the lock screen says "Alarm at ..." with Stop
// Alarm and Snooze (5 min). With no day picked it rings once.
//
// The alarm itself is the phone's (FlowAlarm.java): Android wakes Flow for
// it, also when Flow is closed, and the phone's player starts and fades by
// itself (this page may be asleep or gone). It plays what Play would play:
// the song loaded, else the songs this page hands along when the alarm is
// set (Player.alarmPlan). This is the window to set it, and its button.
//
// nextAt() says when an alarm rings next; the phone's own (FlowAlarm.nextAt)
// counts the same way.

const Alarm = (() => {
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const FADE_SECONDS = 60;
  const SNOOZE_MINUTES = 5;

  /**
   * When an alarm at hour:minute rings next after `now` (ms): on the next of
   * its `days` (a bit each, Monday 1 to Sunday 64), or with none today or
   * tomorrow.
   */
  function nextAt(hour, minute, days, now = Date.now()) {
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    for (let i = 0; i < 8; i += 1) {
      const bit = 1 << ((d.getDay() + 6) % 7);
      if (d.getTime() > now && (!days || (days & bit))) return d.getTime();
      d.setDate(d.getDate() + 1);
      d.setHours(hour, minute, 0, 0);
    }
    return 0;
  }

  const api = {
    DAYS,
    nextAt,
    // { on, hour, minute, days, ringing, snoozeAt, nextAt, notify } as the phone has it.
    state: {
      on: false, hour: 7, minute: 0, days: 0, ringing: false, snoozeAt: 0, nextAt: 0, notify: true,
    },

    get can() {
      return typeof Store !== 'undefined' && Store.can('alarm');
    },

    init() {
      const btn = $('btnAlarm');
      if (!this.can) return;
      btn.hidden = false;
      btn.innerHTML = Icons.alarm;
      btn.onclick = () => this.openDialog();
      if (window.flow.onAlarm) window.flow.onAlarm((s) => this._took(s));
      // Back from Android's settings (notifications allowed there), or the alarm rang meanwhile.
      if (window.flow.onResume) window.flow.onResume(() => this.refresh());
      this._draw();
      this.refresh();
    },

    /** The phone's calls, or (the phone's layout on the computer, for working on it) an alarm that never rings. */
    _phone() {
      if (window.flow.alarm) return window.flow;
      if (!this._fake) {
        const fake = { ...this.state };
        const now = () => ({ ...fake, nextAt: fake.on ? nextAt(fake.hour, fake.minute, fake.days) : 0 });
        this._fake = {
          alarm: async () => now(),
          setAlarm: async (a) => Object.assign(fake, { on: !!a.on, hour: a.hour, minute: a.minute, days: a.days }) && now(),
          alarmAct: async () => now(),
          askNotifications: async () => now(),
        };
      }
      return this._fake;
    },

    async refresh() {
      try {
        this._took(await this._phone().alarm());
      } catch {
        // The button shows what was known before.
      }
    },

    _took(s) {
      if (!s || typeof s !== 'object') return;
      this.state = { ...this.state, ...s };
      this._draw();
      if (this._redraw) this._redraw();
    },

    _time(hour, minute) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    },

    /** "Sat 14.11." for the day of a moment. */
    _day(ms) {
      const d = new Date(ms);
      const two = (v) => String(v).padStart(2, '0');
      return `${T(`alarm.day.${DAYS[(d.getDay() + 6) % 7]}`)} ${two(d.getDate())}.${two(d.getMonth() + 1)}.`;
    },

    /** "Mon, Wed" for the days picked, '' for none. */
    _dayNames(days) {
      return DAYS.filter((d, i) => days & (1 << i)).map((d) => T(`alarm.day.${d}`)).join(', ');
    },

    /** The texts the phone shows without this page (its notification), in the language in use. */
    _texts(hour, minute) {
      return {
        title: T('alarm.notification.title', { time: this._time(hour, minute) }),
        stop: T('alarm.stop'),
        snooze: T('alarm.snooze', { minutes: SNOOZE_MINUTES }),
        snoozed: T('alarm.notification.snoozed', { time: '{time}' }),
        tone: T('alarm.notification.noMusic'),
        channel: T('alarm.title'),
      };
    },

    openDialog() {
      const s = this.state;
      let days = s.days;
      const time = h('input.input.alarm__time', { type: 'time', value: this._time(s.hour, s.minute), 'aria-label': T('alarm.time.label') });
      const dayButtons = DAYS.map((d, i) => {
        const b = h('button.alarm__day', { type: 'button', 'aria-pressed': String(!!(days & (1 << i))) }, T(`alarm.day.${d}`));
        b.onclick = () => {
          days ^= 1 << i;
          b.setAttribute('aria-pressed', String(!!(days & (1 << i))));
          drawHint();
        };
        return b;
      });
      const hint = h('div.alarm__hint');
      const status = h('div.alarm__status');
      const notify = h('div.alarm__notify');
      const error = h('div.form-error');
      let modal = null;

      const picked = () => {
        const m = /^(\d{1,2}):(\d{2})/.exec(time.value || '');
        if (!m) return null;
        const hour = Number(m[1]);
        const minute = Number(m[2]);
        return hour < 24 && minute < 60 ? { hour, minute } : null;
      };
      const drawHint = () => {
        const p = picked();
        if (!p) {
          hint.textContent = '';
          return;
        }
        const at = nextAt(p.hour, p.minute, days);
        const when = { day: this._day(at), time: Util.fmtTimeOfDay(at) };
        hint.textContent = days ? T('alarm.hint.days', when) : T('alarm.hint.once', when);
      };
      time.addEventListener('input', drawHint);

      // What is going on right now: ringing (Stop, Snooze), snoozed (Stop), or when it rings next.
      const act = (action) => async () => {
        try {
          this._took(await this._phone().alarmAct(action));
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      const drawStatus = () => {
        const st = this.state;
        clear(status);
        if (st.ringing) {
          status.append(
            h('span.alarm__status-text', T('alarm.ringing')),
            h('button.btn', { type: 'button', onclick: act('snooze') }, T('alarm.snooze', { minutes: SNOOZE_MINUTES })),
            h('button.btn.btn--primary', { type: 'button', onclick: act('stop') }, T('alarm.stop')),
          );
        } else if (st.snoozeAt > Date.now()) {
          status.append(
            h('span.alarm__status-text', T('alarm.snoozedUntil', { time: Util.fmtTimeOfDay(st.snoozeAt) })),
            h('button.btn.btn--primary', { type: 'button', onclick: act('stop') }, T('alarm.stop')),
          );
        } else if (st.on && st.nextAt) {
          status.append(h('span.alarm__status-text', T('alarm.next', { day: this._day(st.nextAt), time: Util.fmtTimeOfDay(st.nextAt) })));
        }
        status.hidden = !status.firstChild;
        // Without notifications there is nothing on the lock screen to stop it with.
        clear(notify);
        if (st.notify === false) {
          notify.append(
            h('span', T('alarm.notifications.off')),
            h('button.btn', {
              type: 'button',
              onclick: async () => {
                try {
                  const next = await this._phone().askNotifications();
                  this._took(next);
                  // Android no longer asks (refused before): its settings.
                  if (next && next.notify === false && window.flow.appSettings) window.flow.appSettings().catch(() => {});
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            }, T('alarm.notifications.allow')),
          );
        }
        notify.hidden = !notify.firstChild;
      };
      this._redraw = drawStatus;

      const save = async (on) => {
        const p = picked();
        if (on && !p) {
          error.textContent = T('alarm.enterTime');
          return false;
        }
        const at = p || { hour: s.hour, minute: s.minute };
        try {
          const next = await this._phone().setAlarm({
            on, hour: at.hour, minute: at.minute, days, texts: this._texts(at.hour, at.minute), plan: on ? Player.alarmPlan() : [],
          });
          this._took(next);
          if (!on) toast(T('alarm.off'), 'info');
          else toast(T('alarm.set', { day: this._day(this.state.nextAt), time: Util.fmtTimeOfDay(this.state.nextAt) }), 'success');
          // The first alarm: Android asks whether Flow may show notifications (the lock screen's Stop and Snooze).
          if (on && next && next.notify === false) this._phone().askNotifications().then((n) => this._took(n)).catch(() => {});
        } catch (err) {
          error.textContent = err.message;
          return false;
        }
        return true;
      };

      modal = Modal.open({
        title: T('alarm.title'),
        className: 'modal--alarm',
        sheet: document.body.classList.contains('mobile'),
        onClose: () => {
          this._redraw = null;
        },
        body: [
          h('p.alarm__intro', T('alarm.intro', { seconds: FADE_SECONDS })),
          status,
          h('div.alarm__row', h('label.alarm__label', T('alarm.time.label')), time),
          h('div.alarm__days', ...dayButtons),
          hint,
          h('p.alarm__note', T('alarm.note')),
          notify,
          error,
        ],
        buttons: [
          ...(s.on ? [{ label: T('alarm.turnOff'), align: 'left', onClick: () => save(false) }] : []),
          { label: T(s.on ? 'common.save' : 'alarm.setButton'), kind: 'primary', onClick: () => save(true) },
        ],
      });
      drawHint();
      drawStatus();
      return modal;
    },

    _draw() {
      const btn = $('btnAlarm');
      if (!btn) return;
      const s = this.state;
      const on = !!s.on || s.snoozeAt > Date.now() || !!s.ringing;
      btn.classList.toggle('sleep-btn--on', on);
      const names = this._dayNames(s.days);
      btn.title = s.on
        ? T(names ? 'alarm.button.on.days' : 'alarm.button.on', { time: this._time(s.hour, s.minute), days: names })
        : T('alarm.button.tooltip');
      btn.setAttribute('aria-label', btn.title);
    },
  };

  return api;
})();

if (typeof module === 'object' && module.exports) module.exports = Alarm;
