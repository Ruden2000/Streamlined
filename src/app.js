/* ====================================================================
   app.js — networking, transfer, history, rendering, and UI wiring.
   --------------------------------------------------------------------
   NOTE: the `Transport` object below still uses BroadcastChannel (links
   tabs of one browser). Phase 1 replaces it with a WebRTC DataChannel +
   signaling transport; the message protocol (hello/offer/chunk/complete)
   is designed to stay the same so the rest of this file is unaffected.
   ==================================================================== */
import { $, $$, el, fmtBytes, fmtTime, uid, escapeHtml, linkify, isGenericName, numberedName, b64ToBytes, blobToB64 } from "./util.js";
import { state, MAX_DEVICES, CHUNK } from "./state.js";
import { QR } from "./qr.js";
import { Crypto } from "./crypto.js";
import { Scanner } from "./scanner.js";
import { createTransport } from "./transport.js";
import { CONFIG, fetchIceServers, APP_VERSION, UPDATE_CONFIG, VAPID_PUBLIC } from "./config.js";

/* ---------- persistence (device identity + settings are unencrypted;
              history is encrypted with the network key) ---------- */
function loadLocal() {
  try {
    const d = JSON.parse(localStorage.getItem("sl:device") || "null");
    state.device = d || { id: uid(), name: defaultDeviceName(), type: detectType() };
    localStorage.setItem("sl:device", JSON.stringify(state.device));
    const s = JSON.parse(localStorage.getItem("sl:settings") || "null");
    if (s) Object.assign(state.settings, s);
  } catch {
    state.device = { id: uid(), name: defaultDeviceName(), type: detectType() };
  }
}
function saveDevice() { localStorage.setItem("sl:device", JSON.stringify(state.device)); }
function saveSettings() { localStorage.setItem("sl:settings", JSON.stringify(state.settings)); }

function detectType() { const ua = navigator.userAgent; if (/iPhone|Android.*Mobile|Windows Phone/.test(ua)) return "mobile"; if (/iPad|Tablet|Android/.test(ua)) return "tablet"; if (/Macintosh|Mac OS/.test(ua)) return "laptop"; return "desktop"; }
function defaultDeviceName() { const a = ["Swift","Quiet","Bright","Cobalt","Amber","Nimbus","Lunar","Coral"]; const t = detectType(); return a[Math.floor(Math.random() * a.length)] + " " + t.charAt(0).toUpperCase() + t.slice(1); }

async function saveHistory() {
  if (!state.network || !Crypto.ok) return;
  // "size permitting": if localStorage is full, shed the OLDEST stored file
  // copies one at a time and retry, so metadata always survives.
  for (;;) {
    try {
      const payload = JSON.stringify({ history: state.history, incidents: state.incidents });
      const enc = await Crypto.encrypt(state.network.key, new TextEncoder().encode(payload));
      localStorage.setItem("sl:hist:" + state.network.id, JSON.stringify(enc));
      return;
    } catch (e) {
      const withBlobs = state.history.filter((h) => h.blobB64);
      if (!withBlobs.length) { console.warn("history save failed", e); return; }
      withBlobs[withBlobs.length - 1].blobB64 = null;
    }
  }
}
async function loadHistory() {
  if (!state.network || !Crypto.ok) return;
  try {
    const raw = localStorage.getItem("sl:hist:" + state.network.id);
    if (!raw) { state.history = []; state.incidents = []; return; }
    const { iv, ct } = JSON.parse(raw);
    const pt = await Crypto.decrypt(state.network.key, iv, ct);
    const obj = JSON.parse(new TextDecoder().decode(pt));
    state.history = obj.history || [];
    state.incidents = obj.incidents || [];
  } catch (e) { console.warn("history load failed", e); state.history = []; state.incidents = []; }
}

/* ====================================================================
   TRANSPORT — BroadcastChannel (fallback: localStorage event bus)
   Every payload that carries file data is already AES-GCM ciphertext.
   ==================================================================== */
/* Transport facade — delegates to the active WebRTC (or BroadcastChannel
   fallback) instance created in startNetwork. The rest of the app keeps
   calling Transport.send / .stop exactly as before. */
const Transport = {
  active: null,
  async start(room) {
    const iceServers = await fetchIceServers();   // STUN + short-lived TURN from the Worker
    this.active = createTransport({
      selfId: state.device.id,
      room,
      signalingUrl: CONFIG.signalingUrl,
      iceServers,
      onMessage: handleMessage,
      onOpen: onPeerOpen,
      onClose: onPeerClose
    });
    this.active.start();
  },
  send(msg) { if (this.active) this.active.send(msg); },
  notifyAll(msg) { if (this.active) this.active.notifyAll(msg); },
  bufferedAmount(peerId) { return this.active ? this.active.bufferedAmount(peerId) : 0; },
  stop() { if (this.active) { this.active.stop(); this.active = null; } }
};

/* Presence is link-driven: greet a peer when its channel opens, drop it
   when the channel closes. (peerId === null means "announce broadly",
   used by the BroadcastChannel backend.) */
function onPeerOpen(peerId) {
  const dev = { id: state.device.id, name: state.device.name, type: state.device.type };
  if (peerId) Transport.send({ type: "hello", _to: peerId, device: dev });
  else Transport.send({ type: "hello", device: dev });
}
function onPeerClose(peerId) {
  // link dropped ≠ unlinked: keep the device in the roster, just mark Offline
  const d = state.devices.get(peerId);
  if (d && !d.me) { d.online = false; renderDevices(); renderTargets(); }
}

/* ====================================================================
   NETWORKING — create / join / presence
   ==================================================================== */
function randomCode() { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)]; return s; }

async function startNetwork(code) {
  if (!Crypto.ok) { toast("danger", "Encryption unavailable", "Run via http://localhost — see README."); return false; }
  code = code.toUpperCase();
  if (state.network && state.network.code === code) { renderAll(); return true; } // already on it
  const id = (await Crypto.sha256hex("streamlined:" + code)).slice(0, 16);
  const key = await Crypto.deriveKey(code);
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; } // clean up any prior network
  Transport.stop();
  state.network = { code, id, key };
  await Transport.start(id);        // fetches ICE servers, then connects; peers greeted on link open
  await loadHistory();
  state.devices.clear();   // drop any previous network's roster from the UI
  state.devices.set(state.device.id, { ...state.device, lastSeen: Date.now(), online: true, banned: false, me: true });
  loadRoster();            // restore paired devices (shown Offline until they reappear)
  presenceTimer = setInterval(heartbeat, 4000);
  // Hand the active room to the desktop background helper so it can keep
  // receiving "incoming file" notices (and show native notifications) even
  // after the window is closed to the tray and the webview is gone.
  // remember the network so this device re-links automatically on next launch
  try { localStorage.setItem("sl:lastCode", code); } catch { /* private mode */ }
  if (detectShell() === "tauri") {
    tauriInvoke("set_active_room", { info: { signalingUrl: CONFIG.signalingUrl, room: id, code, selfId: state.device.id } });
    // Autostart boot (--hidden): once the helper holds the room, close the
    // window so only the minimal tray helper stays resident.
    if (!window.__slRetired) {
      window.__slRetired = true;
      tauriInvoke("launch_hidden").then((h) => { if (h) tauriInvoke("retire_to_tray"); }).catch(() => {});
    }
  } else if (detectShell() === "web") {
    subscribePush();   // register this room for closed-app web-push (if already permitted)
  } else if (detectShell() === "capacitor") {
    registerFcm();     // register this room for native Android FCM (if permitted + configured)
  }
  renderAll();
  return true;
}
function heartbeat() {
  if (!state.network) return;
  Transport.send({ type: "ping", device: { id: state.device.id, name: state.device.name, type: state.device.type } });
  const now = Date.now();
  let changed = false;
  // silent peers go Offline but STAY in the roster — pairing is permanent
  // until the user leaves the network or removes the app.
  for (const [, d] of state.devices) { if (!d.me && d.online && now - d.lastSeen > 12000) { d.online = false; changed = true; } }
  if (changed) { renderDevices(); renderTargets(); }
}
let presenceTimer = null;

function leaveNetwork() {
  if (presenceTimer) clearInterval(presenceTimer);
  Transport.send({ type: "bye", device: { id: state.device.id } });
  if (detectShell() === "tauri") tauriInvoke("clear_active_room");
  try {
    localStorage.removeItem("sl:lastCode");
    if (state.network) localStorage.removeItem(rosterKey(state.network.id));   // manual unlink forgets the roster
  } catch { /* ignore */ }
  state.clip = { text: "", ts: 0, fromName: "" };
  $("#clipInput").value = "";
  renderClipView(false);
  Transport.stop();
  state.network = null; state.devices.clear(); state.transfers.clear(); state.incoming.clear();
  state.outbox = [];
  state.history = []; state.incidents = [];
  renderAll();
  toast("good", "Left network", "This device is no longer linked.");
}

function registerDevice(d) {
  if (!d || d.id === state.device.id) return;
  const known = state.devices.has(d.id);
  if (!known && countActive() >= MAX_DEVICES) { return; } // network full — ignore
  const prev = state.devices.get(d.id) || {};
  const wasOnline = !!prev.online;
  state.devices.set(d.id, { ...prev, ...d, lastSeen: Date.now(), online: true, banned: prev.banned || false });
  if (!known || prev.name !== d.name || prev.type !== d.type) saveRoster();
  if (!known || !wasOnline) { renderDevices(); renderTargets(); flushOutbox(); }
}
function countActive() { return state.devices.size; }

/* ---- persistent roster: paired devices stay linked (listed) across
        restarts and offline periods, until the user leaves the network ---- */
function rosterKey(netId) { return "sl:roster:" + netId; }
function saveRoster() {
  if (!state.network) return;
  const list = [...state.devices.values()].filter((d) => !d.me)
    .map((d) => ({ id: d.id, name: d.name, type: d.type, banned: !!d.banned }));
  try { localStorage.setItem(rosterKey(state.network.id), JSON.stringify(list)); } catch { /* ignore */ }
}
function loadRoster() {
  if (!state.network) return;
  try {
    const list = JSON.parse(localStorage.getItem(rosterKey(state.network.id)) || "[]");
    for (const d of list) {
      if (d && d.id && !state.devices.has(d.id)) state.devices.set(d.id, { ...d, online: false, lastSeen: 0 });
    }
  } catch { /* ignore */ }
}

/* ====================================================================
   MESSAGE HANDLING
   ==================================================================== */
async function handleMessage(msg) {
  switch (msg.type) {
    case "hello":
      registerDevice(msg.device);
      // respond so the newcomer learns about us
      Transport.send({ type: "welcome", _to: msg.device.id, device: { id: state.device.id, name: state.device.name, type: state.device.type } });
      // share who we currently know is banned
      for (const [id, d] of state.devices) if (d.banned) Transport.send({ type: "ban", _to: msg.device.id, deviceId: id });
      // bring the newcomer up to date on the synced clipboard
      if (state.clip.text) Transport.send({ type: "clip", _to: msg.device.id, text: state.clip.text, ts: state.clip.ts, fromName: state.clip.fromName });
      break;
    case "welcome":
    case "ping":
      registerDevice(msg.device);
      break;
    case "bye": {
      // an explicit "bye" means the device chose to leave — unlink it fully
      const dv = msg.device && state.devices.get(msg.device.id);
      if (dv && !dv.me) { state.devices.delete(msg.device.id); saveRoster(); renderDevices(); renderTargets(); }
      break;
    }
    case "ban":
      markBanned(msg.deviceId);
      break;
    case "notify":      onNotify(msg); break;
    case "clip":        onClip(msg); break;
    case "offer":       await onOffer(msg); break;
    case "accept":      onAccept(msg); break;
    case "decline":     onDecline(msg); break;
    case "chunk":       await onChunk(msg); break;
    case "complete":    await onComplete(msg); break;
    case "progress":    onRemoteProgress(msg); break;
  }
}

function markBanned(deviceId) {
  const d = state.devices.get(deviceId);
  if (d) { d.banned = true; saveRoster(); }
  if (deviceId === state.device.id) {
    state.device.banned = true;
    toast("danger", "Device quarantined", "This device attempted to send blocked content and can no longer transfer on this network.");
  }
  renderDevices(); renderTargets();
}

/* ====================================================================
   SENDING
   ==================================================================== */
async function sendSelected() {
  if (state.device.banned) { toast("danger", "Quarantined", "This device is blocked from sending."); return; }
  const files = state.selected.slice();
  if (!files.length) return;
  const targetId = $("#targetSelect").value;
  if (!targetId) {
    // no device online right now — queue locally and auto-send on reconnect
    state.selected = []; renderSelected();
    for (const f of files) state.outbox.push({ id: uid(), file: f, ts: Date.now() });
    renderTransfers();
    toast("info", "Queued", files.length + " file" + (files.length > 1 ? "s" : "") + " will send automatically when a linked device comes online.");
    return;
  }
  state.selected = []; renderSelected();
  for (const file of files) await sendOneFile(file, targetId);
}

// Fires when a device comes online: drain the offline queue to every
// currently-online device. Files live in memory only, so the queue does not
// survive an app restart (noted in the queued row's status text).
function flushOutbox() {
  if (!state.outbox.length) return;
  const items = state.outbox.splice(0);
  renderTransfers();
  toast("good", "Device online", "Sending " + items.length + " queued file" + (items.length > 1 ? "s" : "") + "…");
  (async () => { for (const it of items) await sendOneFile(it.file, "*"); })();
}

async function sendOneFile(file, targetId) {
  // 1) SCAN PLAINTEXT BEFORE ENCRYPTION
  const verdict = await Scanner.scan(file);
  if (!verdict.allowed) {
    logIncident(file, verdict, state.device.id);
    // Quarantine the offending device (this one) across the network.
    Transport.send({ type: "ban", deviceId: state.device.id });
    markBanned(state.device.id);
    return;
  }
  const targets = targetId === "*"
    ? [...state.devices.values()].filter((d) => !d.me && !d.banned).map((d) => d.id)
    : [targetId];
  if (!targets.length) { toast("warn", "No recipients", "No available devices to receive."); return; }

  // Tell every paired device a file is entering the network so they can surface
  // a notification. notifyAll crosses both P2P and the signaling socket, so even
  // a device sitting in its minimal tray helper (no P2P) gets alerted. The
  // transport drops our own echo, so the sender is never notified.
  Transport.notifyAll({ type: "notify", name: file.name, size: file.size, mime: file.type || "application/octet-stream", fromName: state.device.name });

  for (const to of targets) {
    const tid = uid();
    const rec = { id: tid, name: file.name, size: file.size, type: file.type || "application/octet-stream", dir: "sent", peer: deviceName(to), to, sent: 0, progress: 0, status: "sending", scan: verdict.skipped ? "unscanned" : "clean" };
    state.transfers.set(tid, rec); renderTransfers();
    Transport.send({ type: "offer", _to: to, tid, name: rec.name, size: rec.size, mime: rec.type });
    // wait briefly for accept (auto if receiver has auto-accept)
    rec._buffer = file;
  }
}

async function onAccept(msg) {
  const rec = state.transfers.get(msg.tid);
  if (!rec || rec.dir !== "sent") return;
  await streamFile(rec);
}
function onDecline(msg) {
  const rec = state.transfers.get(msg.tid);
  if (!rec) return;
  rec.status = "declined"; renderTransfers();
  toast("warn", "Declined", '"' + rec.name + '" was declined by ' + rec.peer + ".");
  setTimeout(() => { state.transfers.delete(msg.tid); renderTransfers(); }, 2500);
}

async function streamFile(rec) {
  const file = rec._buffer;
  if (!file) return;
  const total = file.size, key = state.network.key;
  let offset = 0;
  rec.status = "sending";
  try {
    while (offset < total) {
      const slice = file.slice(offset, offset + CHUNK);
      const buf = new Uint8Array(await slice.arrayBuffer());
      const { iv, ct } = await Crypto.encrypt(key, buf);
      // backpressure: don't outrun the DataChannel's send buffer
      while (Transport.bufferedAmount(rec.to) > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 20));
      Transport.send({ type: "chunk", _to: rec.to, tid: rec.id, iv, ct, off: offset, total });
      offset += buf.length;
      rec.sent = offset; rec.progress = Math.round((offset / total) * 100);
      queueProgress(rec.id);
      await new Promise((r) => setTimeout(r, 0)); // yield to UI
    }
    Transport.send({ type: "complete", _to: rec.to, tid: rec.id, name: rec.name, size: rec.size, mime: rec.type });
    rec.status = "done"; rec.progress = 100; renderTransfers();
    addHistory({ name: rec.name, size: rec.size, type: rec.type, dir: "sent", peer: rec.peer, status: "sent", scan: rec.scan });
    chime();
    setTimeout(() => { state.transfers.delete(rec.id); renderTransfers(); }, 3000);
  } catch (e) {
    console.error(e); rec.status = "error"; renderTransfers();
    toast("danger", "Transfer failed", rec.name);
  } finally { rec._buffer = null; }
}

/* ====================================================================
   RECEIVING
   ==================================================================== */
async function onOffer(msg) {
  if (state.device.banned) return;
  const meta = { tid: msg.tid, name: msg.name, size: msg.size, mime: msg.mime, from: msg._from };
  if (state.settings.autoAccept) { acceptOffer(meta); return; }
  state.pendingOffers.set(msg.tid, meta);
  showIncomingPrompt(meta);
}
function acceptOffer(meta) {
  state.incoming.set(meta.tid, { meta, chunks: [], received: 0 });
  const rec = { id: meta.tid, name: meta.name, size: meta.size, type: meta.mime, dir: "received", peer: deviceName(meta.from), from: meta.from, progress: 0, status: "receiving", scan: "clean" };
  state.transfers.set(meta.tid, rec); renderTransfers();
  showDownloadBox(rec);
  Transport.send({ type: "accept", _to: meta.from, tid: meta.tid });
}

/* ---- floating, dismissible download progress box (one per incoming file) ---- */
function showDownloadBox(rec) {
  const box = el("div", "dlbox");
  box.dataset.tid = rec.id;
  box.innerHTML =
    '<div class="dl-head"><span class="dl-name">' + escapeHtml(rec.name) + '</span>' +
    '<button class="x-btn dl-x" aria-label="Dismiss download notification">✕</button></div>' +
    '<div class="bar"><i style="width:0%"></i></div>' +
    '<div class="dl-sub">Receiving · <span class="dl-pct">0%</span></div>';
  box.querySelector(".dl-x").onclick = () => box.remove();   // dismiss the box; the transfer continues
  $("#dlboxes").appendChild(box);
}
function finishDownloadBox(tid, status) {
  const box = document.querySelector('.dlbox[data-tid="' + CSS.escape(tid) + '"]');
  if (!box) return;
  const bar = box.querySelector(".bar > i"), sub = box.querySelector(".dl-sub");
  if (status === "done") {
    if (bar) bar.style.width = "100%";
    if (sub) sub.textContent = "Complete";
    setTimeout(() => { box.style.opacity = "0"; box.style.transition = "opacity .3s"; setTimeout(() => box.remove(), 300); }, 2200);
  } else {
    if (bar) { bar.style.width = "100%"; bar.style.background = "var(--danger)"; }
    if (sub) sub.textContent = status === "blocked" ? "Blocked by content safety" : "Failed";
    setTimeout(() => box.remove(), 3500);
  }
}
function declineOffer(meta) { Transport.send({ type: "decline", _to: meta.from, tid: meta.tid }); }

async function onChunk(msg) {
  const inc = state.incoming.get(msg.tid);
  if (!inc) return;
  try {
    const bytes = await Crypto.decrypt(state.network.key, msg.iv, msg.ct);
    inc.chunks.push({ off: msg.off, bytes });
    inc.received += bytes.length;
    const rec = state.transfers.get(msg.tid);
    if (rec) { rec.progress = Math.round((inc.received / msg.total) * 100); queueProgress(msg.tid); }
  } catch (e) { console.error("decrypt failed", e); }
}

async function onComplete(msg) {
  const inc = state.incoming.get(msg.tid);
  const rec = state.transfers.get(msg.tid);
  if (!inc || !rec) return;
  inc.chunks.sort((a, b) => a.off - b.off);
  const blob = new Blob(inc.chunks.map((c) => c.bytes), { type: msg.mime || "application/octet-stream" });

  // Defense in depth: receiver re-scans the reassembled plaintext.
  const fileForScan = new File([blob], msg.name, { type: msg.mime });
  const verdict = await Scanner.scan(fileForScan);
  if (!verdict.allowed) {
    rec.status = "blocked"; rec.scan = "blocked"; renderTransfers();
    finishDownloadBox(msg.tid, "blocked");
    logIncident(fileForScan, verdict, msg._from);
    Transport.send({ type: "ban", deviceId: msg._from });
    markBanned(msg._from);
    state.incoming.delete(msg.tid);
    setTimeout(() => { state.transfers.delete(msg.tid); renderTransfers(); }, 3500);
    return;
  }

  rec.status = "done"; rec.progress = 100; renderTransfers();
  finishDownloadBox(msg.tid, "done");
  const blobB64 = await blobToB64(blob);
  addHistory({ name: msg.name, size: msg.size, type: msg.mime, dir: "received", peer: rec.peer, status: "received", scan: "clean", blobB64 });
  state.incoming.delete(msg.tid);
  chime();
  toast("good", "File received", msg.name);
  setTimeout(() => { state.transfers.delete(msg.tid); renderTransfers(); }, 3000);
}
function onRemoteProgress() { /* reserved */ }

/* ====================================================================
   HISTORY + INCIDENTS
   ==================================================================== */
function addHistory(entry) {
  entry.id = uid(); entry.ts = Date.now();
  state.history.unshift(entry);
  pruneHistory();
  saveHistory();
  renderHistory();
}
function pruneHistory() {
  // Cap total entries — never below downloadableCopies, so raising the copies
  // slider to 20 actually keeps 20 entries around.
  const cap = Math.max(state.settings.recentInMemory, state.settings.downloadableCopies);
  if (state.history.length > cap) state.history.length = cap;
  // Keep downloadable blobs only for the N most recent received files.
  const recvWithBlob = state.history.filter((h) => h.dir === "received");
  let kept = 0;
  for (const h of recvWithBlob) {
    if (h.blobB64) { kept++; if (kept > state.settings.downloadableCopies) h.blobB64 = null; }
  }
}
function logIncident(file, verdict, deviceId) {
  const inc = { id: uid(), name: file.name, ts: Date.now(), reasons: verdict.reasons, category: verdict.category, peer: deviceName(deviceId), deviceId };
  state.incidents.unshift(inc);
  if (state.incidents.length > 50) state.incidents.length = 50;
  saveHistory();
  renderIncidents();
  setActiveTab("incidents");
  toast("danger", "Blocked: illegal content", file.name + " — transfer blocked, device quarantined, incident logged.");
}
/* ---- preview a stored file before downloading it ---- */
let _previewUrl = null;
async function previewHistory(id) {
  const h = state.history.find((x) => x.id === id);
  if (!h || !h.blobB64) return;
  const blob = new Blob([b64ToBytes(h.blobB64)], { type: h.type || "application/octet-stream" });
  const body = $("#previewBody"); body.innerHTML = "";
  $("#previewTitle").textContent = h.name;
  const t = h.type || "";
  if (t.startsWith("image/")) {
    _previewUrl = URL.createObjectURL(blob);
    const img = el("img"); img.src = _previewUrl; img.alt = h.name; body.appendChild(img);
  } else if (t.startsWith("video/")) {
    _previewUrl = URL.createObjectURL(blob);
    const v = el("video"); v.src = _previewUrl; v.controls = true; body.appendChild(v);
  } else if (t.startsWith("audio/")) {
    _previewUrl = URL.createObjectURL(blob);
    const a = el("audio"); a.src = _previewUrl; a.controls = true; body.appendChild(a);
  } else if (t === "application/pdf") {
    _previewUrl = URL.createObjectURL(blob);
    const f = el("iframe"); f.src = _previewUrl; f.title = "Preview of " + h.name; body.appendChild(f);
  } else if (t.startsWith("text/") || /(json|xml|javascript|csv)/.test(t) || /\.(txt|md|csv|json|log|js|css|html?|xml)$/i.test(h.name)) {
    const txt = await blob.text();
    const pre = el("pre", "preview-text"); pre.textContent = txt.slice(0, 200000);   // cap huge files
    body.appendChild(pre);
  } else {
    body.appendChild(el("div", "empty", "No preview available for this file type — use Download to open it."));
  }
  openModal($("#previewScrim"));
}
function closePreview() {
  closeModal($("#previewScrim"));
  if (_previewUrl) { URL.revokeObjectURL(_previewUrl); _previewUrl = null; }
  $("#previewBody").innerHTML = "";
}

function downloadHistory(id) {
  const h = state.history.find((x) => x.id === id);
  if (!h || !h.blobB64) return;
  const bytes = b64ToBytes(h.blobB64);
  const blob = new Blob([bytes], { type: h.type || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = el("a"); a.href = url; a.download = h.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ====================================================================
   RENDERING
   ==================================================================== */
function deviceName(id) { const d = state.devices.get(id); return d ? d.name : "Unknown device"; }

const DEVICE_ICONS = {
  desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  laptop:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg>',
  mobile:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>',
  tablet:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/></svg>'
};
const fileExt = (n) => { const m = /\.([a-z0-9]+)$/i.exec(n || ""); return m ? m[1].slice(0, 4) : "?"; };

function renderAll() { renderNetPill(); renderDevices(); renderTargets(); renderSelected(); renderTransfers(); renderHistory(); renderIncidents(); renderSettings(); }

function renderNetPill() {
  const pill = $("#netPill"), label = $("#netLabel");
  if (state.network) { pill.classList.add("online"); label.textContent = "Linked · " + state.network.code; $("#leaveBtn").style.display = "block"; }
  else { pill.classList.remove("online"); label.textContent = "Not linked"; $("#leaveBtn").style.display = "none"; }
}

function renderDevices() {
  const list = $("#devicesList"); list.innerHTML = "";
  $("#devCount").textContent = "(" + countActive() + "/" + MAX_DEVICES + ")";
  if (!state.network) { list.appendChild(emptyState("link", "Not linked yet", "Create or enter a pairing code to start a network.")); return; }
  const devs = [...state.devices.values()]
    .sort((a, b) => (b.me ? 1 : 0) - (a.me ? 1 : 0) || (b.online ? 1 : 0) - (a.online ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  for (const d of devs) {
    const off = !d.me && !d.online;
    const row = el("div", "device" + (d.me ? " me" : "") + (d.banned ? " banned" : "") + (off ? " offline" : ""));
    const status = d.banned ? "⛔ Quarantined" : d.me ? "This device" : d.online ? "Online" : "Offline · still linked";
    row.innerHTML =
      '<div class="dv-ic">' + (DEVICE_ICONS[d.type] || DEVICE_ICONS.desktop) + '</div>' +
      '<div class="dv-meta"><div class="dv-name">' + escapeHtml(d.name) + '</div>' +
      '<div class="dv-sub">' + status + " · " + d.type + '</div></div>';
    list.appendChild(row);
  }
}

function renderTargets() {
  const sel = $("#targetSelect"); const prev = sel.value;
  sel.innerHTML = "";
  const others = [...state.devices.values()].filter((d) => !d.me && !d.banned && d.online);
  if (others.length > 1) { const o = el("option"); o.value = "*"; o.textContent = "All devices (" + others.length + ")"; sel.appendChild(o); }
  for (const d of others) { const o = el("option"); o.value = d.id; o.textContent = d.name; sel.appendChild(o); }
  if (!others.length) {
    const anyLinked = [...state.devices.values()].some((d) => !d.me);
    const o = el("option"); o.value = ""; o.textContent = anyLinked ? "No devices online" : "No devices linked";
    sel.appendChild(o);
  }
  if (prev) sel.value = prev;
}

function renderSelected() {
  const list = $("#selectedList"); list.innerHTML = "";
  $("#sendRow").style.display = state.selected.length ? "flex" : "none";
  state.selected.forEach((f, i) => {
    const row = el("div", "file-row");
    row.innerHTML =
      '<div class="file-ic">' + escapeHtml(fileExt(f.name)) + '</div>' +
      '<div class="file-meta"><div class="file-name">' + escapeHtml(f.name) + '</div>' +
      '<div class="file-sub">' + fmtBytes(f.size) + '</div></div>';
    const x = el("button", "x-btn", "✕"); x.title = "Remove";
    x.onclick = () => { state.selected.splice(i, 1); renderSelected(); };
    row.appendChild(x); list.appendChild(row);
  });
}

function renderTransfers() {
  const list = $("#transfersList");
  if (!state.transfers.size && !state.outbox.length) { list.innerHTML = ""; list.appendChild(emptyState("list", "No active transfers", "Sent and received files will appear here while in flight.")); return; }
  list.innerHTML = "";
  for (const q of state.outbox) {
    const row = el("div", "transfer queued");
    row.innerHTML =
      '<div class="t-head"><span class="badge dir-sent">⏸ Queued</span><span class="t-name">' + escapeHtml(q.file.name) + '</span></div>' +
      '<div class="t-sub"><span>Waiting for a device to come online (kept until this app closes)</span><span>' + fmtBytes(q.file.size) + '</span></div>';
    const x = el("button", "x-btn", "✕"); x.title = "Remove from queue"; x.setAttribute("aria-label", "Remove " + q.file.name + " from queue");
    x.onclick = () => { state.outbox = state.outbox.filter((o) => o.id !== q.id); renderTransfers(); };
    row.querySelector(".t-head").appendChild(x);
    list.appendChild(row);
  }
  for (const t of state.transfers.values()) {
    const dirBadge = t.dir === "sent" ? '<span class="badge dir-sent">↑ Sending</span>' : '<span class="badge dir-recv">↓ Receiving</span>';
    const statusTxt = t.status === "done" ? "Complete" : t.status === "blocked" ? "Blocked" : t.status === "declined" ? "Declined" : t.status === "error" ? "Failed" : (t.dir === "sent" ? "to " : "from ") + escapeHtml(t.peer);
    const node = el("div", "transfer");
    node.dataset.tid = t.id;
    node.innerHTML =
      '<div class="t-head">' + dirBadge + '<span class="t-name">' + escapeHtml(t.name) + '</span><span class="t-pct">' + (t.status === "blocked" ? "⛔" : t.progress + "%") + '</span></div>' +
      '<div class="bar"><i style="width:' + (t.status === "blocked" ? 100 : t.progress) + '%;' + (t.status === "blocked" ? "background:var(--danger)" : "") + '"></i></div>' +
      '<div class="t-sub"><span>' + statusTxt + '</span><span>' + fmtBytes(t.size) + '</span></div>';
    list.appendChild(node);
  }
}

/* In-flight progress updates fire once per 16 KB chunk. Rebuilding the whole
   list each time is thousands of DOM rebuilds for a large file, so coalesce
   per-frame and patch only the affected row's bar + percentage in place.
   Structural changes (add/remove/status) still call renderTransfers(). */
let _progressRaf = 0;
const _dirtyTransfers = new Set();
function queueProgress(tid) {
  _dirtyTransfers.add(tid);
  if (_progressRaf) return;
  _progressRaf = requestAnimationFrame(flushProgress);
}
function flushProgress() {
  _progressRaf = 0;
  const list = $("#transfersList");
  let needFull = false;
  for (const tid of _dirtyTransfers) {
    const t = state.transfers.get(tid);
    if (!t) continue;
    const row = list.querySelector('.transfer[data-tid="' + CSS.escape(tid) + '"]');
    if (!row) { needFull = true; continue; }   // row not built yet — fall back to a full render once
    const bar = row.querySelector(".bar > i");
    if (bar) bar.style.width = (t.status === "blocked" ? 100 : t.progress) + "%";
    const pctEl = row.querySelector(".t-pct");
    if (pctEl) pctEl.textContent = t.status === "blocked" ? "⛔" : t.progress + "%";
    // mirror progress into the floating download box, if it exists
    const box = document.querySelector('.dlbox[data-tid="' + CSS.escape(tid) + '"]');
    if (box) {
      const bbar = box.querySelector(".bar > i");
      if (bbar) bbar.style.width = t.progress + "%";
      const bpct = box.querySelector(".dl-pct");
      if (bpct) bpct.textContent = t.progress + "%";
    }
  }
  _dirtyTransfers.clear();
  if (needFull) renderTransfers();
}

function buildHistRow(h) {
  const row = el("div", "hist-row");
  const dir = h.dir === "sent" ? '<span class="badge dir-sent">↑ Sent</span>' : '<span class="badge dir-recv">↓ Received</span>';
  const scan = h.scan === "clean" ? '<span class="badge scan">🛡 Clean</span>' : h.scan === "unscanned" ? '<span class="badge">Unscanned</span>' : "";
  row.innerHTML =
    '<div class="file-ic">' + escapeHtml(fileExt(h.name)) + '</div>' +
    '<div class="hist-meta"><div class="hist-name">' + escapeHtml(h.name) + '</div>' +
    '<div class="hist-sub">' + dir + scan + '<span>' + fmtBytes(h.size) + '</span><span>·</span><span>' + (h.dir === "sent" ? "to " : "from ") + escapeHtml(h.peer) + '</span><span>·</span><span>' + fmtTime(h.ts) + '</span></div></div>';
  if (h.blobB64) {
    const v = el("button", "btn ghost sm", "View"); v.onclick = () => previewHistory(h.id); row.appendChild(v);
    const b = el("button", "btn ghost sm", "Download"); b.onclick = () => downloadHistory(h.id); row.appendChild(b);
  }
  return row;
}

const DAY_MS = 24 * 3600 * 1000;
const RECENT_MAX = 8;   // newest-first cap for the main-panel list

function renderHistory() {
  $("#dlCountLabel").textContent = state.settings.downloadableCopies;
  const now = Date.now();
  const recent = state.history.filter((h) => now - h.ts < DAY_MS);
  // History tab gets everything older than 24h, plus recent overflow past the cap
  const older = state.history.filter((h) => now - h.ts >= DAY_MS).concat(recent.slice(RECENT_MAX));

  const recentList = $("#recentList"); recentList.innerHTML = "";
  if (!recent.length) recentList.appendChild(el("div", "notice", "Nothing transferred in the past 24 hours."));
  else for (const h of recent.slice(0, RECENT_MAX)) recentList.appendChild(buildHistRow(h));

  const list = $("#historyList"); list.innerHTML = "";
  if (!older.length) { list.appendChild(emptyState("clock", "No older history", "Transfers older than 24 hours move here from the main panel.")); return; }
  for (const h of older) list.appendChild(buildHistRow(h));
}

function renderIncidents() {
  const list = $("#incidentsList");
  const dot = $('.tab[data-tab="incidents"] .tabdot');
  list.innerHTML = "";
  if (!state.incidents.length) { list.appendChild(emptyState("shield", "No incidents", "Blocked transfers and quarantines will be logged here.")); if (dot) dot.remove(); return; }
  const tabBtn = $('.tab[data-tab="incidents"]');
  if (!dot && tabBtn) tabBtn.appendChild(el("span", "tabdot"));
  for (const inc of state.incidents) {
    const node = el("div", "incident");
    node.innerHTML =
      '<div class="i-name"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>' + escapeHtml(inc.name) + '</div>' +
      '<ul>' + inc.reasons.map((r) => "<li>" + escapeHtml(r) + "</li>").join("") + '</ul>' +
      '<div class="i-sub">Device: ' + escapeHtml(inc.peer) + ' · quarantined · ' + fmtTime(inc.ts) + '</div>';
    list.appendChild(node);
  }
}

function renderSettings() {
  $("#deviceName").value = state.device.name;
  $("#recentRange").value = state.settings.recentInMemory; $("#recentVal").textContent = state.settings.recentInMemory;
  $("#dlRange").value = state.settings.downloadableCopies; $("#dlVal").textContent = state.settings.downloadableCopies;
  $("#scanToggle").checked = state.settings.scanning;
  $("#autoToggle").checked = state.settings.autoAccept;
  $("#soundToggle").checked = state.settings.sound;
  $("#notifToggle").checked = state.settings.notifications;
  $("#curVersion").textContent = "v" + APP_VERSION;
}

function emptyState(icon, title, sub) {
  const icons = {
    link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><path d="M8 12h8"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    shield: '<path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4z"/>'
  };
  const e = el("div", "empty", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (icons[icon] || "") + '</svg><div style="font-weight:600;color:var(--text)">' + title + '</div><div style="font-size:13px;margin-top:2px">' + sub + '</div>');
  return e;
}

/* ====================================================================
   SYNCED CLIPBOARD
   --------------------------------------------------------------------
   A "clip" broadcast carries the shared text to every linked device over
   the direct peer connection (DataChannels are DTLS-encrypted; nothing
   goes through the server). Last-writer-wins by timestamp; late joiners
   receive the current clip in response to their "hello".
   ==================================================================== */
let _clipTimer = null;
function setClipLocal(text) {
  state.clip = { text, ts: Date.now(), fromName: state.device.name };
  renderClipView(false);
  clearTimeout(_clipTimer);
  _clipTimer = setTimeout(() => {
    if (state.network) Transport.send({ type: "clip", text: state.clip.text, ts: state.clip.ts, fromName: state.clip.fromName });
  }, 350);  // debounce: one broadcast per pause in typing, not per keystroke
}
function onClip(msg) {
  if (typeof msg.text !== "string") return;
  if (msg.ts && state.clip.ts && msg.ts <= state.clip.ts) return;   // stale update
  state.clip = { text: msg.text, ts: msg.ts || Date.now(), fromName: msg.fromName || "" };
  const inp = $("#clipInput");
  if (document.activeElement !== inp) inp.value = state.clip.text;  // don't fight active typing
  renderClipView(true);
}
function renderClipView(remote) {
  const view = $("#clipView");
  if (!state.clip.text) { view.hidden = true; view.innerHTML = ""; return; }
  const meta = remote && state.clip.fromName
    ? '<span class="clip-meta">from ' + escapeHtml(state.clip.fromName) + " · " + fmtTime(state.clip.ts) + "</span>"
    : "";
  view.innerHTML = meta + linkify(state.clip.text);
  view.hidden = false;
}
function openLink(url) {
  if (detectShell() === "tauri") { tauriInvoke("open_external", { url }); return; }
  window.open(url, "_blank", "noopener");
}

/* ====================================================================
   CROSS-DEVICE NOTIFICATIONS
   --------------------------------------------------------------------
   A "notify" broadcast arrives on every paired device except the sender.
   We always surface an in-app toast; if the user enabled notifications,
   permission is granted, and the app isn't already in the foreground, we
   also raise an OS/web notification whose click focuses the app on the file.
   (Delivery to fully-closed devices via FCM/web-push/APNs is a later phase;
   this path covers devices currently running or in the tray helper.)
   ==================================================================== */
function onNotify(msg) {
  toast("info", "Incoming file", '"' + msg.name + '" from ' + (msg.fromName || "a linked device"));
  showOsNotification(msg.name, msg.fromName);
}
function showOsNotification(name, fromName) {
  if (!state.settings.notifications) return;
  if (document.visibilityState === "visible" && document.hasFocus()) return; // don't double-notify a focused app
  const body = '"' + name + '" from ' + (fromName || "a linked device");

  // Android (Capacitor): the WebView has no Notification API — use the native
  // Local Notifications plugin (exposed on the global Capacitor bridge).
  if (detectShell() === "capacitor") {
    const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
    if (LN) LN.schedule({ notifications: [{ id: Date.now() % 2147483000, title: "Streamlined — incoming file", body }] }).catch(() => {});
    return;
  }

  // Web / PWA: standard Notification API (works while a page/SW is alive).
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification("Streamlined — incoming file", { body, icon: "pwa-192.png", tag: "sl-incoming" });
    n.onclick = () => { window.focus(); setActiveTab("history"); n.close(); };
  } catch (e) { console.warn("notification failed", e); }
}

// Ask for notification permission via the right mechanism for the shell.
async function requestNotifyPermission() {
  if (detectShell() === "capacitor") {
    const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
    if (!LN) return false;
    try { const r = await LN.requestPermissions(); return r && r.display === "granted"; } catch { return false; }
  }
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission !== "default") return false;
  try { return (await Notification.requestPermission()) === "granted"; } catch { return false; }
}
let _askedNotif = false;
async function maybeRequestNotifyPermission() {
  if (_askedNotif || !state.settings.notifications) return;
  _askedNotif = true;
  const granted = await requestNotifyPermission();
  if (granted) { subscribePush(); registerFcm(); }   // web-push (PWA) / FCM (Android APK); each guards its own shell
}

/* ---- Web Push (PWA closed-app notifications) ----
   Register a push subscription with the room's Durable Object. The Worker
   wakes us with a payloadless push; the service worker fetches the filename.
   Tauri uses its background helper instead; Android native uses FCM (later). */
function urlB64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function subscribePush() {
  if (detectShell() !== "web") return;                       // PWA-only path
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (!state.network) return;                                // need a room to key the subscription
  if (typeof Notification !== "undefined" && Notification.permission !== "granted") return;
  const httpBase = CONFIG.signalingUrl.replace(/^ws/, "http").replace(/\/+$/, "");
  if (!httpBase) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC) });
    await fetch(httpBase + "/subscribe?room=" + encodeURIComponent(state.network.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: state.device.id, subscription: sub })
    });
    // tell the SW its room + worker base so the push handler can fetch the filename
    if (reg.active) reg.active.postMessage({ type: "sl-room", room: state.network.id, base: httpBase });
  } catch (e) { console.warn("push subscribe failed", e); }
}
async function unsubscribePush() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* ignore */ }
}

/* ---- FCM (native Android closed-app push) ----
   Register for FCM, then hand the device token to the room's DO so the Worker
   can wake a fully-killed APK. No-op until google-services.json is bundled and
   the Worker has FCM_SERVICE_ACCOUNT set. Android PWA users use Web Push above. */
async function registerFcm() {
  if (detectShell() !== "capacitor") return;
  if (!state.network) return;
  const PN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
  if (!PN) return;
  try {
    const perm = await PN.requestPermissions();
    if (perm && perm.receive !== "granted") return;
    if (!window.__slFcmWired) {
      window.__slFcmWired = true;
      PN.addListener("registration", (t) => { window.__slFcmToken = t && t.value; sendFcmToken(); });
      PN.addListener("pushNotificationReceived", (n) => {
        const t = (n && (n.title || (n.notification && n.notification.title))) || "Incoming file";
        const b = (n && (n.body || (n.notification && n.notification.body))) || "";
        toast("info", t, b);   // foreground; FCM auto-shows when backgrounded/killed
      });
    }
    if (window.__slFcmToken) sendFcmToken();   // re-register an existing token for this room
    await PN.register();
  } catch (e) { console.warn("fcm register failed", e); }
}
function sendFcmToken() {
  if (!window.__slFcmToken || !state.network) return;
  const httpBase = CONFIG.signalingUrl.replace(/^ws/, "http").replace(/\/+$/, "");
  if (!httpBase) return;
  fetch(httpBase + "/fcm-register?room=" + encodeURIComponent(state.network.id), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: state.device.id, token: window.__slFcmToken })
  }).catch(() => {});
}

/* ====================================================================
   IN-APP UPDATES + ROLLBACK
   --------------------------------------------------------------------
   Detection + UI are platform-agnostic (compare APP_VERSION to the latest
   GitHub tag). Applying the update is shell-specific: the web/PWA reloads to
   pull fresh assets; native shells (Tauri/Capacitor) get silent in-place
   install + true rollback in later phases — here they open the signed asset.
   ==================================================================== */
function detectShell() {
  if (typeof window === "undefined") return "web";
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) return "tauri";
  if (window.Capacitor) return "capacitor";
  return "web";
}
// Call a Rust command (no-op outside the Tauri shell). withGlobalTauri exposes invoke here.
function tauriInvoke(cmd, args) {
  try {
    const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    return inv ? inv(cmd, args) : Promise.resolve(undefined);
  } catch { return Promise.resolve(undefined); }
}
function semverGt(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if (pa[i] > pb[i]) return true; if (pa[i] < pb[i]) return false; }
  return false;
}
async function checkForUpdates(manual) {
  const statusEl = $("#updateStatus"), actions = $("#updateActions"), applyBtn = $("#applyUpdateBtn");
  if (statusEl) statusEl.textContent = "Checking for updates…";
  try {
    const r = await fetch(UPDATE_CONFIG.releasesApi + "/latest", {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const rel = await r.json();
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    state.update = { latest, url: rel.html_url, notes: rel.body || "" };
    if (latest && semverGt(latest, APP_VERSION)) {
      if (statusEl) statusEl.innerHTML = "Version <strong>v" + escapeHtml(latest) + "</strong> is available (you have v" + escapeHtml(APP_VERSION) + ").";
      if (actions) actions.style.display = "flex";
      if (applyBtn) applyBtn.style.display = "inline-flex";
      if (manual) toast("good", "Update available", "Version v" + latest + " is ready to install.");
    } else {
      if (statusEl) statusEl.textContent = "You're up to date (v" + APP_VERSION + ").";
      if (applyBtn) applyBtn.style.display = "none";
      if (manual) toast("good", "Up to date", "You're on the latest version.");
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = manual ? "Couldn't reach the update server — check your connection." : "Update check unavailable.";
  }
  updateRollbackUI();
}
function applyUpdate() {
  if (!state.update || !state.update.latest) return;
  rememberPriorVersion(APP_VERSION);             // so we can offer rollback afterwards
  const shell = detectShell();
  if (shell === "web") {
    toast("info", "Updating", "Reloading to the latest version…");
    setTimeout(() => location.reload(), 600);    // SW (prod) fetches fresh assets
    return;
  }
  if (shell === "tauri") {
    toast("info", "Updating", "Downloading and installing the latest version… the app will relaunch.");
    tauriInvoke("run_update").catch((e) => toast("danger", "Update failed", String(e)));
    return;
  }
  // Other native shells (Android): open the signed installer for the new release.
  window.open(state.update.url || ("https://github.com/" + UPDATE_CONFIG.repo + "/releases/latest"), "_blank");
}
function rememberPriorVersion(v) { try { localStorage.setItem("sl:prevVersion", v); } catch {} }
function getPriorVersion() { try { return localStorage.getItem("sl:prevVersion"); } catch { return null; } }
function updateRollbackUI() {
  const btn = $("#rollbackBtn"), actions = $("#updateActions");
  if (!btn) return;
  btn.textContent = "Roll Back";
  btn.style.display = "inline-flex";
  if (actions) actions.style.display = "flex";
}
// "Roll Back" opens a picker listing every prior release; choosing one opens
// that build's signed installer page.
async function openRollbackList() {
  const list = $("#rollbackList");
  list.innerHTML = "";
  list.appendChild(el("div", "notice", "Loading earlier versions…"));
  openModal($("#rollbackScrim"));
  try {
    const r = await fetch(UPDATE_CONFIG.releasesApi + "?per_page=15", {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const rels = (await r.json())
      .filter((rel) => !rel.draft && !rel.prerelease)
      .filter((rel) => semverGt(APP_VERSION, String(rel.tag_name || "").replace(/^v/, "")));
    list.innerHTML = "";
    if (!rels.length) { list.appendChild(el("div", "notice", "No earlier versions are available to roll back to.")); return; }
    for (const rel of rels) {
      const row = el("div", "rb-row");
      const meta = el("div", "rb-meta");
      meta.innerHTML = '<div class="rb-ver">' + escapeHtml(rel.tag_name) + '</div>' +
        '<div class="rb-date">' + new Date(rel.published_at || rel.created_at).toLocaleDateString() + '</div>';
      const btn = el("button", "btn ghost sm", "Get this version");
      btn.onclick = () => { openLink(rel.html_url); closeModal($("#rollbackScrim")); };
      row.appendChild(meta); row.appendChild(btn);
      list.appendChild(row);
    }
  } catch {
    list.innerHTML = "";
    list.appendChild(el("div", "notice", "Couldn't load the release list — check your connection and try again."));
  }
}

/* ====================================================================
   UI WIRING
   ==================================================================== */
/* ---- accessible modals: move focus in on open, restore on close,
        Escape to dismiss, and trap Tab within the dialog ---- */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let lastFocused = null;
function modalFocusables(scrim) { return $$(FOCUSABLE, scrim).filter((n) => n.offsetParent !== null); }
function openModal(scrim) {
  lastFocused = document.activeElement;
  scrim.classList.add("open");
  const f = modalFocusables(scrim);
  (f[0] || scrim).focus();
}
function closeModal(scrim) {
  scrim.classList.remove("open");
  if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  lastFocused = null;
}
function handleModalKeydown(e) {
  const scrim = $(".scrim.open");
  if (!scrim) return;
  if (e.key === "Escape") {
    e.preventDefault();
    if (scrim.id === "incomingScrim") { if (currentOffer) { declineOffer(currentOffer); state.pendingOffers.delete(currentOffer.tid); } closeIncoming(); }
    else if (scrim.id === "renameScrim") settleRename(null);      // Escape = keep the default name
    else if (scrim.id === "previewScrim") closePreview();         // revokes the object URL
    else closeModal(scrim);
    return;
  }
  if (e.key === "Tab") {
    const f = modalFocusables(scrim);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

function setActiveTab(name, focusTab = false) {
  $$(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;                 // roving tabindex: only the active tab is tab-reachable
    if (on && focusTab) t.focus();
  });
  $$(".tabpane").forEach((p) => p.classList.toggle("hide", p.dataset.pane !== name));
}

function toast(kind, title, msg, actions) {
  const t = el("div", "toast " + (kind || ""));
  const icons = { good: '<path d="M20 6 9 17l-5-5"/>', danger: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', warn: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>' };
  t.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (icons[kind] || icons.info) + '</svg><div class="t-body"><div class="t-title">' + escapeHtml(title) + '</div><div class="t-msg">' + escapeHtml(msg) + '</div></div>';
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 4200);
}

let audioCtx = null;
function chime() {
  if (!state.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; o.type = "sine";
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3);
    o.start(); o.stop(audioCtx.currentTime + 0.3);
  } catch { /* no-op */ }
}

/* ---- incoming prompt ---- */
let currentOffer = null;
function showIncomingPrompt(meta) {
  currentOffer = meta;
  $("#incTitle").textContent = "Incoming file";
  $("#incSub").textContent = '"' + meta.name + '" (' + fmtBytes(meta.size) + ") from " + deviceName(meta.from);
  openModal($("#incomingScrim"));
}
function closeIncoming() { closeModal($("#incomingScrim")); currentOffer = null; }

/* ---- theme ---- */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  state.settings.theme = theme; saveSettings();
  $("#themeIcon").innerHTML = theme === "dark"
    ? '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
}

/* ---- file selection ---- */
let _renameResolve = null;
function promptRename(file) {
  return new Promise((resolve) => {
    _renameResolve = resolve;   // resolves with a new name, or null to keep
    $("#renameSub").textContent = '"' + file.name + '" looks like a default name. Give it a clearer one? (optional)';
    $("#renameInput").value = file.name;
    openModal($("#renameScrim"));
    $("#renameInput").select();
  });
}
function settleRename(value) {
  closeModal($("#renameScrim"));
  const r = _renameResolve; _renameResolve = null;
  if (r) r(value);
}
function withName(f, name) { return new File([f], name, { type: f.type, lastModified: f.lastModified }); }

async function addFiles(fileList) {
  const incoming = [...fileList];
  const taken = new Set(state.selected.map((f) => f.name));
  for (let f of incoming) {
    // generic default name (image.jpg, IMG_1234, …) → offer an optional rename
    if (isGenericName(f.name)) {
      const newName = await promptRename(f);
      if (newName && newName.trim() && newName.trim() !== f.name) {
        let n = newName.trim();
        if (!/\./.test(n) && f.name.includes(".")) n += f.name.slice(f.name.lastIndexOf("."));   // keep the extension
        f = withName(f, n);
      }
    }
    // duplicates that kept the same name get numbered: image.jpg, image1.jpg, image2.jpg…
    const finalName = numberedName(f.name, taken);
    if (finalName !== f.name) f = withName(f, finalName);
    taken.add(f.name);
    state.selected.push(f);
    renderSelected();
  }
  if (!state.network) toast("info", "Link a device first", "Create or enter a pairing code to choose a destination.");
}

/* ====================================================================
   INIT
   ==================================================================== */
function init() {
  loadLocal();
  // first visit (theme === null) follows the OS preference; once toggled it sticks
  const sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(state.settings.theme || (sysDark ? "dark" : "light"));
  if (!Crypto.ok) $("#cryptoWarn").classList.add("show");

  // logo: use logo.png if it loads, else keep the SVG mark
  const img = new Image();
  img.onload = () => { const box = $("#brandLogo"); box.innerHTML = ""; box.classList.add("has-img"); box.appendChild(img); img.alt = "Streamlined"; };
  img.src = "logo.png";
  // favicon set at runtime (public/logo.png is copied to the web root verbatim by Vite)
  const fav = document.createElement("link"); fav.rel = "icon"; fav.type = "image/png"; fav.href = "logo.png"; document.head.appendChild(fav);

  // PWA: manifest + iOS install metadata, and register the service worker.
  // Web-only; these are no-ops/harmless inside the native (Capacitor/Tauri) shells.
  const manifestLink = document.createElement("link"); manifestLink.rel = "manifest"; manifestLink.href = "manifest.webmanifest"; document.head.appendChild(manifestLink);
  const touchIcon = document.createElement("link"); touchIcon.rel = "apple-touch-icon"; touchIcon.href = "pwa-192.png"; document.head.appendChild(touchIcon);
  const iosCapable = document.createElement("meta"); iosCapable.name = "apple-mobile-web-app-capable"; iosCapable.content = "yes"; document.head.appendChild(iosCapable);
  const iosTitle = document.createElement("meta"); iosTitle.name = "apple-mobile-web-app-title"; iosTitle.content = "Streamlined"; document.head.appendChild(iosTitle);
  // Register the SW only in production builds. In dev a network-first SW just
  // causes stale-cache surprises, and sw.js isn't served from the source tree.
  const isProd = typeof import.meta !== "undefined" && import.meta.env && import.meta.env.PROD;
  if (isProd && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW register failed", e));

  // tabs — click to select, arrow/Home/End for roving keyboard nav (ARIA tablist pattern)
  const tabEls = $$(".tab");
  tabEls.forEach((t) => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));
  $(".tabs").addEventListener("keydown", (e) => {
    const i = tabEls.indexOf(document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % tabEls.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + tabEls.length) % tabEls.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = tabEls.length - 1;
    else return;
    e.preventDefault();
    setActiveTab(tabEls[j].dataset.tab, true);
  });

  // dialog keyboard handling (Escape + focus trap) for any open modal
  document.addEventListener("keydown", handleModalKeydown);

  // theme
  $("#themeBtn").addEventListener("click", () => applyTheme(state.settings.theme === "dark" ? "light" : "dark"));

  // dropzone
  const dz = $("#dropzone"), fi = $("#fileInput");
  dz.addEventListener("click", () => fi.click());
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } });
  fi.addEventListener("change", () => { addFiles(fi.files); fi.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

  // send / clear
  $("#sendBtn").addEventListener("click", sendSelected);
  $("#clearSelBtn").addEventListener("click", () => { state.selected = []; renderSelected(); });

  // link modal
  const scrim = $("#linkScrim");
  $("#linkBtn").addEventListener("click", openLinkModal);
  $("#modalClose").addEventListener("click", () => closeModal(scrim));
  scrim.addEventListener("click", (e) => { if (e.target === scrim) closeModal(scrim); });
  $("#segCreate").addEventListener("click", () => { setSeg("create"); createFreshCode(); });
  $("#segJoin").addEventListener("click", () => setSeg("join"));
  $("#copyCodeBtn").addEventListener("click", () => { if (state.network) { navigator.clipboard?.writeText(state.network.code); toast("good", "Copied", "Pairing code copied to clipboard."); } });
  $("#joinBtn").addEventListener("click", doJoin);
  $("#joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
  $("#leaveBtn").addEventListener("click", leaveNetwork);

  // incoming prompt
  $("#incAccept").addEventListener("click", () => { if (currentOffer) { acceptOffer(currentOffer); state.pendingOffers.delete(currentOffer.tid); } closeIncoming(); });
  $("#incDecline").addEventListener("click", () => { if (currentOffer) { declineOffer(currentOffer); state.pendingOffers.delete(currentOffer.tid); } closeIncoming(); });

  // settings
  $("#deviceName").addEventListener("change", (e) => { state.device.name = e.target.value.trim() || defaultDeviceName(); saveDevice(); if (state.network) Transport.send({ type: "ping", device: state.device }); renderDevices(); });
  $("#recentRange").addEventListener("input", (e) => { state.settings.recentInMemory = +e.target.value; $("#recentVal").textContent = e.target.value; saveSettings(); pruneHistory(); renderHistory(); });
  $("#dlRange").addEventListener("input", (e) => { state.settings.downloadableCopies = +e.target.value; $("#dlVal").textContent = e.target.value; saveSettings(); pruneHistory(); renderHistory(); });
  $("#scanToggle").addEventListener("change", (e) => { state.settings.scanning = e.target.checked; saveSettings(); if (!e.target.checked) toast("warn", "Scanning disabled", "Outgoing files will not be checked. Not recommended."); });
  $("#autoToggle").addEventListener("change", (e) => { state.settings.autoAccept = e.target.checked; saveSettings(); });
  $("#soundToggle").addEventListener("change", (e) => { state.settings.sound = e.target.checked; saveSettings(); });
  $("#notifToggle").addEventListener("change", async (e) => {
    state.settings.notifications = e.target.checked; saveSettings();
    if (e.target.checked) {
      const granted = await requestNotifyPermission();
      if (granted) { subscribePush(); registerFcm(); }
      else toast("warn", "Notifications blocked", "Allow notifications in your browser or OS settings to receive file alerts.");
    } else {
      unsubscribePush();
    }
  });
  $("#clearHistBtn").addEventListener("click", () => { state.history = []; saveHistory(); renderHistory(); toast("good", "History cleared", "Local transfer history removed."); });

  // updates panel
  $("#checkUpdateBtn").addEventListener("click", () => checkForUpdates(true));
  $("#applyUpdateBtn").addEventListener("click", applyUpdate);
  $("#rollbackBtn").addEventListener("click", openRollbackList);
  $("#rollbackClose").addEventListener("click", () => closeModal($("#rollbackScrim")));

  // file preview + rename prompts
  $("#previewClose").addEventListener("click", closePreview);
  $("#renameKeep").addEventListener("click", () => settleRename(null));
  $("#renameApply").addEventListener("click", () => settleRename($("#renameInput").value));
  $("#renameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") settleRename(e.target.value); });

  // synced clipboard
  $("#clipInput").addEventListener("input", (e) => setClipLocal(e.target.value));
  $("#clipClearBtn").addEventListener("click", () => { $("#clipInput").value = ""; setClipLocal(""); });
  $("#clipView").addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    openLink(a.href);   // shell-aware: system browser on desktop, new tab elsewhere
  });

  // desktop: startup-launch setting + one-time first-run prompt
  if (detectShell() === "tauri") {
    $("#startupSetting").style.display = "flex";
    tauriInvoke("get_autostart").then((on) => { if (typeof on === "boolean") $("#startupToggle").checked = on; }).catch(() => {});
    $("#startupToggle").addEventListener("change", async (e) => {
      const on = e.target.checked;
      try {
        await tauriInvoke("set_autostart", { enable: on });
        toast("good", on ? "Startup enabled" : "Startup disabled", on ? "Streamlined will open quietly in the tray when you sign in." : "Streamlined will no longer launch automatically.");
      } catch (err) { e.target.checked = !on; toast("danger", "Couldn't update startup setting", String(err)); }
    });
    $("#startupYes").addEventListener("click", async () => {
      try { await tauriInvoke("set_autostart", { enable: true }); $("#startupToggle").checked = true; toast("good", "Startup enabled", "Streamlined will open quietly in the tray when you sign in."); }
      catch (err) { toast("danger", "Couldn't enable startup", String(err)); }
      closeModal($("#startupScrim"));
    });
    $("#startupNo").addEventListener("click", () => closeModal($("#startupScrim")));
    if (!localStorage.getItem("sl:askedAutostart")) {
      localStorage.setItem("sl:askedAutostart", "1");
      setTimeout(() => openModal($("#startupScrim")), 800);
    }
  }

  renderAll();
  checkForUpdates(false);   // silent check on launch

  // Desktop: after the window is recreated from the tray, the webview reloads
  // fresh — rejoin the network the background helper is still holding.
  // Everywhere: fall back to the last-used pairing code so a relaunched app
  // (including an autostart boot) re-links without user action.
  const rejoinLast = () => {
    if (state.network) return;
    let last = null;
    try { last = localStorage.getItem("sl:lastCode"); } catch { /* ignore */ }
    if (last) startNetwork(last);
  };
  if (detectShell() === "tauri") {
    tauriInvoke("get_active_room")
      .then((r) => { if (r && r.code && !state.network) startNetwork(r.code); else rejoinLast(); })
      .catch(rejoinLast);
  } else {
    rejoinLast();
  }
}

function openLinkModal() {
  // set the pane BEFORE opening so focus lands on a visible control
  setSeg("create");
  if (state.network) showCode(state.network.code);
  else createFreshCode();
  openModal($("#linkScrim"));
}
function setSeg(which) {
  $("#segCreate").classList.toggle("active", which === "create");
  $("#segJoin").classList.toggle("active", which === "join");
  $("#createPane").classList.toggle("hide", which !== "create");
  $("#joinPane").classList.toggle("hide", which === "create");
}
let creatingNetwork = false;
async function createFreshCode() {
  if (state.network) { showCode(state.network.code); return; }
  if (creatingNetwork) return;            // guard against the async double-create race
  creatingNetwork = true;
  const code = randomCode();
  showCode(code);
  const ok = await startNetwork(code);
  creatingNetwork = false;
  if (ok) { toast("good", "Network created", "Share the code or QR with up to 5 more devices."); maybeRequestNotifyPermission(); }
}
function showCode(code) {
  $("#codeDisplay").textContent = code;
  // Always dark-on-white so the QR stays scannable in either theme.
  try { QR.render($("#qrCanvas"), "https://streamlined.app/j/" + code, { scale: 5, dark: "#0f1729", light: "#ffffff" }); }
  catch (e) { console.warn("QR render failed", e); }
}
async function doJoin() {
  const code = $("#joinCode").value.trim().toUpperCase();
  if (code.length !== 6) { toast("warn", "Invalid code", "Pairing codes are 6 characters."); return; }
  if (state.network && state.network.code === code) { toast("info", "Already linked", "This device is already on that network."); closeModal($("#linkScrim")); return; }
  const ok = await startNetwork(code);
  if (ok) {
    closeModal($("#linkScrim"));
    maybeRequestNotifyPermission();
    toast("good", "Linked", "Joined network " + code + ".");
    setTimeout(() => { if (countActive() > MAX_DEVICES) toast("warn", "Network full", "This network already has 6 devices."); }, 600);
  }
}

/* ---- boot (module scripts run after parse; handle both states) ---- */
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
