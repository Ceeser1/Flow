'use strict';

// Builds dist\Flow Server Setup <version>.exe: stages the files the installer
// carries in dist\stage, then runs makensis on installer.nsi.
//
//   npm run dist -w apps/windows-server
//
// What goes in:
//   node.exe        the Node.js this runs on (FLOW_NODE_EXE picks another)
//   app\server\     apps/linux-server's package.json and src
//   app\node_modules\@flow\core\   packages/core's package.json and src
//   app\windows\    src (setup.js, run.js, windows.js)
//   tools\          ffmpeg.exe and ffprobe.exe from apps/desktop/tools, when there
//   flow-server.cmd the server's command line
//   icon.ico        Flow's icon
//
// makensis is electron-builder's (app-builder-lib fetches it once), or the one
// in MAKENSIS.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const DIST = path.join(HERE, 'dist');
const STAGE = path.join(DIST, 'stage');
const { version } = require('./package.json');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

async function makensis() {
  if (process.env.MAKENSIS) return process.env.MAKENSIS;
  let nsisDir;
  try {
    const nsis = require('app-builder-lib/out/targets/nsis/nsisUtil');
    // It waits for electron-builder's options first; none here (its own NSIS).
    nsis.NsisTargetOptions.resolve({});
    nsisDir = await nsis.NSIS_PATH();
  } catch (err) {
    throw new Error(`makensis was not found (${err.message}). Run npm install at the repo's root, or set MAKENSIS.`);
  }
  return path.join(nsisDir, 'Bin', 'makensis.exe');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The Windows installer is built on Windows.');
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  const node = process.env.FLOW_NODE_EXE || process.execPath;
  const nodeVersion = spawnSync(node, ['-v'], { encoding: 'utf8' }).stdout.trim();
  if (Number(nodeVersion.replace(/^v/, '').split('.')[0]) < 18) throw new Error(`Node.js ${nodeVersion} is too old for the server (18 or newer).`);
  fs.copyFileSync(node, path.join(STAGE, 'node.exe'));

  const app = path.join(STAGE, 'app');
  for (const [from, to] of [
    [path.join(ROOT, 'apps', 'linux-server'), path.join(app, 'server')],
    [path.join(ROOT, 'packages', 'core'), path.join(app, 'node_modules', '@flow', 'core')],
  ]) {
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(path.join(from, 'package.json'), path.join(to, 'package.json'));
    copyDir(path.join(from, 'src'), path.join(to, 'src'));
  }
  copyDir(path.join(HERE, 'src'), path.join(app, 'windows'));

  const tools = path.join(STAGE, 'tools');
  fs.mkdirSync(tools);
  const missing = [];
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
    const src = path.join(ROOT, 'apps', 'desktop', 'tools', exe);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tools, exe));
    else missing.push(exe);
  }
  if (missing.length) console.warn(`Without ${missing.join(' and ')} (not in apps/desktop/tools): the server then gives hand-placed songs no length or tags, and cannot download.`);

  fs.writeFileSync(path.join(STAGE, 'flow-server.cmd'), [
    '@echo off',
    'rem The Flow Server\'s command line: flow-server --help says what it does.',
    'setlocal',
    'set "PATH=%~dp0;%~dp0tools;%LOCALAPPDATA%\\Flow\\server\\tools;%PATH%"',
    '"%~dp0node.exe" "%~dp0app\\server\\src\\main.js" %*',
    '',
  ].join('\r\n'));
  fs.copyFileSync(path.join(ROOT, 'apps', 'desktop', 'build', 'icon.ico'), path.join(STAGE, 'icon.ico'));

  const out = path.join(DIST, `Flow Server Setup ${version}.exe`);
  try {
    fs.rmSync(out, { force: true });
  } catch (err) {
    throw new Error(`${out} is in use (${err.code}): close the installer first.`);
  }
  const exe = await makensis();
  console.log(`Staged in ${STAGE} (Node.js ${nodeVersion}); building with ${exe}`);
  const r = spawnSync(exe, ['-V2', '-INPUTCHARSET', 'UTF8', `-DVERSION=${version}`, `-DSTAGE=${STAGE}`, `-DOUTFILE=${out}`,
    `-DICON=${path.join(STAGE, 'icon.ico')}`, path.join(HERE, 'installer.nsi')], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`makensis failed (exit code ${r.status}).`);
  console.log(`Built ${out} (${Math.round(fs.statSync(out).size / 1024 / 1024)} MB)`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
