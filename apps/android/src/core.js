'use strict';

// The shared client as the Android app's page uses it (src/main.js builds
// window.flow from it), gathered for test/bundle.test.js, which bundles it as
// window.FlowCore and runs it without Node. On the desktop the same code runs
// in Electron's main process.

module.exports = {
  createRemote: require('@flow/core/client/remote').createRemote,
  createLocalLibrary: require('@flow/core/client/localLibrary').createLocalLibrary,
  createSettings: require('@flow/core/client/settings').createSettings,
  createActions: require('@flow/core/client/actions').createActions,
  common: require('@flow/core/client/common'),
  fileMeta: require('@flow/core/fileMeta'),
  model: require('@flow/core/libraryModel'),
};
