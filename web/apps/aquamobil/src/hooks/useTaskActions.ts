import { useCallback } from 'react';
import { useOfflineQueue } from './useOfflineQueue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import {
  COMPLETE_TASK,
  START_TASK,
  TOGGLE_CHECKLIST_ITEM,
  ADD_TASK_NOTE,
} from '@/graphql/operations';

export function useTaskActions() {
  const { addToQueue } = useOfflineQueue();

  const completeTask = useCallback(
    async (taskId: string) => {
      try {
        await graphqlRequest(COMPLETE_TASK, { id: taskId });
      } catch {
        // Fallback to offline queue
        await addToQueue('completeTask', { id: taskId });
      }
    },
    [addToQueue],
  );

  const startTask = useCallback(
    async (taskId: string) => {
      try {
        await graphqlRequest(START_TASK, { id: taskId });
      } catch {
        // Fallback to offline queue
        await addToQueue('startTask', { id: taskId });
      }
    },
    [addToQueue],
  );

  const toggleChecklistItem = useCallback(
    async (taskId: string, itemId: string) => {
      await graphqlRequest(TOGGLE_CHECKLIST_ITEM, { taskId, itemId });
    },
    [],
  );

  const addNote = useCallback(
    async (taskId: string, text: string) => {
      await graphqlRequest(ADD_TASK_NOTE, { taskId, text });
    },
    [],
  );

  return { completeTask, startTask, toggleChecklistItem, addNote };
}
