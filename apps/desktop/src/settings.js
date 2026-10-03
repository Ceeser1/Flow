'use strict';

const fs = require('fs');
const paths = require('./paths');
const { writeJsonAtomic } = require('@flow/core/jsonFile');
const {
  createSettings, clean, DEFAULTS, EQ_COLORS, CLOUD_COLORS, VISUALIZERS,
} = require('@flow/core/client/settings');

// The settings themselves (defaults, what each may be) are shared with the
// Android app (@flow/core/client/settings); here they are kept in settings.json.
const settings = createSettings({
  read: () => {
    try {
      return JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'));
    } catch {
      return null;
    }
  },
  write: (value) => writeJsonAtomic(paths.settingsFile(), value),
});

const {
  load, all, get, set, clientId,
} = settings;

module.exports = { load, all, get, set, clean, clientId, DEFAULTS, EQ_COLORS, CLOUD_COLORS, VISUALIZERS };
