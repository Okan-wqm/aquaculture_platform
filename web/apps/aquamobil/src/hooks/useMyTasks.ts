import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuth } from './useAuth';

import { GET_MY_TASKS } from '@/graphql/operations';
import { cacheUserData, getCachedUserData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Task } from '@/types';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';
import { userScopedCacheKey } from '@/utils/user-scoped-cache-key';


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

      // SECURITY (MT-CRITICAL-051): per-user offline cache namespace.
      const cacheKey = userScopedCacheKey(user.id, 'myTasks');
      try {
        const result = await graphqlRequest(
          GET_MY_TASKS,
          { status: ['PENDING', 'IN_PROGRESS', 'OVERDUE'] },
        );

        const tasks = result.myTasks || [];
        await cacheUserData(tenantId, cacheKey, tasks, 1000 * 60 * 30); // 30 min TTL
        return tasks;
      } catch (err) {
        // Try loading from cache on error
        const cached = await getCachedUserData<Task[]>(tenantId, cacheKey);
        if (cached) {
          return cached;
        }
        throw err;
      }
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
