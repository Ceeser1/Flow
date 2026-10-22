'use strict';

// Whether the connection costs by the megabyte: a phone's hotspot, a mobile
// data stick, or a network the user marked as metered in Windows' settings.
// Asked of Windows itself (NetworkInformation, through PowerShell), at most
// once a minute. On Linux NetworkManager is asked (its Metered property, for
// the connection in use: set by hand, or guessed from a phone's hotspot);
// without NetworkManager nothing counts as metered.

const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = [
  '[void][Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]',
  '$p = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()',
  'if ($p) { $c = $p.GetConnectionCost(); "$($c.NetworkCostType)|$($c.Roaming)|$($c.OverDataLimit)" } else { "none" }',
].join('; ');

const CACHE_MS = 60 * 1000;
let cached = null; // { at, metered }

/** From the script's answer: "Unrestricted|False|False", "Fixed|...", "none". */
function parseCost(text) {
  const [type, roaming, over] = String(text || '').trim().split('|');
  if (!type || type === 'none') return false;
  return type === 'Fixed' || type === 'Variable' || roaming === 'True' || over === 'True';
}

/** From busctl's answer for NetworkManager's Metered: "u 1" (yes) or "u 3" (guessed yes) is metered. */
function parseNmMetered(text) {
  const m = /^u\s+(\d+)/.exec(String(text || '').trim());
  return !!m && (m[1] === '1' || m[1] === '3');
}

function askNetworkManager() {
  const args = ['--system', 'get-property', 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
    'org.freedesktop.NetworkManager', 'Metered'];
  return new Promise((resolve) => {
    execFile('busctl', args, { timeout: 15000 }, (err, stdout) => resolve(err ? false : parseNmMetered(stdout)));
  });
}

function ask() {
  if (process.platform === 'linux') return askNetworkManager();
  if (process.platform !== 'win32') return Promise.resolve(false);
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, timeout: 15000 },
      (err, stdout) => resolve(err ? false : parseCost(stdout)));
  });
}

/** Resolves true on a metered connection. Unknown counts as not metered. */
async function isMetered() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.metered;
  const metered = await ask();
  cached = { at: Date.now(), metered };
  return metered;
}

module.exports = { isMetered, parseCost, parseNmMetered };
