/* ====================================================================
   transport.js — message transport behind one interface.
   --------------------------------------------------------------------
   Two backends, same API:
     • WebRTCTransport     — real peer-to-peer DataChannels over WebRTC,
                             using a WebSocket signaling server only to
                             exchange SDP/ICE. File bytes go P2P; the
                             server never sees content. Mesh up to 6.
     • BroadcastTransport  — same-browser tabs via BroadcastChannel
                             (localStorage fallback). Used when no
                             signaling URL is configured, or as automatic
                             fallback if the signaling socket won't open.

   Interface (createTransport returns an object):
     start()                  begin connecting
     send(msg)                msg._to set => unicast; else broadcast
     bufferedAmount(peerId)   bytes queued (for backpressure); 0 if N/A
     stop()                   tear down

   Callbacks (passed in opts):
     onMessage(msg)           a peer message arrived (already _from-stamped)
     onOpen(peerId|null)      a peer link opened (null = "announce broadly")
     onClose(peerId)          a peer link closed
   ==================================================================== */
import { uid } from "./util.js";

class BaseTransport {
  constructor(opts) {
    this.selfId = opts.selfId;
    this.room = opts.room;
    this.onMessage = opts.onMessage || (() => {});
    this.onOpen = opts.onOpen || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.seen = new Set();
  }
  _stamp(msg) { msg._mid = uid(); msg._from = this.selfId; return msg; }
  _deliver(msg) {
    if (!msg || msg._from === this.selfId) return;
    if (msg._mid) { if (this.seen.has(msg._mid)) return; this.seen.add(msg._mid); }
    if (msg._to && msg._to !== this.selfId) return;
    this.onMessage(msg);
  }
  bufferedAmount() { return 0; }
}

/* -------------------- BroadcastChannel (same browser) -------------------- */
export class BroadcastTransport extends BaseTransport {
  start() {
    const ch = "sl-net-" + this.room;
    if (typeof BroadcastChannel !== "undefined") {
      this.bc = new BroadcastChannel(ch);
      this.bc.onmessage = (e) => this._deliver(e.data);
      this.mode = "bc";
    } else {
      this.lsKey = "sl:bus:" + ch;
      this._onStorage = (e) => { if (e.key === this.lsKey && e.newValue) this._deliver(JSON.parse(e.newValue)); };
      window.addEventListener("storage", this._onStorage);
      this.mode = "ls";
    }
    setTimeout(() => this.onOpen(null), 0); // announce broadly once ready
  }
  send(msg) {
    this._stamp(msg);
    if (this.mode === "bc") this.bc.postMessage(msg);
    else localStorage.setItem(this.lsKey, JSON.stringify(msg));
  }
  stop() {
    if (this.bc) { this.bc.close(); this.bc = null; }
    if (this._onStorage) { window.removeEventListener("storage", this._onStorage); this._onStorage = null; }
  }
}

/* -------------------- WebRTC (real cross-device) -------------------- */
export class WebRTCTransport extends BaseTransport {
  constructor(opts) {
    super(opts);
    this.signalingUrl = opts.signalingUrl;
    this.iceServers = opts.iceServers || [{ urls: "stun:stun.l.google.com:19302" }];
    this.peers = new Map();        // peerId -> { pc, dc, open, pending: [] }
    this.fallback = null;          // BroadcastTransport if signaling fails
    this._opened = false;
  }

  start() {
    // room rides in the URL so a Cloudflare Worker can route to the right
    // Durable Object before accepting the socket (the Node dev server ignores it)
    const sep = this.signalingUrl.includes("?") ? "&" : "?";
    const url = this.signalingUrl + sep + "room=" + encodeURIComponent(this.room);
    let ws;
    try { ws = new WebSocket(url); }
    catch { return this._useFallback(); }
    this.ws = ws;
    // If the socket never opens (no server reachable), degrade gracefully.
    this._failTimer = setTimeout(() => { if (!this._opened) this._useFallback(); }, 3500);
    ws.onopen = () => {
      this._opened = true; clearTimeout(this._failTimer);
      ws.send(JSON.stringify({ type: "join", room: this.room, id: this.selfId }));
    };
    ws.onmessage = (e) => { try { this._onSignal(JSON.parse(e.data)); } catch {} };
    ws.onerror = () => { if (!this._opened) this._useFallback(); };
    ws.onclose = () => { if (!this._opened) this._useFallback(); };
  }

  _useFallback() {
    if (this.fallback || this._stopped) return;
    clearTimeout(this._failTimer);
    try { if (this.ws) this.ws.close(); } catch {}
    this.ws = null;
    console.warn("[transport] signaling unavailable — falling back to BroadcastChannel (same-browser only)");
    this.fallback = new BroadcastTransport({ selfId: this.selfId, room: this.room, onMessage: this.onMessage, onOpen: this.onOpen, onClose: this.onClose });
    this.fallback.start();
  }

  _onSignal(m) {
    if (m.type === "peers") { for (const pid of m.peers) this._connect(pid, true); }
    else if (m.type === "signal") { this._handleSignal(m.from, m.data); }
    else if (m.type === "peer-left") { this._closePeer(m.id); }
    else if (m.type === "full") { console.warn("[transport] room full"); }
    // "peer-joined" is informational; the newcomer initiates, so we wait.
  }

  _connect(peerId, initiator) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = { pc, dc: null, open: false, pending: [] };
    this.peers.set(peerId, peer);

    pc.onicecandidate = (e) => { if (e.candidate) this._signal(peerId, { candidate: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this._closePeer(peerId);
    };

    if (initiator) {
      const dc = pc.createDataChannel("data", { ordered: true });
      this._setupDc(peerId, dc);
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this._signal(peerId, { sdp: pc.localDescription }))
        .catch((e) => console.warn("offer failed", e));
    } else {
      pc.ondatachannel = (e) => this._setupDc(peerId, e.channel);
    }
    return peer;
  }

  _setupDc(peerId, dc) {
    dc.binaryType = "arraybuffer";
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.dc = dc;
    dc.onopen = () => { peer.open = true; this.onOpen(peerId); };
    dc.onclose = () => { peer.open = false; };
    dc.onmessage = (e) => { try { this._deliver(JSON.parse(e.data)); } catch {} };
  }

  async _handleSignal(from, data) {
    let peer = this.peers.get(from);
    if (data.sdp) {
      if (!peer) peer = this._connect(from, false);
      await peer.pc.setRemoteDescription(data.sdp);
      // flush any ICE candidates that arrived before the remote description
      for (const c of peer.pending.splice(0)) { try { await peer.pc.addIceCandidate(c); } catch {} }
      if (data.sdp.type === "offer") {
        const ans = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(ans);
        this._signal(from, { sdp: peer.pc.localDescription });
      }
    } else if (data.candidate) {
      if (peer && peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
        try { await peer.pc.addIceCandidate(data.candidate); } catch {}
      } else if (peer) {
        peer.pending.push(data.candidate);
      }
    }
  }

  _signal(to, data) {
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify({ type: "signal", to, from: this.selfId, data }));
  }

  _closePeer(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    try { p.pc.close(); } catch {}
    this.peers.delete(peerId);
    this.onClose(peerId);
  }

  send(msg) {
    if (this.fallback) return this.fallback.send(msg);
    this._stamp(msg);
    const data = JSON.stringify(msg);
    if (msg._to) { const p = this.peers.get(msg._to); if (p && p.open) p.dc.send(data); }
    else for (const p of this.peers.values()) if (p.open) p.dc.send(data);
  }

  bufferedAmount(peerId) {
    if (this.fallback) return 0;
    if (peerId && peerId !== "*") { const p = this.peers.get(peerId); return p && p.dc ? p.dc.bufferedAmount : 0; }
    let max = 0; for (const p of this.peers.values()) if (p.dc) max = Math.max(max, p.dc.bufferedAmount);
    return max;
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._failTimer);
    if (this.fallback) { this.fallback.stop(); this.fallback = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    for (const p of this.peers.values()) { try { p.pc.close(); } catch {} }
    this.peers.clear();
  }
}

/* -------------------- factory -------------------- */
export function createTransport(opts) {
  const hasWebRTC = typeof RTCPeerConnection !== "undefined";
  if (opts.signalingUrl && hasWebRTC) return new WebRTCTransport(opts);
  return new BroadcastTransport(opts);
}
