# Flow for Android

Capacitor app showing the desktop renderer (`apps/desktop/renderer`). With
Flow Server it stays a thin player that streams from the server instead of
downloading on the phone.

Work in progress: the shell builds, nothing Android-specific runs yet.

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
