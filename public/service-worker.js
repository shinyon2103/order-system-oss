const CACHE_NAME = "order-system-shell-v38";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=29",
  "/app.js?v=50",
  "/client-id.js",
  "/device-auth-grace.js",
  "/device-session.js",
  "/kitchen-alert.js",
  "/kitchen-offline-completion.js",
  "/kitchen-offline-cache.js",
  "/kitchen-completion-key.js?v=1",
  "/menu-selection.js",
  "/offline-sync.js",
  "/page-zoom.js?v=1",
  "/realtime-refresh.js",
  "/server-clock.js",
  "/manifest.webmanifest",
  "/order-system-icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/health") return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") {
        const shell = await caches.match("/index.html");
        if (shell) return shell;
      }
      return new Response("オフラインです", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  })());
});
