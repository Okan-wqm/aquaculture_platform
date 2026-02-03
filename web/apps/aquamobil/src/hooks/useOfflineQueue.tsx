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
import type { QueuedOperation, OperationType, MortalityInput, CullInput, HarvestInput } from '@/types';

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
  addToQueue: (type: OperationType, payload: MortalityInput | CullInput | HarvestInput) => Promise<string>;
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
};

export function OfflineProvider({ children }: { children: ReactNode }) {
  const { accessToken, tenantId, user } = useAuth();
  const isOnline = useNetworkStatus();
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingOperations, setPendingOperations] = useState<QueuedOperation[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Use ref to track syncing state to avoid infinite loops
  const isSyncingRef = useRef(false);
  const hasSyncedOnReconnectRef = useRef(false);

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
    async (type: OperationType, payload: MortalityInput | CullInput | HarvestInput): Promise<string> => {
      const id = await queueOperation(type, payload);
      await refreshQueue();
      return id;
    },
    [refreshQueue]
  );

  const executeGraphQL = useCallback(
    async (type: OperationType, payload: MortalityInput | CullInput | HarvestInput): Promise<unknown> => {
      if (!accessToken || !tenantId || !user) {
        throw new Error('Not authenticated');
      }

      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Tenant-Id': tenantId,
        },
        body: JSON.stringify({
          query: MUTATIONS[type],
          variables: {
            input: payload,
          },
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
      const result = await syncAllOperations(executeGraphQL);
      await refreshQueue();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      setSyncError(message);
      return { success: 0, failed: pendingCount };
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [isOnline, executeGraphQL, refreshQueue, pendingCount]);

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

  // Auto-sync when coming online - with debounce to prevent loops
  useEffect(() => {
    if (isOnline && pendingCount > 0 && !hasSyncedOnReconnectRef.current) {
      hasSyncedOnReconnectRef.current = true;
      // Small delay to ensure network is stable
      const timer = setTimeout(() => {
        syncNow();
      }, 1000);
      return () => clearTimeout(timer);
    }

    // Reset flag when going offline
    if (!isOnline) {
      hasSyncedOnReconnectRef.current = false;
    }
  }, [isOnline, pendingCount, syncNow]);

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
