'use strict';

// "Open on PC Start" (the Mini Player's cogwheel): Flow starts with the
// computer, showing only the Mini Player (--mini). Windows keeps it as a
// login item (the user's Run key, through Electron); on Linux it is a
// .desktop file in ~/.config/autostart, which the desktops there start.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const FLAG = '--mini';
const LINUX_FILE = 'flow-mini-player.desktop';

/** Whether this start was the computer's (or asked for the Mini Player alone). */
const asked = (argv) => (argv || []).includes(FLAG);

/**
 * What the computer runs: Flow's own program once installed (an AppImage by
 * its file, not where it is unpacked); in development Electron with the
 * app's folder.
 */
function command() {
  if (app.isPackaged) return { exe: process.env.APPIMAGE || process.execPath, args: [FLAG] };
  return { exe: process.execPath, args: [app.getAppPath(), FLAG] };
}

/** One argument of a .desktop file's Exec line (the Desktop Entry spec's quoting). */
function quoteExec(arg) {
  const text = String(arg);
  if (/^[\w./:=@+-]+$/.test(text)) return text.replace(/%/g, '%%');
  return `"${text.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`;
}

/** The .desktop file that starts `exe` with `args` when the user signs in. */
function desktopEntry(exe, args = []) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Flow Mini Player',
    `Exec=${[exe, ...args].map(quoteExec).join(' ')}`,
    'Icon=flow',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function linuxFile() {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'autostart', LINUX_FILE);
}

/** Whether this computer can start Flow by itself (Windows and Linux). */
const supported = () => process.platform === 'win32' || process.platform === 'linux';

/** Turns the start with the computer on or off. Throws what went wrong. */
function set(on) {
  const { exe, args } = command();
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: !!on, path: exe, args });
    return;
  }
  if (process.platform !== 'linux') return;
  const file = linuxFile();
  if (!on) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desktopEntry(exe, args));
}

module.exports = {
  FLAG, asked, set, supported, desktopEntry, quoteExec,
};
