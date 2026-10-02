// Service worker:
// 1. lets Android Chrome show notifications (it only allows them through a service worker);
// 2. keeps a copy of the page and last data so the site still opens on a flaky connection.
//    Same-origin requests are network-first, so visitors always get fresh data when online.
const CACHE = "banpong-water-v2";
const SHELL = ["./", "./index.html", "./water-data.json", "./ban-pong-boundary.geojson", "./icon.svg", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Leave cross-origin requests (ThaiWater, map tiles, fonts) to the browser.
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    // water-data.json is requested with a cache-busting ?check= param; store it under one key.
    const key = url.pathname.endsWith("/water-data.json") ? new Request(new URL("./water-data.json", self.registration.scope)) : request;
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(key, copy)).catch(() => {});
      }
      return response;
    } catch (error) {
      const cached = await caches.match(key, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === "navigate") {
        const shell = await caches.match("./index.html");
        if (shell) return shell;
      }
      throw error;
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) return existing.focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});
