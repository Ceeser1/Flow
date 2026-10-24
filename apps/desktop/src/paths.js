'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Everything Flow keeps for itself lives under %LOCALAPPDATA%\Flow.
// Local rather than Roaming (Electron's default), because Chromium's own cache
// lands in userData too and a domain profile would try to sync all of it.
// Elsewhere it is $XDG_DATA_HOME/Flow (~/.local/share/Flow).
// FLOW_HOME and FLOW_MUSIC point both somewhere else, for trying the
// app out without touching the real library.
function rootDir() {
  if (process.env.FLOW_HOME) return process.env.FLOW_HOME;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
    return path.join(local, 'Flow');
  }
  const data = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
  return path.join(data, 'Flow');
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
// Where yt-dlp(.exe) goes (Flow does not ship it), somewhere yt-dlp -U may write.
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

// Covers (covers.js): Music\FlowPlayer\Covers, with Local Files' own in
// Covers\local and each Flow Server's in Covers\<server id>. They move with
// the music folder.
const COVERS = 'Covers';
const coversDir = () => path.join(musicDir(), COVERS);

// Lyrics (@flow/core/client/lyricsFolder): Music\FlowPlayer\Lyrics, beside
// Covers and laid out as it is. They move with the music folder too.
const LYRICS = 'Lyrics';
const lyricsDir = () => path.join(musicDir(), LYRICS);

// Bundled tools: under resources\tools in an installed build, tools\ beside
// the project in development.
function bundledToolsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools')
    : path.join(__dirname, '..', 'tools');
}

// The window's and notifications' icon: icon.ico on Windows, icon.png
// elsewhere.
function appIconPath() {
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const file = app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', 'build', name);
  return fs.existsSync(file) ? file : null;
}

module.exports = {
  rootDir, userDataDir, libraryFile, settingsFile, cacheDir,
  localToolsDir, musicDir, setMusicDir, coversDir, COVERS, lyricsDir, LYRICS, bundledToolsDir, appIconPath, ensure,
};
