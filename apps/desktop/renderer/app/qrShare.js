'use strict';

// Sharing a Flow Server by QR code (4.0): Share shows the server in use as a
// QR code (a flow://connect link with its addresses and a one-time pairing
// code, @flow/core/client/share), Scan on a phone reads one with the camera
// (Google's code scanner), and the desktop takes such a link pasted into the
// Home address. Either way the app connects to that server, the code traded
// for its password.

const QrShare = {
  /** The QR code of the server in use, in a popup. */
  async open() {
    let shared;
    try {
      shared = await window.flow.shareLink();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const code = await window.flow.qr(shared.link);
    const canvas = this._draw(code);
    const copy = Store.can('keyboard') ? h('button.btn.btn--small', {
      type: 'button',
      onclick: () => navigator.clipboard.writeText(shared.link).then(() => toast(T('qrShare.copied'), 'success'), () => toast(T('qrShare.notCopied'), 'error')),
    }, T('qrShare.copyLink')) : null;
    Modal.open({
      title: T('qrShare.title', { server: shared.name }),
      className: 'modal--small.modal--qr',
      body: [
        h('div.qr__frame', canvas),
        h('p.settings__note', Store.phone
          ? T('qrShare.howTo.phone')
          : T('qrShare.howTo.computer')),
        h('p.settings__note', shared.code
          ? T('qrShare.onceOnly')
          : T('qrShare.noPassword')),
        copy ? h('div.qr__bar', copy) : null,
      ],
      buttons: [{ label: T('common.close'), kind: 'primary' }],
    });
  },

  /** The modules as black squares on white, with the quiet zone around them. */
  _draw({ size, modules }) {
    const quiet = 4;
    const scale = Math.max(4, Math.floor(300 / (size + quiet * 2)));
    const px = (size + quiet * 2) * scale;
    const canvas = h('canvas.qr__code', { width: px, height: px });
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, px, px);
    g.fillStyle = '#000';
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) if (modules[y][x]) g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
    return canvas;
  },

  /** A phone's Scan: the camera reads a code, which connects. */
  async scan() {
    let text;
    try {
      text = await window.flow.scanQr();
    } catch (err) {
      if (!err.cancelled) toast(err.message, 'error');
      return;
    }
    if (text) await this.connect(text);
  },

  /** A flow://connect link (scanned, pasted): its server is the one in use. True when it was one. */
  async connect(text) {
    if (!/^\s*flow:\/\/connect/i.test(String(text || ''))) {
      toast(T('qrShare.notFlow'), 'error');
      return false;
    }
    try {
      const { name } = await window.flow.connectLink(String(text));
      toast(T('qrShare.connecting', { server: name }), 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    return true;
  },
};
