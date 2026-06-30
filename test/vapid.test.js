import { describe, it, expect } from "vitest";
import { b64urlFromBytes, b64ToBytes, audienceFor, buildVapidJwt, vapidAuthHeader } from "../server/cloudflare/vapid.js";

describe("base64url", () => {
  it("round-trips bytes and strips padding / url-unsafe chars", () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 1, 2, 250]); // includes + and / producers
    const s = b64urlFromBytes(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect([...b64ToBytes(s)]).toEqual([...bytes]);
  });
});

describe("audienceFor", () => {
  it("reduces a push endpoint to its origin", () => {
    expect(audienceFor("https://fcm.googleapis.com/fcm/send/abc123:def")).toBe("https://fcm.googleapis.com");
    expect(audienceFor("https://web.push.apple.com/xyz")).toBe("https://web.push.apple.com");
  });
});

describe("VAPID JWT", () => {
  it("produces a 3-part JWT whose signature verifies with the matching public key", async () => {
    // generate a throwaway P-256 key; export pkcs8 (private) + raw (public)
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const pkcs8b64 = btoa(String.fromCharCode(...pkcs8));

    const jwt = await buildVapidJwt(pkcs8b64, "https://push.example.com", "mailto:test@example.com", 9999999999);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    // verify the signature over header.payload with the public key
    const signingInput = new TextEncoder().encode(parts[0] + "." + parts[1]);
    const sig = b64ToBytes(parts[2]);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      kp.publicKey,
      sig,
      signingInput
    );
    expect(ok).toBe(true);

    // decoded payload carries the audience + subject we asked for
    const payload = JSON.parse(new TextDecoder().decode(b64ToBytes(parts[1])));
    expect(payload.aud).toBe("https://push.example.com");
    expect(payload.sub).toBe("mailto:test@example.com");
  });

  it("formats the Authorization header", () => {
    expect(vapidAuthHeader("JWT", "PUB")).toBe("vapid t=JWT, k=PUB");
  });
});
