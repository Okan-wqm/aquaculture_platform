import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import {
  queueOperation,
  getPendingOperations,
  getPendingCount,
  syncAllOperations,
  removeOperation,
} from '@/pwa/offline-queue';
import { useAuth } from './useAuth';
import { useNetworkStatus } from './useNetworkStatus';
import type { QueuedOperation, OperationType, OperationPayload } from '@/types';

interface SyncResult {
  success: number;
  failed: number;
}

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
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

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
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingOperations, setPendingOperations] = useState<QueuedOperation[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Use ref to track syncing state to avoid infinite loops
  const isSyncingRef = useRef(false);
  const hasSyncedOnReconnectRef = useRef(false);
  // PERF-04: Hold syncNow in a ref so the auto-sync effect does not re-run when
  // syncNow changes due to pendingCount updates during a sync session.
  const syncNowRef = useRef<() => Promise<SyncResult>>(async () => ({ success: 0, failed: 0 }));

  const refreshQueue = useCallback(async () => {
    try {
      const [count, operations] = await Promise.all([
        getPendingCount(),
        getPendingOperations()
      ]);
      setPendingCount(count);
      setPendingOperations(operations);
    } catch (error) {
      console.error('Failed to refresh queue:', error);
    }
  }, []);

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
      // SEC-09: pass auth presence so background sync is only registered when
      // credentials are confirmed valid, preventing auth-failure retryCount inflation.
      const hasValidAuth = Boolean(accessToken && tenantId && user);
      const id = await queueOperation(type, payload, hasValidAuth);
      await refreshQueue();
      return id;
    },
    [refreshQueue, accessToken, tenantId, user]
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

      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Tenant-Id': tenantId,
          // SEC-06: CSRF defense header
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          query: MUTATIONS[type],
          variables,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const result = await response.json() as { data?: unknown; errors?: Array<{ message: string }> };

      if (result.errors && result.errors.length > 0) {
        throw new Error(result.errors[0]?.message || 'GraphQL error');
      }

      return result.data;
    },
    [accessToken, tenantId, user]
  );

  const syncNow = useCallback(async (): Promise<SyncResult> => {
    // Prevent concurrent syncs using ref (not state to avoid re-renders)
    if (!isOnline || isSyncingRef.current) {
      return { success: 0, failed: 0 };
    }

    isSyncingRef.current = true;
    setIsSyncing(true);
    setSyncError(null);

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

      const result = await syncAllOperations(executeGraphQL);
      await refreshQueue();

      // BUG-07: Reset the reconnect guard after a successful sync so that
      // new items queued while online will trigger auto-sync on next effect run.
      if (result.success > 0) {
        hasSyncedOnReconnectRef.current = false;
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      setSyncError(message);
      return { success: 0, failed: pendingCount };
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [isOnline, executeGraphQL, refreshQueue, pendingCount, accessToken, refreshAuth]);

  // Keep ref in sync so the auto-sync effect always calls the latest version
  // without needing syncNow in its dependency array (PERF-04).
  useEffect(() => {
    syncNowRef.current = syncNow;
  }, [syncNow]);

  const removeFromQueueHandler = useCallback(
    async (id: string): Promise<void> => {
      await removeOperation(id);
      await refreshQueue();
    },
    [refreshQueue]
  );

  const clearError = useCallback(() => {
    setSyncError(null);
  }, []);

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
