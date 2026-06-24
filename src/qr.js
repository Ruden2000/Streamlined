/* ====================================================================
   qr.js — QR CODE GENERATOR (byte mode, ECC level L, versions 1-4,
   single block). GF(256) & RS tables generated at runtime to avoid
   transcription error. Placement/format conventions follow the QR
   Model-2 spec. No third-party calls.
   ==================================================================== */
export const QR = (() => {
  const EXP = new Array(512), LOG = new Array(256);
  (() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
  function rsGen(deg) { let p = [1]; for (let i = 0; i < deg; i++) { const n = new Array(p.length + 1).fill(0); for (let j = 0; j < p.length; j++) { n[j] ^= p[j]; n[j + 1] ^= gmul(p[j], EXP[i]); } p = n; } return p; }
  function rsEncode(data, ecLen) { const gen = rsGen(ecLen); const res = data.concat(new Array(ecLen).fill(0)); for (let i = 0; i < data.length; i++) { const c = res[i]; if (c) for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], c); } return res.slice(data.length); }
  // [dataCodewords, ecCodewords] per version at level L
  const CW = { 1: [19, 7], 2: [34, 10], 3: [55, 15], 4: [80, 20] };
  function maskFn(m, r, c) {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r * c) % 2) + ((r + c) % 2)) % 2 === 0;
    }
  }
  function formatBits(ecBits, mask) { const data = (ecBits << 3) | mask; let d = data << 10; for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= 0x537 << (i - 10); return (((data << 10) | d) ^ 0x5412) & 0x7fff; }

  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    let version = 0;
    for (const v of [1, 2, 3, 4]) { const cap = Math.floor((CW[v][0] * 8 - 12) / 8); if (bytes.length <= cap) { version = v; break; } }
    if (!version) throw new Error("QR payload too long for prototype");
    const [dataCw, ecCw] = CW[version];
    const size = 17 + 4 * version;

    // --- bitstream ---
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    put(0b0100, 4);            // byte mode
    put(bytes.length, 8);      // char count (8 bits for v1-9)
    for (const b of bytes) put(b, 8);
    const cap = dataCw * 8;
    for (let i = 0, t = Math.min(4, cap - bits.length); i < t; i++) bits.push(0); // terminator
    while (bits.length % 8) bits.push(0);
    const pad = [0xec, 0x11];
    for (let i = 0; bits.length < cap; i++) put(pad[i % 2], 8);
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; codewords.push(b); }
    const all = codewords.concat(rsEncode(codewords, ecCw));

    // --- module matrix ---
    const m = Array.from({ length: size }, () => new Array(size).fill(null));
    const finder = (row, col) => { for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) { const rr = row + r, cc = col + c; if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue; m[rr][cc] = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4); } };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) { if (m[6][i] === null) m[6][i] = i % 2 === 0; if (m[i][6] === null) m[i][6] = i % 2 === 0; } // timing
    if (version >= 2) { const p = size - 7; for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) m[p + r][p + c] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0); } // alignment
    m[size - 8][8] = true; // dark module
    // format info (level L = 0b01), fixed mask 0
    const mask = 0, fmt = formatBits(0b01, mask);
    for (let i = 0; i < 15; i++) {
      const bit = ((fmt >> i) & 1) === 1;
      if (i < 6) m[i][8] = bit; else if (i < 8) m[i + 1][8] = bit; else m[size - 15 + i][8] = bit;
      if (i < 8) m[8][size - i - 1] = bit; else if (i < 9) m[8][15 - i] = bit; else m[8][14 - i] = bit;
    }
    // --- data placement (zigzag) ---
    let dir = -1, row = size - 1, bi = 7, byi = 0;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (true) {
        for (let c = 0; c < 2; c++) {
          const cc = col - c;
          if (m[row][cc] === null) {
            let dark = byi < all.length ? ((all[byi] >> bi) & 1) === 1 : false;
            if (maskFn(mask, row, cc)) dark = !dark;
            m[row][cc] = dark;
            if (--bi === -1) { byi++; bi = 7; }
          }
        }
        row += dir;
        if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
      }
    }
    return { size, modules: m };
  }

  function render(canvas, text, opts = {}) {
    const { size, modules } = encode(text);
    const quiet = 4, scale = opts.scale || 5, total = (size + quiet * 2) * scale;
    canvas.width = canvas.height = total;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = opts.light || "#ffffff"; ctx.fillRect(0, 0, total, total);
    ctx.fillStyle = opts.dark || "#0f1729";
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (modules[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  }
  return { render };
})();
