'use strict';

// Internet Radio for the web player (5.3.1). A page in a browser cannot play
// most stations itself through its Web Audio (they send no CORS header), nor
// one on plain http from an https page, nor read what a station plays. So the
// server plays a station through to it (core radioStream.js relay):
//
//   GET  /api/radio/stream?u=<station's address>&s=<id>   the sound, as it comes
//   GET  /api/radio/now?s=<id>    { meta, title, name }: whether the station says
//                                 what it plays, what that is now, its icy-name
//   POST /api/radio/check { url } Add Radio's check, by the same rules
//
// `s` is the page's own name for that stream (letters and digits), so it can
// ask what plays on it. The server never asks itself or the machine's own
// services through it (loopback, link-local), and passes on sound only (a
// web page or anything else is refused), so it is no way into the home
// network. A few streams at once per app, a few more in all.

const { relay, checkSound, isOwnAddress } = require('@flow/core/radioStream');

const PER_APP = 2;
const IN_ALL = 12;
// What plays on a stream is kept this long after it ended (a page asking late).
const KEEP_MS = 60 * 1000;
const STREAM_ID = /^[A-Za-z0-9_-]{6,64}$/;

// The tests' stations run on this machine: FLOW_SERVER_RADIO_LOOPBACK=on lets the relay ask it.
const refuse = (ip) => process.env.FLOW_SERVER_RADIO_LOOPBACK !== 'on' && isOwnAddress(ip);

function createRadioRelay({ log = () => {} } = {}) {
  // id -> { app, open (connections now), meta, title, name, endedAt }
  const streams = new Map();

  function sweep() {
    const old = Date.now() - KEEP_MS;
    for (const [id, s] of streams) if (!s.open && s.endedAt < old) streams.delete(id);
  }

  const openOf = (app) => [...streams.values()].reduce((n, s) => n + (app === null || s.app === app ? s.open : 0), 0);

  /**
   * A station played through to `res`. `app`: who asks (its install id or
   * address). Throws an Error with `status` when it cannot (nothing sent yet).
   */
  async function stream(res, { url, id, app }) {
    sweep();
    if (!STREAM_ID.test(String(id || ''))) throw Object.assign(new Error('The stream needs a name of its own (s=).'), { status: 400 });
    if (openOf(app) >= PER_APP || openOf(null) >= IN_ALL) {
      throw Object.assign(new Error('Too many radio stations are playing through this server right now.'), { status: 503 });
    }
    let s = streams.get(id);
    if (s && s.app !== app) throw Object.assign(new Error('That stream is another app\'s.'), { status: 403 });
    if (!s) {
      s = {
        app, open: 0, meta: false, title: '', name: '', endedAt: 0,
      };
      streams.set(id, s);
    }
    s.open += 1;
    let counted = true;
    const done = () => {
      if (!counted) return;
      counted = false;
      s.open -= 1;
      s.endedAt = Date.now();
    };
    res.on('close', done);
    try {
      await relay(url, res, {
        refuse,
        onInfo: (info) => {
          s.meta = !!info.meta;
          s.title = info.title || '';
          if (info.name) s.name = info.name;
        },
      });
    } catch (err) {
      done();
      if (!err.status) log(`Internet Radio: ${err.message}`);
      throw err;
    }
  }

  /** What plays on a stream: { meta, title, name }, or null when there is none of that name. */
  function now(id, app) {
    const s = streams.get(String(id || ''));
    if (!s || s.app !== app) return null;
    return { meta: s.meta, title: s.title, name: s.name };
  }

  /** Add Radio's check (core radioStream.js checkSound): { url, name, checked }. */
  function check(url) {
    return checkSound(url, { refuse });
  }

  return { stream, now, check };
}

module.exports = { createRadioRelay };
