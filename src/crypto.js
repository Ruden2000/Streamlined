/* ====================================================================
   crypto.js — AES-256-GCM via Web Crypto
   ==================================================================== */
import { bytesToB64, b64ToBytes } from "./util.js";

export const Crypto = {
  ok: !!(window.crypto && window.crypto.subtle),
  async deriveKey(code) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: enc.encode("streamlined-v1-pairing-salt"), iterations: 100000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  },
  async encrypt(key, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
    return { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
  },
  async decrypt(key, ivB64, ctB64) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64));
    return new Uint8Array(pt);
  },
  async sha256hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
};
