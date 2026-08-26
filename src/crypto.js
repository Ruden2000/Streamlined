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
  /* Raw-bytes variants used by the binary wire format: no base64 round-trip,
     which keeps large payloads from being inflated ~33% and copied twice. */
  async encryptRaw(key, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
    return { iv, ct: new Uint8Array(ct) };
  },
  async decryptRaw(key, iv, ct) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new Uint8Array(pt);
  },
  /* ==================================================================
     PER-SESSION KEYS (v2)
     ------------------------------------------------------------------
     The pairing code alone used to BE the key: one static AES key derived
     from ~2^30 of entropy, identical for every session. Anyone who recorded
     traffic could attack it offline, and learning the code once exposed
     everything ever sent.

     Now each device makes a throwaway ECDH keypair per session, peers swap
     public keys over the data channel, and the session key is
     HKDF(ECDH shared secret, salt = the pairing code). That means:
       • recorded traffic can't be decrypted later even if the code leaks
         (forward secrecy — the private keys never leave memory), and
       • anyone relaying the handshake without knowing the code derives a
         different key, so a malicious signalling server can't sit in the
         middle.
     The code still binds the exchange; it is no longer the key itself.
     ================================================================== */
  async newSessionKeys() {
    return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  },
  async exportPublic(keyPair) {
    const raw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    return bytesToB64(new Uint8Array(raw));
  },
  /* Both sides must feed HKDF the same info, so peer ids are sorted. */
  async deriveSessionKey(privateKey, peerPublicB64, code, idA, idB) {
    const peerPub = await crypto.subtle.importKey(
      "raw", b64ToBytes(peerPublicB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPub }, privateKey, 256);
    const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const enc = new TextEncoder();
    const salt = await crypto.subtle.digest("SHA-256", enc.encode("streamlined-pair:" + code));
    const info = enc.encode("streamlined-session-v2|" + [idA, idB].sort().join("|"));
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info },
      hkdfKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  },
  /* Six digits both devices can display, so a person can confirm they really
     are talking to each other rather than to something in between. */
  async verificationCode(privateKey, peerPublicB64, code, idA, idB) {
    const peerPub = await crypto.subtle.importKey(
      "raw", b64ToBytes(peerPublicB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPub }, privateKey, 256);
    const enc = new TextEncoder();
    const tag = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array([...new Uint8Array(shared), ...enc.encode("sas|" + code + "|" + [idA, idB].sort().join("|"))])
    ));
    const n = ((tag[0] << 16) | (tag[1] << 8) | tag[2]) % 1000000;
    return String(n).padStart(6, "0");
  },

  async sha256hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
};
