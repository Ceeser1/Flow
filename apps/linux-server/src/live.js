'use strict';

// The live channel: one stream per app (Server-Sent Events), kept open while
// the app is connected, on which the server tells it what happens right away
// (a session's pause, a join request) instead of waiting for its next poll.
// The apps talk back with ordinary requests (POST /api/sessions).
//
//   GET /api/live?client=<install id>
//
// Each event is "event: <type>" and "data: <json>". The first is `hello`
// { client, serverTime }; a ": ping" comment follows every PING_MS, so a
// proxy sees the connection is in use and the app notices a dead one. A
// second stream of the same app replaces the first. Every ping the stream's
// token is checked again: a password changed, a session of level 3 or 4 run
// out, and the stream ends with `end` { reason: 'auth' }.

const PING_MS = 10000;
// More apps than any household has: a stream costs little, but not nothing.
const MAX_STREAMS = 200;

/**
 * opts: { log, now, pingMs }. Returns the hub: open(req, res, info) for a new
 * stream (info: { client, check() -> extra info or null when no longer
 * allowed }), send(client, type, data), clients(), onOpen/onClose(fn),
 * close().
 */
function createLive({ log = () => {}, now = Date.now, pingMs } = {}) {
  pingMs = pingMs || PING_MS;
  const streams = new Map(); // client -> { res, info, timer }
  const openListeners = [];
  const closeListeners = [];

  function write(stream, text) {
    try {
      stream.res.write(text);
    } catch {
      // Gone; its close handler tidies up.
    }
  }

  function event(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify(data === undefined ? {} : data)}\n\n`;
  }

  function drop(client, stream, reason) {
    if (streams.get(client) !== stream) return;
    streams.delete(client);
    clearInterval(stream.timer);
    for (const fn of closeListeners) {
      try {
        fn(client, stream.info, reason);
      } catch (err) {
        log(`Live channel: ${err.message}`);
      }
    }
  }

  function end(client, stream, type, data, reason) {
    if (type) write(stream, event(type, data));
    drop(client, stream, reason);
    try {
      stream.res.end();
    } catch {
      // Already closed.
    }
  }

  return {
    PING_MS: pingMs,

    /** Whether another stream may open (`client` replacing its own always may). */
    hasRoom(client) {
      return streams.has(client) || streams.size < MAX_STREAMS;
    },

    open(req, res, info) {
      const { client } = info;
      const old = streams.get(client);
      if (old) end(client, old, 'end', { reason: 'replaced' }, 'replaced');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        // nginx passes this response on as it comes, even with proxy_buffering on.
        'X-Accel-Buffering': 'no',
      });
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true, pingMs);
      const stream = { res, info, timer: null, openedAt: now() };
      streams.set(client, stream);
      stream.timer = setInterval(() => {
        // Still allowed in? A changed password or an ended session closes it.
        let fresh = null;
        try {
          fresh = info.check ? info.check() : info;
        } catch {
          fresh = null;
        }
        if (!fresh) {
          end(client, stream, 'end', { reason: 'auth' }, 'auth');
          return;
        }
        Object.assign(info, fresh);
        write(stream, `: ping ${now()}\n\n`);
      }, pingMs);
      res.on('close', () => drop(client, stream, 'closed'));
      write(stream, event('hello', { client, serverTime: now(), pingMs }));
      for (const fn of openListeners) {
        try {
          fn(client, info);
        } catch (err) {
          log(`Live channel: ${err.message}`);
        }
      }
      // flow-server doctor: a second event a moment later shows whether a
      // proxy passes events on as they come or holds them back.
      if (info.probe) {
        setTimeout(() => {
          if (streams.get(client) === stream) end(client, stream, 'probe', { serverTime: now() }, 'probe');
        }, 1000);
      }
    },

    /** One event to one app; false when it has no stream open. */
    send(client, type, data) {
      const stream = streams.get(client);
      if (!stream) return false;
      write(stream, event(type, data));
      return true;
    },

    /** Ends an app's stream with a last event (e.g. its profile was deleted). */
    kick(client, type, data) {
      const stream = streams.get(client);
      if (stream) end(client, stream, type, data, 'kicked');
    },

    has(client) {
      return streams.has(client);
    },

    /** The apps connected now: [{ client, ...info }]. */
    clients() {
      return [...streams.entries()].map(([client, s]) => ({ ...s.info, client }));
    },

    info(client) {
      const s = streams.get(client);
      return s ? s.info : null;
    },

    onOpen(fn) {
      openListeners.push(fn);
    },

    onClose(fn) {
      closeListeners.push(fn);
    },

    close() {
      for (const [client, stream] of [...streams.entries()]) end(client, stream, 'end', { reason: 'shutdown' }, 'shutdown');
    },
  };
}

module.exports = { createLive, PING_MS, MAX_STREAMS };
