'use strict';

// The phone's audio engine (src/engine.js) against a stand-in for FlowAudio:
// what it sends the player, and how it follows the player's events.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAudioEngine, fileAddressToPath } = require('../src/engine');

function fakePlugin() {
  const listeners = {};
  const plugin = {
    runs: [],
    answer: null,     // the state run() answers
    addListener(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    },
    run({ ops }) {
      plugin.runs.push(ops);
      return Promise.resolve(plugin.answer);
    },
    fire(name, payload) {
      for (const fn of listeners[name] || []) fn(payload);
    },
  };
  return plugin;
}

function setup() {
  const plugin = fakePlugin();
  let clock = 1000;
  const engine = createAudioEngine({ plugin, toPath: (a) => a.replace('page:', ''), now: () => clock });
  const events = [];
  for (const type of ['play', 'pause', 'ended', 'timeupdate', 'seeking', 'durationchange', 'loadedmetadata', 'error']) {
    engine.on(type, () => events.push(type));
  }
  return { plugin, engine, events, tick: (ms) => { clock += ms; } };
}

const settle = () => new Promise((r) => setImmediate(r));
const state = (o) => ({ id: '1', pwr: false, st: 3, t: 0, d: 200, rate: 1, ...o });

test('a song loaded and played in one turn goes over as one operation', async () => {
  const { plugin, engine, events } = setup();
  engine.setVolume(1);
  await settle();
  assert.equal(engine.load('http://pi:7878/a?t=x', 1.5, 30), true);
  engine.play();
  engine.setMeta({ title: 'Teardrop', artist: 'Massive Attack', album: 'Evening', artwork: 'page:/data/c/1.jpg' });
  assert.equal(engine.paused, false);
  assert.equal(engine.time, 30);
  await settle();
  assert.deepEqual(plugin.runs, [
    [{ op: 'volume', volume: 1 }],
    [{
      op: 'load', id: '1', src: 'http://pi:7878/a?t=x', gain: 1.5, at: 30, play: true,
      meta: { title: 'Teardrop', artist: 'Massive Attack', album: 'Evening', artwork: '/data/c/1.jpg' },
    }],
  ]);
  assert.deepEqual(events, ['play']);
  // The same text again is not sent again.
  engine.setMeta({ title: 'Teardrop', artist: 'Massive Attack', album: 'Evening', artwork: 'page:/data/c/1.jpg' });
  await settle();
  assert.equal(plugin.runs.length, 2);
});

test('the player\'s state: length, place, and a pause from the notification', async () => {
  const { plugin, engine, events, tick } = setup();
  engine.load('http://pi/a', 1, 0);
  engine.play();
  plugin.answer = state({ pwr: true, st: 2, d: -1 });
  await settle();
  events.length = 0;
  plugin.fire('state', state({ pwr: true, st: 3, t: 0.5 }));
  assert.deepEqual(events, ['durationchange', 'loadedmetadata', 'timeupdate']);
  assert.equal(engine.duration, 200);
  assert.equal(engine.readyState, 4);
  // The time moves on by the clock between events.
  tick(2000);
  assert.equal(engine.time, 2.5);
  // Another song's state is not this one's.
  plugin.fire('state', state({ id: '0', pwr: false, t: 99 }));
  assert.equal(engine.paused, false);
  // Paused by the notification (or a call).
  events.length = 0;
  plugin.fire('state', state({ pwr: false, t: 2.6 }));
  assert.equal(engine.paused, true);
  assert.deepEqual(events, ['pause', 'timeupdate']);
  tick(5000);
  assert.equal(engine.time, 2.6);
});

test('states sent before a list of operations arrived are passed over', async () => {
  const { plugin, engine, events } = setup();
  engine.load('http://pi/a', 1, 0);
  engine.play();
  plugin.answer = state({ pwr: true, t: 0 });
  // Still on its way: an older state saying paused does not pause it.
  let release;
  plugin.run = ({ ops }) => {
    plugin.runs.push(ops);
    return new Promise((r) => { release = () => r(plugin.answer); });
  };
  await settle();
  plugin.fire('state', state({ pwr: false }));
  assert.equal(engine.paused, false);
  release();
  await settle();
  assert.equal(engine.paused, false);
  assert.ok(events.includes('loadedmetadata'));
});

test('the end of a song: pause, then ended; play starts it again', async () => {
  const { plugin, engine, events } = setup();
  engine.load('http://pi/a', 1, 0);
  engine.play();
  plugin.answer = state({ pwr: true });
  await settle();
  events.length = 0;
  plugin.fire('state', state({ pwr: true, st: 4, t: 200 }));
  assert.equal(engine.paused, false);
  plugin.fire('ended', { id: '1' });
  assert.deepEqual(events, ['timeupdate', 'pause', 'ended']);
  assert.equal(engine.paused, true);
  assert.equal(engine.time, 200);
  plugin.fire('ended', { id: '0' });
  assert.equal(events.filter((e) => e === 'ended').length, 1);
  engine.play();
  assert.equal(engine.time, 0);
  await settle();
  assert.deepEqual(plugin.runs.at(-1), [{ op: 'play' }]);
});

test('the seek to the start place is the load\'s own; other seeks go over', async () => {
  const { plugin, engine, events } = setup();
  engine.load('http://pi/a', 1, 42);
  plugin.answer = state({ t: 42 });
  await settle();
  engine.seek(42);
  engine.seek(10);
  plugin.answer = state({ t: 10 });
  await settle();
  assert.deepEqual(plugin.runs.at(-1), [{ op: 'seek', t: 10 }]);
  assert.ok(events.includes('seeking'));
  assert.equal(engine.time, 10);
});

test('rates, gains and volumes only go over when they change', async () => {
  const { plugin, engine } = setup();
  engine.load('http://pi/a', 2, 0);
  await settle();
  plugin.runs.length = 0;
  engine.setRate(1);
  engine.setGain(2);
  engine.setRate(1.03);
  engine.setRate(1.03);
  engine.setGain(0.5);
  await settle();
  assert.deepEqual(plugin.runs, [[{ op: 'rate', rate: 1.03 }, { op: 'gain', gain: 0.5 }]]);
});

test('an error: paused, and told', async () => {
  const { plugin, engine, events } = setup();
  engine.load('http://pi/a', 1, 0);
  engine.play();
  await settle();
  plugin.fire('error', { id: '1', message: 'ERROR_CODE_IO_BAD_HTTP_STATUS' });
  assert.equal(engine.paused, true);
  assert.ok(events.includes('error'));
  assert.equal(engine.loaded, true);
  engine.unload();
  assert.equal(engine.loaded, false);
  await engine.play().then(() => assert.fail('played nothing'), () => {});
});

test('a file the page knows by its Capacitor address is played from its path', () => {
  const origin = 'http://localhost';
  assert.equal(fileAddressToPath(`${origin}/_capacitor_file_/data/user/0/x/files/covers/a%20b.jpg?v=3&r=1`, origin), '/data/user/0/x/files/covers/a b.jpg');
  assert.equal(fileAddressToPath('http://192.168.0.61:7878/api/songs/x/audio?t=1', origin), 'http://192.168.0.61:7878/api/songs/x/audio?t=1');
  assert.equal(fileAddressToPath('', origin), '');
});
