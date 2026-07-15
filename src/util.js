/* ====================================================================
   util.js — DOM, formatting, and encoding helpers (no app dependencies)
   ==================================================================== */

/* ---------- tiny DOM helpers ---------- */
export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
export const fmtBytes = (b) => { if (b < 1024) return b + " B"; const u = ["KB","MB","GB","TB"]; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1); return b.toFixed(b < 10 ? 1 : 0) + " " + u[i]; };
export const fmtTime = (t) => { const d = new Date(t), now = Date.now(); const diff = (now - t) / 1000; if (diff < 60) return "just now"; if (diff < 3600) return Math.floor(diff/60) + "m ago"; if (diff < 86400) return Math.floor(diff/3600) + "h ago"; return d.toLocaleDateString(); };
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* does this filename look like a camera/OS default rather than a chosen name? */
export function isGenericName(name) {
  const base = String(name || "").replace(/\.[a-z0-9]+$/i, "").trim();
  return /^(image|img|photo|picture|pic|screenshot|screen[ _-]?shot|scan|document|doc|file|video|movie|clip|audio|recording|untitled|new[ _-]?file|download|attachment)[ _-]?\(?\d*\)?$/i.test(base)
      || /^(img|dsc|dcim|pxl|mvimg|gopr|vid|mov)[ _-]?\d+$/i.test(base);
}

/* first free "base<N>.ext" when `name` collides with an already-taken name */
export function numberedName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) { const c = base + n + ext; if (!taken.has(c)) return c; }
}

/* escape, then turn http(s)/www URLs into safe clickable anchors.
   Trailing sentence punctuation is left outside the link. */
export function linkify(text) {
  const esc = escapeHtml(text);
  return esc.replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/g, (m) => {
    const trail = /[.,!?;:)\]]+$/.exec(m);
    const url = trail ? m.slice(0, -trail[0].length) : m;
    const rest = trail ? trail[0] : "";
    if (!url) return m;
    const href = url.startsWith("www.") ? "https://" + url : url;
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + url + "</a>" + rest;
  });
}

/* ---------- base64 <-> bytes ---------- */
export function bytesToB64(u8) { let s = ""; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
export function b64ToBytes(b64) { const s = atob(b64); const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }
export function blobToB64(blob) { return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(blob); }); }
