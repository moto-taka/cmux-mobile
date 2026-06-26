// cmux-mobile Service Worker
// Cache-first for static assets, network-first for API calls

const CACHE_NAME = 'cmux-v2';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/styles/main.css',
  '/app.js',
  '/manifest.json',
];

// Install: precache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for the whole same-origin app shell so updated client
// code/UI is picked up immediately; the cache is only a last-resort offline
// fallback. (The old cache-first strategy served stale app.js/index.html and
// hid client fixes until the cache name happened to change.)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GETs. Cross-origin CDN assets (xterm, addon-fit),
  // the ttyd port, and WebSocket upgrades all pass straight through.
  if (url.origin !== location.origin || event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
