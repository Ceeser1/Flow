'use strict';

// Where a Flow Server is: an address as typed into Settings, turned into the
// base every request starts with.

// The server's own port, and so the one an address without a port means.
const DEFAULT_PORT = 7878;

/**
 * "192.168.0.63:7878", "192.168.0.63", "flow.example.com" or a full link, as
 * "http://192.168.0.63:7878". Plain http without a port means 7878; https
 * without one means 443 (a proxy in front of the server). A path is kept,
 * for a server behind a proxy at /flow. '' for nothing; throws for nonsense.
 */
function serverBaseUrl(address) {
  let a = String(address || '').trim();
  if (!a) return '';
  if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
  const u = new URL(a);
  if (!u.hostname) throw new Error('No host');
  if (!u.port && u.protocol === 'http:') u.port = String(DEFAULT_PORT);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

function ipv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** The host of an address as typed: no port, no brackets, lower case; '' for nonsense. */
function hostOf(address) {
  try {
    let a = String(address || '').trim();
    if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
    return new URL(a).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

/** A Tailscale address: 100.64.0.0/10 or a *.ts.net name. Takes "host", "host:port" or a link. */
function isTailscaleAddress(address) {
  const host = hostOf(address);
  if (host.endsWith('.ts.net')) return true;
  const ip = ipv4(host);
  return !!ip && ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127;
}

/** A machine on the local network, the loopback or the tailnet: not the open internet. */
function isPrivateIp(ip) {
  let a = String(ip || '').trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  const v4 = ipv4(a);
  if (v4) {
    const [p, q] = v4;
    return p === 127 || p === 10 || (p === 192 && q === 168) || (p === 172 && q >= 16 && q <= 31)
      || (p === 100 && q >= 64 && q <= 127);
  }
  return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

module.exports = { DEFAULT_PORT, serverBaseUrl, isTailscaleAddress, isPrivateIp };
