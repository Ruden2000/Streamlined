import { describe, it, expect } from "vitest";
import { bytesToB64, b64ToBytes, fmtBytes, escapeHtml, linkify, isGenericName, numberedName, uid } from "../src/util.js";

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

describe("linkify", () => {
  it("wraps http(s) URLs in safe anchors", () => {
    const out = linkify("see https://example.com/page?a=1 now");
    expect(out).toContain('<a href="https://example.com/page?a=1" target="_blank" rel="noopener noreferrer">');
    expect(out).toContain("see ");
    expect(out).toContain(" now");
  });

  it("prefixes bare www. URLs with https:// in the href only", () => {
    const out = linkify("go to www.example.com");
    expect(out).toContain('href="https://www.example.com"');
    expect(out).toContain(">www.example.com</a>");
  });

  it("leaves trailing punctuation outside the link", () => {
    const out = linkify("read https://example.com/doc.");
    expect(out).toContain('href="https://example.com/doc"');
    expect(out).toMatch(/<\/a>\.$/);
  });

  it("escapes HTML so pasted markup cannot inject", () => {
    const out = linkify('<img onerror=x> https://a.b/c"><script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;img");
  });

  it("returns plain escaped text when no URL present", () => {
    expect(linkify("just words & things")).toBe("just words &amp; things");
  });
});

describe("isGenericName", () => {
  it.each([
    ["image.jpg", true],
    ["IMG_2043.jpg", true],
    ["Screenshot 2026-01-01.png", false],   // dated screenshots are already specific
    ["screenshot.png", true],
    ["photo (2).jpg", true],
    ["document.pdf", true],
    ["untitled.txt", true],
    ["DSC01234.JPG", true],
    ["quarterly-report.pdf", false],
    ["holiday-in-rome.mp4", false],
    ["invoice-march.pdf", false]
  ])("%s -> %s", (name, expected) => {
    expect(isGenericName(name)).toBe(expected);
  });
});

describe("numberedName", () => {
  it("returns the name unchanged when free", () => {
    expect(numberedName("image.jpg", new Set())).toBe("image.jpg");
  });
  it("numbers sequential collisions", () => {
    const taken = new Set(["image.jpg"]);
    const a = numberedName("image.jpg", taken); taken.add(a);
    const b = numberedName("image.jpg", taken);
    expect(a).toBe("image1.jpg");
    expect(b).toBe("image2.jpg");
  });
  it("keeps the extension intact and handles extensionless names", () => {
    expect(numberedName("notes.tar.gz", new Set(["notes.tar.gz"]))).toBe("notes.tar1.gz");
    expect(numberedName("README", new Set(["README"]))).toBe("README1");
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
