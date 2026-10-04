'use strict';

// What each Flow app can do. The window hides the controls of what its app
// cannot (Store.can), instead of asking which app it runs in.

const DESKTOP = {
  // yt-dlp runs here: Add Songs' Download, the Website Downloads settings.
  downloadHere: true,
  // A choice of where the music comes out, in Flow.
  outputDevices: true,
  // Where the music comes out is the phone's to choose (its own chooser, opened from Flow).
  systemOutput: false,
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
  // A Flow Server's songs kept here too: a playlist's Download, a song's.
  offline: true,
  // Settings: Check for Updates.
  updateCheck: false,
  // Flow's own volume slider (a phone's volume is its buttons).
  volume: true,
  // Song Transition: the next song faded in over the end of this one.
  songTransition: true,
};

const ANDROID = {
  downloadHere: false,
  outputDevices: false,
  systemOutput: true,
  shutdown: false,
  musicFolder: false,
  effects: false,
  keyboard: false,
  localTrim: false,
  moveOriginals: false,
  // Until the phone downloads songs itself (v3.0, Stage 5).
  offline: false,
  updateCheck: true,
  volume: false,
  // The phone plays gaplessly; fading songs over each other comes later (3.1).
  songTransition: false,
};

module.exports = { DESKTOP, ANDROID };
