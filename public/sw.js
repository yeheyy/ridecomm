// RideComm Service Worker — caches app for offline use
const CACHE = 'ridecomm-v2';
const ASSETS = [
  '/offline.html',
  '/css/style.css',
  '/js/app.js',
  '/js/peerjs.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network first for API, cache first for assets
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/health') ||
      url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/peerjs')) {
    return; // let network handle these
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/offline.html'));
    })
  );
});
