/* ====================================================================
   vapid.js — Web Push (RFC 8292 VAPID) helpers, runtime-agnostic.
   --------------------------------------------------------------------
   Pure functions usable from the Cloudflare Worker AND from Vitest (both
   expose Web Crypto + btoa/atob). We send "payloadless" pushes (no encrypted
   body), so we only need the VAPID JWT for authorization — the service worker
   fetches the filename from /last-notify when it wakes.
   ==================================================================== */

export function b64urlFromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64ToBytes(b64) {
  const norm = b64.replace(/-/g, "+").replace(/_/g, "/");
  const s = atob(norm);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export function audienceFor(endpoint) {
  return new URL(endpoint).origin;
}

// Build a signed ES256 VAPID JWT for a given push endpoint's origin (audience).
export async function buildVapidJwt(privatePkcs8B64, audience, subject, exp) {
  const enc = new TextEncoder();
  const header = b64urlFromBytes(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlFromBytes(
    enc.encode(JSON.stringify({
      aud: audience,
      exp: exp || Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: subject
    }))
  );
  const signingInput = header + "." + payload;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    b64ToBytes(privatePkcs8B64),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  // WebCrypto ECDSA produces the JOSE-style raw r||s signature directly.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return signingInput + "." + b64urlFromBytes(new Uint8Array(sig));
}

export function vapidAuthHeader(jwt, vapidPublic) {
  return `vapid t=${jwt}, k=${vapidPublic}`;
}
