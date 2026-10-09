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
  // Equalize volume measures Local Files songs here (ffmpeg); elsewhere only a server's are.
  measureLoudness: true,
  // Help with an OS that stops apps in the background to save battery (Settings, once by itself).
  batteryHelp: false,
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
  offline: true,
  updateCheck: true,
  volume: false,
  // The phone's player fades from one song to the next itself (setTransition).
  songTransition: true,
  measureLoudness: false,
  batteryHelp: true,
};

// The iPhone: as the Android phone, without what iOS has no need or room for.
const IOS = {
  ...ANDROID,
  // Sideloaded and signed by each person (SideStore): nothing to update from.
  updateCheck: false,
  // iOS lets a playing app run in the background: nothing to ask for.
  batteryHelp: false,
};

module.exports = { DESKTOP, ANDROID, IOS };
