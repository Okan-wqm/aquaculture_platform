import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useAuth } from './useAuth';
import { useOfflineQueue } from './useOfflineQueue';

import {
  COMPLETE_TASK,
  START_TASK,
  SET_CHECKLIST_ITEM,
  ADD_TASK_NOTE,
} from '@/graphql/operations';
import { computePayloadHash } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { QueuedPayload } from '@/types';
import { invalidateSyncedOperationQueries } from '@/utils/offline-sync-invalidation';

// WHY: TaskActionResult distinguishes queued-offline actions from confirmed-online
// actions. The UI must never claim "Task completed!" when the operation was only
// queued locally — it must show honest "Queued" status via QueuedStatusBadge.
export interface TaskActionResult {
  /** Whether the action was queued offline rather than confirmed by the server. */
  wasQueued: boolean;
  /** The offline queue operation ID, present only when wasQueued is true. */
  operationId?: string;
}

// FARM-HIGH-057: the at-most-once command envelope the backend now REQUIRES on
// every task mutation (online AND offline). `clientCommandId` is the dedup key the
// server's command receipt uses; `payloadHash` is the SHA-256 of the raw domain
// payload — computed by the SAME `computePayloadHash` the offline queue uses, so
// an online attempt and its offline replay produce a byte-identical hash. The id
// is generated ONCE per action and reused across the online attempt and the
// offline fallback so a retry of the SAME action converges on the server.
interface CommandIdentity {
  clientCommandId: string;
  payloadHash: string;
}

// Lifecycle payload (completeTask/startTask) before the envelope is added.
type TaskLifecyclePayload = QueuedPayload<'completeTask'>;
type ChecklistItemSetInput = QueuedPayload<'setChecklistItem'>;

export function useTaskActions(): {
  completeTask: (taskId: string) => Promise<TaskActionResult>;
  startTask: (taskId: string) => Promise<TaskActionResult>;
  setChecklistItem: (taskId: string, itemId: string, isCompleted: boolean) => Promise<TaskActionResult>;
  addNote: (taskId: string, text: string) => Promise<TaskActionResult>;
} {
  const { addToQueue, isOnline } = useOfflineQueue();
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();

  // WHY: one place mints the command identity so the SAME `clientCommandId` and
  // `payloadHash` are used for both the online attempt and any offline fallback.
  // The hash is over the RAW domain payload — exactly the bytes the offline queue
  // will later hash for its own envelope — so the two paths agree on "the same
  // command" and the server dedups a fall-through retry.
  const mintCommandIdentity = useCallback(
    async (rawPayload: TaskLifecyclePayload | ChecklistItemSetInput): Promise<CommandIdentity> => ({
      clientCommandId: crypto.randomUUID(),
      payloadHash: await computePayloadHash(rawPayload),
    }),
    [],
  );

  const completeTask = useCallback(
    async (taskId: string): Promise<TaskActionResult> => {
      // FARM-HIGH-057: mint the command identity ONCE, before the online attempt,
      // so the offline fallback below reuses the same `clientCommandId`.
      const rawPayload: TaskLifecyclePayload = { id: taskId };
      const { clientCommandId, payloadHash } = await mintCommandIdentity(rawPayload);

      // WHY: When online, attempt a direct GraphQL call for immediate confirmation,
      // carrying the mandatory command envelope. When offline (or on network
      // error), route through the offline queue so the user sees honest "Queued"
      // feedback instead of a false "Task completed!".
      if (isOnline) {
        try {
          await graphqlRequest(COMPLETE_TASK, { input: { id: taskId, clientCommandId, payloadHash } });
          if (tenantId) {
            await invalidateSyncedOperationQueries(queryClient, tenantId, ['completeTask']);
          }
          return { wasQueued: false };
        } catch {
          // Network error despite isOnline — fall through to queue
        }
      }
      // FE-HIGH-050: addToQueue returns a discriminated result. For both 'queued'
      // and 'duplicate' the op is in the queue, so wasQueued stays true; operationId
      // tracks the (existing, on dedup) queued op for the two-phase status badge.
      // The same clientCommandId is threaded so the server dedups the retry.
      const { id: operationId } = await addToQueue('completeTask', rawPayload, clientCommandId);
      return { wasQueued: true, operationId };
    },
    [addToQueue, isOnline, queryClient, tenantId, mintCommandIdentity],
  );

  const startTask = useCallback(
    async (taskId: string): Promise<TaskActionResult> => {
      const rawPayload: TaskLifecyclePayload = { id: taskId };
      const { clientCommandId, payloadHash } = await mintCommandIdentity(rawPayload);

      if (isOnline) {
        try {
          await graphqlRequest(START_TASK, { input: { id: taskId, clientCommandId, payloadHash } });
          if (tenantId) {
            await invalidateSyncedOperationQueries(queryClient, tenantId, ['startTask']);
          }
          return { wasQueued: false };
        } catch {
          // Network error despite isOnline — fall through to queue
        }
      }
      const { id: operationId } = await addToQueue('startTask', rawPayload, clientCommandId);
      return { wasQueued: true, operationId };
    },
    [addToQueue, isOnline, queryClient, tenantId, mintCommandIdentity],
  );

  const setChecklistItem = useCallback(
    // FARM-HIGH-057: `isCompleted` is the ABSOLUTE target the caller resolves from
    // the current item state (`!item.isCompleted`). The server SETs it (no flip),
    // so an offline replay converges instead of reverting the item — which is what
    // makes the checklist safe to queue offline at all.
    async (taskId: string, itemId: string, isCompleted: boolean): Promise<TaskActionResult> => {
      const rawPayload: ChecklistItemSetInput = { taskId, itemId, isCompleted };
      const { clientCommandId, payloadHash } = await mintCommandIdentity(rawPayload);

      if (isOnline) {
        try {
          await graphqlRequest(SET_CHECKLIST_ITEM, {
            input: { taskId, itemId, isCompleted, clientCommandId, payloadHash },
          });
          if (tenantId) {
            await invalidateSyncedOperationQueries(queryClient, tenantId, ['setChecklistItem']);
          }
          return { wasQueued: false };
        } catch {
          // Network error despite isOnline — fall through to queue
        }
      }
      // FARM-HIGH-057: the checklist SET now has a real OperationType, so it queues
      // offline like the lifecycle mutations (absolute target + envelope → safe to
      // replay) instead of throwing "requires network".
      const { id: operationId } = await addToQueue('setChecklistItem', rawPayload, clientCommandId);
      return { wasQueued: true, operationId };
    },
    [addToQueue, isOnline, queryClient, tenantId, mintCommandIdentity],
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

  return { completeTask, startTask, setChecklistItem, addNote };
}
