// Minimal service worker: just enough app-shell caching to satisfy "installable"
// criteria on Android/Chrome. API calls always go to the network — never cached,
// since the roster data must stay live. The shell itself is network-first (not
// cache-first): this is a small, frequently-updated app, so a visit should
// always show the latest deploy, falling back to the cache only when there is
// no connectivity. Bump CACHE whenever the shell's behavior changes in a way
// that needs a clean cache (rare — network-first mostly self-heals).
const CACHE = "roster-shell-v2";
const SHELL = ["/", "/index.html", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("push", (event) => {
  let data = { title: "掃除当番カレンダー", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "掃除当番カレンダー", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return clients.openWindow("/");
    })
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // always network
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
