'use strict';

// Whether the connection costs by the megabyte: a phone's hotspot, a mobile
// data stick, or a network the user marked as metered in Windows' settings.
// Asked of Windows itself (NetworkInformation, through PowerShell), at most
// once a minute.

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

function ask() {
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

module.exports = { isMetered, parseCost };
