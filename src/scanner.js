/* ====================================================================
   scanner.js — content safety scanning (sender-side, on plaintext,
   pre-encryption)
   --------------------------------------------------------------------
   This demonstrates the MECHANISM. The blocklist below uses category
   labels as illustrative, non-exploitable demo triggers (e.g. naming a
   test file "trafficking.txt" will be blocked). In production this layer
   integrates vetted lists (NCMEC/Polaris/Thorn) and licensed perceptual-
   hash CSAM matching (PhotoDNA / Cloudflare CSAM Tool / Google CSAI),
   which require legal authorization and mandated NCMEC reporting.
   ==================================================================== */
import { state } from "./state.js";
import { Crypto } from "./crypto.js";
import { bytesToB64 } from "./util.js";

export const Scanner = {
  // Illustrative category triggers only — NOT a real detection list.
  blocklist: ["csam", "child-sexual", "child-exploitation", "trafficking", "illegal-sample-block"],
  knownIllegalHashes: new Set(), // production: populated from licensed hash database. Intentionally empty.

  async perceptualHashStub(file) {
    // Placeholder integration point. Real systems compute a robust perceptual
    // hash (e.g., PhotoDNA) and match against a licensed database.
    const buf = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    return await Crypto.sha256hex(bytesToB64(buf));
  },

  async scan(file) {
    if (!state.settings.scanning) return { allowed: true, reasons: [], category: null, skipped: true };
    const reasons = [];
    let category = null;
    const name = (file.name || "").toLowerCase();
    for (const term of this.blocklist) if (name.includes(term)) { reasons.push('Filename matched blocked term "' + term + '"'); category = "keyword"; }
    const textual = (file.type || "").startsWith("text/") || /\.(txt|md|csv|json|log|html?|xml|rtf)$/i.test(name);
    if (textual && file.size < 2_000_000) {
      try {
        const text = (await file.text()).toLowerCase();
        for (const term of this.blocklist) if (text.includes(term)) { reasons.push('File content matched blocked term "' + term + '"'); category = "keyword"; }
      } catch { /* ignore unreadable */ }
    }
    if ((file.type || "").startsWith("image/")) {
      const h = await this.perceptualHashStub(file);
      if (this.knownIllegalHashes.has(h)) { reasons.push("Image matched a known illegal-content hash"); category = "csam-hash"; }
    }
    return { allowed: reasons.length === 0, reasons, category };
  }
};
