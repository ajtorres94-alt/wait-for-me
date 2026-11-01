// Service worker: lets phones install the app and open it without a connection.
const CACHE = "wait-for-me-v25";
const FILES = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192-v2.png", "/icons/icon-512-v2.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network first, so every redeploy shows up right away; cache is the offline fallback.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // other sites (like Stripe's card form) load normally
  if (url.pathname.startsWith("/api/")) return; // live data is never cached
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html")))
  );
});

// Phone notifications sent by the server (job updates, messages, meetup reminders).
self.addEventListener("push", (e) => {
  let m = {};
  try {
    m = e.data ? e.data.json() : {};
  } catch {
    m = { title: "Wait For Me!", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(m.title || "Wait For Me!", {
      body: m.body || "",
      icon: "/icons/icon-192-v2.png",
      badge: "/icons/icon-192-v2.png",
      tag: m.tag || undefined,
      data: { url: m.url || "/" },
    })
  );
});

// Tapping a notification opens the app, or brings it forward if it's already open.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if (new URL(c.url).origin === self.location.origin && "focus" in c) return c.focus();
      return self.clients.openWindow(url);
    })
  );
});
