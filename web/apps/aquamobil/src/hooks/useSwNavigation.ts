import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

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

/**
 * MOB-MEDIUM-007: posted by the FCM SW when an alert notification (or its
 * Acknowledge action button) is tapped while an app window is open. The
 * authenticated app performs the ack via /alerts?ack=<id> (offline-safe).
 */
interface NavigateToAlertsMessage {
  type: 'NAVIGATE_TO_ALERTS';
  alertId?: string;
  acknowledge?: boolean;
}

/** Union of all SW navigation message types. Extend as new event types are added. */
type SwNavigationMessage =
  | NavigateToChannelMessage
  | NavigateToNotificationRefMessage
  | NavigateToAlertsMessage;

/** Type guard: narrows unknown MessageEvent data to a known SW navigation message. */
function isSwNavigationMessage(data: unknown): data is SwNavigationMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as { type?: unknown };
  return (
    msg.type === 'NAVIGATE_TO_CHANNEL' ||
    msg.type === 'NAVIGATE_TO_NOTIFICATION_REF' ||
    msg.type === 'NAVIGATE_TO_ALERTS'
  );
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
    if (!('serviceWorker' in navigator)) return;

    const handleMessage = (event: MessageEvent): void => {
      if (!isSwNavigationMessage(event.data)) return;

      switch (event.data.type) {
        case 'NAVIGATE_TO_CHANNEL': {
          // WHY: navigate() uses React Router relative paths (relative to
          // basename). The SW already focused this window — we just need to
          // route to the correct page within the SPA.
          const path = event.data.channelId
            ? `/messages/${event.data.channelId}`
            : '/messages';
          navigate(path);
          break;
        }
        case 'NAVIGATE_TO_NOTIFICATION_REF': {
          const path = event.data.notificationRef
            ? `/messages?notificationRef=${encodeURIComponent(event.data.notificationRef)}`
            : '/messages';
          navigate(path);
          break;
        }
        case 'NAVIGATE_TO_ALERTS': {
          const { alertId, acknowledge } = event.data;
          const path =
            acknowledge && alertId
              ? `/alerts?ack=${encodeURIComponent(alertId)}`
              : '/alerts';
          navigate(path);
          break;
        }
        // Future SW navigation events go here as additional cases.
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handleMessage);
    };
  }, [navigate]);
}
