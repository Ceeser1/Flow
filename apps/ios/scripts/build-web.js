// The iPhone app's page, as the Android app's (apps/android/scripts/build-web.js
// buildWeb): the desktop renderer with window.flow as flow-ios.js, into
// public/, which project.yml puts into the app (Capacitor's "public" folder).
// Also Version.xcconfig, the app's version from package.json (the same number
// as every Flow package; its build number as Android's versionCode: 3.0.0 -> 30000).
const fs = require('fs');
const path = require('path');
const { buildWeb } = require('../../android/scripts/build-web');
const { version } = require('../package.json');

const IOS = path.join(__dirname, '..');

buildWeb({ out: path.join(IOS, 'public'), script: 'flow-ios.js' });

const [major, minor, patch] = version.split('.').map(Number);
fs.writeFileSync(path.join(IOS, 'Version.xcconfig'),
  `MARKETING_VERSION = ${version}\nCURRENT_PROJECT_VERSION = ${major * 10000 + minor * 100 + patch}\n`);
console.log(`public/ built from apps/desktop/renderer with flow-ios.js; Version.xcconfig ${version}`);
