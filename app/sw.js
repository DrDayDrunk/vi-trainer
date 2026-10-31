// Offline support: every app file is saved on the phone at install. Files are served from the saved copy
// first and refreshed quietly in the background, so a new version appears the next time the app is opened.
const CACHE = 'vi-trainer-app-v1';   // change this number when files change, so old copies are dropped
const FILES = [
  './', './index.html', './style.css', './app.js', './engine.js', './pack.js', './store.js',
  './vendor/ts-fsrs.umd.js', './manifest.webmanifest', './icon-180.png', './icon-512.png',
  './fonts/be-vietnam-pro-latin-400-normal.woff2', './fonts/be-vietnam-pro-latin-600-normal.woff2',
  './fonts/be-vietnam-pro-vietnamese-400-normal.woff2', './fonts/be-vietnam-pro-vietnamese-600-normal.woff2',
];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(saved => {
    const fresh = fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; }).catch(() => saved);
    return saved || fresh;
  }));
});
