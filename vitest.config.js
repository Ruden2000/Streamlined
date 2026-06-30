import { defineConfig } from "vitest/config";

// Node 22 provides Web Crypto, File, Blob, and btoa/atob as globals, so the
// browser-oriented source modules run unmodified. setup.js maps `window` to
// globalThis for the few spots that reference it at import time.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.js"],
    include: ["test/**/*.test.js"]
  }
});
