# Streamlined signaling — Cloudflare Worker

Production signaling server (WebRTC SDP/ICE relay only — never file content). Same protocol as the
local Node dev server (`server/signaling.js`); the web client (`src/transport.js`) works with either.

## Verify locally (no account needed)

```bash
npx wrangler dev --config server/cloudflare/wrangler.toml --port 8788
# clients connect to:  ws://localhost:8788/?room=<id>
```

## Deploy (needs your Cloudflare account — this is the step that needs you)

```bash
npx wrangler login            # opens a browser; authorize once
npx wrangler deploy --config server/cloudflare/wrangler.toml
```

Wrangler prints a URL like `https://streamlined-signaling.<your-subdomain>.workers.dev`.
Your WebSocket endpoint is the same host with `wss://`:

```
wss://streamlined-signaling.<your-subdomain>.workers.dev
```

## Point the app at it

Build (or run) the web app with the env var set:

```bash
VITE_SIGNALING_URL=wss://streamlined-signaling.<your-subdomain>.workers.dev npm run build
```

`src/config.js` reads `VITE_SIGNALING_URL`; the app appends `?room=<hashed-code>` automatically.

## Notes

- **Free plan:** the DO class is declared `new_sqlite_classes`, which is eligible for the Workers
  free plan. Check current free-tier request/duration limits for your expected volume.
- **Rooms** are keyed by `idFromName(room)`, where `room` is the hashed pairing code — the server
  never sees the code itself or any file bytes.
- **Cap:** 6 members per room, matching the device limit.
