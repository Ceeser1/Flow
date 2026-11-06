'use strict';

// "Downloads?": Flow comes without yt-dlp, the program that downloads from
// links. Where nothing can download (a computer without yt-dlp in Flow's tools
// folder and no Flow Server that downloads songs; a phone without such a
// server), a "Downloads?" button stands in for the link box on Add Songs; a
// computer without yt-dlp but with such a server shows Download (Client)
// greyed out. Both open the legal note. Once "I understand" is ticked it says
// how to get yt-dlp (no link to it: on a computer into the tools folder,
// which Open Tools Folder opens; for a phone onto the server), and Done
// looks whether it is there now.

const DownloadsHelp = {
  /** yt-dlp is in this computer's tools folder: Add Songs' own Download works. */
  get here() {
    return Store.can('downloadHere') && !!(Store.tools && Store.tools.ytDlp);
  },

  /** yt-dlp's file name on this computer. */
  get file() {
    if (Store.os === 'win32') return 'yt-dlp.exe';
    return Store.os === 'linux' ? 'yt-dlp_linux' : 'yt-dlp';
  },

  open() {
    const computer = Store.can('downloadHere');
    const box = h('input', { type: 'checkbox' });
    const missing = h('p.error-hint', { hidden: true });
    const how = computer
      ? h('div.downloads-help__how', { hidden: true },
        h('p.modal__text', T('downloadsHelp.desktop.getIt', { file: this.file })),
        h('button.btn', { type: 'button', onclick: () => window.flow.openToolsFolder().catch((err) => toast(err.message, 'error')) }, T('downloadsHelp.desktop.openTools')))
      : h('div.downloads-help__how', { hidden: true },
        h('p.modal__text', T('downloadsHelp.phone.serverDownloads')));
    const modal = Modal.open({
      title: T('downloadsHelp.legal.title'),
      className: 'modal--small',
      body: [
        h('p.modal__text', T('downloadsHelp.legal.text')),
        h('label.check.modal__check', box, h('span', T('downloadsHelp.legal.understand'))),
        how,
        missing,
      ],
      buttons: [
        { label: T('common.cancel') },
        { label: T('common.done'), kind: 'primary', onClick: () => this._done(computer, missing) },
      ],
    });
    const done = modal.el.querySelector('.modal__footer .btn--primary');
    const draw = () => {
      how.hidden = !box.checked;
      done.disabled = !box.checked;
      if (!box.checked) missing.hidden = true;
    };
    box.addEventListener('change', draw);
    draw();
    return modal;
  },

  /** Done: closes once something can download; else says what is missing and stays open. */
  async _done(computer, missing) {
    if (computer) {
      try {
        Store.tools = await window.flow.toolStatus();
      } catch {
        // Kept as it was: not found.
      }
      if (this.here) {
        ServerImport.drawButtons();
        toast(T('downloadsHelp.desktop.found'), 'success');
        return true;
      }
      missing.textContent = T('downloadsHelp.desktop.notFound', { file: this.file });
    } else {
      if (ServerImport.available) return true;
      missing.textContent = T('downloadsHelp.noServer');
    }
    missing.hidden = false;
    return false;
  },
};
