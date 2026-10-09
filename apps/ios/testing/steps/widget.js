'use strict';

// The home screen widget: what it shows (the App Group's file, written as the
// song plays: names, cover, playing, place) and its buttons (Play/Pause,
// Next) working the player, also with Flow out of sight. Then a button
// pressed while Flow is not running: iOS starts Flow for it, without a page,
// and Play plays the song Flow was on, the songs after it next; the page
// that starts afterwards takes it over.

const {
  wait, loadAndPlay, start,
} = require('./common');

// The native player's song: before Next, after it, and when Flow ended.
const seen = {};

const widget = (name, waitFor, extra = {}) => ({
  name, native: 'widget', waitFor, timeout: 10000, ...extra,
});

module.exports = [
  ...start,
  {
    // Sine E has a cover of its own.
    name: 'plays',
    js: loadAndPlay('Sine E'),
    timeout: 20000,
    expect: (v) => v.now === 'Sine E' && !v.paused,
  },
  widget('the widget shows it', (v) => v.title === 'Sine E' && v.playing, {
    expect: (v) => v.artist === 'Flow Test' && v.duration > 40 && v.cover && v.coverFile,
  }),
  { name: 'Pause on the widget', native: 'widget-toggle' },
  { name: 'the player paused', native: 'player', waitFor: (v) => !v.pwr, timeout: 5000 },
  widget('the widget shows it paused', (v) => !v.playing),
  { name: 'the page too', js: `${wait(500)} return { paused: Player.engine.paused };`, expect: (v) => v.paused },
  { name: 'Play on the widget', native: 'widget-toggle' },
  {
    name: 'the player plays',
    native: 'player',
    waitFor: (v) => v.pwr && v.st === 3,
    timeout: 8000,
    expect: (v) => {
      seen.before = v.key;
      return true;
    },
  },
  widget('the widget shows it playing', (v) => v.playing),
  { name: 'out of sight', background: true, wait: 4000 },
  { name: 'Next on the widget, Flow out of sight', native: 'widget-next' },
  {
    name: 'the next song plays',
    native: 'player',
    waitFor: (v) => v.key !== seen.before && v.pwr && v.st === 3,
    timeout: 8000,
    expect: (v) => {
      seen.next = v.key;
      return true;
    },
  },
  widget('the widget shows the next song', (v) => v.title && v.title !== 'Sine E' && v.playing),
  { name: 'back to Flow', foreground: true, wait: 2500 },
  {
    name: 'the page caught up',
    native: 'player',
    expect: (v) => {
      seen.now = v.key;
      return v.pwr;
    },
  },
  { name: 'the page\'s song', js: 'return { id: Player.currentId, paused: Player.engine.paused };', expect: (v) => v.id === seen.now && !v.paused },
  {
    // Flow ended (iOS lets an app go): its song kept, then Play on the widget starts Flow.
    name: 'Flow ended; Play on the widget starts it',
    native: 'player',
    expect: (v) => {
      seen.ended = v.key;
      return true;
    },
  },
  { name: 'Flow started by the widget', relaunch: ['-FlowTestWidget', 'toggle'], wait: 1500 },
  {
    name: 'it plays the song it was on',
    native: 'player',
    waitFor: (v) => v.pwr && v.st === 3,
    timeout: 20000,
    expect: (v) => v.key === seen.ended && v.songs > 1,
  },
  widget('the widget shows it playing again', (v) => v.playing),
  {
    name: 'the page that starts takes it over',
    until: `return typeof Store !== 'undefined' && !!Store.version && !!Player.currentId
      && { id: Player.currentId, paused: Player.engine.paused, now: (Store.song(Player.currentId) || {}).title };`,
    timeout: 40000,
    wait: 1500,
    shot: '01-taken-over',
    expect: (v) => v.id === seen.ended && !v.paused,
  },
  { name: 'pause', js: `Player.pause(); ${wait(800)} return Player.engine.paused;`, expect: (v) => v === true },
  widget('the widget shows it paused at the end', (v) => !v.playing),
];
