/* Streamlined service worker — network-first with offline cache fallback.
   Makes the app installable and lets the shell load offline. File transfers
   are peer-to-peer (WebRTC) and unaffected by this cache. */
const CACHE = "streamlined-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith("http")) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((m) => m || (req.mode === "navigate" ? caches.match("./index.html") : Response.error()))
      )
  );
});
