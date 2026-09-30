'use strict';

// Finding a Flow Server on the local network. An app broadcasts a small UDP
// message; every server that hears it answers the asker directly with who it
// is and its port. The apps then know the address without it being typed.
//
// The question goes to one fixed UDP port (the apps cannot know a server's
// own), and the answer carries the server's real port.

const dgram = require('dgram');
const os = require('os');
const { DEFAULT_PORT } = require('./address');

const DISCOVERY_PORT = DEFAULT_PORT;
const REQUEST = Buffer.from(JSON.stringify({ app: 'flow-discover', v: 1 }));
const MAX_MESSAGE = 1024;

/** Is this datagram an app asking who is there? */
function isRequest(buf) {
  if (!buf || buf.length > MAX_MESSAGE) return false;
  try {
    const m = JSON.parse(buf.toString('utf8'));
    return !!m && m.app === 'flow-discover' && m.v === 1;
  } catch {
    return false;
  }
}

/** A server's answer: what /api/hello tells anyone, and the port to use. */
function makeReply({ id, name, port, protocol }) {
  return Buffer.from(JSON.stringify({ app: 'flow-server', id, name, port, protocol }));
}

/** { ip, port, name, id, protocol } of an answer from `address`, or null. */
function parseReply(buf, address) {
  if (!buf || buf.length > MAX_MESSAGE) return null;
  try {
    const m = JSON.parse(buf.toString('utf8'));
    const port = Math.round(Number(m && m.port));
    if (!m || m.app !== 'flow-server' || !address || !(port > 0 && port < 65536)) return null;
    return {
      ip: String(address),
      port,
      name: String(m.name || 'Flow Server').slice(0, 60),
      id: String(m.id || ''),
      protocol: Number(m.protocol) || 0,
    };
  } catch {
    return null;
  }
}

function toInt(ip) {
  const p = String(ip).split('.').map(Number);
  return p.length === 4 && p.every((n) => n >= 0 && n <= 255) ? (((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]) : null;
}

function fromInt(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * Where to send the question: each network this machine is on has its own
 * broadcast address, and the general one (255.255.255.255) only leaves through
 * one of them. `interfaces` as os.networkInterfaces() gives them.
 */
function broadcastAddresses(interfaces) {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(interfaces || {})) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = toInt(a.address);
      const mask = toInt(a.netmask);
      // A /32 (Tailscale's, a VPN's) has no one to broadcast to.
      if (ip === null || mask === null || mask === 0xffffffff) continue;
      out.add(fromInt((ip | (~mask >>> 0)) >>> 0));
    }
  }
  return [...out];
}

/**
 * Asks the local network who is a Flow Server. Sends the question a few times
 * (a datagram can get lost) and collects the answers for `timeoutMs`.
 * Resolves the servers found, one per server id: [{ ip, port, name, id, protocol }].
 * `port` and `targets` are for the tests. Never rejects: no network, none found.
 */
function find({ port = DISCOVERY_PORT, targets = null, timeoutMs = 2500, sends = 3 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timers = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      try {
        socket.close();
      } catch {
        // Not open.
      }
      resolve([...found.values()]);
    };
    socket.on('error', finish);
    socket.on('message', (msg, from) => {
      const server = parseReply(msg, from.address);
      if (server) found.set(server.id || `${server.ip}:${server.port}`, server);
    });
    socket.bind(0, '0.0.0.0', () => {
      try {
        socket.setBroadcast(true);
      } catch {
        return finish();
      }
      const to = targets || broadcastAddresses(os.networkInterfaces());
      for (let i = 0; i < sends; i += 1) {
        timers.push(setTimeout(() => {
          for (const address of to) socket.send(REQUEST, port, address, () => {});
        }, i * 600));
      }
      timers.push(setTimeout(finish, timeoutMs));
    });
  });
}

module.exports = { DISCOVERY_PORT, REQUEST, isRequest, makeReply, parseReply, broadcastAddresses, find };
