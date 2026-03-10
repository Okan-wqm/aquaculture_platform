import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from './useAuth';

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
      title: notification.title ?? data.title ?? 'Bildirim',
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

        // Send Firebase config to service worker
        if ('serviceWorker' in navigator) {
          const registration = await navigator.serviceWorker.ready;
          if (registration.active) {
            registration.active.postMessage({
              type: 'FIREBASE_CONFIG',
              config: FIREBASE_CONFIG,
            });
          }
        }

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const token = await getToken(messaging, {
          vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined,
        });

        if (token) {
          // Only register if token is new or changed
          if (token !== previousTokenRef.current) {
            const response = await fetch('/graphql', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
                'X-Requested-With': 'XMLHttpRequest',
              },
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
