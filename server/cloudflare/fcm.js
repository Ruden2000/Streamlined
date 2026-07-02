/* ====================================================================
   fcm.js — Firebase Cloud Messaging (HTTP v1) sender for the Worker.
   --------------------------------------------------------------------
   Wakes a fully-closed native Android APK. Auth is OAuth2 via the Firebase
   service account: sign an RS256 JWT with the account's private key, exchange
   it for an access token, then POST the message. Pure-ish (crypto + fetch), so
   the JWT builder is unit-testable; network calls take an injectable fetch.
   ==================================================================== */
import { b64urlFromBytes } from "./vapid.js";

// PEM (-----BEGIN PRIVATE KEY-----) -> DER bytes for WebCrypto importKey.
export function pemToDer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export async function buildFcmJwt(sa, now) {
  const iat = now || Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const header = b64urlFromBytes(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64urlFromBytes(enc.encode(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600
  })));
  const signingInput = header + "." + claims;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
  return signingInput + "." + b64urlFromBytes(new Uint8Array(sig));
}

export async function getFcmAccessToken(sa, fetchImpl) {
  const f = fetchImpl || fetch;
  const jwt = await buildFcmJwt(sa);
  const res = await f(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + encodeURIComponent(jwt)
  });
  if (!res.ok) throw new Error("fcm token exchange failed: " + res.status);
  const d = await res.json();
  return d.access_token;
}

// Returns the HTTP status. 404/UNREGISTERED means the token is dead -> caller deletes it.
export async function sendFcm(accessToken, projectId, deviceToken, title, body, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title, body },
        android: { priority: "high" }
      }
    })
  });
  return res.status;
}
