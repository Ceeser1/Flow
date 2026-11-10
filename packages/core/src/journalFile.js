'use strict';

// A big JSON file kept as a whole file plus a log of its changes beside it
// (4.3.4): name and name.log. A change adds one line to the log (what changed,
// libraryPatch.js) instead of writing the whole file again, which for a
// library of 100 000 songs is some 80 MB every time a song is starred. Once
// the log has grown to a quarter of the whole (at least LOG_MIN), the whole
// is written again and the log starts over.
//
// The whole carries the id of its log ("_journal"), and the log's first line
// the id of the whole it belongs to, so a log left from before (the whole
// written, the program stopped before the log started over) is never
// applied to the wrong one. A last line cut off (the power gone while it was
// written) is left out: only that change is lost.
//
// io, by file name:
//   read(name) -> value | null            the whole (the app's own reading:
//                                         its .bak when the file is damaged)
//   write(name, value)                    the whole, safely (temporary file and rename)
//   readText(name) -> text | null         } the log; without appendText the
//   writeText(name, text)                 } whole is written every time, as
//   appendText(name, text)                } before (the web player, the iPhone)
//   remove(name)
// No Node modules: the phone runs this in its WebView.

const LibraryPatch = require('./libraryPatch');

const KEY = '_journal';
const LOG_MIN = 2 * 1024 * 1024;

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * spec: the parts compared item by item (libraryPatch.js); everything else
 * of the value is compared whole. logShare: how big the log may grow against
 * the whole before the whole is written again.
 */
function createJournal(io, file, spec, { logShare = 0.25, logMin = LOG_MIN } = {}) {
  // The file's name, or a function giving it (a folder known only later).
  const nameOf = typeof file === 'function' ? file : () => file;
  const logOf = () => `${nameOf()}.log`;
  const canLog = !!(io.readText && io.writeText && io.appendText);
  const differ = LibraryPatch.createDiffer(spec);
  let id = '';
  let logBytes = 0;
  let wholeBytes = 0;
  const stats = { whole: 0, lines: 0 };

  /** The value as saved: the whole with its log's changes, or null. */
  function load() {
    let value = null;
    try {
      value = io.read(nameOf());
    } catch {
      value = null;
    }
    if (!value || typeof value !== 'object') {
      differ.reset(null);
      return null;
    }
    const wholeId = typeof value[KEY] === 'string' ? value[KEY] : '';
    delete value[KEY];
    id = '';
    logBytes = 0;
    if (canLog && wholeId) {
      let text = null;
      try {
        text = io.readText(logOf());
      } catch {
        text = null;
      }
      const lines = text ? text.split('\n') : [];
      let head = null;
      try {
        head = lines.length ? JSON.parse(lines[0]) : null;
      } catch {
        head = null;
      }
      if (head && head.journal === wholeId) {
        id = wholeId;
        logBytes = text.length;
        for (let i = 1; i < lines.length; i += 1) {
          if (!lines[i]) continue;
          let line;
          try {
            line = JSON.parse(lines[i]);
          } catch {
            // Cut off while written: the changes before it stand.
            break;
          }
          if (line && Array.isArray(line.s)) value = LibraryPatch.apply(value, line.s, { inPlace: true });
        }
      }
    }
    // The size of the whole is only known once written; until then the log may grow to its minimum.
    wholeBytes = 0;
    differ.reset(value);
    return value;
  }

  /** The whole written again, its log started over. */
  function writeWhole(value) {
    if (!canLog) {
      io.write(nameOf(), value);
      return;
    }
    const next = newId();
    const text = JSON.stringify({ ...value, [KEY]: next });
    io.writeText(nameOf(), text);
    // The log started over (stopped in between: no log, and the whole has it all).
    try {
      if (io.remove) io.remove(logOf());
    } catch {
      // Not there.
    }
    io.appendText(logOf(), `${JSON.stringify({ journal: next })}\n`);
    id = next;
    wholeBytes = text.length;
    logBytes = 0;
    stats.whole += 1;
  }

  /** Saves `value`: its changes since the last save added to the log, or the whole when that is due. */
  function save(value) {
    if (!canLog) {
      io.write(nameOf(), value);
      return;
    }
    if (!id || !differ.started()) {
      writeWhole(value);
      differ.reset(value);
      return;
    }
    const steps = differ.next(value);
    if (!steps || !steps.length) return;
    const line = `${JSON.stringify({ s: steps })}\n`;
    if (logBytes + line.length > Math.max(logMin, wholeBytes * logShare)) {
      writeWhole(value);
      return;
    }
    try {
      io.appendText(logOf(), line);
      logBytes += line.length;
      stats.lines += 1;
    } catch {
      // The log could not be added to: the whole, which keeps all of it.
      writeWhole(value);
    }
  }

  /** Writes the whole now (a restore, a server switched), the log started over. */
  function saveWhole(value) {
    writeWhole(value);
    differ.reset(value);
  }

  /** Both files gone (the copy forgotten). */
  function remove() {
    for (const n of [nameOf(), logOf()]) {
      try {
        if (io.remove) io.remove(n);
      } catch {
        // Not there.
      }
    }
    id = '';
    logBytes = 0;
    differ.reset(null);
  }

  return {
    load, save, saveWhole, remove,
    /** For tests: { whole: writes of the whole, lines: lines added }. */
    stats: () => ({ ...stats, logBytes, wholeBytes }),
  };
}

module.exports = { createJournal, KEY };

// The parts of a library (libraryModel.sanitize's shape) compared item by
// item: its songs and playlists, and the listening records that grow with
// every listen (listening.js, the Statistics' days and sessions).
const STATISTICS_SPEC = { days: 'map', sessions: 'map', months: 'map' };
const LISTENING_SPEC = { 'songMonths.*': 'map', days: 'map' };

/** `spec` for a value found at `prefix` ('library', 'profiles.*'). */
function within(prefix, spec) {
  return Object.fromEntries(Object.entries(spec).map(([p, kind]) => [`${prefix}.${p}`, kind]));
}

const LIBRARY_SPEC = {
  songs: 'list', playlists: 'list', sharedPlaylists: 'list', ...within('listening', LISTENING_SPEC), ...within('statistics', STATISTICS_SPEC),
};

module.exports.within = within;
module.exports.LIBRARY_SPEC = LIBRARY_SPEC;
module.exports.STATISTICS_SPEC = STATISTICS_SPEC;
module.exports.LISTENING_SPEC = LISTENING_SPEC;
