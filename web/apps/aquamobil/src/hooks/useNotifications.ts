import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from './useAuth';
import type { InAppNotification, GraphQLResponse } from '@/types';
import {
  GET_MY_NOTIFICATIONS,
  GET_UNREAD_COUNT,
  MARK_NOTIFICATION_READ,
  MARK_ALL_READ,
} from '@/graphql/operations';

export function useNotifications() {
  const { accessToken, isAuthenticated } = useAuth();
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const executeGraphQL = useCallback(
    async <T>(query: string, variables?: Record<string, unknown>): Promise<T | null> => {
      if (!accessToken) return null;

      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) return null;

      const result: GraphQLResponse<T> = await response.json();
      if (result.errors?.length) return null;

      return result.data ?? null;
    },
    [accessToken],
  );

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const result = await executeGraphQL<{ myNotifications: InAppNotification[] }>(
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
  }, [executeGraphQL]);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const result = await executeGraphQL<{ unreadNotificationCount: number }>(GET_UNREAD_COUNT);
      if (result != null && typeof result.unreadNotificationCount === 'number') {
        setUnreadCount(result.unreadNotificationCount);
      }
    } catch {
      // silently fail
    }
  }, [executeGraphQL]);

  const refetch = useCallback(async () => {
    await Promise.all([fetchNotifications(), fetchUnreadCount()]);
  }, [fetchNotifications, fetchUnreadCount]);

  const markAsRead = useCallback(
    async (id: string) => {
      try {
        const result = await executeGraphQL(MARK_NOTIFICATION_READ, { id });
        if (result == null) return;
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n)),
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch {
        // silently fail — don't apply optimistic update on error
      }
    },
    [executeGraphQL],
  );

  const markAllAsRead = useCallback(async () => {
    try {
      const result = await executeGraphQL(MARK_ALL_READ);
      if (result == null) return;
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, isRead: true, readAt: new Date().toISOString() })),
      );
      setUnreadCount(0);
    } catch {
      // silently fail — don't apply optimistic update on error
    }
  }, [executeGraphQL]);

  // Initial fetch + polling every 60 seconds
  useEffect(() => {
    if (!isAuthenticated) return;

    refetch();

    intervalRef.current = setInterval(() => {
      fetchUnreadCount();
    }, 60_000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isAuthenticated, refetch, fetchUnreadCount]);

  return { notifications, unreadCount, loading, markAsRead, markAllAsRead, refetch };
}
