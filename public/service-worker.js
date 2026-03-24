/* eslint-disable no-restricted-globals */

// Service Worker de "desactivación": limpia caches viejos y se desregistra.
// Esto ayuda a recuperar clientes que quedaron pegados a una versión antigua.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (_) {}

    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) {}

    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      await Promise.all(clients.map((c) => c.navigate(c.url)));
    } catch (_) {}

    try { await self.registration.unregister(); } catch (_) {}
  })());
});
