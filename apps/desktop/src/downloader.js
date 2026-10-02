'use strict';

// One song from a link into the cache: probe, download, prepare. The work is
// done by @flow/core/media (shared with the Flow Server); this is the desktop
// app's handle on it.

const media = require('./media');
const { ProcessCancelledError } = require('@flow/core/processRunner');

module.exports = {
  probe: media.probe,
  probedFrom: media.probedFrom,
  readJson: media.readJson,
  download: media.download,
  prepareLocal: media.prepareLocal,
  clearCache: media.clearCache,
  ProcessCancelledError,
};
