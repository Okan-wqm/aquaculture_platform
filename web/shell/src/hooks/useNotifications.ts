/**
 * useNotifications Hook
 *
 * Fetches and manages in-app notifications for the desktop shell.
 * Uses the shared-ui graphqlClient for authenticated requests
 * with automatic token refresh and tenant context.
 *
 * Polling: unread count is polled every 60 seconds as a lightweight
 * fallback. Full notification list is fetched on-demand when the
 * panel is opened.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { graphqlClient, useAuthContext } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

export interface InAppNotification {
  id: string;
  title: string;
  body: string;
  isRead: boolean;
  readAt?: string;
  /** JSON-encoded metadata (notification type, entity IDs, etc.) */
  data?: string;
  createdAt: string;
}

/** Parsed notification data payload */
export interface NotificationData {
  type?: string;
  entityId?: string;
  entityType?: string;
  route?: string;
  [key: string]: unknown;
}

// ============================================================================
// GraphQL Operations
// ============================================================================

const GET_MY_NOTIFICATIONS = `
  query GetMyNotifications($unreadOnly: Boolean, $limit: Int) {
    myNotifications(unreadOnly: $unreadOnly, limit: $limit) {
      id
      title
      body
      isRead
      readAt
      data
      createdAt
    }
  }
`;

const GET_UNREAD_COUNT = `
  query GetUnreadNotificationCount {
    unreadNotificationCount
  }
`;

const MARK_NOTIFICATION_READ = `
  mutation MarkNotificationAsRead($id: ID!) {
    markNotificationAsRead(id: $id)
  }
`;

const MARK_ALL_READ = `
  mutation MarkAllNotificationsAsRead {
    markAllNotificationsAsRead
  }
`;

// ============================================================================
// Constants
// ============================================================================

/** Poll unread count every 60 seconds */
const UNREAD_POLL_INTERVAL_MS = 60_000;

/** Maximum notifications to fetch per page */
const DEFAULT_LIMIT = 50;

// ============================================================================
// Hook
// ============================================================================

export function useNotifications() {
  const { user } = useAuthContext();
  const isAuthenticated = !!user;

  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --------------------------------------------------------------------------
  // Fetch helpers
  // --------------------------------------------------------------------------

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const result = await graphqlClient.request<{
        myNotifications: InAppNotification[];
      }>(GET_MY_NOTIFICATIONS, { limit: DEFAULT_LIMIT });

      if (result?.myNotifications) {
        setNotifications(result.myNotifications);
      }
    } catch {
      // Silently fail — notification fetch should never block the UI
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const result = await graphqlClient.request<{
        unreadNotificationCount: number;
      }>(GET_UNREAD_COUNT);

      if (result != null && typeof result.unreadNotificationCount === 'number') {
        setUnreadCount(result.unreadNotificationCount);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const refetch = useCallback(async () => {
    await Promise.all([fetchNotifications(), fetchUnreadCount()]);
  }, [fetchNotifications, fetchUnreadCount]);

  // --------------------------------------------------------------------------
  // Mutations (optimistic updates)
  // --------------------------------------------------------------------------

  const markAsRead = useCallback(async (id: string) => {
    try {
      await graphqlClient.request(MARK_NOTIFICATION_READ, { id });
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n,
        ),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      // Silently fail — optimistic update only applied on success
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    try {
      await graphqlClient.request(MARK_ALL_READ);
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, isRead: true, readAt: new Date().toISOString() })),
      );
      setUnreadCount(0);
    } catch {
      // Silently fail
    }
  }, []);

  // --------------------------------------------------------------------------
  // Polling & lifecycle
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!isAuthenticated) return;

    // Initial fetch
    fetchUnreadCount();

    // Poll unread count as a lightweight fallback
    intervalRef.current = setInterval(() => {
      fetchUnreadCount();
    }, UNREAD_POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isAuthenticated, fetchUnreadCount]);

  // --------------------------------------------------------------------------
  // Utility: parse data JSON
  // --------------------------------------------------------------------------

  const parseNotificationData = useCallback(
    (notification: InAppNotification): NotificationData | null => {
      if (!notification.data) return null;
      try {
        return JSON.parse(notification.data) as NotificationData;
      } catch {
        return null;
      }
    },
    [],
  );

  return {
    notifications,
    unreadCount,
    loading,
    markAsRead,
    markAllAsRead,
    refetch,
    fetchNotifications,
    parseNotificationData,
  };
}
