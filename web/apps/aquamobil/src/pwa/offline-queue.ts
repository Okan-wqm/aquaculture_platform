import { get, set, del, keys, entries, createStore } from 'idb-keyval';
import {
  canonicalWireJsonStringifyV1,
  MOBILE_COMMAND_ENVELOPE_CONTRACT_V1,
  mobileCommandPayloadSha256V1,
} from '@aquaculture/shared-contracts';
import { FEEDING_MEAL_MOBILE_COMMAND_V1 } from '@aquaculture/feeding-contracts/feeding-record-vocabulary';

import type {
  QueuedOperation,
  OperationType,
  OperationPayload,
  AddToQueueResult,
  MobileCommandEnvelope,
} from '@/types';
import { logger } from '@/utils/logger';
import type { UserScopedCacheKey } from '@/utils/user-scoped-cache-key';
import { OFFLINE_QUEUE_STORAGE_AUTHORITY_V1 } from './offline-queue-storage.authority';

// Separate stores for queue and cache to avoid full-store scans (PERF-08)
const queueStore = createStore(
  OFFLINE_QUEUE_STORAGE_AUTHORITY_V1.databaseName,
  OFFLINE_QUEUE_STORAGE_AUTHORITY_V1.objectStoreName,
);
const cacheStore = createStore('aquamobil-cache', 'cache');
const keyStore = createStore('aquamobil-keys', 'keys');
// MSG-MEDIUM-055: dedicated store for offline media BLOBS. The encrypted JSON
// queue cannot carry binary, so a recorded/selected Blob is persisted here and
// referenced from the 'uploadAndSendMessage' queue op by id. Kept in its own
// store so the queue/cache stores stay scan-clean (PERF-08).
const blobStore = createStore('aquamobil-blobs', 'blobs');

const QUEUE_PREFIX = 'pending_';
const RETIRED_QUEUE_PREFIX = 'retired_v1_';
const RETIREMENT_GENERATION_PREFIX = 'retirement_generation_v1_';
const CACHE_PREFIX = 'cache_';
const BLOB_PREFIX = 'pending_blob_';
const DURABLE_QUEUE_KEY = 'queue-key-v1';
const DEVICE_ID_KEY = 'device-id-v1';

/** Maximum offline media blob size: 25 MB (matches the upload hook cap). */
export const MAX_PENDING_BLOB_BYTES = 26_214_400;

/**
 * Background Sync API surface. `sync` is NOT in the lib.dom
 * ServiceWorkerRegistration type — it is the experimental SyncManager surface,
 * feature-detected via `'SyncManager' in window` before use. We narrow to this
 * typed extension through a predicate rather than casting through `unknown`.
 */
interface BackgroundSyncRegistration extends ServiceWorkerRegistration {
  readonly sync: { register(tag: string): Promise<void> };
}
function hasBackgroundSync(reg: ServiceWorkerRegistration): reg is BackgroundSyncRegistration {
  return 'sync' in reg;
}

/** Maximum number of operations that can be queued offline before requiring a sync. */
export const MAX_QUEUE_SIZE = 200;
/** Threshold at which the UI should warn the user the queue is nearly full. */
export const QUEUE_WARNING_THRESHOLD = 180;

// ============================================================================
// SEC-03: Payload Encryption — AES-GCM with an IndexedDB-persisted non-extractable key
// ============================================================================
// The queue key is stored as a non-extractable CryptoKey in IndexedDB so queued
// commands survive full app restarts without persisting raw key material. Logout
// still clears queued data and cache entries through clearAllOperations().

let _sessionKey: CryptoKey | null = null;

async function getSessionKey(): Promise<CryptoKey> {
  if (_sessionKey) return _sessionKey;
  const persisted = await get<CryptoKey>(DURABLE_QUEUE_KEY, keyStore);
  if (persisted) {
    _sessionKey = persisted;
    return _sessionKey;
  }
  _sessionKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // not extractable — key cannot be exported from the browser
    ['encrypt', 'decrypt'],
  );
  await set(DURABLE_QUEUE_KEY, _sessionKey, keyStore);
  return _sessionKey;
}

async function getDeviceId(): Promise<string> {
  const existing = await get<string>(DEVICE_ID_KEY, keyStore);
  if (existing) return existing;
  const deviceId = crypto.randomUUID();
  await set(DEVICE_ID_KEY, deviceId, keyStore);
  return deviceId;
}

/**
 * Content fingerprint of an operation payload, computed BEFORE the command
 * envelope is attached. The envelope adds a fresh `clientCommandId` + a
 * wall-clock `clientCreatedAt` on every call, so hashing the post-envelope
 * object would make every submission unique and defeat dedup. Hashing the raw
 * domain payload (the exact bytes the user submitted) is what makes a
 * double-tap detectable: two taps of the same form produce the same hash.
 *
 * FE-HIGH-050: this is the single fingerprint used by BOTH the at-most-once
 * command envelope (`payloadHash`) AND the offline double-submit dedup window,
 * replacing the per-domain `extractResourceId` heuristic that silently missed
 * any payload shape it did not enumerate (e.g. stock movements, transfers).
 */
export async function computePayloadHash(payload: OperationPayload): Promise<string> {
  return mobileCommandPayloadSha256V1(payload);
}

async function attachCommandEnvelope(
  type: OperationType,
  payload: OperationPayload,
  clientCommandId: string,
  payloadHash: string,
): Promise<OperationPayload> {
  const envelope: MobileCommandEnvelope = {
    clientCommandId,
    clientCreatedAt: new Date().toISOString(),
    deviceId: await getDeviceId(),
    operationType: type,
    payloadHash,
    schemaVersion:
      type === FEEDING_MEAL_MOBILE_COMMAND_V1.operationType
        ? FEEDING_MEAL_MOBILE_COMMAND_V1.schemaVersion
        : MOBILE_COMMAND_ENVELOPE_CONTRACT_V1.schemaVersion,
  };
  return Object.assign({}, payload, envelope);
}

async function encryptPayload(
  payload: OperationPayload,
): Promise<{ iv: string; ciphertext: string }> {
  const key = await getSessionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  };
}

async function decryptPayload(iv: string, ciphertext: string): Promise<OperationPayload> {
  const key = await getSessionKey();
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
  const ctBytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ctBytes);
  return JSON.parse(new TextDecoder().decode(plaintext)) as OperationPayload;
}

// SEC-03-A: Generic encrypt/decrypt helpers for cache data (reuses the same
// per-session AES-GCM key used by the queue). These operate on arbitrary
// stringified JSON rather than typed OperationPayload.
async function encryptString(plaintext: string): Promise<{ iv: string; ciphertext: string }> {
  const key = await getSessionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertextBuf))),
  };
}

async function decryptString(iv: string, ciphertext: string): Promise<string> {
  const key = await getSessionKey();
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
  const ctBytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ctBytes);
  return new TextDecoder().decode(plaintext);
}

// Internal stored shape — payload is replaced by encrypted envelope
interface StoredOperation extends Omit<QueuedOperation, 'payload'> {
  _enc: { iv: string; ciphertext: string };
  // FE-HIGH-050: Store the plaintext payload fingerprint (SHA-256 hex) for O(1)
  // dedup comparison. A digest is NOT sensitive data (it is a one-way hash, not
  // the payload), so storing it unencrypted is safe and avoids a
  // decrypt-to-compare path. This is the SAME hash carried in the command
  // envelope's `payloadHash`, so the offline window and the server-side
  // at-most-once key agree on what "the same submission" means.
  _payloadHash: string;
}

interface LegacyStoredOperationV0 extends Omit<StoredOperation, 'type'> {
  readonly type: string;
}

interface RetiredQueuedOperationV1 {
  readonly schemaVersion: 'retired-queued-operation/v1';
  readonly disposition: 'quarantined';
  readonly reason: 'legacy-daily-feeding-authority-retired';
  readonly retiredAt: string;
  readonly sourceKey: string;
  readonly operation: LegacyStoredOperationV0;
}

interface RetiredQueueGenerationV1 {
  readonly schemaVersion: 'retired-queue-generation/v1';
  readonly tenantId: string;
  readonly generation: number;
  readonly migratedOperationCount: number;
  readonly lastRetiredAt: string;
}

export const OFFLINE_QUEUE_CLEAR_AUTHORITIES_V1 = Object.freeze({
  USER_PENDING_ONLY: 'user-request/pending-operations-only/v1',
  AUTHENTICATED_LOGOUT: 'authenticated-logout/device-erasure/v1',
} as const);

export type OfflineQueueClearAuthorityV1 =
  (typeof OFFLINE_QUEUE_CLEAR_AUTHORITIES_V1)[keyof typeof OFFLINE_QUEUE_CLEAR_AUTHORITIES_V1];

// ============================================================================
// Offline Queue Operations
// ============================================================================

/**
 * Deduplication window in milliseconds. Operations of the same type whose
 * payload fingerprint (SHA-256 of the raw domain payload) matches within this
 * window are treated as duplicate double-taps and collapsed onto the existing
 * queued operation rather than enqueued twice.
 *
 * FE-HIGH-050: keying dedup on the content fingerprint (not a per-domain id
 * heuristic) means a duplicate is "byte-identical submission of the same form
 * within 5s". This is correct for EVERY operation type by construction —
 * including stock movements and transfers that the old `extractResourceId`
 * heuristic did not enumerate and therefore never deduped (FE-MEDIUM-050).
 */
const DEDUP_WINDOW_MS = 5_000;

// ============================================================================
// FE-HIGH-051: Monotonic per-tenant queue version (auto-sync re-arm token)
// ============================================================================
// The reconnect auto-sync guard must re-fire whenever the queue's CONTENT
// changes, not merely when the pending COUNT changes. A count-delta guard
// misses the "drain to N, then enqueue back to N" case — same observed count,
// but a genuinely new operation that must sync. A monotonic version counter
// changes on every enqueue regardless of count, so the guard re-arms reliably.
//
// The version lives in the durable KEY store (the same store that holds the
// session key + device id), NOT the queue store. Keeping it out of the queue
// store means the queue store contains ONLY operation entries, so prefix-free
// full-store scans, counts, and inspections never see a non-operation record.
// It is a plain integer, not sensitive, so it is stored unencrypted.
const QUEUE_VERSION_PREFIX = 'qver_';

/**
 * Read the current monotonic queue version for a tenant. Returns 0 before the
 * first enqueue. Callers compare successive reads: a strictly greater value
 * means new content was queued since the last observation.
 */
export async function getQueueVersion(tenantId: string): Promise<number> {
  const value = await get<number>(`${QUEUE_VERSION_PREFIX}${tenantId}`, keyStore);
  const retirement = await get<RetiredQueueGenerationV1>(
    `${RETIREMENT_GENERATION_PREFIX}${tenantId}`,
    queueStore,
  );
  const enqueueGeneration = typeof value === 'number' ? value : 0;
  const retirementGeneration = retirement?.generation ?? 0;
  return enqueueGeneration + retirementGeneration;
}

/** Increment the tenant's queue version. Called on every successful enqueue. */
async function bumpQueueVersion(tenantId: string): Promise<void> {
  const key = `${QUEUE_VERSION_PREFIX}${tenantId}`;
  const current = await get<number>(key, keyStore);
  await set(key, (typeof current === 'number' ? current : 0) + 1, keyStore);
}

/**
 * One-way, idempotent cutover for pre-v2 `recordFeeding` queue entries.
 * Ciphertext and metadata move to the retired keyspace in the SAME IndexedDB
 * object-store transaction that deletes the live key. A crash can therefore
 * expose either the replayable pre-cutover row or the non-replayable evidence,
 * never a lost or duplicated half-move.
 */
async function quarantineRetiredLegacyFeedingOperationsV1(): Promise<void> {
  // Ensure idb-keyval has created the database/object store before opening the
  // native transaction authority over that same store.
  await keys(queueStore);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(
      OFFLINE_QUEUE_STORAGE_AUTHORITY_V1.databaseName,
      OFFLINE_QUEUE_STORAGE_AUTHORITY_V1.databaseVersion,
    );
    request.onerror = () => reject(request.error ?? new Error('Queue database open failed'));
    request.onsuccess = () => resolve(request.result);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        OFFLINE_QUEUE_STORAGE_AUTHORITY_V1.objectStoreName,
        'readwrite',
      );
      const store = transaction.objectStore(OFFLINE_QUEUE_STORAGE_AUTHORITY_V1.objectStoreName);
      const cursorRequest = store.openCursor();
      const migrationCountByTenant = new Map<string, number>();
      const retiredAt = new Date().toISOString();
      let abortRequested = false;

      const abort = (): void => {
        if (abortRequested) return;
        abortRequested = true;
        transaction.abort();
      };

      const writeGenerationReceipts = (): void => {
        for (const [tenantId, migratedCount] of migrationCountByTenant) {
          const receiptKey = `${RETIREMENT_GENERATION_PREFIX}${tenantId}`;
          const receiptRequest = store.get(receiptKey);
          receiptRequest.onerror = abort;
          receiptRequest.onsuccess = () => {
            const previous = receiptRequest.result as RetiredQueueGenerationV1 | undefined;
            if (
              previous !== undefined &&
              (previous.schemaVersion !== 'retired-queue-generation/v1' ||
                previous.tenantId !== tenantId ||
                !Number.isSafeInteger(previous.generation) ||
                previous.generation < 1 ||
                !Number.isSafeInteger(previous.migratedOperationCount) ||
                previous.migratedOperationCount < 1)
            ) {
              abort();
              return;
            }
            const receipt: RetiredQueueGenerationV1 = {
              schemaVersion: 'retired-queue-generation/v1',
              tenantId,
              generation: (previous?.generation ?? 0) + 1,
              migratedOperationCount: (previous?.migratedOperationCount ?? 0) + migratedCount,
              lastRetiredAt: retiredAt,
            };
            store.put(receipt, receiptKey);
          };
        }
      };

      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Queue retirement aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Queue retirement failed'));
      cursorRequest.onerror = () => transaction.abort();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          writeGenerationReceipts();
          return;
        }
        const key = cursor.key;
        const operation = cursor.value as LegacyStoredOperationV0;
        if (
          typeof key === 'string' &&
          key.startsWith(QUEUE_PREFIX) &&
          operation.type === 'recordFeeding'
        ) {
          const expectedSourceKey = `${QUEUE_PREFIX}${operation.tenantId}_${operation.id}`;
          if (
            typeof operation.tenantId !== 'string' ||
            operation.tenantId.length === 0 ||
            typeof operation.id !== 'string' ||
            operation.id.length === 0 ||
            key !== expectedSourceKey
          ) {
            abort();
            return;
          }
          const retiredKey = `${RETIRED_QUEUE_PREFIX}${operation.tenantId}_${operation.id}`;
          const existingRequest = store.get(retiredKey);
          existingRequest.onerror = abort;
          existingRequest.onsuccess = () => {
            const existing = existingRequest.result as RetiredQueuedOperationV1 | undefined;
            const evidence: RetiredQueuedOperationV1 = {
              schemaVersion: 'retired-queued-operation/v1',
              disposition: 'quarantined',
              reason: 'legacy-daily-feeding-authority-retired',
              retiredAt: existing?.retiredAt ?? retiredAt,
              sourceKey: key,
              operation,
            };
            if (existing === undefined) {
              store.add(evidence, retiredKey);
            } else {
              try {
                if (
                  canonicalWireJsonStringifyV1(existing) !== canonicalWireJsonStringifyV1(evidence)
                ) {
                  abort();
                  return;
                }
              } catch {
                abort();
                return;
              }
            }
            cursor.delete();
            migrationCountByTenant.set(
              operation.tenantId,
              (migrationCountByTenant.get(operation.tenantId) ?? 0) + 1,
            );
            cursor.continue();
          };
          return;
        }
        cursor.continue();
      };
    });
  } finally {
    database.close();
  }
}

export async function getRetiredLegacyFeedingOperationCount(tenantId?: string): Promise<number> {
  const prefix = tenantId ? `${RETIRED_QUEUE_PREFIX}${tenantId}_` : RETIRED_QUEUE_PREFIX;
  return (await keys(queueStore)).filter(
    (key): key is string => typeof key === 'string' && key.startsWith(prefix),
  ).length;
}

/**
 * Enqueue an offline operation, scoped to the given tenant.
 *
 * SECURITY (C11): tenantId is REQUIRED and embedded in both the StoredOperation
 * record and the IndexedDB key (`pending_${tenantId}_${id}`). This makes
 * cross-tenant replay STRUCTURALLY IMPOSSIBLE -- getPendingOperations() and
 * syncAllOperations() filter by tenantId, so tenant A's queued ops are never
 * visible when tenant B is active.
 *
 * FE-HIGH-050: returns a discriminated {@link AddToQueueResult} rather than a
 * bare string. `{ status: 'queued', id }` means a fresh operation was written;
 * `{ status: 'duplicate', id }` means a byte-identical submission already sits
 * in the queue within the dedup window and `id` points at THAT existing op (so
 * the UI can still surface its sync status, and never claims a second success).
 *
 * @param tenantId - Current tenant UUID (REQUIRED for tenant isolation)
 * @param type - The mutation type to execute on sync
 * @param payload - The operation payload (will be AES-GCM encrypted)
 * @param hasValidAuth - SEC-09: Only register background sync when credentials are valid
 * @param clientCommandId - FARM-HIGH-057: optional caller-supplied at-most-once
 *   command id. When a hook first ATTEMPTS the mutation online and only falls
 *   back to the queue on network failure, the online attempt and the queued
 *   replay are the SAME logical command — they MUST carry the SAME
 *   `clientCommandId` so the server's command receipt dedups the retry. The
 *   caller generates the id ONCE per action and threads it through both paths.
 *   When omitted (pure-offline first submit), a fresh id is minted here, which
 *   is the established behaviour for every other queued operation.
 */
export async function queueOperation(
  tenantId: string,
  type: OperationType,
  payload: OperationPayload,
  // SEC-09: Caller supplies hasValidAuth so background sync is only registered
  // when there are valid credentials. If the token expires before the sync fires
  // the in-app sync path (executeGraphQL) will catch the 401 and surface an error
  // rather than silently incrementing retryCount for an auth failure.
  hasValidAuth = false,
  clientCommandId?: string,
): Promise<AddToQueueResult> {
  await quarantineRetiredLegacyFeedingOperationsV1();
  // SECURITY (C11): tenantId is mandatory -- reject if missing
  if (!tenantId) {
    throw new Error('queueOperation: tenantId is required for tenant-isolated queueing');
  }

  // H6: Reject if queue is at capacity to prevent unbounded growth.
  const currentCount = await getPendingCount(tenantId);
  if (currentCount >= MAX_QUEUE_SIZE) {
    throw new Error('Offline queue is full (200 items). Please sync before adding more.');
  }

  // FE-HIGH-050: dedup on the payload content fingerprint, computed ONCE here
  // and reused for the stored command envelope. Operations of the same type
  // whose raw payload hashes identically within DEDUP_WINDOW_MS are double-taps
  // and are collapsed onto the existing queued op — preventing duplicate
  // submissions common on slow mobile connections, for every operation type.
  const payloadHash = await computePayloadHash(payload);
  const nowMs = Date.now();
  const allEntries = await entries<string, StoredOperation>(queueStore);
  // SECURITY (C11): Only dedup within the same tenant's operations.
  const tenantPrefix = `${QUEUE_PREFIX}${tenantId}_`;
  const existingDuplicate = allEntries.find(([key, op]) => {
    if (!String(key).startsWith(tenantPrefix)) return false;
    if (op.type !== type) return false;
    if (op._payloadHash !== payloadHash) return false;
    const opTimeMs = new Date(op.createdAt).getTime();
    return Math.abs(nowMs - opTimeMs) < DEDUP_WINDOW_MS;
  });
  if (existingDuplicate) {
    // Point the caller at the EXISTING operation so the two-phase status badge
    // tracks the real queued op rather than a second copy that was never written.
    return { status: 'duplicate', id: existingDuplicate[1].id };
  }

  const id = crypto.randomUUID();
  // FARM-HIGH-057: the queue STORAGE id is always fresh (it keys the IndexedDB
  // record), but the envelope's at-most-once `clientCommandId` is the
  // caller-supplied one when present so an online attempt and its offline replay
  // share a command identity. Absent a caller id, the storage id doubles as the
  // command id, matching the historical single-id behaviour.
  const commandId = clientCommandId ?? id;
  const payloadWithEnvelope = await attachCommandEnvelope(type, payload, commandId, payloadHash);

  // SEC-03: Encrypt sensitive payload before writing to IndexedDB.
  const _enc = await encryptPayload(payloadWithEnvelope);

  const stored: StoredOperation = {
    id,
    tenantId,
    type,
    _enc,
    // FE-HIGH-050: Persist the payload fingerprint in plaintext for O(1) dedup
    _payloadHash: payloadHash,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    status: 'pending',
  };

  // SECURITY (C11): Key format pending_${tenantId}_${id} ensures tenant isolation
  await set(`${QUEUE_PREFIX}${tenantId}_${id}`, stored, queueStore);

  // FE-HIGH-051: bump the tenant's monotonic queue version on every successful
  // write. The reconnect auto-sync guard re-arms on a version CHANGE rather than
  // a pending-count delta, so a drain-to-zero immediately followed by a new
  // enqueue (same observed count) still re-triggers sync instead of stalling.
  await bumpQueueVersion(tenantId);

  // SEC-09: Only register background sync when auth credentials are confirmed
  // present. An unauthenticated background sync attempt would fail with 401
  // and incorrectly increment retryCount, eventually permanently discarding
  // the operation even though the failure was due to auth, not bad data.
  // MOB-MEDIUM-002: `globalThis`, not `window` — this module is shared with the
  // SW sub-build (sw-replay.ts imports it), where `window` does not exist. The
  // registration path itself only ever runs in the window context (queueOperation
  // is called by the app), and the SyncManager presence check gates it there.
  if (hasValidAuth && 'serviceWorker' in navigator && 'SyncManager' in globalThis) {
    try {
      const registration = await navigator.serviceWorker.ready;
      if (hasBackgroundSync(registration)) {
        await registration.sync.register('sync-operations');

        // ADR-012: Register messaging-specific sync tag for priority processing.
        // Messaging operations are synced via 'sync-messages' before general ops.
        const isMessagingOp =
          type === 'sendMessage' ||
          type === 'editMessage' ||
          type === 'deleteMessage' ||
          type === 'markMessagesRead';
        if (isMessagingOp) {
          await registration.sync.register('sync-messages');
        }
      }
    } catch (error) {
      // FE-HIGH-056: route through the structured logger (no banned console.*).
      logger.warn('Background sync registration failed:', error);
    }
  }

  return { status: 'queued', id };
}

// Decrypt a StoredOperation back into a QueuedOperation. If decryption fails
// (e.g., the session key was rotated due to a full page reload) the entry is
// skipped rather than crashing the queue -- it will be cleaned up on logout.
async function decryptOperation(stored: StoredOperation): Promise<QueuedOperation | null> {
  try {
    const payload = await decryptPayload(stored._enc.iv, stored._enc.ciphertext);
    const { _enc: _ignored, _payloadHash: _ignored2, ...rest } = stored;
    return { ...rest, payload };
  } catch {
    return null;
  }
}

/**
 * Retrieve pending operations, optionally filtered by tenant.
 *
 * SECURITY (C11): When tenantId is provided, only operations belonging to that
 * tenant are returned. The key prefix `pending_${tenantId}_` is used for
 * efficient filtering without requiring decryption.
 *
 * @param tenantId - Optional tenant UUID. When provided, only that tenant's operations are returned.
 */
export async function getPendingOperations(tenantId?: string): Promise<QueuedOperation[]> {
  await quarantineRetiredLegacyFeedingOperationsV1();
  // Use dedicated queue store -- no need to filter by prefix across mixed entries (PERF-08)
  const allEntries = await entries<string, StoredOperation>(queueStore);
  // SECURITY (C11): Filter by tenant-scoped key prefix when tenantId is provided
  const prefix = tenantId ? `${QUEUE_PREFIX}${tenantId}_` : QUEUE_PREFIX;
  const decrypted = await Promise.all(
    allEntries
      .filter(([key]) => String(key).startsWith(prefix))
      .map(([, value]) => decryptOperation(value)),
  );
  return (decrypted.filter(Boolean) as QueuedOperation[]).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * Count pending operations, optionally scoped to a specific tenant.
 *
 * SECURITY (C11): When tenantId is provided, only that tenant's operations are counted.
 *
 * @param tenantId - Optional tenant UUID for tenant-scoped counting.
 */
export async function getPendingCount(tenantId?: string): Promise<number> {
  await quarantineRetiredLegacyFeedingOperationsV1();
  const allKeys = await keys(queueStore);
  const prefix = tenantId ? `${QUEUE_PREFIX}${tenantId}_` : QUEUE_PREFIX;
  // WHY the `k is string` guard, not `String(k)`: idb-keyval types keys as
  // IDBValidKey (string | number | Date | BufferSource | IDBValidKey[]), so
  // String(k) would stringify a non-string key to "[object Object]" and mis-count.
  // Our queue keys are ALWAYS the `${QUEUE_PREFIX}…` strings we wrote, so narrowing
  // to string is both correct and avoids the base-to-string hazard.
  return allKeys.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix)).length;
}

/**
 * Retrieve a single operation by ID.
 *
 * SECURITY (C11): tenantId is required to construct the correct tenant-scoped
 * IndexedDB key. Without it, the lookup would fail (no entry at wrong key).
 *
 * @param tenantId - Tenant UUID that owns this operation
 * @param id - Operation UUID
 */
export async function getOperation(
  tenantId: string,
  id: string,
): Promise<QueuedOperation | undefined> {
  await quarantineRetiredLegacyFeedingOperationsV1();
  const stored = await get<StoredOperation>(`${QUEUE_PREFIX}${tenantId}_${id}`, queueStore);
  if (!stored) return undefined;
  const op = await decryptOperation(stored);
  return op ?? undefined;
}

/**
 * Update fields of an existing operation.
 *
 * SECURITY (C11): tenantId is required to locate the correct tenant-scoped entry.
 *
 * @param tenantId - Tenant UUID that owns this operation
 * @param id - Operation UUID
 * @param updates - Partial fields to merge into the stored operation
 */
export async function updateOperation(
  tenantId: string,
  id: string,
  updates: Partial<QueuedOperation>,
): Promise<void> {
  const storeKey = `${QUEUE_PREFIX}${tenantId}_${id}`;
  const existingStored = await get<StoredOperation>(storeKey, queueStore);
  if (!existingStored) return;

  // If the caller is updating the payload, re-encrypt it. Otherwise keep the
  // existing encrypted envelope -- only re-encrypt the envelope if payload changed.
  const { payload: newPayload, ...nonPayloadUpdates } = updates;
  const newEnc = newPayload ? await encryptPayload(newPayload) : existingStored._enc;

  await set(storeKey, { ...existingStored, ...nonPayloadUpdates, _enc: newEnc }, queueStore);
}

/**
 * Remove an operation from the queue.
 *
 * SECURITY (C11): tenantId is required to target the correct tenant-scoped key.
 *
 * @param tenantId - Tenant UUID that owns this operation
 * @param id - Operation UUID
 */
export async function removeOperation(tenantId: string, id: string): Promise<void> {
  await del(`${QUEUE_PREFIX}${tenantId}_${id}`, queueStore);
}

/**
 * Clear queued operations under an explicit lifecycle authority.
 *
 * SECURITY (C11): When tenantId is provided, only that tenant's operations are
 * removed. The full-clear variant (no tenantId) is used on logout to wipe all
 * queued data from the device regardless of tenant.
 *
 * Retired cutover evidence is user-owned device data: a normal queue-clear
 * preserves it, while an authenticated logout explicitly erases it together
 * with its generation receipt and encryption key.
 */
export async function clearAllOperations(
  tenantId: string | undefined,
  authority: OfflineQueueClearAuthorityV1,
): Promise<void> {
  const allKeys = await keys(queueStore);
  const prefix = tenantId ? `${QUEUE_PREFIX}${tenantId}_` : QUEUE_PREFIX;
  // Queue keys are always the `${QUEUE_PREFIX}…` strings we wrote, so narrow to
  // string (avoids the base-to-string hazard on idb-keyval's IDBValidKey union).
  const queueKeys = allKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(prefix),
  );
  await Promise.all(queueKeys.map((k) => del(k, queueStore)));
  if (authority === OFFLINE_QUEUE_CLEAR_AUTHORITIES_V1.AUTHENTICATED_LOGOUT) {
    const retiredPrefix = tenantId ? `${RETIRED_QUEUE_PREFIX}${tenantId}_` : RETIRED_QUEUE_PREFIX;
    const generationPrefix = tenantId
      ? `${RETIREMENT_GENERATION_PREFIX}${tenantId}`
      : RETIREMENT_GENERATION_PREFIX;
    const retirementKeys = allKeys.filter(
      (key): key is string =>
        typeof key === 'string' &&
        (key.startsWith(retiredPrefix) || key.startsWith(generationPrefix)),
    );
    await Promise.all(retirementKeys.map((key) => del(key, queueStore)));
  }
  // FE-HIGH-051: tear down the matching queue-version token(s) so a wiped queue
  // also resets its re-arm counter — scoped clears drop just this tenant's
  // token, the full logout clear drops every tenant's token. The tokens live in
  // the durable KEY store, so they are scanned/deleted there, not in queueStore.
  const versionPrefix = tenantId ? `${QUEUE_VERSION_PREFIX}${tenantId}` : QUEUE_VERSION_PREFIX;
  const allKeyStoreKeys = await keys(keyStore);
  // Version tokens are always the `${QUEUE_VERSION_PREFIX}…` strings we wrote,
  // so narrow to string (avoids the base-to-string hazard on IDBValidKey).
  const versionKeys = allKeyStoreKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(versionPrefix),
  );
  await Promise.all(versionKeys.map((k) => del(k, keyStore)));
  // MSG-MEDIUM-055: pending media blobs share the queue's tenant-isolation +
  // logout-wipe lifecycle, so clearing the queue also clears the matching blobs
  // (scoped clear → this tenant's blobs; logout clear → every tenant's). Done
  // BEFORE the session key is torn down below so encrypted blobs are removable.
  await clearPendingBlobs(tenantId);
  if (!tenantId && authority === OFFLINE_QUEUE_CLEAR_AUTHORITIES_V1.AUTHENTICATED_LOGOUT) {
    _sessionKey = null;
    await del(DURABLE_QUEUE_KEY, keyStore);
  }
}

// ============================================================================
// Data Cache Operations (for offline tank/batch data)
// ============================================================================

// SEC-03-A: Cache entries are now AES-GCM encrypted at rest, matching the
// queue encryption strategy. TTL metadata (cachedAt, expiresAt) remains in
// plaintext so expiry checks don't require decryption. Backwards-compatible:
// if a legacy unencrypted entry is encountered, getCachedData() deletes it
// and returns null rather than leaking data or crashing.

interface EncryptedCacheEntry {
  _enc: { iv: string; ciphertext: string };
  cachedAt: string;
  expiresAt: string;
}

/**
 * Store tenant-scoped data in the encrypted IndexedDB cache.
 *
 * SECURITY (FE-CRITICAL-002 fix): tenantId is a REQUIRED parameter and is
 * included in the cache key as `cache_${tenantId}:${key}`. This makes
 * cross-tenant cache leakage STRUCTURALLY IMPOSSIBLE -- on tenant switch or
 * shared-device reuse, data from a previous tenant cannot be served because
 * the key namespace is different.
 *
 * @param tenantId - Current tenant UUID (REQUIRED for tenant isolation)
 * @param key - Domain-specific cache key (e.g., 'schedule_2026-04-07')
 * @param data - Data to cache (will be AES-GCM encrypted)
 * @param ttlMs - Time-to-live in milliseconds (default: 1 hour)
 */
export async function cacheData<T>(
  tenantId: string,
  key: string,
  data: T,
  ttlMs: number = 1000 * 60 * 60,
): Promise<void> {
  if (!tenantId) {
    throw new Error('cacheData: tenantId is required for tenant-isolated caching');
  }
  const _enc = await encryptString(JSON.stringify(data));
  const entry: EncryptedCacheEntry = {
    _enc,
    cachedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  // SECURITY: Key format cache_${tenantId}:${key} prevents cross-tenant reads
  await set(`${CACHE_PREFIX}${tenantId}:${key}`, entry, cacheStore);
}

/**
 * Retrieve tenant-scoped data from the encrypted IndexedDB cache.
 *
 * SECURITY (FE-CRITICAL-002 fix): tenantId is required in the key lookup,
 * so cached data from tenant A is never returned when tenant B is active.
 *
 * @param tenantId - Current tenant UUID (REQUIRED for tenant isolation)
 * @param key - Domain-specific cache key
 */
export async function getCachedData<T>(tenantId: string, key: string): Promise<T | null> {
  if (!tenantId) {
    throw new Error('getCachedData: tenantId is required for tenant-isolated caching');
  }
  // WHY the explicit Record<string, unknown> type arg: idb-keyval's get<T = any>
  // defaults to `any`, which trips no-unsafe-assignment and discards type safety.
  // Cache entries are written as objects (EncryptedCacheEntry, or a legacy plain
  // object), so the unknown-valued record is the correct, honest read type — each
  // field is then narrowed explicitly below.
  const entry = await get<Record<string, unknown>>(`${CACHE_PREFIX}${tenantId}:${key}`, cacheStore);
  if (!entry) return null;

  // Check TTL first (plaintext metadata -- no decryption needed)
  const expiresAt = entry.expiresAt as string | undefined;
  if (expiresAt && new Date(expiresAt) < new Date()) {
    await del(`${CACHE_PREFIX}${tenantId}:${key}`, cacheStore);
    return null;
  }

  // SEC-03-A: Encrypted entry path
  if (entry._enc && typeof entry._enc === 'object') {
    const enc = entry._enc as { iv: string; ciphertext: string };
    try {
      const decrypted = await decryptString(enc.iv, enc.ciphertext);
      return JSON.parse(decrypted) as T;
    } catch {
      // Decryption failed (session key rotated or data corrupted) -- purge entry
      await del(`${CACHE_PREFIX}${tenantId}:${key}`, cacheStore);
      return null;
    }
  }

  // Backwards-compat: legacy unencrypted entry -- purge it instead of returning
  // plaintext data, so the caller re-fetches and stores an encrypted copy.
  await del(`${CACHE_PREFIX}${tenantId}:${key}`, cacheStore);
  return null;
}

/**
 * Store USER-scoped data in the encrypted IndexedDB cache.
 *
 * SECURITY (MT-CRITICAL-051): on shared field devices, two users of the SAME
 * tenant must never share a cache namespace. The `key` is a branded
 * {@link UserScopedCacheKey} that can ONLY be produced by `userScopedCacheKey`,
 * which structurally REQUIRES a userId. So a callsite caching a `my*` resolver
 * result cannot forget the user partition — it would not compile. This is the
 * single user-scoped write path; it delegates to {@link cacheData} so the
 * AES-GCM encryption + TTL handling remain one implementation (no duplicated
 * crypto). The branded key still rides inside the `cache_${tenantId}:` prefix,
 * so the logout wipe (`clearCache()` with no tenant) clears it too.
 *
 * @param tenantId - Current tenant UUID (REQUIRED for tenant isolation)
 * @param key - Branded user-scoped cache key (from `userScopedCacheKey`)
 * @param data - Data to cache (will be AES-GCM encrypted)
 * @param ttlMs - Time-to-live in milliseconds (default: 1 hour)
 */
export async function cacheUserData<T>(
  tenantId: string,
  key: UserScopedCacheKey,
  data: T,
  ttlMs: number = 1000 * 60 * 60,
): Promise<void> {
  await cacheData(tenantId, key, data, ttlMs);
}

/**
 * Retrieve USER-scoped data from the encrypted IndexedDB cache.
 *
 * SECURITY (MT-CRITICAL-051): the branded {@link UserScopedCacheKey} guarantees
 * the lookup namespace embeds the user id, so tenant A/user A's cached `my*`
 * data is never returned for tenant A/user B on a shared device. Delegates to
 * {@link getCachedData} so the decryption + TTL-expiry + legacy-purge logic stay
 * the single source of truth.
 *
 * @param tenantId - Current tenant UUID (REQUIRED for tenant isolation)
 * @param key - Branded user-scoped cache key (from `userScopedCacheKey`)
 */
export async function getCachedUserData<T>(
  tenantId: string,
  key: UserScopedCacheKey,
): Promise<T | null> {
  return getCachedData<T>(tenantId, key);
}

/**
 * Clear all cache entries, optionally scoped to a specific tenant.
 *
 * SECURITY (FE-CRITICAL-002 fix): When tenantId is provided, only that
 * tenant's cache entries are cleared. The full-clear variant is used on
 * logout to wipe all cached data from the device.
 *
 * @param tenantId - Optional tenant UUID. If provided, only clears that tenant's entries.
 */
export async function clearCache(tenantId?: string): Promise<void> {
  const allKeys = await keys(cacheStore);
  const prefix = tenantId ? `${CACHE_PREFIX}${tenantId}:` : CACHE_PREFIX;
  // Cache keys are always the `${CACHE_PREFIX}…` strings we wrote, so narrow to
  // string (avoids the base-to-string hazard on idb-keyval's IDBValidKey union).
  const cacheKeys = allKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(prefix),
  );
  await Promise.all(cacheKeys.map((k) => del(k, cacheStore)));
}

// ============================================================================
// MSG-MEDIUM-055: Binary Blob Store (offline media lane)
// ============================================================================
// Recorded/selected media Blobs are persisted here, AES-GCM encrypted at rest
// with the SAME non-extractable session key the queue uses, under
// tenant-partitioned keys (`pending_blob_${tenantId}_${blobId}`). The logout
// wipe (clearAllOperations with no tenantId) clears every tenant's blobs, and a
// scoped clear drops just that tenant's — mirroring the queue's isolation model.
//
// TRACKED LIMITATION (MSG-MEDIUM-055, not faked): the upload-and-send replay is
// a 3-call presign → PUT → send sequence needing the foreground media plumbing.
// MOB-MEDIUM-002 clarified the real split: PLAIN queued ops ARE replayed by the
// SW while the app is closed (sw-replay.ts — cookie refresh + /graphql re-POST,
// listed in its SW_REPLAY_SKIP_TYPES exception set), but BLOB ops are skipped by
// that lane and sync on the NEXT FOREGROUND (the in-app reconnect lane in
// useOfflineQueue.syncNow). Closing the blob-while-closed gap requires teaching
// the SW the presigned multipart PUT flow and is tracked as a separate finding
// (server-side reaper + SW upload support).

interface EncryptedBlobEntry {
  _enc: { iv: string; ciphertext: string };
  mimeType: string;
}

/**
 * Encode a binary buffer to a base64 string in chunks (avoids the call-stack
 * blow-up of `String.fromCharCode(...hugeArray)` on large media).
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Persist a pending media Blob for later upload-and-send. Tenant-scoped and
 * encrypted at rest. Rejects blobs over the 25 MB cap so the queue cannot grow
 * unbounded from a single oversize file.
 *
 * @param tenantId - Current tenant UUID (REQUIRED for tenant isolation)
 * @param blob - The recorded/selected media bytes
 * @returns The generated blob id to reference from the queue op
 */
export async function putPendingBlob(tenantId: string, blob: Blob): Promise<string> {
  if (!tenantId) {
    throw new Error('putPendingBlob: tenantId is required for tenant-isolated blob storage');
  }
  if (blob.size > MAX_PENDING_BLOB_BYTES) {
    throw new Error('Attachment exceeds the 25 MB offline limit.');
  }
  const blobId = crypto.randomUUID();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const _enc = await encryptString(bytesToBase64(bytes));
  const entry: EncryptedBlobEntry = { _enc, mimeType: blob.type };
  await set(`${BLOB_PREFIX}${tenantId}_${blobId}`, entry, blobStore);
  return blobId;
}

/**
 * Retrieve a persisted media Blob by id, or null if absent/undecryptable.
 *
 * @param tenantId - Tenant UUID that owns the blob
 * @param blobId - Blob id returned by putPendingBlob
 */
export async function getPendingBlob(tenantId: string, blobId: string): Promise<Blob | null> {
  if (!tenantId) {
    throw new Error('getPendingBlob: tenantId is required for tenant-isolated blob storage');
  }
  const entry = await get<EncryptedBlobEntry>(`${BLOB_PREFIX}${tenantId}_${blobId}`, blobStore);
  if (!entry || !entry._enc) return null;
  try {
    const base64 = await decryptString(entry._enc.iv, entry._enc.ciphertext);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: entry.mimeType });
  } catch {
    // Decryption failed (session key rotated / corruption) — purge and report
    // absent so the caller fails the op rather than crashing.
    await del(`${BLOB_PREFIX}${tenantId}_${blobId}`, blobStore);
    return null;
  }
}

/**
 * Delete a persisted media Blob (called after a successful upload-and-send).
 */
export async function removePendingBlob(tenantId: string, blobId: string): Promise<void> {
  await del(`${BLOB_PREFIX}${tenantId}_${blobId}`, blobStore);
}

/**
 * Clear pending blobs, optionally scoped to a tenant. The unscoped variant is
 * the logout wipe; the scoped variant drops a single tenant's blobs.
 */
export async function clearPendingBlobs(tenantId?: string): Promise<void> {
  const allKeys = await keys(blobStore);
  const prefix = tenantId ? `${BLOB_PREFIX}${tenantId}_` : BLOB_PREFIX;
  // Blob keys are always the `${BLOB_PREFIX}…` strings we wrote, so narrow to
  // string (avoids the base-to-string hazard on idb-keyval's IDBValidKey union).
  const blobKeys = allKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(prefix),
  );
  await Promise.all(blobKeys.map((k) => del(k, blobStore)));
}

// ============================================================================
// Sync Logic
// ============================================================================

type GraphQLExecutor = (type: OperationType, payload: OperationPayload) => Promise<unknown>;

export async function syncOperation(
  operation: QueuedOperation,
  executeGraphQL: GraphQLExecutor,
): Promise<boolean> {
  try {
    await updateOperation(operation.tenantId, operation.id, { status: 'syncing' });
    await executeGraphQL(operation.type, operation.payload);
    await removeOperation(operation.tenantId, operation.id);
    return true;
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message.slice(0, 200) // SEC-07: truncate error messages
        : 'Unknown error';
    await updateOperation(operation.tenantId, operation.id, {
      status: 'failed',
      retryCount: operation.retryCount + 1,
      lastError: errorMessage,
    });
    return false;
  }
}

/**
 * Maximum number of retry attempts before an operation is considered permanently
 * failed. After this threshold the operation remains in the queue with 'failed'
 * status so the user can manually inspect or remove it from the Sync Status page.
 */
export const MAX_RETRY_COUNT = 5;

/**
 * Exponential backoff base delay in milliseconds for retry scheduling.
 * Actual delay = BASE_RETRY_DELAY_MS * 2^(retryCount - 1), capped at 5 minutes.
 */
const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1_000;

/**
 * Calculate the next retry delay using exponential backoff with jitter.
 * Prevents thundering-herd when many operations fail simultaneously.
 *
 * @param retryCount - Current retry attempt number (1-based after first failure)
 * @returns Delay in milliseconds before the next retry attempt
 */
export function calculateRetryDelay(retryCount: number): number {
  const exponentialDelay = BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, retryCount - 1));
  const cappedDelay = Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
  // Add 0-25% jitter to prevent synchronized retries across multiple operations
  const jitter = cappedDelay * Math.random() * 0.25;
  return cappedDelay + jitter;
}

/**
 * Determine whether a failed operation is eligible for automatic retry.
 *
 * Distinguishes between transient errors (network timeouts, 5xx server errors)
 * and permanent errors (validation failures, 4xx client errors) to avoid
 * wasting retry budget on operations that will never succeed.
 *
 * @param errorMessage - The truncated error message from the last sync attempt
 * @returns true if the error is likely transient and worth retrying
 */
function isRetryableError(errorMessage?: string): boolean {
  if (!errorMessage) return true;
  const lower = errorMessage.toLowerCase();

  // Permanent errors that should NOT be retried -- these indicate bad data
  // or business-rule violations that won't resolve without user intervention.
  const permanentPatterns = [
    'validation',
    'not found',
    'forbidden',
    'unauthorized',
    'duplicate',
    'constraint',
    'invalid input',
    'bad request',
  ];

  return !permanentPatterns.some((pattern) => lower.includes(pattern));
}

/**
 * Sync all pending operations for the given tenant.
 *
 * SECURITY (C11): tenantId is REQUIRED -- only operations belonging to the
 * specified tenant are synced. This prevents cross-tenant replay on shared
 * devices where multiple users may have queued operations.
 *
 * @param tenantId - Tenant UUID whose operations should be synced
 * @param executeGraphQL - Function that executes the GraphQL mutation
 * @param options.skipTypes - Operation types this drain lane cannot execute
 *   (MOB-MEDIUM-002: the SW replay lane skips the blob lane). Skipped ops are
 *   left completely untouched — not attempted, not counted failed, retryCount
 *   unchanged — so they drain intact on the next lane that CAN run them.
 */
export async function syncAllOperations(
  tenantId: string,
  executeGraphQL: GraphQLExecutor,
  options?: { skipTypes?: readonly OperationType[] },
): Promise<{ success: number; failed: number }> {
  // SECURITY (C11): tenantId is mandatory for sync isolation
  if (!tenantId) {
    throw new Error('syncAllOperations: tenantId is required for tenant-isolated sync');
  }

  // CRIT-4 (BUG-02): Reset stale 'syncing' entries left from interrupted prior sessions
  // before processing. This prevents operations from being permanently stuck in 'syncing'.
  const allOps = await getPendingOperations(tenantId);
  const staleSync = allOps.filter((op) => op.status === 'syncing');
  await Promise.all(
    staleSync.map((op) => updateOperation(op.tenantId, op.id, { status: 'pending' })),
  );

  // BUG-17: Promote retryable 'failed' operations back to 'pending' so they
  // are included in this sync pass. Previously, failed items were skipped
  // permanently -- they never transitioned back to 'pending', leaving the user
  // with a dead queue that only manual deletion could resolve.
  const retryableFailed = allOps.filter(
    (op) =>
      op.status === 'failed' && op.retryCount < MAX_RETRY_COUNT && isRetryableError(op.lastError),
  );
  await Promise.all(
    retryableFailed.map((op) => updateOperation(op.tenantId, op.id, { status: 'pending' })),
  );

  const pendingOps = await getPendingOperations(tenantId);
  // FARM-HIGH-214 priority drain: escape incidents are legally time-critical
  // (the rømming varsling is immediate), so a reconnect flushes them BEFORE the
  // rest of the backlog. Stable partition — relative order within each group
  // is preserved, so the established FIFO semantics hold for everything else.
  const operations = [
    ...pendingOps.filter((op) => op.type === 'recordEscapeIncident'),
    ...pendingOps.filter((op) => op.type !== 'recordEscapeIncident'),
  ];
  let success = 0;
  let failed = 0;

  for (const op of operations) {
    // MOB-MEDIUM-002: types this lane cannot execute are left untouched (not
    // failed, not retried) so the capable lane drains them later.
    if (options?.skipTypes?.includes(op.type)) {
      continue;
    }
    // Skip permanently failed operations (exceeded max retries or non-retryable error).
    // Also skip 'failed' operations that were NOT promoted to 'pending' -- these have
    // non-retryable errors (validation, 4xx) and should not be re-attempted.
    if (op.retryCount >= MAX_RETRY_COUNT) {
      failed++;
      continue;
    }
    if (op.status === 'failed') {
      failed++;
      continue;
    }

    const result = await syncOperation(op, executeGraphQL);
    if (result) {
      success++;
    } else {
      failed++;
    }
  }

  return { success, failed };
}
