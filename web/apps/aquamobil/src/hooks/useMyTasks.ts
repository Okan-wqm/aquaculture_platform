import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import type { Task } from '@/types';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { GET_MY_TASKS } from '@/graphql/operations';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';


type Segment = 'today' | 'upcoming' | 'overdue';

function filterBySegment(tasks: Task[], segment: Segment): Task[] {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0]!;

  switch (segment) {
    case 'today':
      return tasks.filter(
        (t) => t.dueDate?.split('T')[0] === todayStr && t.status !== 'COMPLETED' && t.status !== 'CANCELLED',
      );
    case 'upcoming':
      return tasks.filter(
        (t) => t.dueDate?.split('T')[0]! > todayStr && t.status !== 'COMPLETED' && t.status !== 'CANCELLED',
      );
    case 'overdue':
      return tasks.filter(
        (t) => t.status === 'OVERDUE' || (t.dueDate?.split('T')[0]! < todayStr && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'),
      );
    default:
      return tasks;
  }
}

export function useMyTasks(segment: Segment = 'today') {
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  const query = useQuery<Task[]>({
    // WHY 2026-04-29: task actions invalidate `myTasks`; this hook must be a
    // React Query read model, not isolated local state, or completed/started
    // tasks stay stale until manual remount.
    queryKey: createTenantQueryKey(tenantId, 'myTasks', tenantId),
    queryFn: async () => {
      if (!tenantId) return [];
      try {
        const result = await graphqlRequest<{ myTasks: Task[] }>(
          GET_MY_TASKS,
          { status: ['PENDING', 'IN_PROGRESS', 'OVERDUE'] },
        );

        const tasks = result.myTasks || [];
        // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated caching
        await cacheData(tenantId, 'myTasks', tasks, 1000 * 60 * 30); // 30 min TTL
        return tasks;
      } catch (err) {
        // Try loading from cache on error
        const cached = await getCachedData<Task[]>(tenantId, 'myTasks');
        if (cached) {
          return cached;
        }
        throw err;
      }
    },
    enabled: isAuthenticated && !!accessToken && !!tenantId,
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
