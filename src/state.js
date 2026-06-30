/* ====================================================================
   state.js — shared mutable app state + constants
   Kept in its own module so feature modules can import it without
   creating circular dependencies with app.js.
   ==================================================================== */
export const MAX_DEVICES = 6;
// 16 KB plaintext keeps each encrypted+base64 JSON message comfortably
// under the safe WebRTC DataChannel message-size limit.
export const CHUNK = 16 * 1024;

export const state = {
  device: null,                 // { id, name, type }
  network: null,                // { code, id, key }
  channel: null,                // transport handle
  devices: new Map(),           // id -> { id, name, type, lastSeen, banned }
  selected: [],                 // File[]
  transfers: new Map(),         // id -> transfer record
  incoming: new Map(),          // id -> { meta, chunks:[], received }
  pendingOffers: new Map(),     // id -> offer (awaiting accept)
  history: [],                  // [{ id, name, size, type, dir, peer, ts, status, scan, blobB64? }]
  incidents: [],                // [{ id, name, ts, reasons, peer, deviceId }]
  update: null,                 // { latest, url, notes } from the last update check
  // theme: null until the user picks one, so first load can follow the OS preference
  settings: { recentInMemory: 10, downloadableCopies: 3, scanning: true, autoAccept: false, sound: true, notifications: true, theme: null }
};
