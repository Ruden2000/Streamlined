import { describe, it, expect } from "vitest";
import { bytesToB64, b64ToBytes, fmtBytes, escapeHtml, uid } from "../src/util.js";

describe("base64 round-trip", () => {
  it("recovers arbitrary bytes", () => {
    const src = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    expect([...b64ToBytes(bytesToB64(src))]).toEqual([...src]);
  });

  it("handles payloads larger than the 0x8000 chunking window", () => {
    // bytesToB64 batches String.fromCharCode in 0x8000-byte chunks; cross it.
    const big = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    const round = b64ToBytes(bytesToB64(big));
    expect(round.length).toBe(big.length);
    expect(round[0]).toBe(big[0]);
    expect(round[big.length - 1]).toBe(big[big.length - 1]);
  });
});

describe("fmtBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [15360, "15 KB"],
    [1048576, "1.0 MB"],
    [5 * 1024 * 1024, "5.0 MB"]
  ])("formats %i as %s", (input, expected) => {
    expect(fmtBytes(input)).toBe(expected);
  });
});

describe("escapeHtml", () => {
  it("neutralizes HTML-significant characters", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">'))
      .toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(escapeHtml("a & b's <tag>")).toBe("a &amp; b&#39;s &lt;tag&gt;");
  });
});

describe("uid", () => {
  it("returns unique non-empty strings", () => {
    const a = uid(), b = uid();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
