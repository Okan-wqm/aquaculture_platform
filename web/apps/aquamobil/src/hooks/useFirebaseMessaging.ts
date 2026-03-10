import { useEffect, useRef } from 'react';
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

export function useFirebaseMessaging(onForegroundMessage?: (payload: unknown) => void) {
  const { accessToken, isAuthenticated } = useAuth();
  const registeredRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || !accessToken || registeredRef.current) return;
    if (!isFirebaseConfigured()) return;

    let unsubscribe: (() => void) | null = null;

    (async () => {
      try {
        // Dynamic import to avoid bundling firebase when not configured
        const { initializeApp, getApps } = await import('firebase/app');
        const { getMessaging, getToken, onMessage } = await import('firebase/messaging');

        const app = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApps()[0]!;
        const messaging = getMessaging(app);

        // Inject config into service worker scope for background messages
        if ('serviceWorker' in navigator) {
          const registration = await navigator.serviceWorker.ready;
          const active = registration.active as any;
          if (active) {
            active.__FIREBASE_CONFIG__ = FIREBASE_CONFIG;
          }
        }

        // Request notification permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        // Get FCM token
        const token = await getToken(messaging, {
          vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined,
        });

        if (token) {
          // Register token with backend
          await fetch('/graphql', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: JSON.stringify({
              query: REGISTER_DEVICE_TOKEN_MUTATION,
              variables: { token, platform: 'WEB' },
            }),
          });

          registeredRef.current = true;
        }

        // Listen for foreground messages
        unsubscribe = onMessage(messaging, (payload: unknown) => {
          onForegroundMessage?.(payload);
        });
      } catch (err) {
        // Graceful degradation — push notifications are not critical
        console.warn('Firebase messaging setup failed:', err);
      }
    })();

    return () => {
      unsubscribe?.();
    };
  }, [isAuthenticated, accessToken, onForegroundMessage]);
}
