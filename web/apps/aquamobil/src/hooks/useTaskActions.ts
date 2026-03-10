import { useCallback } from 'react';
import { useAuth } from './useAuth';
import { useOfflineQueue } from './useOfflineQueue';
import type { GraphQLResponse } from '@/types';
import {
  COMPLETE_TASK,
  START_TASK,
  TOGGLE_CHECKLIST_ITEM,
  ADD_TASK_NOTE,
} from '@/graphql/operations';

export function useTaskActions() {
  const { accessToken } = useAuth();
  const { addToQueue } = useOfflineQueue();

  const executeGraphQL = useCallback(
    async <T>(query: string, variables: Record<string, unknown>): Promise<T | null> => {
      if (!accessToken) throw new Error('Not authenticated');

      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

      const result: GraphQLResponse<T> = await response.json();
      if (result.errors?.length) throw new Error(result.errors[0]?.message || 'GraphQL error');

      return result.data ?? null;
    },
    [accessToken],
  );

  const completeTask = useCallback(
    async (taskId: string) => {
      try {
        await executeGraphQL(COMPLETE_TASK, { id: taskId });
      } catch {
        // Fallback to offline queue
        await addToQueue('completeTask', { id: taskId });
      }
    },
    [executeGraphQL, addToQueue],
  );

  const startTask = useCallback(
    async (taskId: string) => {
      try {
        await executeGraphQL(START_TASK, { id: taskId });
      } catch {
        // Fallback to offline queue
        await addToQueue('startTask', { id: taskId });
      }
    },
    [executeGraphQL, addToQueue],
  );

  const toggleChecklistItem = useCallback(
    async (taskId: string, itemId: string) => {
      await executeGraphQL(TOGGLE_CHECKLIST_ITEM, { taskId, itemId });
    },
    [executeGraphQL],
  );

  const addNote = useCallback(
    async (taskId: string, text: string) => {
      await executeGraphQL(ADD_TASK_NOTE, { taskId, text });
    },
    [executeGraphQL],
  );

  return { completeTask, startTask, toggleChecklistItem, addNote };
}
