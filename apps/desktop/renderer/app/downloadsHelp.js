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

  open() {
    const computer = Store.can('downloadHere');
    const box = h('input', { type: 'checkbox' });
    const missing = h('p.error-hint', { hidden: true });
    const how = computer
      ? h('div.downloads-help__how', { hidden: true },
        h('p.modal__text', 'Download yt-dlp.exe yourself from its latest release at GitHub and put it into Flow\'s tools folder.'),
        h('button.btn', { type: 'button', onclick: () => window.flow.openToolsFolder().catch((err) => toast(err.message, 'error')) }, 'Open Tools Folder'))
      : h('div.downloads-help__how', { hidden: true },
        h('p.modal__text', 'On the phone your Flow Server downloads the songs. Install yt-dlp on the server yourself (its installer says which file), then connect to it in Settings, Flow Server.'));
    const modal = Modal.open({
      title: 'Legal note',
      className: 'modal--small',
      body: [
        h('p.modal__text', 'Using Flow to play your own local music files is completely fine. Downloading requires yt-dlp. '
          + 'Using yt-dlp or downloading from URLs may break copyright law in your country or the terms of the site you download from. Use at your own risk.'),
        h('label.check.modal__check', box, h('span', 'I understand and want to proceed')),
        how,
        missing,
      ],
      buttons: [
        { label: 'Cancel' },
        { label: 'Done', kind: 'primary', onClick: () => this._done(computer, missing) },
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
        toast('yt-dlp found: Add Songs downloads from links now.', 'success');
        return true;
      }
      missing.textContent = 'yt-dlp.exe was not found in Flow\'s tools folder.';
    } else {
      if (ServerImport.available) return true;
      missing.textContent = 'No Flow Server that downloads songs is connected.';
    }
    missing.hidden = false;
    return false;
  },
};
