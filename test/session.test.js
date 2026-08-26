import { describe, it, expect } from "vitest";
import { Crypto } from "../src/crypto.js";

/* The pairing code used to be the encryption key outright, so recorded traffic
   was attackable offline and one leaked code exposed every past session. These
   guard the replacement: an ephemeral ECDH exchange bound to the code. */

const A = "device-a", B = "device-b";

describe("per-session keys", () => {
  it("both peers derive the SAME key from the exchange", async () => {
    const [ka, kb] = [await Crypto.newSessionKeys(), await Crypto.newSessionKeys()];
    const [pa, pb] = [await Crypto.exportPublic(ka), await Crypto.exportPublic(kb)];
    const keyA = await Crypto.deriveSessionKey(ka.privateKey, pb, "ABC123", A, B);
    const keyB = await Crypto.deriveSessionKey(kb.privateKey, pa, "ABC123", A, B);

    const msg = new TextEncoder().encode("payload");
    const { iv, ct } = await Crypto.encrypt(keyA, msg);
    expect(new TextDecoder().decode(await Crypto.decrypt(keyB, iv, ct))).toBe("payload");
  });

  it("peer id ordering does not matter", async () => {
    const [ka, kb] = [await Crypto.newSessionKeys(), await Crypto.newSessionKeys()];
    const [pa, pb] = [await Crypto.exportPublic(ka), await Crypto.exportPublic(kb)];
    // each side naturally passes its own id first
    const keyA = await Crypto.deriveSessionKey(ka.privateKey, pb, "ABC123", A, B);
    const keyB = await Crypto.deriveSessionKey(kb.privateKey, pa, "ABC123", B, A);
    const { iv, ct } = await Crypto.encrypt(keyA, new TextEncoder().encode("x"));
    await expect(Crypto.decrypt(keyB, iv, ct)).resolves.toBeTruthy();
  });

  it("a relay that does not know the pairing code derives a different key", async () => {
    const [ka, kb] = [await Crypto.newSessionKeys(), await Crypto.newSessionKeys()];
    const [pa, pb] = [await Crypto.exportPublic(ka), await Crypto.exportPublic(kb)];
    const good = await Crypto.deriveSessionKey(ka.privateKey, pb, "ABC123", A, B);
    const wrong = await Crypto.deriveSessionKey(kb.privateKey, pa, "WRONG9", A, B);
    const { iv, ct } = await Crypto.encrypt(good, new TextEncoder().encode("secret"));
    await expect(Crypto.decrypt(wrong, iv, ct)).rejects.toBeTruthy();
  });

  it("FORWARD SECRECY: a new session never reuses the previous key", async () => {
    const mk = async () => {
      const [ka, kb] = [await Crypto.newSessionKeys(), await Crypto.newSessionKeys()];
      const [pa, pb] = [await Crypto.exportPublic(ka), await Crypto.exportPublic(kb)];
      return Crypto.deriveSessionKey(ka.privateKey, pb, "ABC123", A, B);
    };
    const first = await mk(), second = await mk();          // same code, new session
    const { iv, ct } = await Crypto.encrypt(first, new TextEncoder().encode("old traffic"));
    // knowing the code is no longer enough to read an earlier session
    await expect(Crypto.decrypt(second, iv, ct)).rejects.toBeTruthy();
  });

  it("both peers show the same verification digits, and a MITM shows different ones", async () => {
    const [ka, kb, kEve] = [await Crypto.newSessionKeys(), await Crypto.newSessionKeys(), await Crypto.newSessionKeys()];
    const [pa, pb, pe] = [await Crypto.exportPublic(ka), await Crypto.exportPublic(kb), await Crypto.exportPublic(kEve)];
    const sasA = await Crypto.verificationCode(ka.privateKey, pb, "ABC123", A, B);
    const sasB = await Crypto.verificationCode(kb.privateKey, pa, "ABC123", B, A);
    expect(sasA).toBe(sasB);
    expect(sasA).toMatch(/^\d{6}$/);
    // A talking to an interposed party sees a different number
    const sasMitm = await Crypto.verificationCode(ka.privateKey, pe, "ABC123", A, B);
    expect(sasMitm).not.toBe(sasA);
  });

  it("keys are non-extractable", async () => {
    const [ka, kb] = [await Crypto.newSessionKeys(), await Crypto.newSessionKeys()];
    const key = await Crypto.deriveSessionKey(ka.privateKey, await Crypto.exportPublic(kb), "ABC123", A, B);
    expect(key.extractable).toBe(false);
  });
});
