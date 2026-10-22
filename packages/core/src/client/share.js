'use strict';

// A Flow Server shared by QR code (4.0): flow://connect?v=1&id=...&name=...
// &home=...&remote=...&code=... The addresses are the sharer's (Home: on the
// home network, Remote: from away), code a one-time pairing code that the
// server trades for its password (apps/linux-server/src/pairing.js); no
// password, profile or PIN is ever in it.

const PREFIX = 'flow://connect';
const ADDRESS = /^[^\s/?#]+(?::\d{1,5})?(?:\/[^\s?#]*)?$|^https?:\/\/[^\s?#]+$/i;

const local = (address) => /^(localhost|127\.|\[?::1\]?)(:|$)/i.test(String(address || ''));

/** The link for a server: { id, name, home, remote, code }. */
function makeLink({ id = '', name = '', home = '', remote = '', code = '' }) {
  const q = new URLSearchParams({ v: '1' });
  if (id) q.set('id', id);
  if (name) q.set('name', name);
  // The machine the server runs on is "localhost" only to itself.
  if (home && !local(home)) q.set('home', home);
  if (remote && !local(remote)) q.set('remote', remote);
  if (code) q.set('code', code);
  return `${PREFIX}?${q}`;
}

/** { id, name, home, remote, code } of a link (spaces around it are fine), or null. */
function parseLink(text) {
  const m = /^flow:\/\/connect\/?\?(\S*)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const address = (k) => {
    const v = String(q.get(k) || '').trim();
    return v && ADDRESS.test(v) && v.length <= 200 ? v : '';
  };
  const out = {
    id: /^[0-9a-f]{16,64}$/i.test(q.get('id') || '') ? q.get('id') : '',
    name: String(q.get('name') || 'Flow Server').slice(0, 60),
    home: address('home'),
    remote: address('remote'),
    code: String(q.get('code') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32),
  };
  return out.home || out.remote ? out : null;
}

module.exports = { makeLink, parseLink, PREFIX };
