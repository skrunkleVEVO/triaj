// Triaj service worker (whole site): makes Triaj installable and usable offline, and handles
// notification clicks. Network first, so a new version shows up right away; the last copy is used offline.
const CACHE = 'triaj-v6';
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './app/', './app/app.css', './assets/fonts/fonts.css']).catch(() => {})));
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const mine = u.origin === location.origin, sdk = u.hostname === 'www.gstatic.com' && u.pathname.indexOf('/firebasejs/') === 0;
  if (!mine && !sdk) return;
  e.respondWith(fetch(r).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); }
    return res;
  }).catch(() => caches.match(r, { ignoreSearch: mine }).then((hit) => hit || (r.mode === 'navigate' ? caches.match('./app/') : Response.error()))));
});

// Clicking a notification (or one of its buttons) focuses Triaj and tells the page what was pressed.
self.addEventListener('notificationclick', (e) => {
  const id = (e.notification.data && e.notification.data.id) || e.notification.tag;
  e.notification.close();
  e.waitUntil((async () => {
    const app = new URL('./app/', self.registration.scope).pathname;
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let c = all.find((x) => new URL(x.url).pathname.startsWith(app));
    if (c) { try { await c.focus(); } catch (err) {} }
    else c = await self.clients.openWindow('./app/#' + (id === 'timer' || id === 'refocus' ? 'focus' : id === 'sync' || id === 'unblocked' ? 'tasks' : 'now'));
    if (c) c.postMessage({ type: 'notification', id, action: e.action || '' });
  })());
});
