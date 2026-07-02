/// <reference lib="webworker" />

/**
 * @module messaging-sw
 * @description The DEPLOYED AquaMobil service worker.
 *
 * FE-CRITICAL-050-SW: This file is the artifact VitePWA emits as
 * `dist/messaging-sw.js` via `strategies: 'injectManifest'` with
 * `filename: 'messaging-sw.ts'` (configured in vite.config.ts), and it is what
 * `virtual:pwa-register` registers at scope `/mobile/`. It is the single, real
 * workbox service worker for the app — there is no separate generateSW artifact.
 * Everything the SW must do lives here:
 *   - precache the build manifest (`self.__WB_MANIFEST`, injected at build time)
 *   - runtime caching + SPA navigation fallback (registerRoute rules below)
 *   - background sync for the offline operation queue (sync-operations / sync-messages)
 *   - notification click navigation + Badge API
 *   - the LOGOUT cache-purge message handler (used by useAuth.tsx)
 *
 * PUSH NOTE (FE-HIGH-057, NOT solved here): foreground/background push is
 * delivered by Firebase Cloud Messaging through its OWN service worker
 * (public/firebase-messaging-sw.js → onBackgroundMessage), which
 * useFirebaseMessaging registers at the DISTINCT sub-scope
 * `/mobile/firebase-cloud-messaging-push-scope` — deliberately disjoint from this
 * worker's `/mobile/` scope so the two registrations never evict each other. A
 * raw `push` listener in THIS workbox SW would never fire for FCM messages, so no
 * `push` handler is registered here. Adding one would be dead code. The FCM SW
 * registration wiring is tracked as FE-HIGH-057.
 *
 * @see ADR-012 section 7 (Offline / PWA)
 */

import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { precacheAndRoute, cleanupOutdatedCaches, PrecacheFallbackPlugin } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';

import { logger } from '../utils/logger';

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

// ============================================================================
// Lifecycle: activate immediately, claim all clients
// ============================================================================
// FIX(SW-002, preserved from the prior generateSW config): skipWaiting +
// clientsClaim ensure a freshly deployed SW takes control without waiting for
// every tab to close, so field workers always run the latest version.
// `void`: skipWaiting() returns a Promise the SW deliberately does not await —
// it is the standard fire-and-forget activation idiom.
void self.skipWaiting();
clientsClaim();

// ============================================================================
// Precache (FE-CRITICAL-050-SW)
// ============================================================================
// `self.__WB_MANIFEST` is replaced at build time by VitePWA's injectManifest
// sub-build with the content-hashed precache manifest. Precaching the built
// assets is what makes the app shell available offline — the generateSW
// artifact this file replaces had ZERO precache entries.
precacheAndRoute(self.__WB_MANIFEST);

// Drop precaches written by a previous SW revision so storage does not grow
// unbounded across deployments.
cleanupOutdatedCaches();

// ============================================================================
// Runtime caching (moved here from vite.config.ts workbox.runtimeCaching)
// ============================================================================
// CRIT-2 / SEC-02 / PERF-01: GraphQL POST responses are NEVER cached — caching
// authenticated GraphQL on a shared device leaks tenant data to the next user
// and silently discards offline-queue mutations. GraphQL passes straight to the
// network via handleFetchEvent below; no runtime route is registered for it.

// FIX(SW-003) + FE-HIGH-058: SPA navigation handling with a precache-bound
// offline fallback.
//
// NetworkFirst keeps the online behaviour correct: a navigation tries the network
// first (5s timeout) so a fresh deployment is picked up immediately, then falls
// back to the 1-day runtime navigation-cache when the network is slow/down.
//
// FE-HIGH-058: the previous config had NO fallback for a FIRST-EVER cold offline
// launch — on a device that has never loaded the app online, both the network AND
// the empty runtime nav-cache miss, so the navigation resolved to nothing and the
// PWA opened blank. vite.config.ts now precaches `index.html` (globPatterns
// includes `html`; the sw-build-artifact invariant asserts the manifest entry),
// so the app shell IS available offline. The PrecacheFallbackPlugin hooks
// NetworkFirst's `handlerDidError` and serves the precached `index.html` when —
// and only when — both network and runtime cache fail. The SPA then boots from
// IndexedDB. Content-hashed shell JS/CSS + cleanupOutdatedCaches guarantee a
// stale shell cannot mask a deploy: once online, the fresh manifest reloads the
// app and drops the old precache.
//
// Scope: this route matches navigations only (`request.mode === 'navigate'`).
// GraphQL POST and /messaging//media GETs are claimed earlier by
// handleFetchEvent via event.respondWith(), so the precached HTML shell can never
// be served for an API or asset request.
registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: 'navigation-cache',
    networkTimeoutSeconds: 5,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 1,
        maxAgeSeconds: 60 * 60 * 24, // 1 day
      }),
      // FE-HIGH-058: precache-bound cold-offline fallback. `index.html` is the
      // manifest key VitePWA injects (base '/mobile/'); the plugin resolves it
      // through the default PrecacheController, so a cold offline navigation
      // serves the precached shell instead of a blank page.
      new PrecacheFallbackPlugin({ fallbackURL: 'index.html' }),
    ],
  }),
);

// Static assets — CacheFirst (content-hashed filenames make this safe).
registerRoute(
  ({ url }) => /\.(?:js|css|woff2?)$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'static-cache',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
      }),
    ],
  }),
);

// Images — StaleWhileRevalidate.
registerRoute(
  ({ url }) => /\.(?:png|jpg|jpeg|gif|webp)$/.test(url.pathname),
  new StaleWhileRevalidate({
    cacheName: 'image-cache',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
      }),
    ],
  }),
);

// WHY: AquaMobil is mounted at /mobile (BrowserRouter basename). The service
// worker must use the same base path when opening windows or matching existing
// clients — otherwise notification clicks navigate to /messages/... which does
// not resolve to the React app. This constant is the single source of truth for
// the SW ↔ client routing contract.
const APP_BASENAME = '/mobile';

// ============================================================================
// Background Sync: offline message queue
// ============================================================================

// WHY: registerMessagingSync() was removed — it was orphaned dead code with no
// call site. Background sync registration is now handled by queueOperation() in
// offline-queue.ts, which registers both 'sync-operations' and 'sync-messages'
// tags inline when an operation is queued. One registration site, one owner.

/**
 * Sync event handler — invoked by the browser when connectivity is restored.
 * Posts SYNC_COMPLETE to all active clients so the OfflineProvider triggers
 * a queue refresh and auto-sync via syncAllOperations().
 *
 * WHY SYNC_COMPLETE and not SYNC_MESSAGES: The OfflineProvider's service worker
 * message listener handles 'SYNC_COMPLETE'. Using a single event type ensures
 * ALL queued operations (messaging + farm + HR) are flushed through the single
 * authoritative sync engine — no separate messaging-only drain path.
 */
function handleSyncEvent(event: ExtendableEvent & { tag: string }): void {
  if (event.tag === 'sync-messages' || event.tag === 'sync-operations') {
    event.waitUntil(notifyClientsToSync());
  }
}

async function notifyClientsToSync(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
  for (const client of clients) {
    // WHY: SYNC_COMPLETE is the event the OfflineProvider listens for.
    // Previously this posted SYNC_MESSAGES which was silently dropped,
    // leaving messaging operations stranded after background sync fired.
    client.postMessage({ type: 'SYNC_COMPLETE' });
  }
}

// ============================================================================
// Notification Click Handler
// ============================================================================

/** UUID v4 pattern for validating opaque notificationRef values. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Navigate to messaging with an opaque notificationRef when clicked.
 * The authenticated app resolves the ref before opening a channel.
 *
 * NOTE: FCM notifications shown by firebase-messaging-sw.js fire THAT worker's
 * own notificationclick handler. This handler covers notifications shown by
 * this workbox SW (e.g. local/badge notifications).
 */
function handleNotificationClick(event: NotificationEvent): void {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const rawNotificationRef = (event.notification.data as { notificationRef?: string })?.notificationRef;
  const notificationRef =
    rawNotificationRef && UUID_PATTERN.test(rawNotificationRef)
      ? rawNotificationRef
      : undefined;
  // WHY: openWindow() operates on absolute browser paths, not React Router
  // relative paths. The APP_BASENAME prefix ensures the URL resolves to the
  // AquaMobil SPA so React Router can handle the /messages/* route.
  const targetUrl = notificationRef
    ? `${APP_BASENAME}/messages?notificationRef=${encodeURIComponent(notificationRef)}`
    : `${APP_BASENAME}/messages`;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an existing window if one is open
      for (const client of clients) {
        // WHY: Match against APP_BASENAME + /messages to avoid false positives
        // from other apps that might also have /messages in their URL.
        if (client.url.includes(`${APP_BASENAME}/messages`) && 'focus' in client) {
          client.postMessage({
            type: 'NAVIGATE_TO_NOTIFICATION_REF',
            notificationRef,
          });
          return client.focus();
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(targetUrl);
    }),
  );
}

// ============================================================================
// Cache Strategies — GraphQL pass-through + media
// ============================================================================

/** Messaging GraphQL endpoint pattern. */
const GRAPHQL_PATTERN = /\/graphql$/;
/** Media/attachment URL pattern. */
const MEDIA_PATTERN = /\/(messaging|media)\//;

/**
 * Fetch event handler with messaging-specific cache strategies:
 * - Pass-through for GraphQL (authenticated responses must NEVER be cached)
 * - StaleWhileRevalidate for media files (images, documents)
 *
 * NOTE: This listener runs BEFORE workbox's registerRoute router for these
 * specific URL shapes (GraphQL POST, /messaging/ and /media/ GETs) because it
 * calls event.respondWith() first. All other requests fall through to the
 * registerRoute rules above.
 */
function handleFetchEvent(event: FetchEvent): void {
  const url = new URL(event.request.url);

  // SEC: Never cache authenticated GraphQL POST responses — pass through directly.
  // Caching GraphQL responses risks leaking authenticated data to the next user
  // on shared devices. All GraphQL requests go straight to the network.
  if (GRAPHQL_PATTERN.test(url.pathname) && event.request.method === 'POST') {
    event.respondWith(fetch(event.request));
    return;
  }

  // StaleWhileRevalidate for media/attachment files
  if (MEDIA_PATTERN.test(url.pathname) && event.request.method === 'GET') {
    event.respondWith(staleWhileRevalidateStrategy(event.request));
    return;
  }
}

async function staleWhileRevalidateStrategy(request: Request): Promise<Response> {
  const cacheName = 'messaging-media-v1';
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request.clone()).then((networkResponse) => {
    if (networkResponse.ok) {
      void cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  }).catch((error: unknown) => {
    logger.error('[sw-revalidate] background cache revalidation failed', error);
    return undefined;
  });

  if (cached) {
    // Serve from cache immediately, revalidate in background
    void fetchPromise; // fire-and-forget — void suppresses unhandled promise warning
    return cached;
  }

  // No cache — must wait for network
  const networkResponse = await fetchPromise;
  return networkResponse ?? new Response('Offline', { status: 503 });
}

// ============================================================================
// Event Listener Registration
// ============================================================================

self.addEventListener('sync', handleSyncEvent as EventListener);
self.addEventListener('notificationclick', handleNotificationClick as EventListener);
self.addEventListener('fetch', handleFetchEvent as EventListener);

// ============================================================================
// C-FE-01: Logout cache clearing
// On shared devices, authenticated GraphQL responses cached by the service
// worker must be purged on logout so the next user cannot access prior user's
// data. Main thread calls: navigator.serviceWorker.ready.then(r =>
//   r.active?.postMessage({ type: 'LOGOUT' }))
// This is wired in useAuth.tsx's logout action.
// ============================================================================

self.addEventListener('message', ((event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string })?.type === 'LOGOUT') {
    event.waitUntil(clearMessagingCaches());
  }
}) as EventListener);

async function clearMessagingCaches(): Promise<void> {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((k) => k.startsWith('messaging-'))
      .map((k) => caches.delete(k)),
  );
}
