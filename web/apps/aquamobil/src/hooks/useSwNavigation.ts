import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { RESOLVE_NOTIFICATION_REF } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';

/**
 * Service worker message event types that trigger in-app navigation.
 *
 * WHY: The messaging service worker posts navigation events when a push
 * notification is clicked and an existing AquaMobil window is focused.
 * Without a client-side listener for these events the user sees the focused
 * window but stays on whatever page they were on — the deep-link intent from
 * the notification is silently dropped.
 *
 * This is the SINGLE registration point for all SW-to-client navigation
 * events. Adding a new navigation event type requires:
 *   1. Adding a case to the handler below
 *   2. Posting the event in messaging-sw.ts (or another SW module)
 */

/** Shape of the NAVIGATE_TO_CHANNEL message posted by the messaging SW. */
interface NavigateToChannelMessage {
  type: 'NAVIGATE_TO_CHANNEL';
  channelId?: string;
}

interface NavigateToNotificationRefMessage {
  type: 'NAVIGATE_TO_NOTIFICATION_REF';
  notificationRef?: string;
}

/** Union of all SW navigation message types. Extend as new event types are added. */
type SwNavigationMessage = NavigateToChannelMessage | NavigateToNotificationRefMessage;

/** Type guard: narrows unknown MessageEvent data to a known SW navigation message. */
function isSwNavigationMessage(data: unknown): data is SwNavigationMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as { type?: unknown };
  return msg.type === 'NAVIGATE_TO_CHANNEL' || msg.type === 'NAVIGATE_TO_NOTIFICATION_REF';
}

interface ResolveNotificationRefResponse {
  resolveNotificationRef: {
    channelId: string;
    messageId: string;
  } | null;
}

/**
 * Listens for navigation-intent messages from the service worker and
 * translates them into React Router navigations.
 *
 * IMPORTANT: This hook MUST be rendered inside the BrowserRouter so
 * useNavigate() has access to the router context. It is mounted once in
 * App.tsx — do NOT duplicate this listener elsewhere.
 *
 * @see messaging-sw.ts handleNotificationClick — posts NAVIGATE_TO_CHANNEL
 */
export function useSwNavigation(): void {
  const navigate = useNavigate();

  useEffect(() => {
    const resolveAndNavigate = (notificationRef?: string): void => {
      if (!notificationRef) {
        navigate('/messages');
        return;
      }

      void graphqlRequest<ResolveNotificationRefResponse>(RESOLVE_NOTIFICATION_REF, {
        notificationRef,
      })
        .then((data) => {
          const resolved = data.resolveNotificationRef;
          if (!resolved) {
            navigate('/messages', { replace: true });
            return;
          }
          navigate(`/messages/${resolved.channelId}`, { replace: true });
        })
        .catch(() => {
          navigate('/messages', { replace: true });
        });
    };

    const initialNotificationRef = new URLSearchParams(window.location.search).get(
      'notificationRef',
    );
    if (initialNotificationRef) {
      resolveAndNavigate(initialNotificationRef);
    }

    if (!('serviceWorker' in navigator)) return;

    const handleMessage = (event: MessageEvent): void => {
      if (!isSwNavigationMessage(event.data)) return;

      switch (event.data.type) {
        case 'NAVIGATE_TO_CHANNEL': {
          // WHY: navigate() uses React Router relative paths (relative to
          // basename). The SW already focused this window — we just need to
          // route to the correct page within the SPA.
          const path = event.data.channelId ? `/messages/${event.data.channelId}` : '/messages';
          navigate(path);
          break;
        }
        case 'NAVIGATE_TO_NOTIFICATION_REF':
          resolveAndNavigate(event.data.notificationRef);
          break;
        // Future SW navigation events go here as additional cases.
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handleMessage);
    };
  }, [navigate]);
}
