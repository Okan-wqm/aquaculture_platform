/// <reference lib="webworker" />

/**
 * @module messaging-sw
 * @description Service worker extensions for the messaging feature.
 * Handles background sync for offline message queue, push notification display
 * for CHAT_MESSAGE type, notification click navigation, Badge API updates,
 * and caching strategies for messaging GraphQL and media resources.
 * @see ADR-012 section 7 (Offline / PWA)
 */

export {};

const sw = self as unknown as ServiceWorkerGlobalScope & typeof globalThis;

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
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: false });
  for (const client of clients) {
    // WHY: SYNC_COMPLETE is the event the OfflineProvider listens for.
    // Previously this posted SYNC_MESSAGES which was silently dropped,
    // leaving messaging operations stranded after background sync fired.
    client.postMessage({ type: 'SYNC_COMPLETE' });
  }
}

// ============================================================================
// Push Notification Handler
// ============================================================================

/**
 * Handle incoming push notifications for CHAT_MESSAGE type.
 * SECURITY: Push payload never contains message content — only metadata.
 */
function handlePushEvent(event: PushEvent): void {
  if (!event.data) return;

  let payload: {
    title?: string;
    body?: string;
    data?: { type?: string; notificationRef?: string };
    badge?: number;
  };

  try {
    payload = event.data.json() as typeof payload;
  } catch {
    return;
  }

  // Only handle CHAT_MESSAGE notifications
  if (payload.data?.type !== 'CHAT_MESSAGE') return;

  const title = payload.title ?? 'New Message';
  const options: NotificationOptions & {
    renotify?: boolean;
    actions?: Array<{ action: string; title: string; icon?: string }>;
  } = {
    body: payload.body ?? 'You have a new message',
    icon: '/icons/messaging-icon-192.png',
    badge: '/icons/messaging-badge-72.png',
    tag: `chat-${payload.data.notificationRef ?? 'unknown'}`,
    renotify: true,
    data: {
      notificationRef: payload.data.notificationRef,
    },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    Promise.all([
      sw.registration.showNotification(title, options),
      updateBadgeCount(payload.badge ?? 0),
    ]),
  );
}

// ============================================================================
// Notification Click Handler
// ============================================================================

const MAX_NOTIFICATION_REF_LENGTH = 128;

/**
 * Navigate to the messaging channel when a notification is clicked.
 */
function handleNotificationClick(event: NotificationEvent): void {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const rawNotificationRef = (event.notification.data as { notificationRef?: string })
    ?.notificationRef;
  const notificationRef =
    typeof rawNotificationRef === 'string' &&
    rawNotificationRef.length > 0 &&
    rawNotificationRef.length <= MAX_NOTIFICATION_REF_LENGTH
      ? rawNotificationRef
      : undefined;
  // WHY: openWindow() operates on absolute browser paths, not React Router
  // relative paths. The APP_BASENAME prefix ensures the URL resolves to the
  // AquaMobil SPA so React Router can handle the /messages/* route.
  const targetUrl = notificationRef
    ? `${APP_BASENAME}/messages?notificationRef=${encodeURIComponent(notificationRef)}`
    : `${APP_BASENAME}/messages`;

  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an existing window if one is open
      for (const client of clients) {
        // WHY: Match against APP_BASENAME + /messages to avoid false positives
        // from other apps that might also have /messages in their URL.
        if (client.url.includes(`${APP_BASENAME}/messages`) && 'focus' in client) {
          client.postMessage({
            type: 'NAVIGATE_TO_NOTIFICATION_REF',
            notificationRef,
          });
          return (client as WindowClient).focus();
        }
      }
      // Otherwise open a new window
      return sw.clients.openWindow(targetUrl);
    }),
  );
}

// ============================================================================
// Badge API
// ============================================================================

/**
 * Update the app badge count with unread message count.
 * Falls back gracefully if the Badge API is not supported.
 */
async function updateBadgeCount(count: number): Promise<void> {
  try {
    const badgeNavigator = sw.navigator as unknown as {
      setAppBadge?: (n: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };

    if (badgeNavigator.setAppBadge) {
      if (count > 0) {
        await badgeNavigator.setAppBadge(count);
      } else {
        await badgeNavigator.clearAppBadge?.();
      }
    }
  } catch {
    // Badge API not available — no-op
  }
}

// ============================================================================
// Cache Strategies
// ============================================================================

/** Messaging GraphQL endpoint pattern. */
const GRAPHQL_PATTERN = /\/graphql$/;
/** Media/attachment URL pattern. */
const MEDIA_PATTERN = /\/(messaging|media)\//;

/**
 * Fetch event handler with messaging-specific cache strategies:
 * - Pass-through for GraphQL (authenticated responses must NEVER be cached)
 * - StaleWhileRevalidate for media files (images, documents)
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

  const fetchPromise = fetch(request.clone())
    .then((networkResponse) => {
      if (networkResponse.ok) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => undefined);

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

sw.addEventListener('sync', handleSyncEvent as EventListener);
sw.addEventListener('push', handlePushEvent as EventListener);
sw.addEventListener('notificationclick', handleNotificationClick as EventListener);
sw.addEventListener('fetch', handleFetchEvent as EventListener);

// ============================================================================
// C-FE-01: Logout cache clearing
// On shared devices, authenticated GraphQL responses cached by the service
// worker must be purged on logout so the next user cannot access prior user's
// data. Main thread calls: navigator.serviceWorker.ready.then(r =>
//   r.active?.postMessage({ type: 'LOGOUT' }))
// This is wired in the auth store's logout action (authStore.logout()).
// ============================================================================

sw.addEventListener('message', ((event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string })?.type === 'LOGOUT') {
    event.waitUntil(clearMessagingCaches());
  }
}) as EventListener);

async function clearMessagingCaches(): Promise<void> {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith('messaging-')).map((k) => caches.delete(k)));
}
