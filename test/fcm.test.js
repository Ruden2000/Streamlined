import { describe, it, expect } from "vitest";
import { pemToDer, buildFcmJwt } from "../server/cloudflare/fcm.js";
import { b64ToBytes } from "../server/cloudflare/vapid.js";

// Build a service-account-like object with a fresh RSA key; return the PEM + public key.
async function makeServiceAccount() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const b64 = btoa(String.fromCharCode(...pkcs8));
  const pem = "-----BEGIN PRIVATE KEY-----\n" + (b64.match(/.{1,64}/g).join("\n")) + "\n-----END PRIVATE KEY-----\n";
  return {
    sa: { client_email: "svc@proj.iam.gserviceaccount.com", private_key: pem, token_uri: "https://oauth2.googleapis.com/token", project_id: "proj" },
    publicKey: kp.publicKey
  };
}

describe("pemToDer", () => {
  it("strips PEM armor and base64-decodes", () => {
    const der = pemToDer("-----BEGIN PRIVATE KEY-----\nAAECAwQ=\n-----END PRIVATE KEY-----\n");
    expect([...der]).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("FCM service-account JWT", () => {
  it("produces an RS256 JWT that verifies with the account's public key", async () => {
    const { sa, publicKey } = await makeServiceAccount();
    const jwt = await buildFcmJwt(sa, 1000000000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64ToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
    expect(ok).toBe(true);

    const header = JSON.parse(new TextDecoder().decode(b64ToBytes(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(b64ToBytes(parts[1])));
    expect(header.alg).toBe("RS256");
    expect(claims.iss).toBe("svc@proj.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(claims.exp - claims.iat).toBe(3600);
  });
});
