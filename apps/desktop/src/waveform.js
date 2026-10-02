'use strict';

// Audio peaks for the trim editor's waveform (@flow/core/media peaksFor). Only
// one song is ever in the editor, so there is no cache: loading another song
// stops the analysis in flight.

const media = require('./media');

let current = null;

function abort() {
  if (!current) return;
  if (current.cancel) current.cancel();
  else current.cancelled = true;
  current = null;
}

/** Flat [min0, max0, min1, max1, ...] for the file, values -1..1. */
function peaksFor(filePath, duration) {
  abort();
  const token = { cancelled: false };
  current = token;
  return media.peaksFor(filePath, duration, token).finally(() => {
    if (current === token) current = null;
  });
}

module.exports = { peaksFor, abort };
