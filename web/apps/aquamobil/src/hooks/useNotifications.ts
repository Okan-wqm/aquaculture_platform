// ============================================================================
// useNotifications — in-app notification bell: count + list with unified cadence
// ============================================================================
//
// FE-MEDIUM-053: this hook used to run a bespoke 300s setInterval over local
// useState, while the message-badge (useUnreadCount) used a 60s react-query
// poll. The two unread surfaces could therefore disagree for up to ~5 minutes
// after a read/new-message with no disclosure. The fix converges BOTH surfaces
// onto ONE cache (the shared QueryClient), ONE cadence (~60s), and ONE
// invalidation contract:
//   - both queries live under the tenant query-key root (createTenantQueryKey)
//     in the SAME QueryClient as the message badge,
//   - both poll at the SAME 60s refetchInterval with refetchIntervalInBackground
//     false (a backgrounded PWA does not poll),
//   - the FCM PUSH handler invalidates the notification keys AND the messaging
//     unreadCount key together, and useMessageSocket's unreadCount invalidations
//     also nudge the notification keys — so the bell and the badge tick together.
// markAsRead / markAllAsRead stay optimistic (react-query mutations with onMutate
// + rollback) so the UX is unchanged, now invalidated consistently.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useAuth } from './useAuth';
import { PUSH_NOTIFICATION_EVENT } from './useFirebaseMessaging';

import {
  GET_MY_NOTIFICATIONS,
  GET_UNREAD_COUNT,
  MARK_NOTIFICATION_READ,
  MARK_ALL_READ,
} from '@/graphql/operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { InAppNotification } from '@/types';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// FE-MEDIUM-053: single 60s cadence shared with the message badge (useUnreadCount).
// FCM push triggers an immediate invalidation, so the poll is only a fallback for
// environments where FCM is not configured or permission was denied.
const POLL_INTERVAL_MS = 60_000;

interface UseNotificationsResult {
  notifications: InAppNotification[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
  // FE-LOW-051: the unread COUNT fetch can fail independently of the list. When
  // it does, the bell must NOT render a confident "0" (which reads as "all
  // caught up") — it should fall back to a neutral "unread unavailable"
  // affordance. `unreadCount` stays a number for the success path (optimistic
  // markAsRead/markAllAsRead writes are unaffected); `isCountError` is the
  // parallel signal the bell consumer opts into, and `unreadCountError` carries
  // the message for diagnostics.
  unreadCountError: string | null;
  isCountError: boolean;
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  refetch: () => Promise<void>;
}

export function useNotifications(): UseNotificationsResult {
  const { isAuthenticated, tenantId } = useAuth();
  const queryClient = useQueryClient();

  // The tenant-scoped keys for the two notification surfaces. Held as variables
  // for the positional setQueryData/getQueryData calls (which read/write the same
  // cache entries); the `queryKey:` property sites inline createTenantQueryKey(...)
  // directly so the no-bare-tenant-query-key rule can statically prove the factory
  // is used (FE-CRITICAL-001 discipline).
  const listKey = createTenantQueryKey(tenantId, 'notifications', 'list');
  const countKey = createTenantQueryKey(tenantId, 'notifications', 'unreadCount');

  const listQuery = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'notifications', 'list'),
    queryFn: async (): Promise<InAppNotification[]> => {
      const result = await graphqlRequest<{ myNotifications: InAppNotification[] }>(
        GET_MY_NOTIFICATIONS,
        { limit: 50 },
      );
      return result.myNotifications ?? [];
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const countQuery = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'notifications', 'unreadCount'),
    queryFn: async (): Promise<number> => {
      const result = await graphqlRequest<{ unreadNotificationCount: number }>(GET_UNREAD_COUNT);
      return typeof result.unreadNotificationCount === 'number'
        ? result.unreadNotificationCount
        : 0;
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  // markAsRead — optimistic: flip the one notification to read and decrement the
  // count in cache BEFORE the network settles; roll BOTH back on error.
  const markAsReadMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await graphqlRequest(MARK_NOTIFICATION_READ, { id });
    },
    onMutate: async (id: string) => {
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: createTenantQueryKey(tenantId, 'notifications', 'list'),
        }),
        queryClient.cancelQueries({
          queryKey: createTenantQueryKey(tenantId, 'notifications', 'unreadCount'),
        }),
      ]);
      const previousList = queryClient.getQueryData<InAppNotification[]>(listKey);
      const previousCount = queryClient.getQueryData<number>(countKey);
      queryClient.setQueryData<InAppNotification[]>(listKey, (old) =>
        (old ?? []).map((n) =>
          n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n,
        ),
      );
      queryClient.setQueryData<number>(countKey, (old) => Math.max(0, (old ?? 0) - 1));
      return { previousList, previousCount };
    },
    onError: (_err, _id, context) => {
      // Roll back the optimistic write so a failed mark does not leave a stale
      // "read" state in the cache.
      if (context?.previousList !== undefined) {
        queryClient.setQueryData(listKey, context.previousList);
      }
      if (context?.previousCount !== undefined) {
        queryClient.setQueryData(countKey, context.previousCount);
      }
    },
  });

  // markAllAsRead — optimistic: flip every notification to read, zero the count.
  const markAllAsReadMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      await graphqlRequest(MARK_ALL_READ);
    },
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: createTenantQueryKey(tenantId, 'notifications', 'list'),
        }),
        queryClient.cancelQueries({
          queryKey: createTenantQueryKey(tenantId, 'notifications', 'unreadCount'),
        }),
      ]);
      const previousList = queryClient.getQueryData<InAppNotification[]>(listKey);
      const previousCount = queryClient.getQueryData<number>(countKey);
      queryClient.setQueryData<InAppNotification[]>(listKey, (old) =>
        (old ?? []).map((n) => ({ ...n, isRead: true, readAt: new Date().toISOString() })),
      );
      queryClient.setQueryData<number>(countKey, 0);
      return { previousList, previousCount };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousList !== undefined) {
        queryClient.setQueryData(listKey, context.previousList);
      }
      if (context?.previousCount !== undefined) {
        queryClient.setQueryData(countKey, context.previousCount);
      }
    },
  });

  // FE-MEDIUM-053: a single FCM foreground push refreshes BOTH unread surfaces in
  // one tick — the notification bell AND the message badge — collapsing the prior
  // up-to-5-minute divergence. Invalidating (not refetching directly) lets the
  // shared QueryClient drive a single coherent refresh of every consumer.
  useEffect(() => {
    if (!isAuthenticated || !tenantId) return;

    const handlePushNotification = (): void => {
      void queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'notifications', 'list'),
      });
      void queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'notifications', 'unreadCount'),
      });
      // Converge the message badge in the same tick so the two surfaces agree.
      void queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'messaging', 'unreadCount'),
      });
    };

    window.addEventListener(PUSH_NOTIFICATION_EVENT, handlePushNotification);
    return () => {
      window.removeEventListener(PUSH_NOTIFICATION_EVENT, handlePushNotification);
    };
    // listKey/countKey are derived from tenantId; depending on tenantId keeps the
    // handler bound to the current tenant's keys without re-subscribing per render.
  }, [isAuthenticated, tenantId, queryClient, listKey, countKey]);

  const markAsRead = async (id: string): Promise<void> => {
    await markAsReadMutation.mutateAsync(id);
  };

  const markAllAsRead = async (): Promise<void> => {
    await markAllAsReadMutation.mutateAsync();
  };

  const refetch = async (): Promise<void> => {
    await Promise.all([listQuery.refetch(), countQuery.refetch()]);
  };

  // FE-LOW-051: distinguish a real "0 unread" from "the count fetch failed".
  // countQuery.data is undefined while the count query is in error (no successful
  // result yet), so `isCountError` keys on the query's error state, not on the
  // numeric value. `unreadCount` keeps its `?? 0` success default so numeric
  // consumers and the optimistic mark-read setQueryData writes are untouched.
  const isCountError = countQuery.isError;
  const unreadCountError = countQuery.error instanceof Error ? countQuery.error.message : null;

  return {
    notifications: listQuery.data ?? [],
    unreadCount: countQuery.data ?? 0,
    loading: listQuery.isLoading,
    // BUG-09 preserved: surface the list query error so the UI can render an
    // error state + Retry. react-query's error is an Error | null.
    error: listQuery.error instanceof Error ? listQuery.error.message : null,
    unreadCountError,
    isCountError,
    markAsRead,
    markAllAsRead,
    refetch,
  };
}
