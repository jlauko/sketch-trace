// Bump VERSION whenever any file below changes, so installed copies pick it up.
const VERSION = 'sketch-trace-v5';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

// The face finder (library + model, about 14 MB) comes from these hosts the
// first time the Face view is used. It is kept in its own cache, which survives
// app updates, so it only ever downloads once.
const FACE_CACHE = 'sketch-trace-face';
const FACE_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION && k !== FACE_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache first, so the app opens with no signal at all.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (FACE_HOSTS.includes(new URL(e.request.url).hostname)) {
    e.respondWith(
      caches.open(FACE_CACHE).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
