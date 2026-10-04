'use strict';

// The release APK, signed with Flow's key: dist/Flow-<version>.apk.
//   npm run release -w apps/android
// The key is never in the repo (see README.md, "Releases"); without it this
// stops instead of making an APK no phone could update to.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ANDROID = path.join(__dirname, '..');
const PROJECT = path.join(ANDROID, 'android');
const { version } = require('../package.json');

const signing = process.env.FLOW_SIGNING || path.join(os.homedir(), 'FlowSigning', 'keystore.properties');
if (!fs.existsSync(signing)) {
  console.error(`No signing key: ${signing} is not there (or set FLOW_SIGNING). See apps/android/README.md.`);
  process.exit(1);
}

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
run('npm', ['run', 'sync'], ANDROID);
// By its full path: a shell may not look in the current folder for programs.
run(path.join(PROJECT, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), ['assembleRelease', '-q'], PROJECT);

const built = path.join(PROJECT, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!fs.existsSync(built)) {
  console.error(`The build made no signed APK (${built} is missing).`);
  process.exit(1);
}
const out = path.join(ANDROID, 'dist', `Flow-${version}.apk`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(built, out);
console.log(`${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
