/* ====================================================================
   app.js — networking, transfer, history, rendering, and UI wiring.
   --------------------------------------------------------------------
   NOTE: the `Transport` object below still uses BroadcastChannel (links
   tabs of one browser). Phase 1 replaces it with a WebRTC DataChannel +
   signaling transport; the message protocol (hello/offer/chunk/complete)
   is designed to stay the same so the rest of this file is unaffected.
   ==================================================================== */
import { $, $$, el, fmtBytes, fmtTime, uid, escapeHtml, b64ToBytes, blobToB64 } from "./util.js";
import { state, MAX_DEVICES, CHUNK } from "./state.js";
import { QR } from "./qr.js";
import { Crypto } from "./crypto.js";
import { Scanner } from "./scanner.js";
import { createTransport } from "./transport.js";
import { CONFIG, fetchIceServers } from "./config.js";

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
  try {
    const payload = JSON.stringify({ history: state.history, incidents: state.incidents });
    const enc = await Crypto.encrypt(state.network.key, new TextEncoder().encode(payload));
    localStorage.setItem("sl:hist:" + state.network.id, JSON.stringify(enc));
  } catch (e) { console.warn("history save failed", e); }
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
  const d = state.devices.get(peerId);
  if (d && !d.me) { state.devices.delete(peerId); renderDevices(); renderTargets(); }
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
  state.devices.set(state.device.id, { ...state.device, lastSeen: Date.now(), banned: false, me: true });
  presenceTimer = setInterval(heartbeat, 4000);
  renderAll();
  return true;
}
function heartbeat() {
  if (!state.network) return;
  Transport.send({ type: "ping", device: { id: state.device.id, name: state.device.name, type: state.device.type } });
  const now = Date.now();
  let changed = false;
  for (const [id, d] of state.devices) { if (!d.me && now - d.lastSeen > 12000) { state.devices.delete(id); changed = true; } }
  if (changed) { renderDevices(); renderTargets(); }
}
let presenceTimer = null;

function leaveNetwork() {
  if (presenceTimer) clearInterval(presenceTimer);
  Transport.send({ type: "bye", device: { id: state.device.id } });
  Transport.stop();
  state.network = null; state.devices.clear(); state.transfers.clear(); state.incoming.clear();
  state.history = []; state.incidents = [];
  renderAll();
  toast("good", "Left network", "This device is no longer linked.");
}

function registerDevice(d) {
  if (!d || d.id === state.device.id) return;
  const known = state.devices.has(d.id);
  if (!known && countActive() >= MAX_DEVICES) { return; } // network full — ignore
  const prev = state.devices.get(d.id) || {};
  state.devices.set(d.id, { ...prev, ...d, lastSeen: Date.now(), banned: prev.banned || false });
  if (!known) { renderDevices(); renderTargets(); }
}
function countActive() { return state.devices.size; }

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
      break;
    case "welcome":
    case "ping":
      registerDevice(msg.device);
      break;
    case "bye":
      if (msg.device && state.devices.has(msg.device.id) && !state.devices.get(msg.device.id).me) { state.devices.delete(msg.device.id); renderDevices(); renderTargets(); }
      break;
    case "ban":
      markBanned(msg.deviceId);
      break;
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
  if (d) { d.banned = true; }
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
  const targetId = $("#targetSelect").value;
  if (!targetId) { toast("warn", "No destination", "Link and pick a device first."); return; }
  const files = state.selected.slice();
  state.selected = []; renderSelected();
  for (const file of files) await sendOneFile(file, targetId);
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
      renderTransfers();
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
  Transport.send({ type: "accept", _to: meta.from, tid: meta.tid });
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
    if (rec) { rec.progress = Math.round((inc.received / msg.total) * 100); renderTransfers(); }
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
    logIncident(fileForScan, verdict, msg._from);
    Transport.send({ type: "ban", deviceId: msg._from });
    markBanned(msg._from);
    state.incoming.delete(msg.tid);
    setTimeout(() => { state.transfers.delete(msg.tid); renderTransfers(); }, 3500);
    return;
  }

  rec.status = "done"; rec.progress = 100; renderTransfers();
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
  // Cap total entries to recentInMemory.
  if (state.history.length > state.settings.recentInMemory) state.history.length = state.settings.recentInMemory;
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
  for (const d of state.devices.values()) {
    const row = el("div", "device" + (d.me ? " me" : "") + (d.banned ? " banned" : ""));
    row.innerHTML =
      '<div class="dv-ic">' + (DEVICE_ICONS[d.type] || DEVICE_ICONS.desktop) + '</div>' +
      '<div class="dv-meta"><div class="dv-name">' + escapeHtml(d.name) + '</div>' +
      '<div class="dv-sub">' + (d.banned ? "⛔ Quarantined" : d.me ? "This device" : "Online") + " · " + d.type + '</div></div>';
    list.appendChild(row);
  }
}

function renderTargets() {
  const sel = $("#targetSelect"); const prev = sel.value;
  sel.innerHTML = "";
  const others = [...state.devices.values()].filter((d) => !d.me && !d.banned);
  if (others.length > 1) { const o = el("option"); o.value = "*"; o.textContent = "All devices (" + others.length + ")"; sel.appendChild(o); }
  for (const d of others) { const o = el("option"); o.value = d.id; o.textContent = d.name; sel.appendChild(o); }
  if (!others.length) { const o = el("option"); o.value = ""; o.textContent = "No devices linked"; sel.appendChild(o); }
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
  if (!state.transfers.size) { list.innerHTML = ""; list.appendChild(emptyState("list", "No active transfers", "Sent and received files will appear here while in flight.")); return; }
  list.innerHTML = "";
  for (const t of state.transfers.values()) {
    const dirBadge = t.dir === "sent" ? '<span class="badge dir-sent">↑ Sending</span>' : '<span class="badge dir-recv">↓ Receiving</span>';
    const statusTxt = t.status === "done" ? "Complete" : t.status === "blocked" ? "Blocked" : t.status === "declined" ? "Declined" : t.status === "error" ? "Failed" : (t.dir === "sent" ? "to " : "from ") + escapeHtml(t.peer);
    const node = el("div", "transfer");
    node.innerHTML =
      '<div class="t-head">' + dirBadge + '<span class="t-name">' + escapeHtml(t.name) + '</span><span class="t-pct">' + (t.status === "blocked" ? "⛔" : t.progress + "%") + '</span></div>' +
      '<div class="bar"><i style="width:' + (t.status === "blocked" ? 100 : t.progress) + '%;' + (t.status === "blocked" ? "background:var(--danger)" : "") + '"></i></div>' +
      '<div class="t-sub"><span>' + statusTxt + '</span><span>' + fmtBytes(t.size) + '</span></div>';
    list.appendChild(node);
  }
}

function renderHistory() {
  const list = $("#historyList"); list.innerHTML = "";
  $("#dlCountLabel").textContent = state.settings.downloadableCopies;
  if (!state.history.length) { list.appendChild(emptyState("clock", "No history yet", "Completed transfers are logged here, encrypted on this device.")); return; }
  for (const h of state.history) {
    const row = el("div", "hist-row");
    const dir = h.dir === "sent" ? '<span class="badge dir-sent">↑ Sent</span>' : '<span class="badge dir-recv">↓ Received</span>';
    const scan = h.scan === "clean" ? '<span class="badge scan">🛡 Clean</span>' : h.scan === "unscanned" ? '<span class="badge">Unscanned</span>' : "";
    row.innerHTML =
      '<div class="file-ic">' + escapeHtml(fileExt(h.name)) + '</div>' +
      '<div class="hist-meta"><div class="hist-name">' + escapeHtml(h.name) + '</div>' +
      '<div class="hist-sub">' + dir + scan + '<span>' + fmtBytes(h.size) + '</span><span>·</span><span>' + (h.dir === "sent" ? "to " : "from ") + escapeHtml(h.peer) + '</span><span>·</span><span>' + fmtTime(h.ts) + '</span></div></div>';
    if (h.blobB64) { const b = el("button", "btn ghost sm", "Download"); b.onclick = () => downloadHistory(h.id); row.appendChild(b); }
    list.appendChild(row);
  }
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
   UI WIRING
   ==================================================================== */
function setActiveTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
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
  $("#incomingScrim").classList.add("open");
}
function closeIncoming() { $("#incomingScrim").classList.remove("open"); currentOffer = null; }

/* ---- theme ---- */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  state.settings.theme = theme; saveSettings();
  $("#themeIcon").innerHTML = theme === "dark"
    ? '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
}

/* ---- file selection ---- */
function addFiles(fileList) {
  for (const f of fileList) state.selected.push(f);
  renderSelected();
  if (!state.network) toast("info", "Link a device first", "Create or enter a pairing code to choose a destination.");
}

/* ====================================================================
   INIT
   ==================================================================== */
function init() {
  loadLocal();
  applyTheme(state.settings.theme);
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW register failed", e));

  // tabs
  $$(".tab").forEach((t) => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));

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
  $("#modalClose").addEventListener("click", () => scrim.classList.remove("open"));
  scrim.addEventListener("click", (e) => { if (e.target === scrim) scrim.classList.remove("open"); });
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
  $("#clearHistBtn").addEventListener("click", () => { state.history = []; saveHistory(); renderHistory(); toast("good", "History cleared", "Local transfer history removed."); });

  renderAll();
}

function openLinkModal() {
  $("#linkScrim").classList.add("open");
  setSeg("create");
  if (state.network) showCode(state.network.code);
  else createFreshCode();
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
  if (ok) toast("good", "Network created", "Share the code or QR with up to 5 more devices.");
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
  if (state.network && state.network.code === code) { toast("info", "Already linked", "This device is already on that network."); $("#linkScrim").classList.remove("open"); return; }
  const ok = await startNetwork(code);
  if (ok) {
    $("#linkScrim").classList.remove("open");
    toast("good", "Linked", "Joined network " + code + ".");
    setTimeout(() => { if (countActive() > MAX_DEVICES) toast("warn", "Network full", "This network already has 6 devices."); }, 600);
  }
}

/* ---- boot (module scripts run after parse; handle both states) ---- */
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
