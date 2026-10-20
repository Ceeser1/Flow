# Flow Server for Windows

The Flow Server's installer for Windows: `Flow Server Setup <version>.exe`
puts the server (the one in `apps/linux-server`), the Node.js it runs on and
ffmpeg into `Program Files\Flow Server`, asks how it should be set up, and
starts it with Windows. Nothing else needs to be installed first.

## Installing

Run `Flow Server Setup <version>.exe` from the Windows account the server
should run as (Windows asks for an administrator once). After copying the
files, a window asks what `install.sh` asks on Linux:

1. **How far it can be reached:** 1 the home network only, 2 also through
   Tailscale (install Tailscale for Windows and sign in; the window waits),
   or 4 the internet through a web server or tunnel of your own (nginx,
   Caddy, Cloudflare Tunnel...). The window shows what to add to it and then
   checks it with `flow-server doctor`. Level 3 (Caddy set up by the
   installer) is Linux only; with a Caddy of your own, that is level 4.
2. **The music folder** (default `~\flow-music`).
3. **Downloads by the server:** yes needs yt-dlp. Download `yt-dlp.exe`
   yourself from yt-dlp's latest release at GitHub and put it into the folder
   the window opens (`%LOCALAPPDATA%\Flow\server\tools`). There it updates
   itself once a day, and YouTube's JavaScript is solved with the server's
   own Node.js. ffmpeg comes with the server.
4. **Where new songs go:** separate Uploads and Downloads folders, and
   whether uploads keep their folders.
5. **Finding the server on the network**, the **password** (required at
   level 4) and the **master admin**.

Then it registers the **Flow Server** task and opens Windows Firewall for it:

- The task starts the server with Windows, before anyone signs in, as your
  account but without your password stored and without a window ("Run
  whether user is logged on or not", "Do not store password"). The server
  therefore reaches local disks but no network drives that need a sign-in.
  A server that fails is started again after 5 seconds.
- The firewall rule lets in the server's port, for the server's `node.exe`
  only: from the home network, plus Tailscale's addresses at level 2 and a
  proxy on the internet at level 4. UDP 7878 is let in from the home network
  when the apps may find the server.

At the end the window shows the addresses to enter in Flow (Settings,
Streaming, Download and Synchronization).

Run over an installed server, the installer first offers three choices:
**Only update** (everything stays as it is set up; the server is updated and
restarted), **Reinstall (change config)** (the questions again; Enter keeps
each answer as it is) and **Uninstall**. `/S` only updates. The library (`%LOCALAPPDATA%\Flow\server`) and the
music are never touched by the installer, and stay when it is uninstalled.

## The Start menu

| | |
|---|---|
| Flow Server Settings | the questions again; what was chosen before is the default |
| Start, Stop, Restart Flow Server | the task (Stop: until Start, or the next start of Windows) |
| Flow Server Log | `flow-server.log` in the library folder, in Notepad |
| Flow Server Command Line | a window where `flow-server` works: `set-password`, `profiles`, `admin master <name>`, `doctor <address>`, `--help` |
| Uninstall Flow Server | removes the task, the firewall rules and the program |

The settings can also be given on the command line, as `install.sh` takes
them (`--level`, `--music`, `--port`, `--url`, `--proxy`, `--proxy-at`,
`--yes`, `--downloads`, `--no-discovery`...):

```bat
"C:\Program Files\Flow Server\node.exe" "C:\Program Files\Flow Server\app\windows\setup.js" --help
```

`Flow Server Setup <version>.exe /S` installs without questions: what was set
up before, else level 1 (2 when Tailscale is up on the PC) with the defaults.

## Files

| | |
|---|---|
| `src/setup.js` | the questions, the task, the firewall; start, stop, restart, log, uninstall |
| `src/run.js` | what the task runs: the server in a child process, its output in the log, restarted when it fails; stops it as on Ctrl+C when setup.js asks (`flow-server.stop`); updates a yt-dlp in the tools folder daily |
| `src/windows.js` | shared and testable: where things are, the task's XML, the firewall's rules, the options |
| `installer.nsi` | the NSIS installer |
| `build.js` | stages the files in `dist\stage` and runs makensis |

## Building

```sh
npm run dist -w apps/windows-server
```

Builds `dist\Flow Server Setup <version>.exe` (about 75 MB) on Windows. It
carries the Node.js the build runs on (`FLOW_NODE_EXE` picks another
`node.exe`), `apps/linux-server`'s and `packages/core`'s `src`, and
`ffmpeg.exe` and `ffprobe.exe` from `apps/desktop/tools` (not in the repo; see
the main README). makensis is electron-builder's NSIS, fetched once by
`app-builder-lib` (`MAKENSIS` points at another).

`npm test -w apps/windows-server` runs setup.js from start to end on a free
port with Windows' own commands stood in for (`FLOW_SERVER_SETUP_FAKE`), so
it needs no administrator and leaves no task or firewall rule behind.
