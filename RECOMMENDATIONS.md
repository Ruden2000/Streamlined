# Streamlined — Optimizations & Improvements (prioritized)

This is a recommendation backlog. **Nothing here is implemented yet** — awaiting your approval on
what to pursue. Tiers: **P0** = required to be a real cross-device product, **P1** = important
hardening/quality, **P2** = polish & growth.

---

## P0 — Required for a real product

1. **Real cross-device transport (WebRTC).**
   The prototype links tabs in one browser via BroadcastChannel. Replace with **WebRTC
   DataChannels** + a minimal **WebSocket signaling server** (exchanges SDP/ICE only — never file
   bytes). This is the single biggest gap between prototype and product.

2. **Harden the key exchange.**
   A 6-character code is ~30 bits of entropy — brute-forceable by anyone who can reach the signaling
   channel. Move to a **PAKE (e.g. SPAKE2)** or **ephemeral ECDH** with a **short-authentication-
   string** the user confirms on both devices. Keep the short code only as a UX layer over a strong
   exchange. Rate-limit and lock out pairing attempts.

3. **CSAM detection: integrate a licensed service + mandated reporting.**
   The current hash matcher is an empty stub. Integrate **PhotoDNA / Cloudflare CSAM Scanning Tool /
   Thorn Safer / Google CSAI Match** (all require authorization), and implement legally-reviewed
   **NCMEC reporting** (US: 18 U.S.C. §2258A). This has real legal weight — involve counsel before
   launch.

4. **Move ban enforcement server-side.**
   The broadcast "quarantine" is advisory; a modified client can ignore it. Enforce IP/account bans
   on the signaling/relay server so a flagged device genuinely cannot pair or relay.

---

## P1 — Security, reliability, performance

5. **Forward secrecy** — derive a fresh ephemeral session key per pairing/transfer (ECDH ratchet)
   so a leaked code can't decrypt past or future sessions.
6. **Whole-file integrity manifest** — alongside per-chunk AES-GCM tags, send a signed manifest
   (total size + SHA-256) so truncation/reordering/tampering is detectable end-to-end.
7. **Device authentication & approval** — per-device keypairs + explicit "approve new device"
   (trust-on-first-use with verification), instead of trusting anyone holding the code.
8. **Flow control / backpressure** — the sender currently streams chunks without acks; honor
   WebRTC `bufferedAmount` (or a sliding-window ack scheme) to avoid overwhelming the channel on
   large files.
9. **Resumable transfers** — persist offsets to retry/resume after a drop instead of restarting.
10. **Stream to disk for large files** — use the **File System Access API** (`showSaveFilePicker`)
    and Web Streams instead of buffering whole files + base64 in memory.
11. **Offload crypto/hashing to a Web Worker** — keeps the UI smooth on multi-GB files.
12. **Harden history-at-rest** — store in **IndexedDB** (size + binary blobs), and encrypt with a
    key that isn't derived *solely* from the pairing code (add an optional device passphrase), plus
    auto-expiry and a "panic wipe".
13. **False-positive handling** — scanning needs a review/appeal path and a server-managed,
    versioned corpus; over-blocking legitimate files is a real product risk.

## P2 — UX, accessibility, growth

14. **PWA** — installable app, offline shell, manifest + icons, and a **Web Share Target** so mobile
    "Share → Streamlined" works.
15. **Accessibility pass** — modal focus traps, ARIA live regions for transfer/toast updates, full
    keyboard nav, `prefers-reduced-motion`, contrast audit.
16. **Richer transfer UI** — transfer **speed + ETA**, overall batch progress, per-file status, and
    **cancel** mid-transfer.
17. **Quality-of-life** — paste-to-send, drag a file directly onto a device, trusted-device memory,
    device avatars, optional pre-encryption compression.
18. **Internationalization** (i18n) and a copy/tone pass.
19. **Test suite** — unit tests for the QR encoder (encode→decode round-trip), crypto, and scanner;
    **Playwright** E2E across two browser contexts for a real transfer; fuzz chunk reassembly.

---

## Cross-cutting decision to make

**Client-side scanning is a deliberate privacy trade-off.** It's the only way to combine E2E
encryption with content blocking, but it's bypassable and carries civil-liberties concerns (the
Apple-2021 debate). Decide explicitly: ship client-side scanning, scan only on the recipient,
restrict scanning to specific contexts, or treat it as policy + reporting rather than prevention.
Whichever way, document it in a public transparency note.
