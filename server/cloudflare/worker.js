/* ====================================================================
   worker.js — Streamlined signaling on Cloudflare Workers + Durable Objects
   --------------------------------------------------------------------
   Production port of server/signaling.js. A plain Worker can't hold
   WebSocket state across peers, so each pairing "room" maps to one
   Durable Object instance (single-threaded, keyed by the hashed pairing
   code) that relays SDP/ICE between members. File bytes NEVER pass
   through here — they go peer-to-peer over the encrypted DataChannel.

   The room id arrives as ?room=<id> on the WebSocket URL so the Worker
   can route to the right DO before the socket is accepted. Identity
   (device id) arrives in the {type:"join"} message — identical protocol
   to the Node dev server, so src/transport.js is unchanged by which one
   it talks to.

   Uses the WebSocket Hibernation API + a SQLite-backed DO class so it
   runs on the Workers free plan. Deploy: see README.md in this folder.
   ==================================================================== */

const MAX_ROOM = 6;

export class SignalingRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
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
    }
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

/* GET /turn -> short-lived ICE servers (STUN + Cloudflare TURN if configured).
   The TURN secret lives only here as a Worker secret; clients never see it.
   Set secrets:  wrangler secret put TURN_TOKEN_ID  /  TURN_API_TOKEN  */
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
