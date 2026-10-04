# Flow for Android

Capacitor app showing the desktop renderer (`apps/desktop/renderer`). With
Flow Server it stays a thin player that streams from the server instead of
downloading on the phone.

Work in progress (v3.0). It connects to a Flow Server (found on the network,
or its address typed in at the first start), streams its songs, and changes
playlists, favourites and profiles there. Not yet: playing on with the screen
off, songs kept on the phone, adding songs from the share menu.

How it fits together: `scripts/build-web.js` copies the renderer into `www/`
and bundles `src/main.js` as `www/flow-android.js`, which the page loads before
its own scripts. That is the phone's `window.flow`: the same calls as the
desktop's preload, answered in the page by the shared client
(`@flow/core/client`) instead of in Electron's main process. What the client
needs from the phone comes from two native pieces in
`android/app/src/main/java/io/github/ceeser1/flow/`:

- `FlowSync` (`window.FlowSync`): what must answer at once, as Node does on the
  desktop: the app's files (settings, the library, covers), secrets (Android
  Keystore), the phone's name.
- `FlowNative` (a Capacitor plugin): what takes a while: a file downloaded
  straight to storage, Flow Servers looked for on the network (UDP), links
  opened, and the Back button handed to the page.

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

`testing/harness.js` installs the debug APK on the emulator, starts Flow and
runs a steps file against its WebView over the DevTools protocol (debug
builds allow that), saving screenshots:

```
emulator -avd <name> -no-window -no-snapshot-save -no-boot-anim -no-audio
node apps/android/testing/harness.js [--build] [--no-install] steps.js out/
```

A steps file exports `[{ name, key, js, wait, shot, screen }]`; see the top of the
harness. It drives `emulator-5554` (or `FLOW_ADB_SERIAL`, which must be an
emulator) and refuses a phone.

The emulator reaches the PC as `10.0.2.2`: a Flow Server running on the PC (or
in WSL) is at `10.0.2.2:7878`. Discovery does not get through the emulator's
network; type the address in.
