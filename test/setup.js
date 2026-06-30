// crypto.js evaluates `window.crypto` at import time. In Node there is no
// `window`, so point it at globalThis (whose `crypto` is Node's Web Crypto).
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
