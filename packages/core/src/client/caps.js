'use strict';

// What each Flow app can do. The window hides the controls of what its app
// cannot (Store.can), instead of asking which app it runs in.

const DESKTOP = {
  // yt-dlp runs here: Add Songs' Download, the Website Downloads settings.
  downloadHere: true,
  // A choice of where the music comes out.
  outputDevices: true,
  // The sleep timer can shut the computer down.
  shutdown: true,
  // Local Files is a folder the user sees: open it, move it, show a song in it.
  musicFolder: true,
  // Screen flash, the visualizers, the clouds and the equalizer.
  effects: true,
  // Keyboard shortcuts, and the hints that name them.
  keyboard: true,
  // A Local Files song is cut here (ffmpeg); without it only through a server.
  localTrim: true,
  // Local files picked for Add Songs may be moved instead of copied.
  moveOriginals: true,
  // Settings: Check for Updates.
  updateCheck: false,
};

const ANDROID = {
  downloadHere: false,
  outputDevices: false,
  shutdown: false,
  musicFolder: false,
  effects: false,
  keyboard: false,
  localTrim: false,
  moveOriginals: false,
  updateCheck: true,
};

module.exports = { DESKTOP, ANDROID };
