'use strict';

// A visualizer's picture (or a background's video) picked in its cogwheel,
// as each app keeps it (window.flow.saveVizPicture): what it is by its
// first bytes, the most it may be, and which files it takes the place of.

/** 'png', 'mp4', 'webm' or (anything else) 'jpg', by the file's first bytes. */
function typeOf(bytes) {
  const b = bytes || [];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  // An MP4's first box is its 'ftyp', after the box's size.
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  return 'jpg';
}

const isVideo = (type) => type === 'mp4' || type === 'webm';

/**
 * The type `bytes` are kept as under `name` (typeOf), or an Error thrown: a
 * name not of letters, digits and dashes, no bytes, a picture over 30 MB or
 * a video over `videoMB`.
 */
function check(name, bytes, videoMB) {
  if (!/^[a-z][\w-]{0,40}$/i.test(String(name || ''))) throw new Error('Not a picture name.');
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Not a picture.');
  const type = typeOf(bytes);
  if (bytes.length > (isVideo(type) ? videoMB * 1e6 : 30e6)) throw new Error('Too big.');
  return type;
}

/** Whether `file` (a name in the folder) is one kept under `name` before, to go. */
const keptBefore = (file, name) => file.startsWith(`${name}-`) && /\.(jpg|png|mp4|webm)$/.test(file);

module.exports = { typeOf, isVideo, check, keptBefore };
