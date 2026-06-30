/* ====================================================================
   signaling.js — minimal WebRTC signaling server (local dev).
   --------------------------------------------------------------------
   Relays ONLY connection handshakes (SDP offers/answers + ICE
   candidates) between peers that share a room. File bytes NEVER pass
   through here — they travel peer-to-peer over the encrypted WebRTC
   DataChannel. The room id is derived from the (hashed) pairing code,
   so the server never sees the code or any content.

   Rooms are capped at 6 members (the device limit). This same protocol
   will be re-implemented on a Cloudflare Worker for production; the
   client (src/transport.js) is unchanged by where it runs.

   Run:  npm run signal       (PORT env overrides, default 8787)
   ==================================================================== */
import { WebSocketServer } from "ws";
import { createServer } from "http";

const PORT = Number(process.env.PORT) || 8787;
const MAX_ROOM = 6;

/** room id -> Map<deviceId, ws> */
const rooms = new Map();

// Plain HTTP for GET /turn (mirrors the Cloudflare Worker so local dev gets
// ICE servers too); the WebSocket server shares the same port.
const httpServer = createServer((req, res) => {
  if (req.url && req.url.startsWith("/turn")) {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Streamlined signaling (dev) — connect via WebSocket with ?room=<id>");
});
const wss = new WebSocketServer({ server: httpServer });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws) => {
  ws.id = null;
  ws.room = null;

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === "join") {
      const roomId = String(m.room || "");
      const id = String(m.id || "");
      if (!roomId || !id) return;
      const room = rooms.get(roomId) || new Map();
      if (!rooms.has(roomId)) rooms.set(roomId, room);
      if (!room.has(id) && room.size >= MAX_ROOM) { send(ws, { type: "full" }); return; }

      ws.id = id; ws.room = roomId;
      room.set(id, ws);

      // Tell the newcomer who is already here (newcomer initiates to them).
      send(ws, { type: "peers", peers: [...room.keys()].filter((k) => k !== id) });
      // Notify existing members (informational).
      for (const [pid, pws] of room) if (pid !== id) send(pws, { type: "peer-joined", id });
      console.log(`join ${id.slice(0, 6)} -> room ${roomId.slice(0, 8)} (${room.size})`);

    } else if (m.type === "signal") {
      const room = rooms.get(ws.room);
      if (!room) return;
      const target = room.get(m.to);
      if (target) send(target, { type: "signal", from: ws.id, data: m.data });
    } else if (m.type === "notify") {
      // Mirror the Worker: fan out the lightweight "incoming file" notice to
      // every other member so background helpers can show a native notification.
      const room = rooms.get(ws.room);
      if (!room) return;
      for (const [pid, pws] of room) if (pid !== ws.id) send(pws, m);
    }
  });

  ws.on("close", () => {
    if (ws.room && rooms.has(ws.room)) {
      const room = rooms.get(ws.room);
      room.delete(ws.id);
      for (const [, pws] of room) send(pws, { type: "peer-left", id: ws.id });
      if (room.size === 0) rooms.delete(ws.room);
      console.log(`leave ${String(ws.id).slice(0, 6)} (${room.size} left)`);
    }
  });
});

httpServer.listen(PORT, () => console.log(`Streamlined signaling server listening on ws://localhost:${PORT}`));
