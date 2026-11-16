/* Chỉ quản lý tài nguyên Sổ Ghi; không đụng cache của ứng dụng khác. */
const CACHE_PREFIX = `soghi-static-${new URL(self.registration.scope).pathname}-`;
const CACHE_NAME = CACHE_PREFIX + "v10";
const ASSETS = [
  "soghi.html", "soghi.css", "soghi.js", "soghi-ledger.js", "soghi-sync.js", "soghi-config.js",
  "soghi.webmanifest", "soghi-icon.svg", "soghi-icon-180.png", "soghi-icon-192.png", "soghi-icon-512.png"
].map(name => new URL(name, self.registration.scope).href);
const ALLOWED = new Set(ASSETS);
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS.map(url => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    // Các phiên bản cũ chỉ có các cache này; không xóa cache khác cùng origin.
    await Promise.all(keys.filter(key => /^soghi-static-v[1-8]$/.test(key)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  url.search = "";
  if (!ALLOWED.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        await cache.put(url.href, response.clone());
        return response;
      }
      return (await cache.match(url.href)) || response;
    } catch (error) {
      const cached = await cache.match(url.href);
      if (cached) return cached;
      throw error;
    }
  })());
});
