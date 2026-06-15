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

// FE-CRITICAL-050-SW: Read the Firebase config from THIS worker's own
// registration URL query params. A static SW cannot read import.meta.env, and
// the previous self-global config object was never assigned (the app posted
// FIREBASE_CONFIG to the workbox SW, not this one), so initializeApp always
// received undefined values and FCM never worked. useFirebaseMessaging registers
// this file as `${BASE_URL}firebase-messaging-sw.js?apiKey=...` so the values
// arrive here at load time.
const SW_CONFIG = new URL(self.location.href).searchParams;

// FE-CRITICAL-050-SW: AquaMobil is served behind `location /mobile/` on the outer
// reverse proxy, so every SW-issued navigation and asset reference MUST carry the
// `/mobile/` base — the bare origin root is NOT routed to this app. This mirrors
// APP_BASENAME in the workbox SW (src/pwa/messaging-sw.ts), the single routing
// contract both workers share. Notification clicks that fall back to the app root,
// and the notification icon, both resolve through this base.
const APP_BASENAME = '/mobile';

firebase.initializeApp({
  apiKey: SW_CONFIG.get('apiKey') || undefined,
  projectId: SW_CONFIG.get('projectId') || undefined,
  messagingSenderId: SW_CONFIG.get('messagingSenderId') || undefined,
  appId: SW_CONFIG.get('appId') || undefined,
});

const messaging = firebase.messaging();

/**
 * Update the app badge count with the unread count carried in the push payload.
 * FE-CRITICAL-050-SW: the Badge API update moved here from the workbox SW. Badge
 * updates are driven by push delivery, and push is delivered through THIS FCM
 * worker — a `push` listener in the workbox SW would never fire for FCM messages.
 */
async function updateBadgeCount(count) {
  try {
    if (typeof count !== 'number') return;
    if (self.navigator && self.navigator.setAppBadge) {
      if (count > 0) {
        await self.navigator.setAppBadge(count);
      } else if (self.navigator.clearAppBadge) {
        await self.navigator.clearAppBadge();
      }
    }
  } catch {
    // Badge API not available — no-op
  }
}

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

  // FE-CRITICAL-050-SW: drive the app badge from the unread count carried in the
  // push payload (string-encoded over the wire), if present.
  // onBackgroundMessage's callback is NOT an ExtendableEvent (the Firebase SDK
  // owns the underlying push event's waitUntil), so we return the combined
  // promise for the SDK to keep the worker alive while these settle.
  const badgeCount = Number.parseInt(notificationData.badge ?? '', 10);

  return Promise.all([
    self.registration.showNotification(title || 'Notification', {
      body: body || 'You have a new notification',
      // FE-CRITICAL-050-SW: icon must point at a real asset under the /mobile base.
      // The HEAD baseline referenced a 192px icon at the bare origin root with a
      // filename that does not exist (the only PNG icons shipped are the
      // icon-192x192 / icon-512x512 pair under public/icons), so notifications
      // rendered with no icon. The `badge:` field (the monochrome status-bar glyph)
      // likewise pointed at a non-existent 72px asset and is dropped; the numeric
      // app badge is driven by the Badge API in updateBadgeCount() below, not this
      // notification field.
      icon: `${APP_BASENAME}/icons/icon-192x192.png`,
      data: notificationData,
    }),
    updateBadgeCount(Number.isFinite(badgeCount) ? badgeCount : 0),
  ]);
});

/**
 * Handle notification click — validate URL before navigating.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const rawUrl = event.notification.data?.url || event.notification.data?.route;

  if (rawUrl && isAllowedNotificationUrl(rawUrl)) {
    // FE-CRITICAL-050-SW: notification data carries app-relative paths (e.g.
    // `/messages/123`). openWindow() and client.url are browser-absolute, so a
    // relative path must be resolved against the /mobile base before navigating
    // or matching — otherwise it targets the unrouted origin root and the
    // `client.url === url` focus check never matches.
    const targetPath = rawUrl.startsWith('/') ? `${APP_BASENAME}${rawUrl}` : rawUrl;
    const targetUrl = new URL(targetPath, self.location.origin).href;

    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clientList) => {
        // Focus existing window if available
        for (const client of clientList) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        // Open new window
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
    );
  } else {
    // No URL or blocked URL — open the app root UNDER the /mobile base. Opening
    // the bare origin root '/' would land on a path the outer reverse proxy never
    // routes to AquaMobil (a 404), so a tapped push would navigate nowhere.
    event.waitUntil(
      self.clients.openWindow(`${APP_BASENAME}/`)
    );
  }
});
