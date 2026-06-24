# Streamlined

Fast, private, end-to-end-encrypted file transfer — no account required. Link up to **6 devices**
with a pairing code or QR, then send any file type between them. Files travel **peer-to-peer over
encrypted WebRTC**; no server ever sees their contents.

This repo is moving from prototype → multi-platform app (iOS / Android / Windows / Mac via
Capacitor + Tauri). See [`ROADMAP.md`](ROADMAP.md) for the plan and [`RECOMMENDATIONS.md`](RECOMMENDATIONS.md)
for the backlog.

---

## Project layout

```
Streamlined/
├─ index.html              # markup; links CSS + loads the ES-module entry
├─ package.json            # Vite (build) + ws (dev signaling) + scripts
├─ vite.config.js          # base:"./" so the build loads inside native shells
├─ public/
│  └─ logo.png             # copied verbatim to the web root by Vite
├─ server/
│  └─ signaling.js         # dev WebSocket signaling server (relays SDP/ICE only)
└─ src/
   ├─ main.js              # entry
   ├─ app.js               # networking glue, transfer, history, rendering, UI
   ├─ transport.js         # WebRTC DataChannel transport (+ BroadcastChannel fallback)
   ├─ config.js            # signaling URL + ICE (STUN/TURN) config
   ├─ crypto.js            # AES-256-GCM via Web Crypto
   ├─ scanner.js           # client-side, pre-encryption content scanning
   ├─ qr.js                # QR generator (no third-party calls)
   ├─ state.js             # shared state + constants
   ├─ util.js              # DOM / format / base64 helpers
   └─ styles.css
```

---

## Run it

```bash
npm install

# 1) start the signaling server (relays connection handshakes only)
npm run signal            # ws://localhost:8787

# 2a) dev with hot reload …
npm run dev               # http://localhost:5173

# 2b) … or build the production bundle and serve it
npm run build             # -> dist/
npx serve dist -l 8090
```

Open the app over `http://localhost` (Web Crypto + WebSockets need a secure origin; `file://`
shows a warning and degrades).

### Try a transfer

- **Two tabs on this machine:** open the app in two tabs, create a code in one, enter it in the
  other. They connect through the local signaling server over **real WebRTC DataChannels** and you
  can transfer files between them. (If the signaling server isn't running, the app automatically
  falls back to BroadcastChannel, which still links same-browser tabs.)
- **Two real devices (phone + PC):** point both at a signaling server they can both reach — your
  machine's LAN IP for local testing, or the deployed Cloudflare Worker for production — and host
  the web build somewhere both can load. This is the next milestone (see ROADMAP).

### Try the safety layer

Name a test file e.g. `trafficking-notes.txt`, or put the word `csam` inside a `.txt`, and try to
send it. It's **blocked before encryption**, the sending device is **quarantined** across the
network, and an entry appears under **Security**. (Harmless category-name triggers — see below.)

---

## What's real vs. in progress

| Capability | Status |
|---|---|
| **AES-256-GCM** encryption (per-chunk, fresh IV) via Web Crypto | ✅ real |
| **Pairing-code → shared key** (PBKDF2); code never transmitted | ✅ real (hardening in Phase 2) |
| **Cross-device transport** — WebRTC DataChannels, P2P, server sees only SDP/ICE | ✅ real (verified: encrypted 512 KB transfer, byte-perfect) |
| **Signaling server** (dev: Node `ws`) | ✅ real (Cloudflare Worker for prod = next) |
| **Backpressure** (DataChannel `bufferedAmount`) | ✅ real |
| **Content scanning** — client-side, on plaintext, before encryption | ✅ real (mechanism) |
| STUN | ✅ configured (free) · **TURN** = config slot, add a managed provider |
| **CSAM hash matching** | ⚠️ stub — integrate PhotoDNA/Thorn/Cloudflare (legal authorization required) |
| **"IP ban" on detection** | ⚠️ network-wide device quarantine (advisory); server-side enforcement = prod |
| **Incident reporting** | ⚠️ local log only; mandated NCMEC reporting needs a legal entity + counsel |
| **History** stored locally, **encrypted at rest** | ✅ real |
| **QR pairing** (scannable, generated locally) | ✅ real |

### The E2E ⇄ scanning tension (unchanged, important)

End-to-end encryption and server-side content scanning are mutually exclusive — if a server can read
content to scan it, it isn't E2E. Streamlined scans **client-side, on plaintext, before
encryption**, so only ciphertext ever leaves the device. This is the same approach (and the same
trade-off) as Apple's 2021 client-side-scanning proposal: it raises the bar but is bypassable by a
modified client, and carries civil-liberties considerations. Treat it as a conscious product +
legal decision (see ROADMAP Phase 5).

### About the demo blocklist

`Scanner.blocklist` holds only **category labels** (`csam`, `trafficking`, …) as illustrative,
non-exploitable triggers so the mechanism is testable. It is **not** a real detection list — those
come from vetted authorities (NCMEC/Polaris/Thorn) and licensed perceptual-hash databases that
cannot live in client code.

---

## Settings

- **Recent files in memory** — 5–20 history entries retained.
- **Downloadable copies** — keep re-downloadable copies of the N most recent received files (0–3).
- **Content safety scanning** — on by default; disabling warns.
- **Auto-accept incoming**, **sound on complete**, **light/dark theme**, editable **device name**.

## Known limitations / next steps

- The 6-character pairing code is convenient but low-entropy; Phase 2 hardens the key exchange
  (PAKE/ECDH + verification) and adds forward secrecy.
- The broadcast "quarantine" is advisory; real enforcement must be server-side.
- TURN isn't configured yet, so transfers behind strict/symmetric NATs will fail until a managed
  TURN provider is added.
- History blobs are base64 in `localStorage` (capped at 3); IndexedDB + stream-to-disk is the
  production plan.
