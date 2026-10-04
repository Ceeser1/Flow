'use strict';

// What another app shared to Flow (Android's Share > Flow; FlowNative's
// "share" { text, subject }): the first web link in it, which Add Songs
// downloads. Apps share a link alone ("https://youtu.be/..."), or in a
// sentence ("Listen to this on ...: https://..."), sometimes in brackets.

const LINK = /https?:\/\/[^\s<>"']+/i;

/** { url, text }: the first web link shared ('' when there is none), and what was shared. */
function sharedLink(shared) {
  const text = String((shared && shared.text) || '').trim();
  const subject = String((shared && shared.subject) || '').trim();
  const found = LINK.exec(text) || LINK.exec(subject);
  // A sentence's full stop or a bracket around the link are not part of it.
  const url = found ? found[0].replace(/[.,;:!?)\]}>]+$/, '') : '';
  return { url, text: text || subject };
}

module.exports = { sharedLink };
