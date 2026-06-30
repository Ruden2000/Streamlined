/* ====================================================================
   config.js — runtime configuration (signaling + ICE servers)
   --------------------------------------------------------------------
   In a Vite build, VITE_SIGNALING_URL / VITE_TURN_* env vars win.
   When run as plain ES modules (no build), we fall back to a localhost
   dev signaling server, and to empty (BroadcastChannel) off-localhost.
   ==================================================================== */
const env = (typeof import.meta !== "undefined" && import.meta.env) ? import.meta.env : {};

// Bump this in lockstep with package.json / tauri.conf.json / android versionName
// on every release — the in-app updater compares it against the latest GitHub tag.
export const APP_VERSION = "1.0.1";

export const UPDATE_CONFIG = {
  repo: "Ruden2000/Streamlined",
  // Public, unauthenticated GitHub Releases API (60 req/hr/IP — ample for update checks).
  releasesApi: "https://api.github.com/repos/Ruden2000/Streamlined/releases"
};

// VAPID public key for Web Push (closed-app notifications on PWA installs,
// including iOS 16.4+ home-screen apps). The matching private key lives ONLY as
// a Worker secret (VAPID_PRIVATE). Safe to ship publicly — it's the server id.
export const VAPID_PUBLIC = "BCvoofClfzLCLp9Nezbfo3vyPnm8Bv8Ad38NA7UTjRe_PM6EeqZxj0FBTv9wXx1snw32mRqXJQJE4_tZv7Kxg_M";

const isLocal = typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

export const CONFIG = {
  // WebSocket signaling endpoint. Empty string => use BroadcastChannel
  // (same-browser tabs only). Set to your Cloudflare Worker URL in prod.
  signalingUrl: env.VITE_SIGNALING_URL || (isLocal ? "ws://localhost:8787" : ""),

  // ICE servers for NAT traversal. STUN is free; TURN is a managed,
  // pay-per-GB relay used only when a direct P2P path can't be found.
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    ...(env.VITE_TURN_URL
      ? [{ urls: env.VITE_TURN_URL, username: env.VITE_TURN_USERNAME, credential: env.VITE_TURN_CREDENTIAL }]
      : [])
  ]
};

/* Ask the signaling Worker's /turn endpoint for fresh ICE servers (STUN +
   short-lived Cloudflare TURN). Falls back to the static STUN config above
   if the endpoint is unreachable or no signaling URL is set. */
export async function fetchIceServers() {
  if (!CONFIG.signalingUrl) return CONFIG.iceServers;
  try {
    const httpBase = CONFIG.signalingUrl.replace(/^ws/, "http").replace(/\/+$/, "");
    const r = await fetch(httpBase + "/turn", { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d.iceServers) && d.iceServers.length) return d.iceServers;
    }
  } catch { /* fall through */ }
  return CONFIG.iceServers;
}
