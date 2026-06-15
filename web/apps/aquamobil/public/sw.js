/* Legacy AquaMobil service worker cleanup.
 *
 * Older builds registered /mobile/sw.js. Current builds use
 * /mobile/messaging-sw.js, but browsers that still control a page with the old
 * worker must receive JavaScript here instead of the SPA HTML fallback.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      self.registration.unregister(),
    ]),
  );
});
