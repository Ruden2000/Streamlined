import { describe, it, expect } from "vitest";
import { Crypto } from "../src/crypto.js";

describe("Crypto", () => {
  it("reports Web Crypto availability", () => {
    expect(Crypto.ok).toBe(true);
  });

  it("sha256hex matches the known empty-string vector", async () => {
    expect(await Crypto.sha256hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("derives a usable AES-GCM key from a pairing code", async () => {
    const key = await Crypto.deriveKey("ABC123");
    expect(key.type).toBe("secret");
    expect(key.algorithm.name).toBe("AES-GCM");
  });

  it("encrypt → decrypt round-trips the plaintext", async () => {
    const key = await Crypto.deriveKey("ABC123");
    const plain = new TextEncoder().encode("the quick brown fox 🦊");
    const { iv, ct } = await Crypto.encrypt(key, plain);
    const out = await Crypto.decrypt(key, iv, ct);
    expect(new TextDecoder().decode(out)).toBe("the quick brown fox 🦊");
  });

  it("uses a fresh random IV per encryption", async () => {
    const key = await Crypto.deriveKey("ABC123");
    const data = new Uint8Array([1, 2, 3]);
    const a = await Crypto.encrypt(key, data);
    const b = await Crypto.encrypt(key, data);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct); // GCM ciphertext differs with the IV
  });

  it("the same code on two devices derives an interoperable key", async () => {
    const k1 = await Crypto.deriveKey("ZX9QP2");
    const k2 = await Crypto.deriveKey("ZX9QP2");
    const { iv, ct } = await Crypto.encrypt(k1, new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(await Crypto.decrypt(k2, iv, ct))).toBe("hello");
  });

  it("a wrong code cannot decrypt (GCM auth fails)", async () => {
    const good = await Crypto.deriveKey("ABC123");
    const bad = await Crypto.deriveKey("XYZ789");
    const { iv, ct } = await Crypto.encrypt(good, new TextEncoder().encode("secret"));
    await expect(Crypto.decrypt(bad, iv, ct)).rejects.toBeTruthy();
  });
});
