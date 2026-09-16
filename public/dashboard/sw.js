const VERSION = "v4";
const CACHE_PREFIX = "dcc-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const DASHBOARD_URL = "/dashboard/";
const OFFLINE_URL = "/dashboard/offline.html";
const SHELL = [
  DASHBOARD_URL,
  OFFLINE_URL,
  "/dashboard/manifest.webmanifest",
  "/dashboard/icon.svg",
  "/dashboard/icon-192.png",
  "/dashboard/icon-512.png",
  "/dashboard/icon-maskable-512.png",
  "/dashboard/apple-touch-icon-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)),
    )).then(async () => {
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      clients.forEach((client) => client.postMessage({ type: "SW_ACTIVATED", version: VERSION }));
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin) return;

  if (requestUrl.pathname.startsWith("/dashboard/api/")) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({ error: "Offline", offline: true }),
        { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      )),
    );
    return;
  }

  if (event.request.mode === "navigate" && requestUrl.pathname.startsWith("/dashboard/")) {
    event.respondWith(networkFirstNavigation(event.request));
    return;
  }

  if (!requestUrl.pathname.startsWith("/dashboard/") && !requestUrl.pathname.startsWith("/_astro/")) return;

  event.respondWith(staleWhileRevalidate(event.request));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "GET_VERSION") event.source?.postMessage({ type: "SW_VERSION", version: VERSION });
  if (event.data?.type === "CACHE_STATIC_ASSETS") {
    const urls = Array.isArray(event.data.urls) ? event.data.urls : [];
    const allowed = urls.filter((value) => {
      try {
        const url = new URL(value, self.location.origin);
        return url.origin === self.location.origin && url.pathname.startsWith("/_astro/");
      } catch {
        return false;
      }
    });
    if (allowed.length) event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...new Set(allowed)])));
  }
});

self.addEventListener("push", (event) => {
  const payload = event.data?.json?.() || { title: "Developer Control Center", body: "Status changed", url: DASHBOARD_URL };
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/dashboard/icon-192.png",
    badge: "/dashboard/icon-192.png",
    tag: payload.tag || "dcc-status",
    data: { url: payload.url || DASHBOARD_URL },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || DASHBOARD_URL, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => client.url.startsWith(self.location.origin));
    return existing ? existing.focus().then(() => existing.navigate(url)) : self.clients.openWindow(url);
  }));
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(DASHBOARD_URL, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(DASHBOARD_URL)) || (await caches.match(OFFLINE_URL));
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request).then(async (response) => {
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);
  return cached || (await network) || (await caches.match(OFFLINE_URL));
}
