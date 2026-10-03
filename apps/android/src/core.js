'use strict';

// What the Android app's page uses of @flow/core, bundled into
// www/flow-core.js as window.FlowCore (scripts/bundle.js). On the desktop the
// same code runs in Electron's main process.

module.exports = {
  createRemote: require('@flow/core/client/remote').createRemote,
  createLocalLibrary: require('@flow/core/client/localLibrary').createLocalLibrary,
  createSettings: require('@flow/core/client/settings').createSettings,
  createActions: require('@flow/core/client/actions').createActions,
  common: require('@flow/core/client/common'),
  fileMeta: require('@flow/core/fileMeta'),
  model: require('@flow/core/libraryModel'),
};
