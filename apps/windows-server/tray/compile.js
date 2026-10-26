'use strict';

// Compiles tray.cs into "Flow Server Tray.exe" with the C# compiler that comes
// with Windows (.NET Framework 4's csc.exe, C# 5), so building it needs nothing
// installed. build.js uses it; on its own:
//
//   node tray/compile.js <out.exe> [icon.ico]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SOURCE = path.join(__dirname, 'tray.cs');
const { version } = require('../package.json');

function csc() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const exe = ['Framework64', 'Framework'].map((d) => path.join(root, 'Microsoft.NET', d, 'v4.0.30319', 'csc.exe')).find((f) => fs.existsSync(f));
  if (!exe) throw new Error('The C# compiler of .NET Framework 4 (csc.exe) was not found; it comes with Windows 10 and 11.');
  return exe;
}

/** Builds the exe at `out` (with `icon` as its own icon); throws with the compiler's output when it fails. */
function compile(out, icon) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ['/nologo', '/target:winexe', '/optimize+', `/out:${out}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll'];
  if (icon) args.push(`/win32icon:${icon}`);
  // Its name and version, as Task Manager and the file's Properties show them.
  const about = path.join(path.dirname(out), `flow-server-tray-${process.pid}.cs`);
  fs.writeFileSync(about, [
    'using System.Reflection;',
    '[assembly: AssemblyTitle("Flow Server")]',
    '[assembly: AssemblyProduct("Flow Server")]',
    '[assembly: AssemblyCompany("Ceeser")]',
    '[assembly: AssemblyCopyright("MIT License")]',
    `[assembly: AssemblyVersion("${version}.0")]`,
    `[assembly: AssemblyFileVersion("${version}.0")]`,
    '',
  ].join('\r\n'));
  try {
    const r = spawnSync(csc(), [...args, SOURCE, about], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`The tray icon did not compile:\n${`${r.stdout || ''}${r.stderr || ''}`.trim()}`);
  } finally {
    fs.rmSync(about, { force: true });
  }
  return out;
}

module.exports = { compile, SOURCE };

if (require.main === module) {
  try {
    console.log(`Built ${compile(path.resolve(process.argv[2] || 'Flow Server Tray.exe'), process.argv[3] && path.resolve(process.argv[3]))}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
