// Generates PWA icons from public/logo.png using sharp.
import sharp from "sharp";

const SRC = "public/logo.png";
const white = { r: 255, g: 255, b: 255, alpha: 1 };

await sharp(SRC).resize(192, 192, { fit: "contain", background: white }).png().toFile("public/pwa-192.png");
await sharp(SRC).resize(512, 512, { fit: "contain", background: white }).png().toFile("public/pwa-512.png");

// maskable: logo at ~72% inside a 512 safe area (so launchers can mask/crop it)
const inner = await sharp(SRC).resize(368, 368, { fit: "contain", background: white }).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: white } })
  .composite([{ input: inner, gravity: "center" }])
  .png()
  .toFile("public/pwa-maskable-512.png");

console.log("PWA icons generated: pwa-192.png, pwa-512.png, pwa-maskable-512.png");
