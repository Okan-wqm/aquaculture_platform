/* eslint-disable no-undef */
/**
 * Firebase Cloud Messaging Service Worker
 *
 * FE-HIGH-008 / SEC-MEDIUM-052: importScripts() in service workers does not
 * support SRI attributes, so the gstatic-hosted Firebase SDK is loaded without a
 * per-file integrity hash. The in-repo defense-in-depth that ACTUALLY exists
 * today is:
 *   1. Pin the exact Firebase SDK version below (no range, no "latest"), so the
 *      fetched script URL is deterministic and cannot silently float forward.
 *   2. Same-origin sub-scope registration — this worker only controls
 *      `/mobile/firebase-cloud-messaging-push-scope` (see useFirebaseMessaging),
 *      it does not control navigations.
 *
 * NOT YET IN PLACE — a real Content-Security-Policy. A prior version of this
 * comment claimed "CSP in the HTML shell restricts script-src to 'self' +
 * gstatic.com". That CSP DOES NOT EXIST: there is no meta-tag CSP in this repo,
 * and a meta-tag CSP could not enforce `worker-src` / `script-src` on this SW's
 * importScripts anyway. The enforcing CSP must be served as an HTTP RESPONSE
 * HEADER by the gateway/nginx vhost fronting `location /mobile/` — which is
 * OUTSIDE this repo. That gap is tracked as SEC-MEDIUM-052 (BLOCKED-ON-INFRA);
 * the exact required header + server-block location + owner/deadline are recorded
 * in docs/reviews/aquamobil-e2e-audit/2026-06-13-findings.md#SEC-MEDIUM-052. Do
 * NOT add a meta-tag CSP here — it would be a placebo that gives false assurance.
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
 * @see SEC-MEDIUM-052
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

/** UUID v4 pattern for validating opaque notificationRef values. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// MSG-CRITICAL-056: the active session userId is PERSISTED in this worker's own
// IndexedDB, not just an in-memory variable. A service worker is terminated
// aggressively between events; an in-memory `activeUserId` resets to null on the
// next cold start, so a legitimate background push arriving at a freshly-woken
// worker had a null active user and was DROPPED by the gate (background push
// silently dead after any SW eviction). IndexedDB survives termination, so the
// gate stays authoritative across the worker's whole lifecycle. The in-memory
// cache is a fast path only; IndexedDB is the durable source of truth.
const IDB_NAME = 'aquamobil-fcm';
const IDB_STORE = 'session';
const IDB_ACTIVE_USER_KEY = 'activeUserId';
let activeUserIdCache = null;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRun(mode, run) {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, mode);
        const store = tx.objectStore(IDB_STORE);
        let result;
        const req = run(store);
        if (req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      }),
  );
}

async function setActiveUser(userId) {
  activeUserIdCache = userId;
  try {
    await idbRun('readwrite', (store) => store.put(userId, IDB_ACTIVE_USER_KEY));
  } catch {
    // Best-effort persistence — the in-memory cache still gates this session.
  }
}

async function clearActiveUser() {
  activeUserIdCache = null;
  try {
    await idbRun('readwrite', (store) => store.delete(IDB_ACTIVE_USER_KEY));
  } catch {
    // Best-effort — a failed clear is covered by device-token deregistration.
  }
}

async function getActiveUser() {
  if (activeUserIdCache !== null) return activeUserIdCache;
  try {
    const persisted = await idbRun('readonly', (store) => store.get(IDB_ACTIVE_USER_KEY));
    if (typeof persisted === 'string') {
      activeUserIdCache = persisted;
      return persisted;
    }
  } catch {
    // IndexedDB unavailable — fall through to "no active user" (fail-closed).
  }
  return null;
}

// MT-HIGH-050 / MT-MEDIUM-051: learn the active session user from SET_ACTIVE_USER
// and clear it on LOGOUT. AquaMobil runs on SHARED devices, so a push minted for
// user A may arrive at a device now logged into user B if the device token was not
// yet deregistered. A push whose payload userId does not match the active user is
// DROPPED by the gate. The writes go through IndexedDB (see above) so they survive
// worker termination; event.waitUntil keeps the worker alive until the write lands.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SET_ACTIVE_USER' && typeof data.userId === 'string') {
    event.waitUntil(setActiveUser(data.userId));
  } else if (data.type === 'LOGOUT') {
    event.waitUntil(clearActiveUser());
  }
});

/**
 * MT-HIGH-050: decide whether a push targeted at `payloadUserId` may be shown on
 * this device given the active session. A push with NO userId (legacy/broadcast)
 * is always allowed; a push WITH a userId is shown only when it matches the
 * active session. When no session is active (logged out) a user-targeted push is
 * dropped — there is no recipient to show it to. Async because the active user is
 * read from IndexedDB (durable across worker termination).
 */
async function isPushForActiveUser(payloadUserId) {
  if (!payloadUserId) return true;
  const active = await getActiveUser();
  return payloadUserId === active;
}

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
  // FE-HIGH-009: Validate any URL in the notification data
  const notificationData = { ...payload.data };
  if (notificationData.url && !isAllowedNotificationUrl(notificationData.url)) {
    delete notificationData.url;
  }

  // MSG-CRITICAL-056: the messaging chat push is a DATA-ONLY FCM message (no
  // `notification` block), so title/body/badge are carried in `data` and this SW
  // is the sole presenter. Read from data first, falling back to the notification
  // block for any legacy notification-bearing push.
  const notif = payload.notification || {};
  const title = notificationData.title || notif.title || 'Notification';
  const body = notificationData.body || notif.body || 'You have a new notification';

  // MSG-MEDIUM-069: the numeric unread count is carried in `data.badge` (a count),
  // NOT the webpush badge field (an icon URL). Parsing the icon-URL field as a
  // number yielded NaN → the app badge was cleared to 0 on every push.
  const badgeCount = Number.parseInt(notificationData.badge ?? '', 10);

  // MT-HIGH-050: drop a push whose intended recipient is not the active session.
  // Resolving without showNotification suppresses the banner on a shared device
  // that has switched users. The gate is async (reads the persisted active user),
  // so the whole handler returns a promise the Firebase SDK awaits.
  return isPushForActiveUser(notificationData.userId).then((allowed) => {
    if (!allowed) {
      return Promise.resolve();
    }
    // FE-CRITICAL-050-SW: icon must point at a real asset under the /mobile base;
    // the numeric app badge is driven by the Badge API in updateBadgeCount(), not
    // a notification `badge:` image field.
    return Promise.all([
      self.registration.showNotification(title, {
        body,
        icon: `${APP_BASENAME}/icons/icon-192x192.png`,
        data: notificationData,
      }),
      updateBadgeCount(Number.isFinite(badgeCount) ? badgeCount : 0),
    ]);
  });
});

/**
 * Handle notification click — validate URL before navigating.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};

  // MSG-HIGH-069: the messaging chat push carries an opaque `notificationRef`
  // (never a channelId/messageId — those must not leak through FCM's servers).
  // Deep-link by opening `/messages?notificationRef=…`; the authenticated app
  // resolves the ref over its socket and routes to the channel. This mirrors the
  // workbox SW's handler (messaging-sw.ts) so a chat push tapped while the FCM SW
  // is the active worker deep-links instead of dropping the user at the app root.
  const rawRef = data.notificationRef;
  const notificationRef = rawRef && UUID_PATTERN.test(rawRef) ? rawRef : undefined;

  if (notificationRef) {
    const targetUrl = new URL(
      `${APP_BASENAME}/messages?notificationRef=${encodeURIComponent(notificationRef)}`,
      self.location.origin,
    ).href;
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) {
          // Focus an already-open AquaMobil window and hand it the ref to resolve.
          if (client.url.includes(`${APP_BASENAME}/messages`) && 'focus' in client) {
            client.postMessage({ type: 'NAVIGATE_TO_NOTIFICATION_REF', notificationRef });
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
    );
    return;
  }

  const rawUrl = data.url || data.route;

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
