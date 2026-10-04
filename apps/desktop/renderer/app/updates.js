'use strict';

// Updates, where Flow has no store (the phone: caps.updateCheck). A while
// after the start, the newest release on GitHub is looked at; a newer one
// asks "Newer version X available, update?" with "Don't ask again" (then
// only Settings' Check for Updates asks), "Not now" (asked again at the next
// start) and "Update": the APK is downloaded and Android's installer opens,
// which asks before installing. Android lets Flow do that once allowed to
// ("Install unknown apps"): its setting opens, and coming back the update
// goes on by itself. A newer version found shows in Settings under the button.

const Updates = {
  // How long after the start the newest release is looked at (ms).
  START_DELAY_MS: 8000,
  _installing: false,
  // The release waiting for "Install unknown apps" to be switched on.
  _waitAllow: null,
  _progressEl: null,
  // The note saying how to allow that, closed on coming back.
  _allowNote: null,

  init() {
    if (!Store.can('updateCheck') || !window.flow.checkUpdate) return;
    window.flow.onUpdateProgress(({ frac }) => {
      if (this._progressEl) this._progressEl.textContent = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    });
    window.flow.onResume(() => {
      const found = this._waitAllow;
      if (!found) return;
      this._waitAllow = null;
      if (this._allowNote) this._allowNote.close();
      this.install(found, { ask: false });
    });
    // Installed since it was found: nothing to show any more.
    if (Store.settings.updateFound && !this.isNewer(Store.settings.updateFound.version, Store.version)) {
      Store.saveSettings({ updateFound: null });
    }
    setTimeout(() => this.check({ quiet: true }), this.START_DELAY_MS);
  },

  /** Whether version `a` is newer than `b` ("3.0.1" > "3.0.0"). */
  isNewer(a, b) {
    const x = String(a || '').split('.').map(Number);
    const y = String(b || '').split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    }
    return false;
  },

  /** A newer Flow found earlier, else null. */
  get found() {
    const f = Store.settings.updateFound;
    return f && this.isNewer(f.version, Store.version) ? f : null;
  },

  /**
   * Looks at GitHub. `quiet` (the start): nothing said unless there is a newer
   * Flow, and not even then after "Don't ask again". Resolves the newer
   * release, or null.
   */
  async check({ quiet = false } = {}) {
    let r;
    try {
      r = await window.flow.checkUpdate();
    } catch (err) {
      if (!quiet) toast(err.message, 'error');
      return null;
    }
    const found = r.newer ? r.latest : null;
    if (JSON.stringify(found) !== JSON.stringify(Store.settings.updateFound)) Store.saveSettings({ updateFound: found });
    if (!found) {
      if (!quiet) toast(r.latest ? `Flow ${Store.version} is the newest version.` : 'There is no release of Flow on GitHub yet.', 'info');
      return null;
    }
    if (!quiet || !Store.settings.updateNoPrompt) this.ask(found, { atStart: quiet });
    return found;
  },

  /** "Newer version X available, update?" (`atStart`: with "Don't ask again"). */
  ask(found, { atStart = false } = {}) {
    let box = null;
    const body = [h('p.modal__text', `Newer version ${found.version} available, update?`)];
    body.push(h('p.muted-text', `You have Flow ${Store.version}.${found.size ? ` The update is ${fmtBytes(found.size)}.` : ''} Android asks before it installs it; your songs and settings stay.`));
    if (atStart) {
      box = h('input', { type: 'checkbox' });
      body.push(h('label.check.modal__check', box, h('span', 'Don\'t ask again')));
    }
    Modal.open({
      title: 'Update available',
      className: 'modal--small',
      body,
      buttons: [
        { label: 'Not now' },
        { label: 'Update', kind: 'primary', onClick: () => { this.install(found); } },
      ],
      onClose: () => {
        if (box && box.checked) Store.saveSettings({ updateNoPrompt: true });
      },
    });
  },

  /** Downloads `found` and opens Android's installer (`ask`: may open Android's setting to allow it). */
  async install(found, { ask = true } = {}) {
    if (this._installing) return;
    this._installing = true;
    this._progressEl = h('span.update__progress', '0%');
    const modal = Modal.open({
      title: `Downloading Flow ${found.version}`,
      className: 'modal--small',
      body: [h('p.modal__text', 'Downloading the update… ', this._progressEl)],
    });
    try {
      const r = await window.flow.installUpdate(found, { ask });
      modal.close();
      if (!r.allowed) {
        if (!ask) {
          toast('Flow may not install updates yet: switch on "Install unknown apps" for Flow, then tap Update again.', 'info');
          return;
        }
        this._waitAllow = found;
        this._allowNote = Modal.open({
          title: 'Allow Flow to install its updates',
          className: 'modal--small',
          body: [
            h('p.modal__text', 'Android opened its setting "Install unknown apps". Switch it on for Flow, then come back: the update goes on by itself.'),
            h('p.muted-text', 'Asked once: later updates install straight away (Android still asks before each one).'),
          ],
          buttons: [{ label: 'OK', kind: 'primary' }],
          onClose: () => {
            this._allowNote = null;
          },
        });
      } else if (!r.started) {
        toast('Android\'s installer could not be opened.', 'error');
      }
    } catch (err) {
      modal.close();
      toast(err.message, 'error');
    } finally {
      this._installing = false;
      this._progressEl = null;
    }
  },
};
