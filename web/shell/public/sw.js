/*
 * Root service worker cleanup.
 *
 * The desktop shell does not use a root-scoped service worker. Older
 * deployments briefly served a Workbox service worker at /sw.js; browsers
 * that installed it keep retrying that script URL. Serving valid JavaScript
 * here lets those clients replace the stale worker and unregister cleanly.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.clients?.claim) {
        await self.clients.claim();
      }

      await self.registration.unregister();
    })()
  );
});
