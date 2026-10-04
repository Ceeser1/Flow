# Flow for Android

Flow on the phone (from version 3.0). It plays the songs of your Flow Server
(the one on your computer or your Raspberry Pi) and songs kept on the phone
itself, with Flow's look: the menu as a drawer, the player at the bottom,
Now Playing, the Queue, Settings.

- **Flow Server:** found on the home network at the first start, or its
  address typed in; profiles, playlists, favourites and listening stats are the
  server's, as on the desktop.
- **Playing with the screen off:** the music goes on in the background, with
  its notification, the lock screen's controls, headphone buttons and two home
  screen widgets. Song Transition, Equalize volume and the sleep timer work
  there too.
- **Downloads:** a playlist's Download keeps its songs on the phone, to play
  without the server.
- **Add Songs:** share a link to Flow (Share > Flow, from YouTube or a
  browser) and the server downloads it; trim and name it on the phone (it
  turns sideways there). Songs already on the phone come in through Open local
  File(s) / Folder.
- **Active Sessions:** join another device's session and control it, or play
  its music on the phone too, in step; or host one, while Flow is open.
- **Updates:** Flow looks for a newer version on GitHub when it starts, and
  Settings > App > Check for Updates looks any time.

Not on the phone: downloading with yt-dlp on the phone itself (the server
does that), the visualizers, the clouds and the equalizer, the screen flash.

## Installing

Flow is not in the Play Store: its APK is installed by hand ("sideloaded").

1. Download `Flow-<version>.apk` from the newest release on GitHub
   (Ceeser1/Flow, Releases), on the phone.
2. Open it. Android asks once whether your browser (or Files app) may install
   unknown apps: allow it, go back, and tap Install.
3. Open Flow. It looks for your Flow Server; if it is not found, type in the
   address the server shows when it starts (for example `192.168.0.20:7878`).

Later versions install over it: Flow says when there is one ("Newer version
X available, update?"), downloads it and opens Android's installer. The first
time, Android asks whether Flow may install apps: switch that on for Flow and
come back; the update goes on by itself. Songs, downloads and settings stay.

Flow needs Android 8 or later and an up-to-date **Android System WebView**
(version 108 or later; phones with the Play Store keep it up to date). With an
older one Flow says so and links to it in the Play Store.

### Playing with the screen off

Android may stop apps in the background to save battery, some phones (Samsung
among them) more readily than others. The first time music plays, Flow shows
how Android treats it and offers **Allow background use** (Android asks: allow
it). On a Samsung phone also check Settings > Battery > Background usage
limits: Flow must not be in Sleeping apps or Deep sleeping apps. Settings >
App > Playing with the screen off shows this again.

## Releases

A release APK is signed with Flow's key. The key never goes into this
repository: it lives in `C:/Users/Ceeser/FlowSigning` (`flow-release.jks` and
`keystore.properties`), or wherever the environment variable `FLOW_SIGNING`
names its `keystore.properties`. Every release must be signed with this same
key, or phones cannot update Flow; keep a copy of that folder somewhere safe.

```
npm run release -w apps/android      # dist/Flow-<version>.apk, signed
```

The version is the one in `apps/android/package.json` (3.0.0 -> versionCode
30000), the same for every Flow package. On GitHub, a release whose tag is the
version (`v3.0.1`) with the APK attached is what Flow's update check finds
(once the repository is public; until then GitHub answers "not found" and
Flow finds nothing).

## How it fits together

Capacitor app showing the desktop renderer (`apps/desktop/renderer`) in its
phone layout. `scripts/build-web.js` copies the renderer into `www/` and
bundles `src/main.js` as `www/flow-android.js`, which the page loads before
its own scripts (after `web/webview-check.js`, which stops a WebView too old
for Flow). That is the phone's `window.flow`: the same calls as the desktop's
preload, answered in the page by the shared client (`@flow/core/client`)
instead of in Electron's main process. What the client needs from the phone
comes from native pieces in `android/app/src/main/java/io/github/ceeser1/flow/`:

- `FlowSync` (`window.FlowSync`): what must answer at once, as Node does on the
  desktop: the app's files (settings, the library, covers), secrets (Android
  Keystore), the phone's name.
- `FlowNative` (a Capacitor plugin): what takes a while: files downloaded and
  uploaded, Flow Servers looked for on the network (UDP), local files picked
  and read, waveforms, links shared to Flow, the output, orientation, updates,
  battery settings, the Back button.
- `FlowPlayer`, `PlaybackService`, `FlowAudio`: the native player (Media3
  ExoPlayer) that plays on in the background, holds the songs coming next and
  moves on by itself; `src/engine.js` is the page's side of it.
- `FlowWidget`, `FlowWidgetTall`: the home screen widgets.

## Building

Needs Android Studio (its SDK and bundled Java).

```
npm run sync -w apps/android     # copies the renderer into www/ and into the Android project
npm run open -w apps/android     # opens apps/android/android in Android Studio
```

Or from a terminal, with `JAVA_HOME` set to Android Studio's `jbr` folder and
`ANDROID_HOME` to the SDK:

```
cd apps/android/android
gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
```

The Gradle wrapper is on 9.1 rather than Capacitor's 8.14: Android Studio
2026.2 ships Java 25, which Gradle 8.14 cannot run on.

Keystores (`*.jks`, `*.keystore`) are ignored by git and must stay out of the
repo.

## Testing on the emulator

`npm test -w apps/android` runs the unit tests (the engine, local files,
shares, updates, the bundle).

`testing/harness.js` installs the debug APK on the emulator, starts Flow and
runs a steps file against its WebView over the DevTools protocol (debug
builds allow that), saving screenshots:

```
emulator -avd <name> -no-window -no-snapshot-save -no-boot-anim -no-audio
node apps/android/testing/harness.js [--build] [--no-install] [--keep] steps.js out/
```

A steps file exports `[{ name, key, tap, shell, run, js, wait, shot, screen }]`;
see the top of the harness. It drives `emulator-5554` (or `FLOW_ADB_SERIAL`,
which must be an emulator) and refuses a phone.

The emulator reaches the PC as `10.0.2.2`: a Flow Server running on the PC (or
in WSL) is at `10.0.2.2:7878`. Discovery does not get through the emulator's
network; type the address in. The emulator's audio clock moves in steps of
about a tenth of a second, so how closely Play here keeps in step is for a
real phone to show.
