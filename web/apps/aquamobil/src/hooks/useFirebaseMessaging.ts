import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from './useAuth';
import { authenticatedFetch } from '@/services/authenticated-fetch';

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
export function useFirebaseMessaging() {
  const { accessToken, isAuthenticated } = useAuth();
  const registeredRef = useRef(false);
  const previousTokenRef = useRef<string | null>(null);

  const handleForegroundMessage = useCallback((payload: any) => {
    const notification = payload?.notification ?? {};
    const data = payload?.data ?? {};

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

  // Reset registration when user changes (logout or different user login)
  useEffect(() => {
    if (!isAuthenticated || !accessToken) {
      registeredRef.current = false;
      previousTokenRef.current = null;
    }
  }, [isAuthenticated, accessToken]);

  useEffect(() => {
    if (!isAuthenticated || !accessToken || registeredRef.current) return;
    if (!isFirebaseConfigured()) return;
    if (typeof Notification === 'undefined') return;

    let unsubscribe: (() => void) | null = null;

    (async () => {
      try {
        const { initializeApp, getApps } = await import('firebase/app');
        const { getMessaging, getToken, onMessage } = await import('firebase/messaging');

        const app = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApps()[0]!;
        const messaging = getMessaging(app);

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

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const token = await getToken(messaging, {
          vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined,
          serviceWorkerRegistration: fcmRegistration,
        });

        if (token) {
          // Only register if token is new or changed
          if (token !== previousTokenRef.current) {
            const response = await authenticatedFetch('/graphql', {
              method: 'POST',
              body: JSON.stringify({
                query: REGISTER_DEVICE_TOKEN_MUTATION,
                variables: { token, platform: 'web' },
              }),
            });

            if (!response.ok) {
              console.warn('Failed to register device token:', response.status);
            }

            previousTokenRef.current = token;
          }

          registeredRef.current = true;
        }

        // Listen for foreground messages
        unsubscribe = onMessage(messaging, handleForegroundMessage);
      } catch (err) {
        console.warn('Firebase messaging setup failed:', err);
      }
    })();

    return () => {
      unsubscribe?.();
    };
  }, [isAuthenticated, accessToken, handleForegroundMessage]);
}
