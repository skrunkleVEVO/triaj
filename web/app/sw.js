// Triaj service worker: makes the app installable and usable offline, and handles notification clicks.
// Network first (so a new version shows up right away), falling back to the last copy when offline.
const CACHE = 'triaj-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const mine = u.origin === location.origin, sdk = u.hostname === 'www.gstatic.com' && u.pathname.indexOf('/firebasejs/') === 0;
  if (!mine && !sdk) return;
  e.respondWith(fetch(r).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); }
    return res;
  }).catch(() => caches.match(r, { ignoreSearch: mine }).then((hit) => hit || (r.mode === 'navigate' ? caches.match('./') : Response.error()))));
});

// Clicking a notification (or one of its buttons) focuses Triaj and tells the page what was pressed.
self.addEventListener('notificationclick', (e) => {
  const id = (e.notification.data && e.notification.data.id) || e.notification.tag;
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let c = all.find((x) => new URL(x.url).pathname.startsWith(new URL('./', self.registration.scope).pathname));
    if (c) { try { await c.focus(); } catch (err) {} }
    else c = await self.clients.openWindow('./#' + (id === 'timer' || id === 'refocus' ? 'focus' : id === 'sync' || id === 'unblocked' ? 'tasks' : 'now'));
    if (c) c.postMessage({ type: 'notification', id, action: e.action || '' });
  })());
});
