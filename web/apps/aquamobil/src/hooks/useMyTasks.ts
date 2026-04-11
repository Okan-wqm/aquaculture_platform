import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from './useAuth';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import type { Task } from '@/types';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { GET_MY_TASKS } from '@/graphql/operations';


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
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasFetchedRef = useRef(false);

  const fetchTasks = useCallback(async () => {
    if (!accessToken || !tenantId) return;

    setLoading(true);
    setError(null);

    try {
      const result = await graphqlRequest<{ myTasks: Task[] }>(
        GET_MY_TASKS,
        { status: ['PENDING', 'IN_PROGRESS', 'OVERDUE'] },
      );

      const tasks = result.myTasks || [];
      setAllTasks(tasks);
      // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated caching
      await cacheData(tenantId, 'myTasks', tasks, 1000 * 60 * 30); // 30 min TTL
    } catch (err) {
      // Try loading from cache on error
      const cached = tenantId ? await getCachedData<Task[]>(tenantId, 'myTasks') : null;
      if (cached) {
        setAllTasks(cached);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load tasks');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, tenantId]);

  useEffect(() => {
    if (isAuthenticated && !hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchTasks();
    }
  }, [isAuthenticated, fetchTasks]);

  const tasks = filterBySegment(allTasks, segment);

  return { tasks, loading, error, refetch: fetchTasks };
}
