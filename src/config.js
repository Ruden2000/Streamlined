/* ====================================================================
   config.js — runtime configuration (signaling + ICE servers)
   --------------------------------------------------------------------
   In a Vite build, VITE_SIGNALING_URL / VITE_TURN_* env vars win.
   When run as plain ES modules (no build), we fall back to a localhost
   dev signaling server, and to empty (BroadcastChannel) off-localhost.
   ==================================================================== */
const env = (typeof import.meta !== "undefined" && import.meta.env) ? import.meta.env : {};

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
