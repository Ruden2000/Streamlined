import { defineConfig } from "vite";

// base: "./" emits relative asset paths — required so the built app loads
// correctly from a file:// origin inside the Capacitor (iOS/Android) and
// Tauri (Windows/Mac) native shells.
export default defineConfig({
  base: "./",
  server: { port: 8080 },
  build: { outDir: "dist", target: "es2020" }
});
