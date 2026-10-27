import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuth } from './useAuth';
import { useOfflineCacheScope } from './useOfflineCacheScope';

import { GET_MY_TASKS } from '@/graphql/operations';
import { readThroughOfflineCache } from '@/pwa/offline-cache';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Task } from '@/types';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';


type Segment = 'today' | 'upcoming' | 'overdue';

/** Return shape of {@link useMyTasks}. */
export interface UseMyTasksReturn {
  /** Tasks filtered to the requested segment. */
  tasks: Task[];
  /** True during the initial fetch. */
  loading: boolean;
  /** Human-readable error message, or null. */
  error: string | null;
  /** Manually re-run the underlying query (TanStack Query refetch). */
  refetch: UseQueryResult<Task[], Error>['refetch'];
}

function filterBySegment(tasks: Task[], segment: Segment): Task[] {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  switch (segment) {
    case 'today':
      return tasks.filter(
        (t) => t.dueDate?.split('T')[0] === todayStr && t.status !== 'COMPLETED' && t.status !== 'CANCELLED',
      );
    case 'upcoming':
      return tasks.filter(
        (t) => t.dueDate?.split('T')[0] > todayStr && t.status !== 'COMPLETED' && t.status !== 'CANCELLED',
      );
    case 'overdue':
      return tasks.filter(
        (t) => t.status === 'OVERDUE' || (t.dueDate?.split('T')[0] < todayStr && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'),
      );
    default:
      return tasks;
  }
}

export function useMyTasks(segment: Segment = 'today'): UseMyTasksReturn {
  const { accessToken, tenantId, user, isAuthenticated } = useAuth();
  const cacheScope = useOfflineCacheScope();

  const query = useQuery<Task[]>({
    // WHY 2026-04-29: task actions invalidate `myTasks`; this hook must be a
    // React Query read model, not isolated local state, or completed/started
    // tasks stay stale until manual remount.
    // SECURITY (MT-CRITICAL-051): user.id is in the key because GET_MY_TASKS
    // returns the CURRENT user's private tasks — without it, user A's tasks
    // would be served to user B of the same tenant on a shared device.
    queryKey: createTenantQueryKey(tenantId, 'myTasks', user?.id),
    queryFn: async () => {
      if (!tenantId || !user?.id) return [];

      // SECURITY (MT-CRITICAL-051): the offline cache scope is per user
      // (MOB-MEDIUM-031), and its copy stands in only when the server is unreachable.
      const read = await readThroughOfflineCache(
        cacheScope,
        { key: 'myTasks', ttlMs: 1000 * 60 * 30 }, // 30 min TTL
        async (): Promise<Task[]> => {
          const result = await graphqlRequest(GET_MY_TASKS, {
            status: ['PENDING', 'IN_PROGRESS', 'OVERDUE'],
          });
          return result.myTasks || [];
        },
      );
      return read.data;
    },
    enabled: isAuthenticated && !!accessToken && !!tenantId && !!user?.id,
    staleTime: 30_000,
    gcTime: 1000 * 60 * 30,
  });

  const tasks = useMemo(
    () => filterBySegment(query.data ?? [], segment),
    [query.data, segment],
  );

  return {
    tasks,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
  };
}
