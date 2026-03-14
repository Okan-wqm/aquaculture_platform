import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from './useAuth';
import type { InAppNotification } from '@/types';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { PUSH_NOTIFICATION_EVENT } from './useFirebaseMessaging';
import {
  GET_MY_NOTIFICATIONS,
  GET_UNREAD_COUNT,
  MARK_NOTIFICATION_READ,
  MARK_ALL_READ,
} from '@/graphql/operations';

// D07 PERF-01: Polling reduced from 60s to 300s (5 minutes).
// FCM push messages trigger an immediate refetch via the PUSH_NOTIFICATION_EVENT
// custom event, so the long polling interval is only a fallback for environments
// where FCM is not configured or permission was denied.
const POLL_INTERVAL_MS = 300_000; // 5 minutes

export function useNotifications() {
  const { isAuthenticated } = useAuth();
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const result = await graphqlRequest<{ myNotifications: InAppNotification[] }>(
        GET_MY_NOTIFICATIONS,
        { limit: 50 },
      );
      if (result?.myNotifications) {
        setNotifications(result.myNotifications);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const result = await graphqlRequest<{ unreadNotificationCount: number }>(GET_UNREAD_COUNT);
      if (result != null && typeof result.unreadNotificationCount === 'number') {
        setUnreadCount(result.unreadNotificationCount);
      }
    } catch {
      // silently fail
    }
  }, []);

  const refetch = useCallback(async () => {
    await Promise.all([fetchNotifications(), fetchUnreadCount()]);
  }, [fetchNotifications, fetchUnreadCount]);

  const markAsRead = useCallback(
    async (id: string) => {
      try {
        await graphqlRequest(MARK_NOTIFICATION_READ, { id });
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n)),
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch {
        // silently fail — don't apply optimistic update on error
      }
    },
    [],
  );

  const markAllAsRead = useCallback(async () => {
    try {
      await graphqlRequest(MARK_ALL_READ);
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, isRead: true, readAt: new Date().toISOString() })),
      );
      setUnreadCount(0);
    } catch {
      // silently fail — don't apply optimistic update on error
    }
  }, []);

  // Initial fetch + polling every 5 minutes (fallback)
  useEffect(() => {
    if (!isAuthenticated) return;

    refetch();

    intervalRef.current = setInterval(() => {
      fetchUnreadCount();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isAuthenticated, refetch, fetchUnreadCount]);

  // D07 PERF-01: Listen for FCM foreground push events and refetch immediately.
  // This replaces the aggressive 60s polling with event-driven updates.
  useEffect(() => {
    if (!isAuthenticated) return;

    const handlePushNotification = () => {
      refetch();
    };

    window.addEventListener(PUSH_NOTIFICATION_EVENT, handlePushNotification);

    return () => {
      window.removeEventListener(PUSH_NOTIFICATION_EVENT, handlePushNotification);
    };
  }, [isAuthenticated, refetch]);

  return { notifications, unreadCount, loading, markAsRead, markAllAsRead, refetch };
}
