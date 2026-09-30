'use strict';

// Answers the apps' "who is a Flow Server here?" (UDP broadcast, see
// @flow/core/discovery) with the server's name and port. Only askers on a
// private network get an answer, and it holds nothing /api/hello would not
// tell anyone.

const dgram = require('dgram');
const { isPrivateIp } = require('@flow/core/address');
const { isRequest, makeReply } = require('@flow/core/discovery');

/**
 * Listens on UDP `port`. `info()` gives { id, name, port, protocol } for the
 * answer. Resolves { close }, or null (with a note in the log) when the port
 * is taken: the server works without, the apps then need the address typed.
 */
function startDiscovery({ port, info, log = () => {} }) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg, from) => {
      if (!isRequest(msg) || !isPrivateIp(from.address)) return;
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
