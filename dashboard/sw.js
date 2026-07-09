// Minimal service worker — app-shell cache + "network first, fallback to
// cache" for the dashboard's JSON data, so the last-known status still shows
// up if the device goes offline.
const CACHE_NAME = 'sentryxp-status-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.json', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept POST (admin actions)

  const url = new URL(req.url);
  const isJsonData = (url.hostname === 'raw.githubusercontent.com' || url.hostname === 'cdn.jsdelivr.net') && url.pathname.endsWith('.json');
  const isAppShell = url.origin === self.location.origin && (url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname.endsWith('.json') || url.pathname.endsWith('.svg'));

  if (!isJsonData && !isAppShell) return; // let everything else (functions, images) hit the network normally

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
