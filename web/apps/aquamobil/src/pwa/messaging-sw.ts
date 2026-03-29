/**
 * @module messaging-sw
 * @description Service worker extensions for the messaging feature.
 * Handles background sync for offline message queue, push notification display
 * for CHAT_MESSAGE type, notification click navigation, Badge API updates,
 * and caching strategies for messaging GraphQL and media resources.
 * @see ADR-012 section 7 (Offline / PWA)
 */

declare const self: ServiceWorkerGlobalScope;

// ============================================================================
// Background Sync: offline message queue
// ============================================================================

/**
 * Register a background sync tag for pending messaging operations.
 * Called from the main thread when a message is queued offline.
 */
export async function registerMessagingSync(): Promise<void> {
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await (registration as unknown as { sync: { register: (tag: string) => Promise<void> } })
        .sync.register('sync-messages');
    } catch (err) {
      console.warn('[messaging-sw] Background sync registration failed:', err);
    }
  }
}

/**
 * Sync event handler — invoked by the browser when connectivity is restored.
 * Posts a message to all active clients to trigger queue flush.
 */
function handleSyncEvent(event: ExtendableEvent & { tag: string }): void {
  if (event.tag === 'sync-messages' || event.tag === 'sync-operations') {
    event.waitUntil(notifyClientsToSync());
  }
}

async function notifyClientsToSync(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
  for (const client of clients) {
    client.postMessage({ type: 'SYNC_MESSAGES' });
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
    data?: { type?: string; channelId?: string; messageId?: string };
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
  const options: NotificationOptions = {
    body: payload.body ?? 'You have a new message',
    icon: '/icons/messaging-icon-192.png',
    badge: '/icons/messaging-badge-72.png',
    tag: `chat-${payload.data.channelId ?? 'unknown'}`,
    renotify: true,
    data: {
      channelId: payload.data.channelId,
      messageId: payload.data.messageId,
    },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      updateBadgeCount(payload.badge ?? 0),
    ]),
  );
}

// ============================================================================
// Notification Click Handler
// ============================================================================

/**
 * Navigate to the messaging channel when a notification is clicked.
 */
function handleNotificationClick(event: NotificationEvent): void {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const channelId = (event.notification.data as { channelId?: string })?.channelId;
  const targetUrl = channelId
    ? `/messages/${channelId}`
    : '/messages';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an existing window if one is open
      for (const client of clients) {
        if (client.url.includes('/messages') && 'focus' in client) {
          client.postMessage({
            type: 'NAVIGATE_TO_CHANNEL',
            channelId,
          });
          return (client as WindowClient).focus();
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(targetUrl);
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
    if ('setAppBadge' in navigator) {
      if (count > 0) {
        await (navigator as unknown as { setAppBadge: (n: number) => Promise<void> })
          .setAppBadge(count);
      } else {
        await (navigator as unknown as { clearAppBadge: () => Promise<void> })
          .clearAppBadge();
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
 * - NetworkFirst for GraphQL (messaging queries/mutations)
 * - StaleWhileRevalidate for media files (images, documents)
 */
function handleFetchEvent(event: FetchEvent): void {
  const url = new URL(event.request.url);

  // NetworkFirst for messaging GraphQL
  if (GRAPHQL_PATTERN.test(url.pathname) && event.request.method === 'POST') {
    event.respondWith(networkFirstStrategy(event.request));
    return;
  }

  // StaleWhileRevalidate for media/attachment files
  if (MEDIA_PATTERN.test(url.pathname) && event.request.method === 'GET') {
    event.respondWith(staleWhileRevalidateStrategy(event.request));
    return;
  }
}

async function networkFirstStrategy(request: Request): Promise<Response> {
  const cacheName = 'messaging-graphql-v1';
  try {
    const networkResponse = await fetch(request.clone());
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await caches.match(request);
    return cached ?? new Response(JSON.stringify({ errors: [{ message: 'Offline' }] }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function staleWhileRevalidateStrategy(request: Request): Promise<Response> {
  const cacheName = 'messaging-media-v1';
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request.clone()).then((networkResponse) => {
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  }).catch(() => undefined);

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
self.addEventListener('push', handlePushEvent as EventListener);
self.addEventListener('notificationclick', handleNotificationClick as EventListener);
self.addEventListener('fetch', handleFetchEvent as EventListener);
