# Flow for iPhone

Flow on the iPhone, the Android app's twin: it plays the songs of your Flow
Server (the one on your computer or your Raspberry Pi) and songs kept on the
phone, with Flow's look and phone layout. Work in progress: built and tried out
in the iOS Simulator on GitHub's Macs; not yet tried on a real iPhone.

- **Flow Server:** found on the home network at the first start, or its
  address typed in; profiles, playlists, favourites and listening stats are the
  server's.
- **Playing with the screen locked:** the music goes on in the background, with
  the lock screen's and Control Center's controls, headphones and the car.
  The sleep timer works there too.
- **Downloads** and **songs of the phone's own** (Add Songs > Open local
  File(s) / Folder, from the Files app).
- **Song Transition** (the end of a song and the start of the next one
  overlap) and **Equalize volume** both ways, also with the screen locked.
- **The home screen widget** (small and medium): the song playing with
  Play/Pause and Next (the medium one: Previous and the timeline too). Its
  Play also works when Flow is not running: Flow starts in the background
  and plays the song it was on.

Not on the iPhone: the share target (each extension of an app costs a free
Apple ID one of its 10 App IDs a week; Flow and its widget take two).

Needs iOS 18.4 or later (iPhone XS / XR and newer): from 18.4 iOS plays Ogg
Opus itself, the format most of Flow's songs from YouTube are in. Ogg Vorbis
(.ogg) iOS does not play (neither 18 nor 26): a Flow Server with ffmpeg sends
such a song as Opus (converted once and kept), streamed or downloaded; a
Vorbis file of the phone's own is not imported, and says why.

## Installing

Flow is not in the App Store. An iPhone runs it when it is signed with the
owner's own Apple ID, which a sideloading app does: **SideStore** (free). Each
person installs SideStore once (with a computer, for the setup), opens
`Flow.ipa` in it and signs it with their Apple ID; a free Apple ID's signature
lasts 7 days, and SideStore renews it on the phone. Flow's songs and settings
stay through renewals and updates.

`Flow.ipa` comes from the iOS workflow's runs on GitHub (the artifact
`Flow-ipa-<run>`, kept 30 days), sealed with the owner's key, as the
repository is public. Opened with the key:

```
node apps/ios/scripts/sealed.js open Flow-3.2.0.ipa.sealed Flow.ipa --key-file <the key's file>
```

## Building

There is no Mac here: GitHub's Macs build it (`.github/workflows/ios.yml`), on
every push to the `ios` branch. The Xcode project is made by
[XcodeGen](https://github.com/yonaskolb/XcodeGen) from `project.yml` and is not
kept in the repository. On a Mac with Xcode:

```
npm ci                                  # in the repository's root
node apps/ios/scripts/build-web.js      # public/ (the page) and Version.xcconfig
cd apps/ios && xcodegen generate        # Flow.xcodeproj
open Flow.xcodeproj
```

The version is the one in `apps/ios/package.json` (the same for every Flow
package; build number as Android's versionCode, 3.0.0 -> 30000).

### Trying it out in the Simulator

`testing/run.js` starts a Flow Server with a test song of each kind
(ffmpeg, oggenc), installs the Debug build on a Simulator, runs a steps file
against the page (`testing/steps/`) and saves screenshots, a video and the
logs. The CI runs, on iOS 26 (iPhone 17) and iOS 18 (iPhone SE):

- `steps/smoke.js`: the server found, every kind of song, playing on in the
  background, the main screens;
- `steps/offline.js`: songs downloaded and played with the server gone,
  files imported (names, pictures, waveforms);
- `steps/effects.js`: Song Transition and Equalize volume, measured;
- `steps/widget.js`: what the widget shows, its buttons, and its Play
  starting Flow when it is not running;
- `steps/sessions.js`: a second device (the test script) joins the iPhone's
  Active Session, pauses and plays it, and it stays while Flow is out of
  sight; then the iPhone joins another device's session, plays along in step
  with it (Play here), follows its Pause and Play, and its own buttons go to
  the host.

Others are chosen when the workflow is started by hand.

```
node apps/ios/testing/run.js --app apps/ios/build/Build/Products/Debug-iphonesimulator/Flow.app \
  --steps apps/ios/testing/steps/smoke.js --out out --video
```

Only Debug builds answer the test runner (`App/Harness.swift`). What installs
on an iPhone (a Release build) the workflow uploads only sealed, and nothing
without the repository's secret `FLOW_IPA_KEY`.

## How it fits together

Capacitor app showing the desktop renderer (`apps/desktop/renderer`) in its
phone layout, with the Android app's `window.flow` (`apps/android/src`,
bundled as `public/flow-ios.js` by `scripts/build-web.js`). Its native side is
Swift in `App/`, with the plugins and calls of the Android app's Java:

- `FlowSync.swift`: `window.FlowSync`, what the page needs answered at once
  (files, secrets, the phone's name), through `prompt()`, the one
  synchronous way out of a WKWebView. Secrets are encrypted with a key in the
  Keychain.
- `FlowPaths.swift`: an iPhone app's folders move with every update, so the
  page keeps Flow's paths as `/Flow/files` and `/Flow/cache`
  (`Library/Flow`, `Library/Caches/Flow`).
- `FlowNative.swift`: downloads and uploads (`Transfers.swift`), finding a
  Flow Server (`Discovery.swift`: iOS allows no broadcast, so every address of
  the home network is asked directly; the first search waits for the answer
  to iOS's "find devices on your local network" question and asks again once
  it is allowed), iOS's file picker and the songs' names,
  covers and waveforms (`AudioFiles.swift`), where the sound comes out.
- `FlowPlayer.swift` / `FlowAudio.swift`: the player (an AVQueuePlayer)
  with the operations, states and events of the Android player, so the page's
  audio engine (`apps/android/src/engine.js`) is the same; the lock screen and
  Control Center.
- `StreamLoader.swift`: the songs from a Flow Server, fetched for the player
  by Flow itself (as Android's `Streams.java`): with the newest token, signed
  in again when the server ended this app's session (`ServerSignIn.swift`),
  and tried again for a while when the network drops.
- `SessionKeeper.swift`: keeps this phone's Active Session on the server
  while Flow is out of sight.
- `WidgetFeed.swift`: the widget's song, written into the App Group shared
  with the widget (`Widget/FlowWidget.swift`, WidgetKit); its buttons are
  App Intents (`Shared/WidgetShared.swift`) that run in Flow's process.
- `FlowLog.swift`: `Library/Flow/logs/flow.log`.
