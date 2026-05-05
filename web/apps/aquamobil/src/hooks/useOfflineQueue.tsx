import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateSyncedOperationQueries } from '@/utils/offline-sync-invalidation';
import {
  queueOperation,
  getPendingOperations,
  getPendingCount,
  syncAllOperations,
  removeOperation,
  MAX_RETRY_COUNT,
} from '@/pwa/offline-queue';
import { useAuth } from './useAuth';
import { useNetworkStatus } from './useNetworkStatus';
import type { QueuedOperation, OperationType, OperationPayload } from '@/types';

interface SyncResult {
  success: number;
  failed: number;
}

// IMPORTANT: SyncStatus tracks whether a queued operation has been confirmed by
// the backend ('synced'), is still waiting ('pending'), is currently being sent
// ('syncing'), or failed ('failed'). This powers the two-phase success UX (C7)
// so users see honest "Queued" feedback until the backend roundtrip succeeds.
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed';

interface OfflineContextValue {
  pendingCount: number;
  pendingOperations: QueuedOperation[];
  isOnline: boolean;
  isSyncing: boolean;
  syncError: string | null;
  addToQueue: (type: OperationType, payload: OperationPayload) => Promise<string>;
  syncNow: () => Promise<SyncResult>;
  removeFromQueue: (id: string) => Promise<void>;
  refreshQueue: () => Promise<void>;
  clearError: () => void;
  /** C7: Get the sync status of a specific queued operation by its operationId. */
  getSyncStatus: (operationId: string) => SyncStatus;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

// WHY: submitLeaveRequest mutation is defined outside MUTATIONS because it is
// never queued as a standalone operation — it is only called as the second step
// of the createLeaveRequest compound flow inside executeGraphQL. Keeping it
// outside the component avoids per-render recreation and useCallback dep churn.
const SUBMIT_LEAVE_AFTER_CREATE = `
  mutation SubmitLeaveRequest($id: ID!) {
    submitLeaveRequest(id: $id) { id status }
  }
`;

// GraphQL mutations for sync - tenantId/userId extracted from JWT by backend
const MUTATIONS: Record<OperationType, string> = {
  recordMortality: `
    mutation RecordMortality($input: RecordMortalityInput!) {
      recordMortality(input: $input) {
        id
        currentQuantity
        totalMortality
      }
    }
  `,
  recordCull: `
    mutation RecordCull($input: RecordCullInput!) {
      recordCull(input: $input) {
        id
        currentQuantity
        cullCount
      }
    }
  `,
  createHarvestRecord: `
    mutation CreateHarvestRecord($input: CreateHarvestRecordInput!) {
      createHarvestRecord(input: $input) {
        id
        recordCode
        quantityHarvested
      }
    }
  `,
  recordFeeding: `
    mutation RecordDailyFeeding($input: RecordDailyFeedingInput!) {
      recordDailyFeeding(input: $input) {
        id
        actualFeedKg
        status
      }
    }
  `,
  clockIn: `
    mutation ClockIn($input: ClockInInput!) {
      clockIn(input: $input) {
        id
        date
        clockIn
        status
        workedMinutes
        remarks
      }
    }
  `,
  clockOut: `
    mutation ClockOut($input: ClockOutInput!) {
      clockOut(input: $input) {
        id
        date
        clockOut
        status
        workedMinutes
      }
    }
  `,
  createLeaveRequest: `
    mutation CreateLeaveRequest($input: CreateLeaveRequestInput!) {
      createLeaveRequest(input: $input) {
        id
        startDate
        endDate
        totalDays
        status
      }
    }
  `,
  completeTask: `
    mutation CompleteTask($id: String!) {
      completeTask(id: $id) {
        id
        status
        completedAt
        completedBy
      }
    }
  `,
  startTask: `
    mutation StartTask($id: String!) {
      startTask(id: $id) {
        id
        status
      }
    }
  `,
  recordTransfer: `
    mutation RecordTransfer($input: TransferBatchInput!) {
      transferBatch(input: $input) {
        id
      }
    }
  `,
  createWaterQuality: `
    mutation CreateWaterQualityMeasurement($input: CreateWaterQualityInput!) {
      createWaterQualityMeasurement(input: $input) {
        id
        overallStatus
        hasAlarm
      }
    }
  `,
  recordStockMovement: `
    mutation RecordStockMovement($input: RecordStockMovementInput!) {
      recordStockMovement(input: $input) {
        id
        movementType
        quantity
      }
    }
  `,
  transferStock: `
    mutation TransferStock($input: TransferStockInput!) {
      transferStock(input: $input) {
        id
        quantity
      }
    }
  `,
  // Messaging mutations — ADR-012
  sendMessage: `
    mutation SendMessage($input: SendMessageInput!) {
      sendMessage(input: $input) {
        id
        channelId
        content
        contentType
        createdAt
      }
    }
  `,
  editMessage: `
    mutation EditMessage($id: String!, $input: EditMessageInput!) {
      editMessage(id: $id, input: $input) {
        id
        content
        editedAt
      }
    }
  `,
  deleteMessage: `
    mutation DeleteMessage($id: String!) {
      deleteMessage(id: $id)
    }
  `,
  markMessagesRead: `
    mutation MarkMessagesRead($input: MarkReadInput!) {
      markMessagesRead(input: $input)
    }
  `,
};

export function OfflineProvider({ children }: { children: ReactNode }) {
  const { accessToken, tenantId, user, refreshAuth } = useAuth();
  const isOnline = useNetworkStatus();
  const queryClient = useQueryClient();
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingOperations, setPendingOperations] = useState<QueuedOperation[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  // C7: Track per-operation sync outcomes for the two-phase success UX.
  // 'synced' = backend confirmed, 'failed' = backend rejected or network error.
  const [syncResults, setSyncResults] = useState<Map<string, SyncStatus>>(new Map());

  // Use ref to track syncing state to avoid infinite loops
  const isSyncingRef = useRef(false);
  const hasSyncedOnReconnectRef = useRef(false);
  // PERF-04: Hold syncNow in a ref so the auto-sync effect does not re-run when
  // syncNow changes due to pendingCount updates during a sync session.
  const syncNowRef = useRef<() => Promise<SyncResult>>(async () => ({ success: 0, failed: 0 }));

  // SECURITY (C11): All queue operations are scoped to the current tenantId.
  // refreshQueue only shows the active tenant's operations, preventing
  // cross-tenant data leakage on shared devices.
  const refreshQueue = useCallback(async () => {
    try {
      const [count, operations] = await Promise.all([
        getPendingCount(tenantId ?? undefined),
        getPendingOperations(tenantId ?? undefined)
      ]);
      setPendingCount(count);
      setPendingOperations(operations);
    } catch (error) {
      console.error('Failed to refresh queue:', error);
    }
  }, [tenantId]);

  // Refresh queue on mount
  useEffect(() => {
    refreshQueue();
  }, [refreshQueue]);

  // Listen for service worker sync messages
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SYNC_COMPLETE') {
        refreshQueue();
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleMessage);
      return () => {
        navigator.serviceWorker.removeEventListener('message', handleMessage);
      };
    }
  }, [refreshQueue]);

  const addToQueue = useCallback(
    async (type: OperationType, payload: OperationPayload): Promise<string> => {
      // SECURITY (C11): tenantId is required -- reject if not authenticated
      if (!tenantId) {
        throw new Error('Cannot queue operations without an active tenant');
      }
      // SEC-09: pass auth presence so background sync is only registered when
      // credentials are confirmed valid, preventing auth-failure retryCount inflation.
      const hasValidAuth = Boolean(accessToken && tenantId && user);
      const id = await queueOperation(tenantId, type, payload, hasValidAuth);
      await refreshQueue();
      return id;
    },
    [refreshQueue, accessToken, tenantId, user]
  );

  /** Execute a single GraphQL mutation and return the parsed response data. */
  const executeSingleMutation = useCallback(
    async (query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (!accessToken || !tenantId || !user) {
        throw new Error('Not authenticated');
      }

      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Tenant-Id': tenantId,
          // SEC-06: CSRF defense header
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const result = await response.json() as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };

      if (result.errors && result.errors.length > 0) {
        throw new Error(result.errors[0]?.message || 'GraphQL error');
      }

      return result.data ?? {};
    },
    [accessToken, tenantId, user],
  );

  const executeGraphQL = useCallback(
    async (type: OperationType, payload: OperationPayload): Promise<unknown> => {
      if (!accessToken || !tenantId || !user) {
        throw new Error('Not authenticated');
      }

      // Task mutations (completeTask, startTask) and deleteMessage use { id } variable
      const isIdMutation = type === 'completeTask' || type === 'startTask' || type === 'deleteMessage';
      // editMessage uses { id, input: { content } } — split payload into id + nested input
      const isEditMessage = type === 'editMessage';

      let variables: Record<string, unknown>;
      if (isEditMessage) {
        const { id: msgId, content, ...rest } = payload as Record<string, unknown>;
        variables = { id: msgId, input: { content, ...rest } };
      } else if (isIdMutation) {
        variables = payload as Record<string, unknown>;
      } else {
        variables = { input: payload };
      }

      const data = await executeSingleMutation(MUTATIONS[type], variables);

      // WHY: Leave requests require a two-step backend flow (create DRAFT then
      // submit for approval). Rather than exposing this as two separate queue
      // operations — which would break if the first succeeds but the second
      // doesn't get queued — we chain them atomically here. The queue sees ONE
      // operation; the sync engine transparently handles both mutations.
      if (type === 'createLeaveRequest') {
        const created = data['createLeaveRequest'] as { id: string } | undefined;
        if (created?.id) {
          await executeSingleMutation(SUBMIT_LEAVE_AFTER_CREATE, { id: created.id });
        }
      }

      return data;
    },
    [accessToken, tenantId, user, executeSingleMutation]
  );

  const syncNow = useCallback(async (): Promise<SyncResult> => {
    // Prevent concurrent syncs using ref (not state to avoid re-renders)
    if (!isOnline || isSyncingRef.current) {
      return { success: 0, failed: 0 };
    }

    isSyncingRef.current = true;
    setIsSyncing(true);
    setSyncError(null);

    // C7: Snapshot operation IDs before sync so we can track per-operation outcomes.
    // Mark all pending operations as 'syncing' in the syncResults map.
    const preSyncOps = [...pendingOperations];
    setSyncResults((prev) => {
      const next = new Map(prev);
      for (const op of preSyncOps) {
        next.set(op.id, 'syncing');
      }
      return next;
    });

    try {
      // Ensure token is fresh before starting sync to avoid 401s mid-batch
      if (accessToken) {
        try {
          const payload = JSON.parse(atob(accessToken.split('.')[1]));
          const expiresAt = payload.exp * 1000;
          if (expiresAt - Date.now() < 60_000) { // less than 60s remaining
            await refreshAuth();
          }
        } catch {
          // If token parsing fails, attempt refresh as a safety measure
          await refreshAuth();
        }
      }

      // SECURITY (C11): Only sync operations belonging to the active tenant
      if (!tenantId) {
        return { success: 0, failed: 0 };
      }
      const result = await syncAllOperations(tenantId, executeGraphQL);
      await refreshQueue();

      // C7: After sync, determine per-operation outcomes by comparing against
      // the refreshed queue. Operations no longer in the queue succeeded;
      // operations still present with 'failed' status failed.
      const postSyncOps = await getPendingOperations(tenantId);
      const remainingIds = new Set(postSyncOps.map((op) => op.id));
      const failedIds = new Set(
        postSyncOps.filter((op) => op.status === 'failed').map((op) => op.id),
      );
      setSyncResults((prev) => {
        const next = new Map(prev);
        for (const op of preSyncOps) {
          if (!remainingIds.has(op.id)) {
            next.set(op.id, 'synced');
          } else if (failedIds.has(op.id)) {
            next.set(op.id, 'failed');
          }
          // else: still pending (e.g., skipped due to retry backoff)
        }
        return next;
      });

      // WHY: After a successful queue sync, invalidate React Query caches for
      // the operation types that were confirmed by the backend. The queue is the
      // single offline write path, so this is the convergence point that makes
      // DB-committed farm data visible in list/card/detail screens immediately
      // instead of waiting for staleTime or offline cache expiry.
      const syncedOperationTypes = preSyncOps
        .filter((op) => !remainingIds.has(op.id))
        .map((op) => op.type);
      await invalidateSyncedOperationQueries(queryClient, tenantId, syncedOperationTypes);

      // BUG-07: Reset the reconnect guard after a successful sync so that
      // new items queued while online will trigger auto-sync on next effect run.
      if (result.success > 0) {
        hasSyncedOnReconnectRef.current = false;
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      setSyncError(message);

      // C7: Mark all pre-sync operations as failed on bulk sync error
      setSyncResults((prev) => {
        const next = new Map(prev);
        for (const op of preSyncOps) {
          next.set(op.id, 'failed');
        }
        return next;
      });

      return { success: 0, failed: pendingCount };
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [isOnline, executeGraphQL, refreshQueue, pendingCount, pendingOperations, accessToken, refreshAuth, tenantId, queryClient]);

  // Keep ref in sync so the auto-sync effect always calls the latest version
  // without needing syncNow in its dependency array (PERF-04).
  useEffect(() => {
    syncNowRef.current = syncNow;
  }, [syncNow]);

  const removeFromQueueHandler = useCallback(
    async (id: string): Promise<void> => {
      // SECURITY (C11): Use current tenantId to target the correct tenant-scoped key
      if (!tenantId) return;
      await removeOperation(tenantId, id);
      await refreshQueue();
    },
    [refreshQueue, tenantId]
  );

  const clearError = useCallback(() => {
    setSyncError(null);
  }, []);

  /** C7: Return the sync status of a specific queued operation. */
  const getSyncStatus = useCallback(
    (operationId: string): SyncStatus => {
      // Check tracked sync results first
      const tracked = syncResults.get(operationId);
      if (tracked) return tracked;

      // Check if operation is still in the pending queue
      const inQueue = pendingOperations.find((op) => op.id === operationId);
      if (inQueue) {
        if (inQueue.status === 'failed') return 'failed';
        if (inQueue.status === 'syncing') return 'syncing';
        return 'pending';
      }

      // Not in queue and not tracked -- assume it was synced before tracking started
      // or was deduped (empty string id from queueOperation).
      if (!operationId) return 'pending';
      return 'synced';
    },
    [syncResults, pendingOperations],
  );

  // Auto-sync when coming online - with debounce to prevent loops.
  // PERF-04: syncNow is accessed via ref, not listed as a dependency,
  // preventing 50+ re-evaluations during a bulk sync session.
  useEffect(() => {
    if (isOnline && pendingCount > 0 && !hasSyncedOnReconnectRef.current) {
      hasSyncedOnReconnectRef.current = true;
      // Small delay to ensure network is stable
      const timer = setTimeout(() => {
        syncNowRef.current();
      }, 1000);
      return () => clearTimeout(timer);
    }

    // Reset flag when going offline so the next reconnect triggers sync
    if (!isOnline) {
      hasSyncedOnReconnectRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, pendingCount]);

  // BUG-17: Periodic retry for failed operations.
  // When online with failed items in the queue, schedule automatic retries
  // at a fixed interval. syncAllOperations() now promotes retryable 'failed'
  // operations back to 'pending' before processing, so this interval ensures
  // transient failures (network blips, 5xx) are retried without user action.
  // Interval is 30 seconds — long enough to avoid hammering the server, short
  // enough that users see progress without manual intervention.
  useEffect(() => {
    if (!isOnline || pendingCount === 0) return;

    const hasRetryableFailures = pendingOperations.some(
      (op) => op.status === 'failed' && op.retryCount < MAX_RETRY_COUNT,
    );
    if (!hasRetryableFailures) return;

    const retryInterval = setInterval(() => {
      if (!isSyncingRef.current) {
        syncNowRef.current();
      }
    }, 30_000);

    return () => clearInterval(retryInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, pendingCount, pendingOperations]);

  return (
    <OfflineContext.Provider
      value={{
        pendingCount,
        pendingOperations,
        isOnline,
        isSyncing,
        syncError,
        addToQueue,
        syncNow,
        removeFromQueue: removeFromQueueHandler,
        refreshQueue,
        clearError,
        getSyncStatus,
      }}
    >
      {children}
    </OfflineContext.Provider>
  );
}

export function useOfflineQueue(): OfflineContextValue {
  const context = useContext(OfflineContext);
  if (!context) {
    throw new Error('useOfflineQueue must be used within OfflineProvider');
  }
  return context;
}
