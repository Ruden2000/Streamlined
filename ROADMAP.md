# Streamlined — Productization Roadmap (prototype → app stores)

## Locked decisions
- **Platforms:** iOS, Android, Windows, Mac (all four).
- **Build approach:** reuse the web core. **Capacitor** for mobile (iOS + Android), **Tauri** for
  desktop (Windows + Mac). One shared web build feeds all four.
- **Resourcing:** solo / indie, lightest viable path (managed services, no self-hosted infra).
- **Assumed product framing:** transfer between a user's **own paired devices** (AirDrop-like), not
  a stranger-to-stranger network. This assumption materially lowers the Trust-&-Safety burden — if
  it's wrong, revisit Section "Trust & Safety".

## Two upfront constraints
1. **A Mac is required for the Apple builds** (Xcode build + notarization for both the iOS App Store
   and the Mac App Store). On Windows, use **GitHub Actions macOS runners** or a cloud Mac — there
   is no Windows-only path to Apple.
2. **The Trust-&-Safety/legal track is the long pole**, not the code (see its section). Start the
   legal consult early; it gates public launch.

---

## Target architecture (lightest viable, fully E2E)

```
 Device A  ──────────── WebRTC DataChannel (AES-256-GCM, P2P) ──────────── Device B
    │                          (file bytes never touch a server)                │
    └──── signaling (SDP/ICE only) ──►  tiny WebSocket server  ◄──── signaling ──┘
                                         (Cloudflare Workers / PartyKit)
    direct fails (~15% of NATs) ─────►  managed TURN relay (encrypted bytes only)
                                         (Cloudflare / Metered free tier)
```

- **STUN:** free (e.g. Google STUN). **TURN:** managed, pay-per-GB, only when direct P2P fails.
- **Signaling server** only exchanges connection handshakes — never file content. Stateless, cheap.
- The privacy promise ("encrypted content never stored server-side") and the *minimized legal
  exposure* are the same design: your servers never see plaintext or store files.

---

## Phased plan

### Phase 0 — Restructure (foundation) ✅ DONE
Vite project with ES-module `src/` split, `public/logo.png`, production build verified.

Convert the single `index.html` into a **Vite** project so both Capacitor and Tauri can consume one
`dist/`. Split into modules: `ui/`, `crypto.ts`, `scanner.ts`, `transport.ts`, `history.ts`, `qr.ts`.
No behavior change. *Low risk, unlocks everything.*

### Phase 1 — Real cross-device transport (the critical step) ✅ DONE
WebRTC DataChannel transport (`src/transport.js`) + Node signaling server (`server/signaling.js`)
+ STUN + BroadcastChannel auto-fallback. Verified end-to-end in-browser: two peers connect through
the signaling server over real `RTCPeerConnection` DataChannels and an AES-256-GCM-encrypted
512 KB file transfers byte-perfect. (TURN + cross-device on real networks = remaining sub-steps.)

Replace the BroadcastChannel `Transport` with **WebRTC DataChannels** + a small signaling
WebSocket. The pairing QR/code carries the signaling room id. Keep the existing message protocol
(`offer`/`chunk`/`complete`) so app logic is untouched. Add STUN + managed TURN.
**Outcome: two real devices on different networks can transfer.** Without this there is no product.

### Phase 2 — Hardening
- PAKE/ECDH pairing with a short verification string (replace the low-entropy 6-char-only key).
- Forward secrecy (ephemeral session keys).
- Backpressure via DataChannel `bufferedAmount` ✅ done; resumable/retryable transfers (todo).
- Stream large files to disk (File System Access / native fs) instead of buffering in memory.

### Phase 3 — Native shells 🟡 scaffolded
Capacitor (Android project in `android/`, icons/splash generated) + Tauri (`src-tauri/`, icons +
`com.streamlined.app` identifier) are set up and the web build syncs into both (verified). Remaining:
install toolchains (Android Studio/JDK, Rust) and produce real installers — see `NATIVE.md`.
iOS/macOS added last on your Mac.

- **Capacitor** → iOS + Android. Add native **camera QR scan**, native **file picker / share
  sheet**, background transfer. (These native features also satisfy Apple Guideline 4.2 — they make
  it a real app, not a thin web wrapper.)
- **Tauri** → Windows (MSIX for the Store) + Mac (.app, sandboxed + notarized).

### Phase 4 — Store preparation
- App icons + splash from the pipe **logo**; screenshots per device class.
- **Privacy policy + Terms of Service** (required by Apple & Google).
- Apple **Privacy Nutrition Labels**, Google **Data Safety** form.
- Encryption declaration (`ITSAppUsesNonExemptEncryption`); self-classify AES (generally export-
  exempt). 
- Developer accounts; TestFlight (iOS) + internal testing (Play) + Store flighting.

### Phase 5 — Trust & Safety + legal (parallel; gates public launch)
- **Legal consult** on operating a file-transfer service with client-side scanning: what creates
  "actual knowledge" and whether/when **NCMEC reporting (18 U.S.C. §2258A)** is triggered.
- Decide the scanning posture for v1 given the personal-device framing (keep client-side scanning as
  protective; no server-side content access).
- Abuse/appeals contact + process (also helps satisfy store UGC expectations).

---

## Rough costs (solo, early volume)
| Item | Cost |
|---|---|
| Apple Developer Program | **$99 / year** (recurring, required for iOS + Mac) |
| Google Play registration | **$25** one-time |
| Microsoft Store registration | small one-time fee (**verify current**) |
| Mac for Apple builds | cloud Mac / GitHub macOS runners, or hardware |
| Domain + privacy-policy hosting | ~$12 / year |
| Signaling + TURN | **$0–20 / mo** at low volume (free tiers cover early) |
| Initial legal consult | a few hundred $ — strongly recommended |

---

## Status & immediate next step

**Done:** Phase 0 (Vite restructure) and Phase 1 (WebRTC transport + signaling + backpressure),
verified in-browser.

**Next — these are the points that need you / your environment:**
1. **Real two-device test** — run the signaling server on your LAN (or deploy the Worker), load the
   web build on your phone and PC, and confirm a real cross-network transfer. *(needs your devices)*
2. **Deploy signaling to Cloudflare** — port `server/signaling.js` to a Worker + Durable Object.
   *(needs your Cloudflare account)*
3. **Add managed TURN** — drop a provider's URL/creds into `VITE_TURN_*` so strict-NAT transfers
   work. *(needs a TURN account; free tiers exist)*
4. **Native shells (Phase 3)** — scaffold Capacitor (Android first, on your PC) and Tauri (Windows);
   iOS/Mac last on your Mac. *(installing Android SDK / Rust is a setup step we do together)*
