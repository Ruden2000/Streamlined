/* ====================================================================
   worker.js — Streamlined signaling on Cloudflare Workers + Durable Objects
   --------------------------------------------------------------------
   Each pairing "room" maps to one Durable Object (keyed by the hashed
   pairing code) that relays SDP/ICE + the lightweight "notify" notice.
   File bytes NEVER pass through here — they go peer-to-peer over the
   encrypted DataChannel.

   The DO also stores Web Push subscriptions (SQLite) so a closed PWA can be
   woken with a payloadless push when a file arrives; the device's service
   worker then calls /last-notify to show the filename.
   ==================================================================== */
import { buildVapidJwt, vapidAuthHeader, audienceFor } from "./vapid.js";
import { getFcmAccessToken, sendFcm } from "./fcm.js";

const MAX_ROOM = 6;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" };
function json(obj, extra) { return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json", ...CORS, ...(extra || {}) } }); }

export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, device_id TEXT, sub TEXT)"
    );
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fcm (token TEXT PRIMARY KEY, device_id TEXT)"
    );
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Register / refresh a Web Push subscription for this room.
    if (url.pathname === "/subscribe" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || !body.subscription || !body.subscription.endpoint) return json({ ok: false }, { status: 400 });
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO subs(endpoint, device_id, sub) VALUES (?,?,?)",
        body.subscription.endpoint,
        String(body.deviceId || ""),
        JSON.stringify(body.subscription)
      );
      return json({ ok: true });
    }

    // Register / refresh a native-Android FCM token for this room.
    if (url.pathname === "/fcm-register" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || !body.token) return json({ ok: false }, { status: 400 });
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO fcm(token, device_id) VALUES (?,?)",
        String(body.token),
        String(body.deviceId || "")
      );
      return json({ ok: true });
    }

    // The service worker fetches the last file name to show in its notification.
    if (url.pathname === "/last-notify" && request.method === "GET") {
      const last = (await this.state.storage.get("lastNotify")) || {};
      return json(last);
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);          // hibernatable
    return new Response(null, { status: 101, webSocket: client });
  }

  _ids(except) {
    return this.state.getWebSockets()
      .map((ws) => (ws.deserializeAttachment() || {}).id)
      .filter((id) => id && id !== except);
  }
  _byId(id) {
    return this.state.getWebSockets().find((ws) => (ws.deserializeAttachment() || {}).id === id);
  }
  _send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === "join") {
      const id = String(m.id || "");
      if (!id) return;
      const others = this._ids(id);
      if (!this._byId(id) && others.length >= MAX_ROOM) { this._send(ws, { type: "full" }); return; }
      ws.serializeAttachment({ id });
      this._send(ws, { type: "peers", peers: others });
      for (const pid of others) { const t = this._byId(pid); if (t) this._send(t, { type: "peer-joined", id }); }
    } else if (m.type === "signal") {
      const att = ws.deserializeAttachment() || {};
      const target = this._byId(m.to);
      if (target) this._send(target, { type: "signal", from: att.id, data: m.data });
    } else if (m.type === "notify") {
      // Fan out to live members, remember the filename for the SW to fetch,
      // and Web-Push any subscribed devices that aren't currently connected.
      const att = ws.deserializeAttachment() || {};
      for (const pid of this._ids(att.id)) { const t = this._byId(pid); if (t) this._send(t, m); }
      await this.state.storage.put("lastNotify", { name: m.name, fromName: m.fromName, ts: Date.now() });
      const live = this._ids(att.id);
      await this._pushToSubs(att.id, live);
      await this._pushToFcm(att.id, live, m);
    }
  }

  // Send a payloadless Web Push to every subscribed device except the sender
  // and devices already live on a socket (they got the in-band notify).
  async _pushToSubs(senderId, liveIds) {
    if (!this.env.VAPID_PRIVATE || !this.env.VAPID_PUBLIC) return;
    const live = new Set([senderId, ...liveIds]);
    const rows = this.state.storage.sql.exec("SELECT endpoint, device_id, sub FROM subs").toArray();
    const subject = this.env.VAPID_SUBJECT || "mailto:ray.yabardental@gmail.com";
    for (const row of rows) {
      if (live.has(row.device_id)) continue;
      let sub;
      try { sub = JSON.parse(row.sub); } catch { continue; }
      try {
        const jwt = await buildVapidJwt(this.env.VAPID_PRIVATE, audienceFor(sub.endpoint), subject);
        const res = await fetch(sub.endpoint, {
          method: "POST",
          headers: { Authorization: vapidAuthHeader(jwt, this.env.VAPID_PUBLIC), TTL: "86400" }
        });
        if (res.status === 404 || res.status === 410) {
          this.state.storage.sql.exec("DELETE FROM subs WHERE endpoint = ?", row.endpoint);
        }
      } catch { /* skip this endpoint */ }
    }
  }

  // Wake fully-closed native Android apps via FCM (HTTP v1). Access token is
  // cached in memory for its lifetime to avoid re-minting on every notify.
  async _pushToFcm(senderId, liveIds, m) {
    if (!this.env.FCM_SERVICE_ACCOUNT) return;
    let rows;
    try { rows = this.state.storage.sql.exec("SELECT token, device_id FROM fcm").toArray(); } catch { return; }
    if (!rows.length) return;
    let sa;
    try { sa = JSON.parse(this.env.FCM_SERVICE_ACCOUNT); } catch { return; }
    const live = new Set([senderId, ...liveIds]);
    try {
      const now = Date.now();
      if (!this._fcmToken || now >= this._fcmExp) {
        this._fcmToken = await getFcmAccessToken(sa);
        this._fcmExp = now + 3000 * 1000;   // ~50 min (token lasts 60)
      }
      const title = "Streamlined — incoming file";
      const body = '"' + (m.name || "a file") + '" from ' + (m.fromName || "a linked device");
      for (const row of rows) {
        if (live.has(row.device_id)) continue;
        const status = await sendFcm(this._fcmToken, sa.project_id, row.token, title, body);
        if (status === 404) this.state.storage.sql.exec("DELETE FROM fcm WHERE token = ?", row.token);
      }
    } catch { /* token/network failure — skip this round */ }
  }

  async webSocketClose(ws) { this._announceLeave(ws); }
  async webSocketError(ws) { this._announceLeave(ws); }
  _announceLeave(ws) {
    const att = ws.deserializeAttachment() || {};
    if (!att.id) return;
    for (const pid of this._ids(att.id)) { const t = this._byId(pid); if (t) this._send(t, { type: "peer-left", id: att.id }); }
  }
}

const STUN = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" }
];

/* GET /turn -> short-lived ICE servers (STUN + Cloudflare TURN if configured). */
async function handleTurn(env) {
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
  if (!env.TURN_TOKEN_ID || !env.TURN_API_TOKEN) {
    return new Response(JSON.stringify({ iceServers: STUN }), { headers });
  }
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_TOKEN_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.TURN_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: 86400 })
      }
    );
    if (!r.ok) return new Response(JSON.stringify({ iceServers: STUN, error: `turn ${r.status}` }), { headers });
    const data = await r.json();
    let ice = data.iceServers;
    if (!Array.isArray(ice)) ice = ice ? [ice] : [];
    return new Response(JSON.stringify({ iceServers: [...STUN, ...ice] }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ iceServers: STUN, error: String(e) }), { headers });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/turn") return handleTurn(env);

    // Push subscription endpoints are routed to the room's Durable Object.
    if (url.pathname === "/subscribe" || url.pathname === "/last-notify" || url.pathname === "/fcm-register") {
      const room = url.searchParams.get("room") || "default";
      const stub = env.SIGNALING_ROOM.get(env.SIGNALING_ROOM.idFromName(room));
      return stub.fetch(request);
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Streamlined signaling worker — connect via WebSocket with ?room=<id>", {
        status: 200, headers: { "content-type": "text/plain" }
      });
    }
    const room = url.searchParams.get("room") || "default";
    const stub = env.SIGNALING_ROOM.get(env.SIGNALING_ROOM.idFromName(room));
    return stub.fetch(request);
  }
};
