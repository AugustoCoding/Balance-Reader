// Offline support: serves the app shell from cache and refreshes it in the
// background, so the page opens even when the lab computer is offline.

const CACHE = 'balance-reader-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'icon.png',
  'manifest.webmanifest',
  'src/app.js',
  'src/chart.js',
  'src/profiles.js',
  'src/protocol.js',
  'src/reader.js',
  'src/serial.js',
  'src/session.js',
  'src/settings.js',
  'src/simulator.js',
  'src/stats.js',
  'src/xlsx.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // network first (always the latest version when online), cache when offline
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(req);
        if (res.ok && (new URL(req.url).origin === location.origin || res.type === 'cors')) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        throw err;
      }
    }),
  );
});
