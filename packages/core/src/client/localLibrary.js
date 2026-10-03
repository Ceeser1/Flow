'use strict';

// The songs kept on this device (Local Files): the library held in memory,
// saved whole after every change, and whoever listens told. Where it is saved
// is the app's (read, write); the rules are libraryModel.js's.

const model = require('../libraryModel');
const { randomHex } = require('./common');

/** read(): the saved library, or null. write(data): saves it. */
function createLocalLibrary({ read, write }) {
  let data = null;
  const listeners = [];

  const newId = () => randomHex(6);

  function load() {
    data = model.sanitize(read());
    return data;
  }

  function get() {
    return data || load();
  }

  function save() {
    write(get());
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  function notify() {
    for (const fn of listeners) {
      try {
        fn(get());
      } catch {
        // A closed window must not stop the save that follows.
      }
    }
  }

  /**
   * Runs one change against the library, then saves and tells the window.
   * Whatever `fn` returns is handed back; whatever it throws is thrown on, with
   * nothing saved.
   */
  function mutate(fn) {
    const result = fn(get());
    save();
    notify();
    return result;
  }

  return { load, get, save, onChange, notify, mutate, newId };
}

module.exports = { createLocalLibrary };
