import { describe, it, expect, afterEach } from "vitest";
import { Scanner } from "../src/scanner.js";
import { state } from "../src/state.js";

const file = (name, content = "", type = "") =>
  new File([content], name, { type });

afterEach(() => { state.settings.scanning = true; }); // restore default

describe("Scanner.scan", () => {
  it("allows a clean file", async () => {
    const v = await Scanner.scan(file("vacation.txt", "hello world", "text/plain"));
    expect(v.allowed).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it("blocks a filename containing a blocked term", async () => {
    const v = await Scanner.scan(file("trafficking-notes.txt", "x", "text/plain"));
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("keyword");
    expect(v.reasons.join(" ")).toMatch(/trafficking/);
  });

  it("blocks blocked terms found in text content", async () => {
    const v = await Scanner.scan(file("notes.txt", "contains csam reference", "text/plain"));
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/content matched/i);
  });

  it("does not read content of non-textual files for keywords", async () => {
    // a binary file whose bytes spell a blocked term should not be text-scanned
    const v = await Scanner.scan(file("photo.jpg", "csam", "image/jpeg"));
    expect(v.allowed).toBe(true); // image path uses hash stub (empty set), not text
  });

  it("skips scanning entirely when disabled, and flags it", async () => {
    state.settings.scanning = false;
    const v = await Scanner.scan(file("trafficking.txt", "csam", "text/plain"));
    expect(v.allowed).toBe(true);
    expect(v.skipped).toBe(true);
  });

  it("matches the perceptual-hash set when populated", async () => {
    const img = file("clean.png", "pixels", "image/png");
    const known = await Scanner.perceptualHashStub(img);
    Scanner.knownIllegalHashes.add(known);
    try {
      const v = await Scanner.scan(img);
      expect(v.allowed).toBe(false);
      expect(v.category).toBe("csam-hash");
    } finally {
      Scanner.knownIllegalHashes.delete(known);
    }
  });
});
