/* ====================================================================
   state.js — shared mutable app state + constants
   Kept in its own module so feature modules can import it without
   creating circular dependencies with app.js.
   ==================================================================== */
export const MAX_DEVICES = 6;
// 32 KB plaintext -> ~44 KB once AES-GCM tagged, base64'd and wrapped in JSON,
// which still sits under the 64 KiB DataChannel message limit every browser
// supports. Halving the message count roughly doubles throughput; the receiver
// derives sizes from the payload, so senders and receivers can differ safely.
export const CHUNK = 32 * 1024;

export const state = {
  device: null,                 // { id, name, type }
  network: null,                // { code, id, key }
  channel: null,                // transport handle
  devices: new Map(),           // id -> { id, name, type, lastSeen, banned }
  selected: [],                 // File[]
  outbox: [],                   // [{ id, file, ts }] queued sends awaiting an online device
  transfers: new Map(),         // id -> transfer record
  incoming: new Map(),          // id -> { meta, chunks:[], received }
  pendingOffers: new Map(),     // id -> offer (awaiting accept)
  history: [],                  // [{ id, name, size, type, dir, peer, ts, status, scan, blobB64? }]
  incidents: [],                // [{ id, name, ts, reasons, peer, deviceId }]
  update: null,                 // { latest, url, notes } from the last update check
  clip: { text: "", ts: 0, fromName: "" },  // synced clipboard (last-writer-wins by ts)
  // theme: null until the user picks one, so first load can follow the OS preference
  settings: { recentInMemory: 10, downloadableCopies: 3, scanning: true, autoAccept: false, sound: true, notifications: true, autoSave: false, saveFolder: null, shrinkImages: false, trusted: [], theme: null }
};

// Partially-received files, keyed by a stable per-file id so an interrupted
// transfer can resume where it stopped instead of starting over.
state.partials = new Map();   // fid -> { chunks: [{off,bytes}], received }
