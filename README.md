# Flow

A music player for your own music library, on Windows, Linux, Android,
iPhone and in the browser. Keep your songs on your PC, or put them on your own
Flow Server at home and listen everywhere.

Flow is made for private use.

## Features at a glance

### Your library
- **Add Songs** from a link or a whole playlist, or import the music files
  you already have
- **Trim** every song on its waveform: cut off intros, outros and silence
- **Artist, Title and Mix** filled in for you, and easy to correct
- **Album covers** found automatically and written into the files
- **Lyrics**, synced to the music when available, with a lyrics editor on the PC
- **Search** across playlists, songs and artists (Ctrl+F)

### Playlists
- Playlists, **Favourites** and **All Songs**, every column sortable
- **Smart playlists** that fill themselves by your rules (artist, genre, most
  played, not heard in a while, …)
- **Update from source**: a playlist imported from a link picks up its new songs
- **Your listening trend**: most listened, least skipped, long time no see, …
- **Continue with similar songs** when a playlist ends

### Playback
- **Song transitions** (crossfade) and **Equalize volume**, so every song plays
  equally loud
- **Sound equalizer** with presets
- Choose the **output device** (speakers, headphones, Bluetooth)
- **Sleep timer**, media keys, and Flow remembers where you stopped

### Looks
- A live **equalizer** and softly glowing **background clouds** that react to
  the bass
- Dozens of full-screen **visualizers**, with your own picture or video as the
  background
- **English and German**

### Flow Server (optional)
- Your library lives on a **Raspberry Pi, a Linux machine or a Windows PC**;
  every app that connects can play from it
- **Profiles** with their own playlists, favourites and stats, protected by a PIN
  if you like
- **Download** playlists to a device to listen offline
- Reach it **at home, through Tailscale, or over the internet** (with a password)
- **Share** a server with a QR code
- **Shared playlists** to follow other profiles' playlists
- **Administration** for admins: profiles, every playlist and who owns it, rules, recent uploads, trash
- **Weekly backups**

### Jam sessions
- Listen **together** with other devices on the same server
- Join a session and control the music, or **play along in sync** on your own
  speakers
- Delay your speakers by ear so Bluetooth speakers play in time
- Guests from other servers in the same home network can join too

### Statistics
- Songs added, time listened, listening streaks, longest session
- Monthly and daily activity graphs, per profile

## The apps

| App | What it is |
|---|---|
| **Windows** | The full app, with or without a Flow Server |
| **Linux** | The same app as a `.deb` or `.AppImage` |
| **Android** | Plays from a Flow Server and from the phone's own songs, also in the background |
| **iPhone** | Plays from a Flow Server |
| **Web player** | Flow in the browser, connected to a Flow Server |
| **Flow Server** | For Linux (Raspberry Pi included) and Windows |

## Getting started

1. Download the installer for your system from
   [Releases](https://github.com/Ceeser1/Flow/releases).
2. Install and start Flow. Your songs go into `Music\FlowPlayer`.
3. Optional: set up a Flow Server (see
   [apps/linux-server](apps/linux-server/README.md) or
   [apps/windows-server](apps/windows-server/README.md)) and turn on
   **Use a Flow Server** in Settings.

Flow plays your own files right away. Adding songs from links needs an extra
tool that is not included; the **Downloads?** button in Add Songs explains it.

### Linux

- **deb** (Debian, Ubuntu, Mint, …): `sudo apt install ./flow_<version>_amd64.deb`
- **AppImage** (any 64-bit Linux): `chmod +x Flow-<version>.AppImage`, then
  start it. Needs `libfuse2`. On Ubuntu 24.04 and newer use the deb.

## For developers

```
npm install     # once: every app and package
npm start       # run the desktop app
npm test        # all tests
npm run dist    # build the Windows installer
```

`ffmpeg.exe` and `ffprobe.exe` are not in the repository: put them into
`apps/desktop/tools/`. Each app has its own README with details.

```
packages/core/        shared code of every Flow app
apps/desktop/         the desktop app (Windows and Linux)
apps/linux-server/    Flow Server and its Linux installer
apps/windows-server/  Flow Server installer for Windows
apps/android/         the Android app
apps/ios/             the iPhone app
apps/web/             the web player
```
