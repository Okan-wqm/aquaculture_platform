import type { Messaging } from 'firebase/messaging';
import { useEffect, useRef, useCallback } from 'react';

import { useAuth } from './useAuth';

import { authenticatedFetch } from '@/services/authenticated-fetch';
import { registerPushTeardown } from '@/services/push-lifecycle';

// Firebase config from env vars
const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

const REGISTER_DEVICE_TOKEN_MUTATION = `
  mutation RegisterDeviceToken($token: String!, $platform: String!) {
    registerDeviceToken(token: $token, platform: $platform)
  }
`;

// MT-HIGH-050: deregister the device token on logout so push for the prior
// tenant/user never reaches the next user on this shared device.
const UNREGISTER_DEVICE_TOKEN_MUTATION = `
  mutation UnregisterDeviceToken($token: String!) {
    unregisterDeviceToken(token: $token)
  }
`;

/**
 * Foreground push payload shape we read. Structurally typed (not `any`) so the
 * read sites are type-checked without importing firebase's MessagePayload into
 * the eager bundle. Mirrors the subset of firebase/messaging's MessagePayload
 * this hook consumes.
 */
interface ForegroundPushPayload {
  notification?: { title?: string; body?: string };
  data?: Record<string, string>;
}

function isFirebaseConfigured(): boolean {
  return !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.messagingSenderId && FIREBASE_CONFIG.appId);
}

/** Custom event name dispatched when a foreground push notification arrives. */
export const PUSH_NOTIFICATION_EVENT = 'push-notification';

export interface PushNotificationDetail {
  title: string;
  body: string;
  taskId?: string;
  data?: Record<string, string>;
}

/**
 * Activates Firebase Cloud Messaging for the current authenticated user.
 */
export function useFirebaseMessaging(): void {
  const { accessToken, isAuthenticated, user } = useAuth();
  const registeredRef = useRef(false);
  const previousTokenRef = useRef<string | null>(null);
  // MT-HIGH-050: hold the live messaging instance so the logout teardown can
  // call FCM deleteToken() on the same instance that minted the token.
  const messagingRef = useRef<Messaging | null>(null);

  const handleForegroundMessage = useCallback((payload: ForegroundPushPayload) => {
    const notification = payload.notification ?? {};
    const data = payload.data ?? {};

    const detail: PushNotificationDetail = {
      title: notification.title ?? data.title ?? 'Notification',
      body: notification.body ?? data.body ?? '',
      taskId: data.taskId,
      data,
    };

    window.dispatchEvent(
      new CustomEvent(PUSH_NOTIFICATION_EVENT, { detail }),
    );
  }, []);

  // Reset registration when user changes (logout or different user login).
  // MT-HIGH-050: also drop the teardown registration — by the time auth has
  // flipped to unauthenticated the teardown has already run inside logout(),
  // so clearing it here just prevents a stale teardown bound to a deleted token
  // from lingering until the next sign-in.
  useEffect(() => {
    if (!isAuthenticated || !accessToken) {
      registeredRef.current = false;
      previousTokenRef.current = null;
      messagingRef.current = null;
      registerPushTeardown(null);
    }
  }, [isAuthenticated, accessToken]);

  useEffect(() => {
    if (!isAuthenticated || !accessToken || !user?.id || registeredRef.current) return;
    if (!isFirebaseConfigured()) return;
    if (typeof Notification === 'undefined') return;

    const activeUserId = user.id;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      try {
        const { initializeApp, getApps } = await import('firebase/app');
        const { getMessaging, getToken, onMessage, deleteToken } = await import('firebase/messaging');

        // Reuse the already-initialized Firebase app if present (a second
        // initializeApp with the same name throws). Destructure rather than
        // index-with-`!` so the "no app yet" branch is expressed by `?? init`.
        const [existingApp] = getApps();
        const app = existingApp ?? initializeApp(FIREBASE_CONFIG);
        const messaging = getMessaging(app);
        messagingRef.current = messaging;

        // FE-CRITICAL-050-SW / FE-HIGH-057: Register the FCM service worker
        // EXPLICITLY and hand that registration to getToken(), so Firebase uses
        // ITS OWN worker for push rather than the page's controlling worker.
        //
        // WHY a DISTINCT sub-scope (not the /mobile base scope):
        //   1. getToken() with no serviceWorkerRegistration auto-registers
        //      `/firebase-messaging-sw.js` at the ROOT scope. AquaMobil is served
        //      behind `location /mobile/ { proxy_pass http://aquamobil/; }`, so the
        //      root path is NOT routed to this app — the auto-registered root SW
        //      404s and background push silently dies.
        //   2. The workbox SW (dist/messaging-sw.js, registered by
        //      virtual:pwa-register) ALREADY owns scope `/mobile/`. A
        //      ServiceWorker registration is keyed by SCOPE, so registering a
        //      DIFFERENT script at the identical `/mobile/` scope does not give
        //      "two SWs at one scope" — it REPLACES the registration, evicting the
        //      workbox SW (breaking precache/offline) or being evicted by it
        //      (breaking push), depending on activation order. That is the very
        //      dual-SW collision this finding must resolve, not relocate.
        //
        // FIX: register the FCM worker at a DISTINCT deeper scope
        // `/mobile/firebase-cloud-messaging-push-scope` — mirroring Firebase's own
        // default `/firebase-cloud-messaging-push-scope` convention. The FCM worker
        // never needs to control navigations; it only holds the push subscription,
        // so a non-navigated sub-scope is sufficient and provably cannot collide
        // with the workbox SW that controls `/mobile/`. Two SWs, two scripts, two
        // disjoint scopes.
        //
        // The Firebase config can't be read via import.meta.env inside a static
        // SW file, so it is passed as URL query params the SW parses on load
        // (the canonical static-SW FCM pattern), replacing the old broken
        // postMessage-to-the-wrong-SW approach.
        const fcmRegistration = await (async () => {
          if (!('serviceWorker' in navigator)) return undefined;
          const swParams = new URLSearchParams({
            apiKey: FIREBASE_CONFIG.apiKey ?? '',
            projectId: FIREBASE_CONFIG.projectId ?? '',
            messagingSenderId: FIREBASE_CONFIG.messagingSenderId ?? '',
            appId: FIREBASE_CONFIG.appId ?? '',
          });
          const base = import.meta.env.BASE_URL; // '/mobile/'
          return navigator.serviceWorker.register(
            `${base}firebase-messaging-sw.js?${swParams.toString()}`,
            { scope: `${base}firebase-cloud-messaging-push-scope` },
          );
        })();

        // MT-HIGH-050 (tier-1 backstop): tell the FCM SW which user is active so
        // it can drop a background push minted for a different user on this shared
        // device. Posted to the FCM registration's worker (active ?? installing),
        // not the page's controlling workbox SW.
        const fcmWorker = fcmRegistration?.active ?? fcmRegistration?.installing;
        fcmWorker?.postMessage({ type: 'SET_ACTIVE_USER', userId: activeUserId });

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const token = await getToken(messaging, {
          vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined,
          serviceWorkerRegistration: fcmRegistration,
        });

        if (token) {
          // Only register if token is new or changed
          if (token !== previousTokenRef.current) {
            // A failed registration is non-fatal — push simply won't arrive and
            // the app stays fully functional. There is no logger sink in this
            // PWA (and the surrounding hooks likewise swallow non-fatal
            // background failures), so the HTTP result is not inspected/logged.
            // Record the token as last-attempted regardless, so it is not
            // re-POSTed on every render.
            await authenticatedFetch('/graphql', {
              method: 'POST',
              body: JSON.stringify({
                query: REGISTER_DEVICE_TOKEN_MUTATION,
                variables: { token, platform: 'web' },
              }),
            });
            previousTokenRef.current = token;
          }

          registeredRef.current = true;

          // MT-HIGH-050: register the logout teardown for THIS token. logout()
          // awaits runPushTeardown() while the session is still valid, so both
          // the server-side mapping (unregisterDeviceToken) and the local FCM
          // subscription (deleteToken) are removed before the next user can log
          // in. deleteToken() invalidates the subscription so the device stops
          // receiving push for the prior tenant immediately, even if the network
          // unregister call were to fail.
          registerPushTeardown(async () => {
            const activeMessaging = messagingRef.current;
            // MT-MEDIUM-051: tell the FCM SW the session ended so it clears the
            // persisted active user (in-memory + IndexedDB). Without this the SW's
            // gate keeps the prior user active across a logout, and a background
            // push for that user could surface to the next user on this shared
            // device before the token deregistration below propagates. Posted
            // first, and never allowed to block the token teardown.
            try {
              const fcmWorker = fcmRegistration?.active ?? fcmRegistration?.installing;
              fcmWorker?.postMessage({ type: 'LOGOUT' });
            } catch {
              // postMessage is best-effort; the token teardown below is the
              // authoritative stop for push to the prior session.
            }
            try {
              await authenticatedFetch('/graphql', {
                method: 'POST',
                body: JSON.stringify({
                  query: UNREGISTER_DEVICE_TOKEN_MUTATION,
                  variables: { token },
                }),
              });
            } finally {
              // Always drop the local FCM subscription even if the server call
              // failed — a phone that keeps a live subscription to tenant-A's
              // token is the leak this finding closes.
              if (activeMessaging) {
                await deleteToken(activeMessaging);
              }
              previousTokenRef.current = null;
              registeredRef.current = false;
              messagingRef.current = null;
            }
          });
        }

        // Listen for foreground messages
        unsubscribe = onMessage(messaging, handleForegroundMessage);
      } catch {
        // FCM setup is best-effort: a failure degrades to no-push (the app
        // stays fully functional), never an app error. No logger sink exists in
        // this PWA, matching the silent non-fatal handling above.
      }
    })();

    return () => {
      unsubscribe?.();
    };
  }, [isAuthenticated, accessToken, user?.id, handleForegroundMessage]);
}
