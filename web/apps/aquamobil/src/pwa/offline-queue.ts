import { get, set, del, keys, entries, createStore } from 'idb-keyval';
import type { QueuedOperation, OperationType, OperationPayload } from '@/types';

// Separate stores for queue and cache to avoid full-store scans (PERF-08)
const queueStore = createStore('aquamobil-queue', 'queue');
const cacheStore = createStore('aquamobil-cache', 'cache');
const keyStore = createStore('aquamobil-keys', 'keys');

const QUEUE_PREFIX = 'pending_';
const CACHE_PREFIX = 'cache_';
const DURABLE_QUEUE_KEY = 'queue-key-v1';
const DEVICE_ID_KEY = 'device-id-v1';

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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function attachCommandEnvelope(
  type: OperationType,
  payload: OperationPayload,
  clientCommandId: string,
): Promise<OperationPayload> {
  const payloadHash = await sha256Hex(stableStringify(payload));
  return {
    ...(payload as unknown as Record<string, unknown>),
    clientCommandId,
    clientCreatedAt: new Date().toISOString(),
    deviceId: await getDeviceId(),
    operationType: type,
    payloadHash,
    schemaVersion: 'mobile-command-v1',
  } as OperationPayload;
}

async function encryptPayload(payload: OperationPayload): Promise<{ iv: string; ciphertext: string }> {
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
  // FE-MEDIUM-030: Store plaintext resourceId for dedup comparison.
  // This is NOT sensitive data (it's a UUID/composite key), so storing it
  // unencrypted is safe and avoids the expensive decrypt-to-compare path.
  _resourceId: string;
}

// ============================================================================
// Offline Queue Operations
// ============================================================================

/**
 * Deduplication window in milliseconds. Operations with the same type and
 * resourceId within this window are considered duplicates (e.g., double-tap).
 */
const DEDUP_WINDOW_MS = 5_000;

/**
 * Extract a stable resource identifier from a payload for dedup comparison.
 * Uses batchId+tankId for farm operations, employeeId for HR, or task id.
 */
function extractResourceId(type: OperationType, payload: OperationPayload): string {
  const p = payload as unknown as Record<string, unknown>;
  // Water quality operations identify by equipmentId (H7)
  if (type === 'createWaterQuality') {
    return String(p['equipmentId'] || '');
  }
  // Task mutations use { id } directly
  if (type === 'completeTask' || type === 'startTask') {
    return String(p['id'] || '');
  }
  // Messaging: sendMessage dedupes by idempotencyKey, edit/delete by message id,
  // markMessagesRead by channelId+messageId (ADR-012)
  if (type === 'sendMessage') {
    return String(p['idempotencyKey'] || '');
  }
  if (type === 'editMessage' || type === 'deleteMessage') {
    return String(p['id'] || '');
  }
  if (type === 'markMessagesRead') {
    return `${p['channelId']}:${p['messageId']}`;
  }
  // Most farm operations identify by batchId+tankId
  if (p['batchId'] && p['tankId']) {
    return `${p['batchId']}:${p['tankId']}`;
  }
  // Self-service leave requests no longer carry employeeId; use the natural
  // request fingerprint so double-taps cannot create duplicate queued submits.
  if (type === 'createLeaveRequest' && p['leaveTypeId'] && p['startDate'] && p['endDate']) {
    return [
      p['leaveTypeId'],
      p['startDate'],
      p['endDate'],
      p['isHalfDayStart'] ?? false,
      p['isHalfDayEnd'] ?? false,
    ].join(':');
  }
  // Self-service attendance requests identify the current authenticated employee
  // on the server. The operation type is already part of the dedup comparison.
  if (type === 'clockIn' || type === 'clockOut') {
    return String(p['employeeId'] || 'self');
  }
  // Legacy HR payloads may still carry employeeId.
  if (p['employeeId']) {
    return String(p['employeeId']);
  }
  // Transfers identify by source+destination
  if (p['sourceTankId'] && p['destinationTankId']) {
    return `${p['batchId']}:${p['sourceTankId']}:${p['destinationTankId']}`;
  }
  return '';
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
 * @param tenantId - Current tenant UUID (REQUIRED for tenant isolation)
 * @param type - The mutation type to execute on sync
 * @param payload - The operation payload (will be AES-GCM encrypted)
 * @param hasValidAuth - SEC-09: Only register background sync when credentials are valid
 */
export async function queueOperation(
  tenantId: string,
  type: OperationType,
  payload: OperationPayload,
  // SEC-09: Caller supplies hasValidAuth so background sync is only registered
  // when there are valid credentials. If the token expires before the sync fires
  // the in-app sync path (executeGraphQL) will catch the 401 and surface an error
  // rather than silently incrementing retryCount for an auth failure.
  hasValidAuth: boolean = false,
): Promise<string> {
  // SECURITY (C11): tenantId is mandatory -- reject if missing
  if (!tenantId) {
    throw new Error('queueOperation: tenantId is required for tenant-isolated queueing');
  }

  // H6: Reject if queue is at capacity to prevent unbounded growth.
  const currentCount = await getPendingCount(tenantId);
  if (currentCount >= MAX_QUEUE_SIZE) {
    throw new Error('Offline queue is full (200 items). Please sync before adding more.');
  }

  // Deduplication: reject operations with the same type + resourceId within DEDUP_WINDOW_MS.
  // This prevents double-tap / duplicate submissions common on slow mobile connections.
  const resourceId = extractResourceId(type, payload);
  if (resourceId) {
    const nowMs = Date.now();
    const allEntries = await entries<string, StoredOperation>(queueStore);
    // FE-MEDIUM-030: Compare type + resourceId + time window for dedup.
    // SECURITY (C11): Only dedup within the same tenant's operations.
    const tenantPrefix = `${QUEUE_PREFIX}${tenantId}_`;
    const isDuplicate = allEntries.some(([key, op]) => {
      if (!String(key).startsWith(tenantPrefix)) return false;
      if (op.type !== type) return false;
      if (op._resourceId !== resourceId) return false;
      const opTimeMs = new Date(op.createdAt).getTime();
      if (Math.abs(nowMs - opTimeMs) >= DEDUP_WINDOW_MS) return false;
      return true;
    });
    if (isDuplicate) {
      // Return empty string to signal the caller that the operation was deduped.
      // The hook's addToQueue wrapper still refreshes the queue count.
      return '';
    }
  }

  const id = crypto.randomUUID();
  const payloadWithEnvelope = await attachCommandEnvelope(type, payload, id);

  // SEC-03: Encrypt sensitive payload before writing to IndexedDB.
  const _enc = await encryptPayload(payloadWithEnvelope);

  const stored: StoredOperation = {
    id,
    tenantId,
    type,
    _enc,
    // FE-MEDIUM-030: Persist resourceId in plaintext for O(1) dedup comparison
    _resourceId: resourceId,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    status: 'pending',
  };

  // SECURITY (C11): Key format pending_${tenantId}_${id} ensures tenant isolation
  await set(`${QUEUE_PREFIX}${tenantId}_${id}`, stored, queueStore);

  // SEC-09: Only register background sync when auth credentials are confirmed
  // present. An unauthenticated background sync attempt would fail with 401
  // and incorrectly increment retryCount, eventually permanently discarding
  // the operation even though the failure was due to auth, not bad data.
  if (hasValidAuth && 'serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const registration = await navigator.serviceWorker.ready;
      const syncManager = (registration as unknown as { sync: { register: (tag: string) => Promise<void> } }).sync;
      await syncManager.register('sync-operations');

      // ADR-012: Register messaging-specific sync tag for priority processing.
      // Messaging operations are synced via 'sync-messages' before general ops.
      const isMessagingOp = type === 'sendMessage' || type === 'editMessage' ||
        type === 'deleteMessage' || type === 'markMessagesRead';
      if (isMessagingOp) {
        await syncManager.register('sync-messages');
      }
    } catch (error) {
      console.warn('Background sync registration failed:', error);
    }
  }

  return id;
}

/**
 * Forward-compat queue UPGRADE for water-quality payloads (Tier-1 single-ingress).
 *
 * WHY: aquamobil persists serialized CreateWaterQualityInput payloads in the
 * encrypted IndexedDB queue and replays them via raw GraphQL later — possibly
 * AFTER a deploy that removed the legacy `parameters` field. Under the
 * production ValidationPipe ({ whitelist: true, forbidNonWhitelisted: true }) a
 * replayed payload still carrying `parameters` would be REJECTED, silently
 * losing a measurement the field worker believed was saved offline.
 *
 * WHAT: this transform runs at the SINGLE queue read/replay ingress
 * (decryptOperation, which feeds both getPendingOperations/sync and getOperation).
 * For `createWaterQuality` operations it:
 *   1. folds any legacy `parameters` values into `dynamicParameters` (existing
 *      dynamicParameters keys win — they were the newer, validated channel),
 *   2. drops the now-forbidden `parameters` field,
 *   3. backfills `equipmentId` from a legacy `tankId` when equipmentId is absent
 *      (the pre-migration web path conflated the two).
 * No queued record is lost: a legacy payload is upgraded in-flight to the new
 * single-ingress shape before it reaches the server.
 */
function migrateWaterQualityPayload(payload: OperationPayload): OperationPayload {
  // A pre-migration WQ payload carries a legacy `parameters` key the current
  // OperationPayload type no longer declares. Intersect with the optional
  // legacy/transitional keys so they are readable + removable WITHOUT an
  // `unknown` bridge; every added key is optional, so the intersection is a
  // subtype of OperationPayload and `rest` below remains assignable back to it.
  const record = payload as OperationPayload & {
    parameters?: Record<string, unknown>;
    dynamicParameters?: Record<string, number | string | boolean>;
    equipmentId?: string;
    tankId?: string;
  };
  if (!record.parameters && record.equipmentId) {
    return payload;
  }

  const foldedDynamic: Record<string, number | string | boolean> = {};
  if (record.parameters && typeof record.parameters === 'object' && !Array.isArray(record.parameters)) {
    for (const [key, value] of Object.entries(record.parameters)) {
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        foldedDynamic[key] = value;
      }
    }
  }

  const existingDynamic = record.dynamicParameters ?? {};

  // Existing dynamicParameters keys take precedence over folded legacy ones.
  const { parameters: _legacyParameters, ...rest } = record;
  rest.dynamicParameters = { ...foldedDynamic, ...existingDynamic };

  // Backfill equipmentId from legacy tankId when the new required field is absent.
  if (!rest.equipmentId && rest.tankId) {
    rest.equipmentId = rest.tankId;
  }

  return rest;
}

// Decrypt a StoredOperation back into a QueuedOperation. If decryption fails
// (e.g., the session key was rotated due to a full page reload) the entry is
// skipped rather than crashing the queue -- it will be cleaned up on logout.
async function decryptOperation(stored: StoredOperation): Promise<QueuedOperation | null> {
  try {
    const payload = await decryptPayload(stored._enc.iv, stored._enc.ciphertext);
    const { _enc: _ignored, _resourceId: _ignored2, ...rest } = stored;
    // Forward-compat single-ingress upgrade for legacy WQ payloads queued
    // before the `parameters` field was removed (see migrateWaterQualityPayload).
    const migratedPayload =
      stored.type === 'createWaterQuality' ? migrateWaterQualityPayload(payload) : payload;
    return { ...rest, payload: migratedPayload };
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
  // Use dedicated queue store -- no need to filter by prefix across mixed entries (PERF-08)
  const allEntries = await entries<string, StoredOperation>(queueStore);
  // SECURITY (C11): Filter by tenant-scoped key prefix when tenantId is provided
  const prefix = tenantId
    ? `${QUEUE_PREFIX}${tenantId}_`
    : QUEUE_PREFIX;
  const decrypted = await Promise.all(
    allEntries
      .filter(([key]) => String(key).startsWith(prefix))
      .map(([, value]) => decryptOperation(value)),
  );
  return (decrypted.filter(Boolean) as QueuedOperation[])
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/**
 * Count pending operations, optionally scoped to a specific tenant.
 *
 * SECURITY (C11): When tenantId is provided, only that tenant's operations are counted.
 *
 * @param tenantId - Optional tenant UUID for tenant-scoped counting.
 */
export async function getPendingCount(tenantId?: string): Promise<number> {
  const allKeys = await keys(queueStore);
  const prefix = tenantId
    ? `${QUEUE_PREFIX}${tenantId}_`
    : QUEUE_PREFIX;
  return allKeys.filter((k) => String(k).startsWith(prefix)).length;
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
export async function getOperation(tenantId: string, id: string): Promise<QueuedOperation | undefined> {
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
export async function updateOperation(tenantId: string, id: string, updates: Partial<QueuedOperation>): Promise<void> {
  const storeKey = `${QUEUE_PREFIX}${tenantId}_${id}`;
  const existingStored = await get<StoredOperation>(storeKey, queueStore);
  if (!existingStored) return;

  // If the caller is updating the payload, re-encrypt it. Otherwise keep the
  // existing encrypted envelope -- only re-encrypt the envelope if payload changed.
  const { payload: newPayload, ...nonPayloadUpdates } = updates;
  const newEnc = newPayload ? await encryptPayload(newPayload) : existingStored._enc;

  await set(
    storeKey,
    { ...existingStored, ...nonPayloadUpdates, _enc: newEnc },
    queueStore,
  );
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
 * Clear all queued operations, optionally scoped to a specific tenant.
 *
 * SECURITY (C11): When tenantId is provided, only that tenant's operations are
 * removed. The full-clear variant (no tenantId) is used on logout to wipe all
 * queued data from the device regardless of tenant.
 *
 * @param tenantId - Optional tenant UUID. If provided, only clears that tenant's queue.
 */
export async function clearAllOperations(tenantId?: string): Promise<void> {
  const allKeys = await keys(queueStore);
  const prefix = tenantId
    ? `${QUEUE_PREFIX}${tenantId}_`
    : QUEUE_PREFIX;
  const queueKeys = allKeys.filter((k) => String(k).startsWith(prefix));
  await Promise.all(queueKeys.map((k) => del(k, queueStore)));
  if (!tenantId) {
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
export async function cacheData<T>(tenantId: string, key: string, data: T, ttlMs: number = 1000 * 60 * 60): Promise<void> {
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
  const cached = await get(`${CACHE_PREFIX}${tenantId}:${key}`, cacheStore);
  if (!cached) return null;

  const entry = cached as Record<string, unknown>;

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
  const prefix = tenantId
    ? `${CACHE_PREFIX}${tenantId}:`
    : CACHE_PREFIX;
  const cacheKeys = allKeys.filter((k) => String(k).startsWith(prefix));
  await Promise.all(cacheKeys.map((k) => del(k, cacheStore)));
}

// ============================================================================
// Sync Logic
// ============================================================================

type GraphQLExecutor = (
  type: OperationType,
  payload: OperationPayload
) => Promise<unknown>;

export async function syncOperation(
  operation: QueuedOperation,
  executeGraphQL: GraphQLExecutor
): Promise<boolean> {
  try {
    await updateOperation(operation.tenantId, operation.id, { status: 'syncing' });
    await executeGraphQL(operation.type, operation.payload);
    await removeOperation(operation.tenantId, operation.id);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error
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
 */
export async function syncAllOperations(
  tenantId: string,
  executeGraphQL: GraphQLExecutor
): Promise<{ success: number; failed: number }> {
  // SECURITY (C11): tenantId is mandatory for sync isolation
  if (!tenantId) {
    throw new Error('syncAllOperations: tenantId is required for tenant-isolated sync');
  }

  // CRIT-4 (BUG-02): Reset stale 'syncing' entries left from interrupted prior sessions
  // before processing. This prevents operations from being permanently stuck in 'syncing'.
  const allOps = await getPendingOperations(tenantId);
  const staleSync = allOps.filter((op) => op.status === 'syncing');
  await Promise.all(staleSync.map((op) => updateOperation(op.tenantId, op.id, { status: 'pending' })));

  // BUG-17: Promote retryable 'failed' operations back to 'pending' so they
  // are included in this sync pass. Previously, failed items were skipped
  // permanently -- they never transitioned back to 'pending', leaving the user
  // with a dead queue that only manual deletion could resolve.
  const retryableFailed = allOps.filter(
    (op) => op.status === 'failed' && op.retryCount < MAX_RETRY_COUNT && isRetryableError(op.lastError),
  );
  await Promise.all(retryableFailed.map((op) => updateOperation(op.tenantId, op.id, { status: 'pending' })));

  const operations = await getPendingOperations(tenantId);
  let success = 0;
  let failed = 0;

  for (const op of operations) {
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
