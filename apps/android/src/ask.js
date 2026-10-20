'use strict';

// The questions the shared client asks when the phone's songs go up to a
// Flow Server (remote.init's confirmUpload and askExisting), asked in the
// window, as the desktop asks them in a dialog of its own (main.js). The
// window's dialogs (ui.js: Modal, confirmDialog, h) are there by the time a
// server is connected to; without them the answer is the careful one.

const ui = () => (typeof Modal !== 'undefined' && typeof confirmDialog === 'function' && typeof h === 'function');

/**
 * Songs on the phone, a server not used before: may they go up? fromOthers:
 * how many are copies downloaded from other servers; returning: songs that
 * came to the phone while another server was in use.
 */
async function upload({
  count, name, fromOthers = 0, returning = false,
}) {
  if (!ui()) return false;
  const songs = count === 1 ? 'song' : `${count} songs`;
  const others = fromOthers ? ` ${fromOthers === count ? (count === 1 ? 'It was' : 'All of them were') : `${fromOthers} of them were`} downloaded from another Flow Server.` : '';
  const answer = await confirmDialog({
    title: `Upload ${count === 1 ? 'your song' : `your ${count} songs`}?`,
    message: returning
      ? `Upload the ${songs} that came to this phone while you used another Flow Server to "${name}"?${others} `
        + 'Choose Not now to keep them on this phone only; Synchronize now in Settings uploads them later.'
      : `Upload the ${songs} on this phone to "${name}"? This is a Flow Server you have not used before.${others} `
        + 'If you are not sure it is yours, choose Not now: your songs stay on this phone, and Synchronize now in Settings uploads them later.',
    confirmLabel: 'Upload',
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
      title: 'Already on the server',
      className: 'modal--small',
      body: [
        h('p.modal__text', `"${label(local)}" is on "${name}" already, as "${label(server)}". It is the same song under other names: `
          + 'use the names from here on the server, keep the server\'s, or upload it as a song of its own?'),
        h('label.check.modal__check', box, h('span', 'Do the same for the other songs of this upload')),
      ],
      buttons: [
        { label: 'New song', onClick: () => { choice = 'new'; } },
        { label: 'Keep the server\'s', onClick: () => { choice = 'keep'; } },
        { label: 'Use these', kind: 'primary', onClick: () => { choice = 'apply'; } },
      ],
      onClose: () => resolve({ choice, all: box.checked }),
    });
  });
}

module.exports = { upload, existing };
