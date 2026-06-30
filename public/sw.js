/* Streamlined service worker.
   - network-first cache so the app shell loads offline
   - Web Push: wakes a closed PWA, fetches the incoming file's name, and shows a
     native notification. File transfers themselves stay peer-to-peer (WebRTC)
     and never touch this worker. */
const CACHE = "streamlined-v1";
const META = "sl-meta";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/* ---- offline shell (network-first) ---- */
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

/* ---- the page tells us which room + worker to query on push ----
   Persisted in the Cache so it survives the SW being stopped between pushes. */
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "sl-room") {
    e.waitUntil(
      caches.open(META).then((c) =>
        c.put("room", new Response(JSON.stringify({ room: e.data.room, base: e.data.base })))
      )
    );
  }
});

async function roomMeta() {
  try {
    const c = await caches.open(META);
    const r = await c.match("room");
    return r ? await r.json() : null;
  } catch { return null; }
}

/* ---- Web Push: payloadless wake, then fetch the filename ---- */
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let title = "Streamlined";
    let body = "A file was shared with you.";
    try {
      const meta = await roomMeta();
      if (meta && meta.room && meta.base) {
        const r = await fetch(meta.base + "/last-notify?room=" + encodeURIComponent(meta.room));
        if (r.ok) {
          const d = await r.json();
          if (d && d.name) {
            title = "Streamlined — incoming file";
            body = '"' + d.name + '" from ' + (d.fromName || "a linked device");
          }
        }
      }
    } catch { /* fall back to the generic message */ }
    await self.registration.showNotification(title, { body, icon: "pwa-192.png", badge: "pwa-192.png", tag: "sl-incoming" });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow("./");
  })());
});
