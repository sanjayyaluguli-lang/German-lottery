/* Minimal offline cache. Bump CACHE when you change any asset. */
const CACHE = 'lotto-smart-v2';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

/* The draw feed is the one file that must never be served stale — a cached
   copy would freeze the app on whichever draw it saw first. */
const FEED = 'data/draws.json';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network-first for the draw feed, cache-first for our other files, plain
// network for everything else (fonts, Tailwind CDN).
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === location.origin;

  if (sameOrigin && url.pathname.endsWith(FEED)) {
    e.respondWith(fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request)));      // offline: last feed we saw
    return;
  }

  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    if (sameOrigin) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match('./index.html'))));
});
