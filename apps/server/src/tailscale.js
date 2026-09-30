'use strict';

// The server's Tailscale address, when the machine is on a tailnet. The apps
// use it as their Remote address (away from home the same server is reached
// through Tailscale, no port opened on the router). Nothing here is needed to
// run: without Tailscale the server just says so.
//
// FLOW_SERVER_TAILSCALE=<ip> stands in for a real Tailscale (the tests, and
// trying the apps without one).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { isTailscaleAddress } = require('@flow/core/address');
const { onPath } = require('./tools');

function cli() {
  const found = onPath('tailscale');
  if (found) return found;
  if (process.platform === 'win32') {
    const candidate = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** { ip, dns } from `tailscale status --json`, or null unless it is up. */
function fromStatus(status) {
  if (!status || status.BackendState !== 'Running' || !status.Self) return null;
  const ip = (status.Self.TailscaleIPs || []).find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a) && isTailscaleAddress(a));
  if (!ip) return null;
  return { ip, dns: String(status.Self.DNSName || '').replace(/\.$/, '') };
}

/** Without the CLI: an address of ours in Tailscale's range, if the interface is up. */
function fromInterfaces(interfaces) {
  for (const list of Object.values(interfaces)) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && isTailscaleAddress(a.address)) return { ip: a.address, dns: '' };
    }
  }
  return null;
}

/** Resolves { ip, dns }, or null when this machine is not on a tailnet. */
function detect() {
  const fake = process.env.FLOW_SERVER_TAILSCALE;
  if (fake) return Promise.resolve(isTailscaleAddress(fake) ? { ip: fake, dns: '' } : null);
  const exe = cli();
  if (!exe) return Promise.resolve(fromInterfaces(os.networkInterfaces()));
  return new Promise((resolve) => {
    execFile(exe, ['status', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // tailscale exits non-zero while stopped or logged out, but still prints JSON.
      try {
        resolve(fromStatus(JSON.parse(stdout)));
      } catch {
        resolve(err ? null : fromInterfaces(os.networkInterfaces()));
      }
    });
  });
}

module.exports = { detect, fromStatus, fromInterfaces };
