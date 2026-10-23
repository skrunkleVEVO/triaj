// Retired: Triaj's service worker now lives at the site root (../sw.js). This removes the old one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister()));
