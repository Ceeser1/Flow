'use strict';

// Answers the apps' "who is a Flow Server here?" (UDP broadcast, see
// @flow/core/discovery) with the server's name and port. Only askers on a
// private network get an answer, and it holds nothing /api/hello would not
// tell anyone. Each asker gets a handful of answers a minute at most, so the
// port cannot be used to bounce traffic at someone else.

const dgram = require('dgram');
const { isPrivateIp } = require('@flow/core/address');
const { isRequest, makeReply } = require('@flow/core/discovery');

// One search is three questions, each perhaps heard once per network the
// asker is on; a few searches a minute is plenty.
const MAX_PER_MINUTE = 30;

/**
 * Listens on UDP `port`. `info()` gives { id, name, port, protocol } for the
 * answer. Resolves { close }, or null (with a note in the log) when the port
 * is taken: the server works without, the apps then need the address typed.
 */
function startDiscovery({ port, info, log = () => {}, maxPerMinute = MAX_PER_MINUTE }) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const asked = new Map(); // address -> answer times in the last minute
    const allowed = (address) => {
      const now = Date.now();
      const recent = (asked.get(address) || []).filter((t) => now - t < 60000);
      if (recent.length >= maxPerMinute) return false;
      recent.push(now);
      asked.set(address, recent);
      if (asked.size > 500) {
        for (const [a, times] of asked) if (!times.some((t) => now - t < 60000)) asked.delete(a);
      }
      return true;
    };
    socket.on('message', (msg, from) => {
      if (!isRequest(msg) || !isPrivateIp(from.address) || !allowed(from.address)) return;
      socket.send(makeReply(info()), from.port, from.address, () => {});
    });
    socket.once('error', (err) => {
      log(`Discovery is off (UDP ${port}: ${err.message}). Apps need the address typed in.`);
      try {
        socket.close();
      } catch {
        // Not open.
      }
      resolve(null);
    });
    socket.bind(port, '0.0.0.0', () => {
      socket.removeAllListeners('error');
      socket.on('error', () => {});
      resolve({ port: socket.address().port, close: () => new Promise((r) => socket.close(() => r())) });
    });
  });
}

module.exports = { startDiscovery };
