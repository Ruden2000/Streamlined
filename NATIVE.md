# Building the native apps

One web build (Vite `dist/`) is wrapped in two shells:

- **Capacitor** → iOS + Android (mobile) — project in `android/` (and `ios/`, added on your Mac)
- **Tauri** → Windows + macOS (desktop) — project in `src-tauri/`

> ⚠️ **Production/native builds must set `VITE_SIGNALING_URL`** (your deployed Cloudflare Worker),
> e.g. `VITE_SIGNALING_URL=wss://streamlined-signaling.<you>.workers.dev`. Inside a packaged app the
> page origin is `localhost`, so without this the app would look for a signaling server on the device
> itself and fail. The localhost default is for desktop browser dev only.

## Android (Capacitor) — on your PC
**Prereqs:** [Android Studio](https://developer.android.com/studio) (bundles the Android SDK + platform tools) + **JDK 17**.

```bash
npm run android          # build web → sync → open Android Studio
# in Android Studio: ▶ Run to a device/emulator
# Play Store release: Build ▸ Generate Signed Bundle/APK ▸ Android App Bundle (.aab)
```
CLI alternative: `cd android && ./gradlew assembleDebug`

## Windows (Tauri) — on your PC
**Prereqs:** [Rust](https://rustup.rs) (rustup), **Microsoft C++ Build Tools**, WebView2 (preinstalled on Win 11).

```bash
npm run tauri:dev        # hot-reload desktop dev
npm run tauri:build      # → src-tauri/target/release/bundle (.msi / .exe)
```
For the **Microsoft Store**, package as **MSIX** (Tauri bundle target / Store submission path).

## iOS + macOS — on your Mac (do last)
```bash
# iOS (Capacitor)
npm i @capacitor/ios && npx cap add ios && npx cap sync ios && npx cap open ios   # Xcode
# macOS desktop (Tauri)
npm run tauri:build      # → .app / .dmg; notarize for distribution
```

## Bundle identifiers
- Capacitor `appId`: `com.streamlined.app` — `capacitor.config.json`
- Tauri `identifier`: `com.streamlined.app` — `src-tauri/tauri.conf.json`

Change both to a **reverse-domain you control** before submitting to any store.

## Notes
- WebRTC runs in the system WebView (Android) / WebView2 (Windows) / WKWebView (Apple) — already works.
- Native niceties to add later via Capacitor plugins: camera **QR scan**, native **share sheet /
  file picker**, **background transfer**. These also help satisfy Apple's "minimum functionality" rule.
- The web bits (`dist/`), `android/app/build/`, and `src-tauri/target/` are build outputs — see `.gitignore`.
