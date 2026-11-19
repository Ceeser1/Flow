'use strict';

// The questions the shared client asks when the phone's songs go up to a
// Flow Server (remote.init's confirmUpload and askExisting), asked in the
// window, as the desktop asks them in a dialog of its own (main.js). The
// window's dialogs (ui.js: Modal, confirmDialog, h) are there by the time a
// server is connected to; without them the answer is the careful one.

const { tr } = require('@flow/core/lang');

const ui = () => (typeof Modal !== 'undefined' && typeof confirmDialog === 'function' && typeof h === 'function');

/**
 * Songs on the phone, a server not used before: may they go up? fromOthers:
 * how many are copies downloaded from other servers; returning: songs that
 * came to the phone while another server was in use.
 */
async function upload({
  count, name, fromOthers = 0, returning = false, known = 0,
}) {
  if (!ui()) return false;
  const one = count === 1;
  const songs = one ? 'song' : '{count} songs';
  // known: how many more songs here the server has already (they are not sent, and not asked about).
  const there = known ? ` ${tr('desktop.upload.detail.alreadyThere', known === 1
    ? '{count} more song here is on that server already and is not sent.'
    : '{count} more songs here are on that server already and are not sent.', { count: known })}` : '';
  let from = '';
  if (fromOthers && fromOthers === count) {
    from = one ? tr('common.upload.fromOthers.it', 'It was downloaded from another Flow Server.')
      : tr('common.upload.fromOthers.all', 'All of them were downloaded from another Flow Server.');
  } else if (fromOthers) {
    from = tr('common.upload.fromOthers.some', fromOthers === 1
      ? '{count} of them was downloaded from another Flow Server.'
      : '{count} of them were downloaded from another Flow Server.', { count: fromOthers });
  }
  // {fromOthers} in the sentences: what the server has already and where the songs came from, each with a space before it.
  const vars = { count, server: name, fromOthers: `${there}${from ? ` ${from}` : ''}` };
  const answer = await confirmDialog({
    title: tr('phone.upload.title', one ? 'Upload your song?' : 'Upload your {count} songs?', vars),
    message: returning
      ? tr('phone.upload.text.afterOther', `Upload the ${songs} that came to this phone while you used another Flow Server to "{server}"?{fromOthers} `
        + 'Choose Not now to keep them on this phone only; Synchronize now in Settings uploads them later.', vars)
      : tr('phone.upload.text', `Upload the ${songs} on this phone to "{server}"? This is a Flow Server you have not used before.{fromOthers} `
        + 'If you are not sure it is yours, choose Not now: your songs stay on this phone, and Synchronize now in Settings uploads them later.', vars),
    confirmLabel: tr('common.upload', 'Upload'),
    cancelLabel: tr('common.notNow', 'Not now'),
  });
  return !!answer;
}

/** An upload the server has already, under other names: { choice: apply | keep | new, all }. */
function existing({ local, server, name }) {
  if (!ui()) return Promise.resolve({ choice: 'keep', all: true });
  const label = (n) => `${[n.artist, n.title].filter(Boolean).join(' - ')}${n.mix ? ` (${n.mix})` : ''}`;
  return new Promise((resolve) => {
    let choice = 'keep';
    const box = h('input', { type: 'checkbox' });
    Modal.open({
      title: tr('phone.sameSong.title', 'Already on the server'),
      className: 'modal--small',
      body: [
        h('p.modal__text', tr('phone.sameSong.text', '"{song}" is on "{server}" already, as "{serverSong}". It is the same song under other names: '
          + 'use the names from here on the server, keep the server\'s, or upload it as a song of its own?', { song: label(local), server: name, serverSong: label(server) })),
        h('label.check.modal__check', box, h('span', tr('common.sameSong.forAll', 'Do the same for the other songs of this upload'))),
      ],
      buttons: [
        { label: tr('phone.sameSong.newSong', 'New song'), onClick: () => { choice = 'new'; } },
        { label: tr('common.sameSong.keepServers', 'Keep the server\'s'), onClick: () => { choice = 'keep'; } },
        { label: tr('phone.sameSong.useThese', 'Use these'), kind: 'primary', onClick: () => { choice = 'apply'; } },
      ],
      onClose: () => resolve({ choice, all: box.checked }),
    });
  });
}

module.exports = { upload, existing };
