/* eslint-disable no-undef */
/**
 * Firebase Cloud Messaging Service Worker
 *
 * FE-HIGH-008: importScripts() in service workers does not support SRI
 * attributes. Mitigation layers:
 *   1. Pin exact Firebase SDK version (no range, no "latest")
 *   2. CSP in the HTML shell restricts script-src to 'self' + gstatic.com
 *   3. Service worker fetch scope limits requests to same-origin
 *
 * IMPORTANT: When upgrading Firebase SDK, update the version below AND
 * re-verify the SHA-256 hash of the hosted files at:
 * https://www.gstatic.com/firebasejs/{VERSION}/firebase-app-compat.js
 *
 * Verified hashes (Firebase 10.8.0):
 *   firebase-app-compat.js:     sha256-<generate-at-build-time>
 *   firebase-messaging-compat.js: sha256-<generate-at-build-time>
 *
 * @see FE-HIGH-008
 */

// SECURITY: Pin exact version — never use ranges or "latest"
const FIREBASE_VERSION = '10.8.0';
importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-compat.js`);
importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-messaging-compat.js`);

firebase.initializeApp({
  apiKey: self.__FIREBASE_CONFIG__?.apiKey,
  projectId: self.__FIREBASE_CONFIG__?.projectId,
  messagingSenderId: self.__FIREBASE_CONFIG__?.messagingSenderId,
  appId: self.__FIREBASE_CONFIG__?.appId,
});

const messaging = firebase.messaging();

/**
 * SECURITY: FE-HIGH-009 — Validate notification click URL before navigating.
 * Only allow same-origin or explicitly allowed origins.
 */
const ALLOWED_ORIGINS = new Set([
  self.location.origin,
  'https://app.suderra.com',
  'https://aquamobil.suderra.com',
]);

function isAllowedNotificationUrl(url) {
  if (!url || typeof url !== 'string') return false;

  // Relative paths are always safe
  if (url.startsWith('/') && !url.startsWith('//')) return true;

  try {
    const parsed = new URL(url, self.location.origin);
    return ALLOWED_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};

  // FE-HIGH-009: Validate any URL in the notification data
  const notificationData = { ...payload.data };
  if (notificationData.url && !isAllowedNotificationUrl(notificationData.url)) {
    delete notificationData.url;
  }

  self.registration.showNotification(title || 'Notification', {
    body: body || 'You have a new notification',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: notificationData,
  });
});

/**
 * Handle notification click — validate URL before navigating.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || event.notification.data?.route;

  if (url && isAllowedNotificationUrl(url)) {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clientList) => {
        // Focus existing window if available
        for (const client of clientList) {
          if (client.url === url && 'focus' in client) {
            return client.focus();
          }
        }
        // Open new window
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
      })
    );
  } else {
    // No URL or blocked URL — open app root
    event.waitUntil(
      self.clients.openWindow('/')
    );
  }
});
