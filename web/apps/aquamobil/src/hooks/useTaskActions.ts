import { useCallback } from 'react';
import { useOfflineQueue } from './useOfflineQueue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import {
  COMPLETE_TASK,
  START_TASK,
  TOGGLE_CHECKLIST_ITEM,
  ADD_TASK_NOTE,
} from '@/graphql/operations';

// WHY: TaskActionResult distinguishes queued-offline actions from confirmed-online
// actions. The UI must never claim "Task completed!" when the operation was only
// queued locally — it must show honest "Queued" status via QueuedStatusBadge.
export interface TaskActionResult {
  /** Whether the action was queued offline rather than confirmed by the server. */
  wasQueued: boolean;
  /** The offline queue operation ID, present only when wasQueued is true. */
  operationId?: string;
}

export function useTaskActions(): {
  completeTask: (taskId: string) => Promise<TaskActionResult>;
  startTask: (taskId: string) => Promise<TaskActionResult>;
  toggleChecklistItem: (taskId: string, itemId: string) => Promise<TaskActionResult>;
  addNote: (taskId: string, text: string) => Promise<TaskActionResult>;
} {
  const { addToQueue, isOnline } = useOfflineQueue();

  const completeTask = useCallback(
    async (taskId: string): Promise<TaskActionResult> => {
      // WHY: When online, attempt a direct GraphQL call for immediate confirmation.
      // When offline (or on network error), route through the offline queue so the
      // user sees honest "Queued" feedback instead of false "Task completed!".
      if (isOnline) {
        try {
          await graphqlRequest(COMPLETE_TASK, { id: taskId });
          return { wasQueued: false };
        } catch {
          // Network error despite isOnline — fall through to queue
        }
      }
      const operationId = await addToQueue('completeTask', { id: taskId });
      return { wasQueued: true, operationId };
    },
    [addToQueue, isOnline],
  );

  const startTask = useCallback(
    async (taskId: string): Promise<TaskActionResult> => {
      if (isOnline) {
        try {
          await graphqlRequest(START_TASK, { id: taskId });
          return { wasQueued: false };
        } catch {
          // Network error despite isOnline — fall through to queue
        }
      }
      const operationId = await addToQueue('startTask', { id: taskId });
      return { wasQueued: true, operationId };
    },
    [addToQueue, isOnline],
  );

  const toggleChecklistItem = useCallback(
    async (taskId: string, itemId: string): Promise<TaskActionResult> => {
      if (isOnline) {
        try {
          await graphqlRequest(TOGGLE_CHECKLIST_ITEM, { taskId, itemId });
          return { wasQueued: false };
        } catch {
          // Network error — fall through to queue
        }
      }
      // WHY: Checklist toggles don't have a dedicated OperationType in the queue,
      // but the UX still degrades gracefully — we throw so the caller knows it failed.
      throw new Error('Checklist toggle requires network connectivity');
    },
    [isOnline],
  );

  const addNote = useCallback(
    async (taskId: string, text: string): Promise<TaskActionResult> => {
      if (isOnline) {
        try {
          await graphqlRequest(ADD_TASK_NOTE, { taskId, text });
          return { wasQueued: false };
        } catch {
          // Network error — fall through
        }
      }
      // WHY: Notes don't have a dedicated OperationType in the queue.
      // We throw so the caller can show an explicit error instead of silently failing.
      throw new Error('Adding notes requires network connectivity');
    },
    [isOnline],
  );

  return { completeTask, startTask, toggleChecklistItem, addNote };
}
