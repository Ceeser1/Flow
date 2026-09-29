'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Everything Flow keeps for itself lives under %LOCALAPPDATA%\Flow.
// Local rather than Roaming (Electron's default), because Chromium's own cache
// lands in userData too and a domain profile would try to sync all of it.
// FLOW_HOME and FLOW_MUSIC point both somewhere else, for trying the
// app out without touching the real library.
function rootDir() {
  if (process.env.FLOW_HOME) return process.env.FLOW_HOME;
  const local = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
  return path.join(local, 'Flow');
}

function ensure(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Read-only or unreachable; whoever uses it reports the real error.
  }
  return dir;
}

const userDataDir = () => path.join(rootDir(), 'data');
const libraryFile = () => path.join(ensure(rootDir()), 'library.json');
const settingsFile = () => path.join(ensure(rootDir()), 'settings.json');
const cacheDir = () => ensure(path.join(rootDir(), 'cache'));
// A copy of yt-dlp the app can update. The installed one sits in Program
// Files, where yt-dlp -U is not allowed to write.
const localToolsDir = () => ensure(path.join(rootDir(), 'tools'));

// The folder chosen in Settings, once there is one (main.js hands it over at
// start and after a move).
let chosenMusicDir = '';

function setMusicDir(dir) {
  chosenMusicDir = dir ? path.resolve(String(dir)) : '';
}

// Music\FlowPlayer, or the folder chosen in Settings.
// app.getPath follows the Music folder wherever the user has moved it,
// OneDrive included.
function musicDir() {
  if (chosenMusicDir) return ensure(chosenMusicDir);
  if (process.env.FLOW_MUSIC) return ensure(process.env.FLOW_MUSIC);
  let base;
  try {
    base = app.getPath('music');
  } catch {
    base = path.join(app.getPath('home'), 'Music');
  }
  return ensure(path.join(base, 'FlowPlayer'));
}

// Bundled tools: under resources\tools in an installed build, tools\ beside
// the project in development.
function bundledToolsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools')
    : path.join(__dirname, '..', 'tools');
}

function appIconPath() {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico');
  return fs.existsSync(file) ? file : null;
}

module.exports = {
  rootDir, userDataDir, libraryFile, settingsFile, cacheDir,
  localToolsDir, musicDir, setMusicDir, bundledToolsDir, appIconPath, ensure,
};
