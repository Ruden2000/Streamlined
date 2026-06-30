# Background behavior, notifications & updates

This document explains how Streamlined behaves in the background and why — written
plainly so it can be quoted directly into GitHub release notes.

## Why the app runs in the background (desktop)

Streamlined transfers files **directly between your devices** (peer-to-peer, end-to-end
encrypted). For a device to be told "a file is on its way," it has to be reachable.
Rather than keep the full app (and its memory footprint) running, Streamlined uses a
**minimal background helper**:

- When you close the window to the system tray, the app's main UI (the Chromium webview)
  is **shut down completely** — it stops using webview memory.
- A tiny native process stays behind holding **one lightweight WebSocket** to the
  Streamlined signaling server. It does nothing but wait for a short "incoming file"
  message. This is the smallest footprint technically possible while still being able to
  notify you.
- When a paired device sends a file, that message arrives, the helper raises a **native
  OS notification with the filename**, and clicking it relaunches the full app focused on
  that file.

**What the helper does NOT do:** it never sees file contents (those go peer-to-peer,
encrypted), it does no scanning, and it holds no decrypted data. It is purely a doorbell.

You can quit it entirely from the tray icon → **Quit**. If you do, you won't receive
notifications while the app is closed (see "Closed-app notifications" below).

## What you see when a file is sent

Every paired device **except the sender** is notified:

1. **In-app:** a toast banner appears with the filename and the sending device's name.
2. **OS notification** (if you allowed notifications): same details, even when the window
   is minimized or in the tray.
3. **Click the notification** → the app comes to the foreground, opened to that file for
   review or action.

## Notifications across platforms

| Platform | While app is open / in tray | While app is fully closed |
|----------|-----------------------------|---------------------------|
| Windows (desktop) | ✅ native notification via tray helper | ⏳ requires the tray helper running |
| Android | ✅ local notification | ⏳ FCM push (planned) |
| iPhone / iPad (PWA) | ✅ while open | ⏳ web-push/APNs (planned) |

"Closed-app notifications" (waking an app that isn't running at all) require push
infrastructure per platform and are delivered in a later release.

## In-app updates

- Streamlined checks GitHub Releases for a newer version on launch (and on demand from
  **Settings → Updates**).
- When an update exists you'll see **Update now** — no manual redownload from GitHub.
  - **Desktop:** downloads and installs the new signed build in place, then relaunches.
  - **PWA/web:** reloads to the latest assets.
  - **Android:** fetches and installs the new signed APK.
- **Rollback:** Streamlined remembers the version you upgraded from. **Settings → Updates →
  Roll back** reinstalls that previous signed build if a release ever misbehaves.

## Implementation status

- ✅ **Phase 1 (this build):** notification protocol (sender broadcasts to all paired
  devices, filename surfaced, click focuses the app), update detection + Updates panel +
  rollback bookkeeping — all at the cross-platform web layer.
- ⏳ **Phase 2:** native desktop tray + minimal background WebSocket helper + Tauri
  in-place updater and rollback.
- ⏳ **Phase 3:** Android local notifications + foreground/update handling.
- ⏳ **Phase 4:** closed-app push (FCM / web-push+VAPID / APNs) via the signaling Worker.
