import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from './useAuth';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import type { Task, GraphQLResponse } from '@/types';
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
  const { accessToken, isAuthenticated } = useAuth();
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasFetchedRef = useRef(false);

  const fetchTasks = useCallback(async () => {
    if (!accessToken) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          query: GET_MY_TASKS,
          variables: { status: ['PENDING', 'IN_PROGRESS', 'OVERDUE'] },
        }),
      });

      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

      const result: GraphQLResponse<{ myTasks: Task[] }> = await response.json();
      if (result.errors?.length) throw new Error(result.errors[0]?.message || 'GraphQL error');

      const tasks = result.data?.myTasks || [];
      setAllTasks(tasks);
      await cacheData('myTasks', tasks, 1000 * 60 * 30); // 30 min TTL
    } catch (err) {
      // Try loading from cache on error
      const cached = await getCachedData<Task[]>('myTasks');
      if (cached) {
        setAllTasks(cached);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load tasks');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (isAuthenticated && !hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchTasks();
    }
  }, [isAuthenticated, fetchTasks]);

  const tasks = filterBySegment(allTasks, segment);

  return { tasks, loading, error, refetch: fetchTasks };
}
