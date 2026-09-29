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

module.exports = { DEFAULT_PORT, serverBaseUrl };
