import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactElement, type ReactNode } from 'react';

import { useAuth } from './useAuth';
import { useNetworkStatus } from './useNetworkStatus';

import { REQUEST_MEDIA_UPLOAD, SEND_MESSAGE } from '@/graphql/messaging-operations';
import {
  queueOperation,
  getPendingOperations,
  getPendingCount,
  getQueueVersion,
  syncAllOperations,
  removeOperation,
  getPendingBlob,
  removePendingBlob,
  MAX_RETRY_COUNT,
} from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type {
  QueuedOperation,
  OperationType,
  OperationPayload,
  AddToQueueResult,
  UploadAndSendMessageOfflinePayload,
} from '@/types';
import type { MediaUploadResponse } from '@/types/messaging';
import { logger } from '@/utils/logger';
import { invalidateSyncedOperationQueries } from '@/utils/offline-sync-invalidation';


interface SyncResult {
  success: number;
  failed: number;
}

// FE-LOW-050: 'unknown' makes the not-representable state representable. Before,
// getSyncStatus returned 'synced' for ANY id absent from pendingOperations —
// including a never-seen or typo'd id — rendering a false green "Confirmed".
// 'unknown' is returned when an id is absent from BOTH the syncResults drain map
// AND the pending queue, so a real success (which leaves a 'synced' entry in
// syncResults on drain) still resolves to 'synced', while a phantom id can no
// longer be mistaken for a confirmed write. Adding the member forces exhaustive
// handling at every consumer — a missed branch is a compile error.
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed' | 'unknown';

interface OfflineContextValue {
  pendingCount: number;
  pendingOperations: QueuedOperation[];
  isOnline: boolean;
  isSyncing: boolean;
  syncError: string | null;
  addToQueue: (type: OperationType, payload: OperationPayload, clientCommandId?: string) => Promise<AddToQueueResult>;
  syncNow: () => Promise<SyncResult>;
  removeFromQueue: (id: string) => Promise<void>;
  getSyncStatus: (id: string) => SyncStatus;
  refreshQueue: () => Promise<void>;
  clearError: () => void;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

// GraphQL mutations for sync - tenantId/userId extracted from JWT by backend
// MSG-MEDIUM-055: 'uploadAndSendMessage' is excluded — it is NOT a single
// GraphQL mutation string. Its 3-step presign → PUT → send replay is handled by
// replayUploadAndSendMessage below, never looked up in this map. Excluding it
// keeps this record exhaustive over the single-mutation op types only.
const MUTATIONS: Record<Exclude<OperationType, 'uploadAndSendMessage'> | 'submitLeaveRequest', string> = {
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
  submitLeaveRequest: `
    mutation SubmitLeaveRequest($id: ID!) {
      submitLeaveRequest(id: $id) {
        id
        status
      }
    }
  `,
  // FARM-HIGH-057: task lifecycle mutations take a single TaskLifecycleInput that
  // carries the task id PLUS the at-most-once command envelope. The server rejects
  // an envelope-less call, so the queued payload (envelope already stamped on
  // enqueue) is sent verbatim under `input`.
  completeTask: `
    mutation CompleteTask($input: TaskLifecycleInput!) {
      completeTask(input: $input) {
        id
        status
        completedAt
        completedBy
      }
    }
  `,
  startTask: `
    mutation StartTask($input: TaskLifecycleInput!) {
      startTask(input: $input) {
        id
        status
      }
    }
  `,
  // FARM-HIGH-057: idempotent checklist SET — the queued payload carries the
  // ABSOLUTE target isCompleted (taskId/itemId/isCompleted) plus the envelope, so
  // a replay after reconnect converges instead of reverting the item.
  setChecklistItem: `
    mutation SetChecklistItem($input: SetChecklistItemInput!) {
      setChecklistItem(input: $input) {
        id
        checklistItems
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

/**
 * MSG-MEDIUM-055: in-app replay of the binary offline lane. Runs the 3-step
 * online flow a single queued GraphQL op cannot: presign → PUT blob → send. The
 * persisted blob is deleted ONLY after a fully successful send, so an
 * interruption between PUT and send leaves the op retryable; the send's stable
 * idempotencyKey makes that retry at-most-once on the server. Throws on any
 * failure so syncOperation marks the op failed (and retries with backoff).
 *
 * Auth + tenant headers are injected by graphqlRequest/authenticatedFetch, so
 * this replay is tenant-scoped exactly like every other synced op.
 */
async function replayUploadAndSendMessage(
  payload: UploadAndSendMessageOfflinePayload,
  tenantId: string,
): Promise<unknown> {
  const blob = await getPendingBlob(tenantId, payload.blobId);
  if (!blob) {
    // The blob is gone (wiped on logout, decryption failure, or already sent on a
    // prior partial replay). There is nothing to upload; treat as a terminal,
    // non-retryable condition so the op does not loop forever.
    throw new Error('not found: offline media blob is no longer available');
  }

  // Step 1: presigned PUT URL.
  const presign = await graphqlRequest<{ requestMediaUpload: MediaUploadResponse }>(
    REQUEST_MEDIA_UPLOAD,
    {
      input: {
        channelId: payload.channelId,
        filename: payload.filename,
        mimeType: payload.mimeType,
        fileSize: blob.size,
      },
    },
  );
  const { uploadUrl, storageKey } = presign.requestMediaUpload;

  // Step 2: PUT the blob bytes directly to MinIO (NOT via /graphql).
  const putResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': payload.mimeType },
    body: blob,
  });
  if (!putResponse.ok) {
    throw new Error(`Upload failed with status ${putResponse.status}`);
  }

  // Step 3: send the message referencing the uploaded object. The stable
  // idempotencyKey makes this safe to retry after a lost response.
  const sent = await graphqlRequest<{ sendMessage: { id: string } }>(SEND_MESSAGE, {
    input: {
      channelId: payload.channelId,
      content: null,
      contentType: payload.contentType,
      idempotencyKey: payload.idempotencyKey,
      parentId: payload.parentId ?? null,
      attachmentKeys: [storageKey],
      metadata:
        payload.durationSeconds !== undefined
          ? { durationSeconds: payload.durationSeconds }
          : null,
    },
  });

  // Only now is the blob safe to delete — the message durably references the
  // uploaded object.
  await removePendingBlob(tenantId, payload.blobId);
  return sent;
}

export function OfflineProvider({ children }: { children: ReactNode }): ReactElement {
  const { accessToken, tenantId, user, refreshAuth } = useAuth();
  const queryClient = useQueryClient();
  const isOnline = useNetworkStatus();
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingOperations, setPendingOperations] = useState<QueuedOperation[]>([]);
  // FE-HIGH-051: monotonic per-tenant queue version surfaced into React state so
  // the auto-sync effect re-arms on a queue CONTENT change (any enqueue), not on
  // a pending-COUNT delta. A drain-to-N-then-enqueue-back-to-N leaves the count
  // unchanged but bumps the version, so this is the only signal that catches it.
  const [queueVersion, setQueueVersion] = useState(0);
  const [syncResults, setSyncResults] = useState<Map<string, SyncStatus>>(() => new Map());
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Use ref to track syncing state to avoid infinite loops
  const isSyncingRef = useRef(false);
  // FE-HIGH-051: the queue version we last armed an auto-sync for. The reconnect
  // effect fires only when the current version differs from this. Reset to a
  // sentinel (-1, never a real version) when going offline so the next reconnect
  // always re-arms even if the queue content did not change while offline.
  const lastArmedVersionRef = useRef(-1);
  // PERF-04: Hold syncNow in a ref so the auto-sync effect does not re-run when
  // syncNow changes due to pendingCount updates during a sync session.
  // WHY no async: the placeholder needs no await — it just resolves the zero
  // result. Written with Promise.resolve so it is not an async function lacking
  // an await (require-await). It is replaced by the real syncNow on first effect run.
  const syncNowRef = useRef<() => Promise<SyncResult>>(() => Promise.resolve({ success: 0, failed: 0 }));

  // SECURITY (C11): All queue operations are scoped to the current tenantId.
  // refreshQueue only shows the active tenant's operations, preventing
  // cross-tenant data leakage on shared devices.
  const refreshQueue = useCallback(async () => {
    try {
      const [count, operations, version] = await Promise.all([
        getPendingCount(tenantId ?? undefined),
        getPendingOperations(tenantId ?? undefined),
        tenantId ? getQueueVersion(tenantId) : Promise.resolve(0),
      ]);
      setPendingCount(count);
      setPendingOperations(operations);
      setQueueVersion(version);
    } catch (error) {
      // FE-HIGH-056: route through the structured logger (no banned console.*).
      logger.error('Failed to refresh queue:', error);
    }
  }, [tenantId]);

  // Refresh queue on mount
  useEffect(() => {
    // WHY void: refreshQueue handles its own errors (logs internally) and never
    // rejects, so it runs as a discarded background task here.
    void refreshQueue();
  }, [refreshQueue]);

  // Listen for service worker sync messages
  useEffect(() => {
    const handleMessage = (event: MessageEvent): void => {
      // WHY typed guard: MessageEvent.data is `any`; narrow to an object with a
      // `type` field via `in` before reading it so the access is type-safe.
      const data: unknown = event.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'SYNC_COMPLETE'
      ) {
        void refreshQueue();
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
    // FARM-HIGH-057: `clientCommandId` is the stable at-most-once id a hook
    // generates ONCE per action and threads through both its online attempt and
    // this offline fallback, so the server dedups an online-fail-then-queue
    // retry. Omitted by pure-offline-first callers, which mint a fresh id inside
    // queueOperation as before.
    async (type: OperationType, payload: OperationPayload, clientCommandId?: string): Promise<AddToQueueResult> => {
      // SECURITY (C11): tenantId is required -- reject if not authenticated
      if (!tenantId) {
        throw new Error('Cannot queue operations without an active tenant');
      }
      // SEC-09: pass auth presence so background sync is only registered when
      // credentials are confirmed valid, preventing auth-failure retryCount inflation.
      const hasValidAuth = Boolean(accessToken && tenantId && user);
      const result = await queueOperation(tenantId, type, payload, hasValidAuth, clientCommandId);
      await refreshQueue();
      return result;
    },
    [refreshQueue, accessToken, tenantId, user]
  );

  const executeGraphQL = useCallback(
    async (type: OperationType, payload: OperationPayload): Promise<unknown> => {
      if (!accessToken || !tenantId || !user) {
        throw new Error('Not authenticated');
      }

      // MSG-MEDIUM-055: the binary offline lane. A single queue op cannot model
      // the 3-call presign → PUT → send flow, so it is run here on replay: the
      // persisted blob is presigned, PUT to MinIO, then sent with the resulting
      // storage key. The blob is deleted only on a fully successful send. The
      // send carries the op's stable idempotencyKey, so a half-replayed
      // (uploaded-but-unsent) op retried later returns the original message
      // (SendMessageHandler's Redis + Postgres ledger) instead of duplicating.
      if (type === 'uploadAndSendMessage') {
        return replayUploadAndSendMessage(payload as UploadAndSendMessageOfflinePayload, tenantId);
      }

      // deleteMessage uses a flat { id } variable (no envelope: messaging deletes
      // are not at-most-once-enveloped here). FARM-HIGH-057: completeTask/startTask
      // are NO LONGER flat-id mutations — they take a single TaskLifecycleInput, so
      // the whole enveloped payload rides under `input` like every other input
      // mutation (the default branch below). setChecklistItem is the same shape.
      const isIdMutation = type === 'deleteMessage';
      // editMessage uses { id, input: { content } } — split payload into id + nested input
      const isEditMessage = type === 'editMessage';

      let variables: Record<string, unknown>;
      if (isEditMessage) {
        const { id: msgId, content, ...rest } = payload as unknown as Record<string, unknown>;
        variables = { id: msgId, input: { content, ...rest } };
      } else if (isIdMutation) {
        variables = payload as unknown as Record<string, unknown>;
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

      if (type === 'createLeaveRequest') {
        const created = result.data as { createLeaveRequest?: { id?: string } } | undefined;
        const createdId = created?.createLeaveRequest?.id;
        if (!createdId) {
          throw new Error('Leave request was created without an id');
        }

        const submitResponse = await fetch('/graphql', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'X-Tenant-Id': tenantId,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({
            query: MUTATIONS.submitLeaveRequest,
            variables: { id: createdId },
          }),
        });

        if (!submitResponse.ok) {
          throw new Error(`HTTP error: ${submitResponse.status}`);
        }

        const submitResult = await submitResponse.json() as { data?: unknown; errors?: Array<{ message: string }> };
        if (submitResult.errors && submitResult.errors.length > 0) {
          throw new Error(submitResult.errors[0]?.message || 'GraphQL error');
        }
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
          // WHY typed parse: JSON.parse returns `any`; narrow to the one claim we
          // read (`exp`) so the expiry math is type-safe. A malformed token (no
          // numeric exp) falls through to the catch below, which refreshes anyway.
          const payload: unknown = JSON.parse(atob(accessToken.split('.')[1]));
          const exp =
            typeof payload === 'object' && payload !== null && 'exp' in payload
              ? payload.exp
              : undefined;
          if (typeof exp !== 'number') {
            throw new Error('token has no numeric exp claim');
          }
          const expiresAt = exp * 1000;
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
      const preSyncOps = await getPendingOperations(tenantId);
      setSyncResults((prev) => {
        const next = new Map(prev);
        for (const op of preSyncOps) {
          next.set(op.id, 'syncing');
        }
        return next;
      });

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

      // FE-HIGH-051: no manual guard reset here. The reconnect auto-sync guard
      // is keyed on the monotonic queue version, which refreshQueue() (called
      // above) has just re-read. Any subsequent enqueue bumps the version and
      // re-arms the guard automatically — including the same-count
      // drain-then-enqueue case the old success-delta reset could not see.

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      setSyncError(message);
      return { success: 0, failed: pendingCount };
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [isOnline, executeGraphQL, refreshQueue, pendingCount, accessToken, refreshAuth, tenantId, queryClient]);

  const getSyncStatus = useCallback(
    (id: string): SyncStatus => {
      // A truthful success is keyed on the RETAINED syncResults map entry, which
      // syncNow sets to 'synced' only when an op actually drained from the queue.
      const cached = syncResults.get(id);
      if (cached) return cached;

      const operation = pendingOperations.find((op) => op.id === id);
      // FE-LOW-050: absent from BOTH the drain map AND the pending queue means we
      // have NO evidence this id ever existed (never-seen / typo'd id). Returning
      // 'synced' here was the false-confirm bug; 'unknown' makes it honest. A
      // genuinely-drained op is still 'synced' via the syncResults hit above.
      if (!operation) return 'unknown';
      if (operation.status === 'failed') return 'failed';
      if (operation.status === 'syncing' || (isSyncing && isOnline)) return 'syncing';
      return 'pending';
    },
    [isOnline, isSyncing, pendingOperations, syncResults],
  );

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

  // Auto-sync when coming online - with debounce to prevent loops.
  // PERF-04: syncNow is accessed via ref, not listed as a dependency,
  // preventing 50+ re-evaluations during a bulk sync session.
  //
  // FE-HIGH-051: re-arm on the queue VERSION token, not a pending-count delta.
  // The guard fires when (a) we are online, (b) there is work pending, and
  // (c) the current queue version differs from the version we last armed for.
  // Because every enqueue bumps the version, a drain-to-N-then-enqueue-back-to-N
  // (same count) still changes the version and re-triggers sync. Going offline
  // resets the armed version to a sentinel so the next reconnect always re-fires.
  useEffect(() => {
    if (!isOnline) {
      lastArmedVersionRef.current = -1;
      return;
    }
    if (pendingCount > 0 && lastArmedVersionRef.current !== queueVersion) {
      lastArmedVersionRef.current = queueVersion;
      // Small delay to ensure network is stable
      const timer = setTimeout(() => {
        // WHY void: auto-sync is fire-and-forget; syncNow swallows its own errors
        // (sets syncError state) and never rejects.
        void syncNowRef.current();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [isOnline, pendingCount, queueVersion]);

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
        // WHY void: periodic retry is fire-and-forget (syncNow handles its own errors).
        void syncNowRef.current();
      }
    }, 30_000);

    return () => clearInterval(retryInterval);
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
        getSyncStatus,
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
