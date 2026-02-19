import { get, set, del, keys, entries, createStore } from 'idb-keyval';
import type { QueuedOperation, OperationType, OperationPayload } from '@/types';

// Separate stores for queue and cache to avoid full-store scans (PERF-08)
const queueStore = createStore('aquamobil-queue', 'queue');
const cacheStore = createStore('aquamobil-cache', 'cache');

const QUEUE_PREFIX = 'pending_';
const CACHE_PREFIX = 'cache_';

// ============================================================================
// SEC-03: Payload Encryption — AES-GCM with a per-session in-memory key
// ============================================================================
// The encryption key lives only in memory (never persisted) and is regenerated
// each session. This prevents trivial extraction of sensitive agribusiness data
// (harvest prices, buyer names, biomass figures) from IndexedDB via DevTools or
// mobile forensic tools. On the next app launch the encrypted blobs are unreadable
// and clearAllOperations() is called on logout to remove them anyway.

let _sessionKey: CryptoKey | null = null;

async function getSessionKey(): Promise<CryptoKey> {
  if (_sessionKey) return _sessionKey;
  _sessionKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // not extractable — key cannot be exported from the browser
    ['encrypt', 'decrypt'],
  );
  return _sessionKey;
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

// Internal stored shape — payload is replaced by encrypted envelope
interface StoredOperation extends Omit<QueuedOperation, 'payload'> {
  _enc: { iv: string; ciphertext: string };
}

// ============================================================================
// Offline Queue Operations
// ============================================================================

export async function queueOperation(
  type: OperationType,
  payload: OperationPayload,
  // SEC-09: Caller supplies hasValidAuth so background sync is only registered
  // when there are valid credentials. If the token expires before the sync fires
  // the in-app sync path (executeGraphQL) will catch the 401 and surface an error
  // rather than silently incrementing retryCount for an auth failure.
  hasValidAuth: boolean = false,
): Promise<string> {
  const id = crypto.randomUUID();

  // SEC-03: Encrypt sensitive payload before writing to IndexedDB.
  const _enc = await encryptPayload(payload);

  const stored: StoredOperation = {
    id,
    type,
    _enc,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    status: 'pending',
  };

  await set(`${QUEUE_PREFIX}${id}`, stored, queueStore);

  // SEC-09: Only register background sync when auth credentials are confirmed
  // present. An unauthenticated background sync attempt would fail with 401
  // and incorrectly increment retryCount, eventually permanently discarding
  // the operation even though the failure was due to auth, not bad data.
  if (hasValidAuth && 'serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await (registration as any).sync.register('sync-operations');
    } catch (error) {
      console.warn('Background sync registration failed:', error);
    }
  }

  return id;
}

// Decrypt a StoredOperation back into a QueuedOperation. If decryption fails
// (e.g., the session key was rotated due to a full page reload) the entry is
// skipped rather than crashing the queue — it will be cleaned up on logout.
async function decryptOperation(stored: StoredOperation): Promise<QueuedOperation | null> {
  try {
    const payload = await decryptPayload(stored._enc.iv, stored._enc.ciphertext);
    const { _enc: _ignored, ...rest } = stored;
    return { ...rest, payload };
  } catch {
    return null;
  }
}

export async function getPendingOperations(): Promise<QueuedOperation[]> {
  // Use dedicated queue store — no need to filter by prefix across mixed entries (PERF-08)
  const allEntries = await entries<string, StoredOperation>(queueStore);
  const decrypted = await Promise.all(
    allEntries
      .filter(([key]) => String(key).startsWith(QUEUE_PREFIX))
      .map(([, value]) => decryptOperation(value)),
  );
  return (decrypted.filter(Boolean) as QueuedOperation[])
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export async function getPendingCount(): Promise<number> {
  const allKeys = await keys(queueStore);
  return allKeys.filter((k) => String(k).startsWith(QUEUE_PREFIX)).length;
}

export async function getOperation(id: string): Promise<QueuedOperation | undefined> {
  const stored = await get<StoredOperation>(`${QUEUE_PREFIX}${id}`, queueStore);
  if (!stored) return undefined;
  const op = await decryptOperation(stored);
  return op ?? undefined;
}

export async function updateOperation(id: string, updates: Partial<QueuedOperation>): Promise<void> {
  const existingStored = await get<StoredOperation>(`${QUEUE_PREFIX}${id}`, queueStore);
  if (!existingStored) return;

  // If the caller is updating the payload, re-encrypt it. Otherwise keep the
  // existing encrypted envelope — only re-encrypt the envelope if payload changed.
  const { payload: newPayload, ...nonPayloadUpdates } = updates;
  const newEnc = newPayload ? await encryptPayload(newPayload) : existingStored._enc;

  await set(
    `${QUEUE_PREFIX}${id}`,
    { ...existingStored, ...nonPayloadUpdates, _enc: newEnc },
    queueStore,
  );
}

export async function removeOperation(id: string): Promise<void> {
  await del(`${QUEUE_PREFIX}${id}`, queueStore);
}

export async function clearAllOperations(): Promise<void> {
  const allKeys = await keys(queueStore);
  const queueKeys = allKeys.filter((k) => String(k).startsWith(QUEUE_PREFIX));
  await Promise.all(queueKeys.map((k) => del(k, queueStore)));
}

// ============================================================================
// Data Cache Operations (for offline tank/batch data)
// ============================================================================

export async function cacheData<T>(key: string, data: T, ttlMs: number = 1000 * 60 * 60): Promise<void> {
  await set(`${CACHE_PREFIX}${key}`, {
    data,
    cachedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  }, cacheStore);
}

export async function getCachedData<T>(key: string): Promise<T | null> {
  const cached = await get(`${CACHE_PREFIX}${key}`, cacheStore);
  if (!cached) return null;

  const { data, expiresAt } = cached as { data: T; expiresAt: string };
  if (new Date(expiresAt) < new Date()) {
    await del(`${CACHE_PREFIX}${key}`, cacheStore);
    return null;
  }

  return data;
}

export async function clearCache(): Promise<void> {
  const allKeys = await keys(cacheStore);
  const cacheKeys = allKeys.filter((k) => String(k).startsWith(CACHE_PREFIX));
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
    await updateOperation(operation.id, { status: 'syncing' });
    await executeGraphQL(operation.type, operation.payload);
    await removeOperation(operation.id);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message.slice(0, 200) // SEC-07: truncate error messages
      : 'Unknown error';
    await updateOperation(operation.id, {
      status: 'failed',
      retryCount: operation.retryCount + 1,
      lastError: errorMessage,
    });
    return false;
  }
}

export async function syncAllOperations(
  executeGraphQL: GraphQLExecutor
): Promise<{ success: number; failed: number }> {
  // CRIT-4 (BUG-02): Reset stale 'syncing' entries left from interrupted prior sessions
  // before processing. This prevents operations from being permanently stuck in 'syncing'.
  const allOps = await getPendingOperations();
  const staleSync = allOps.filter((op) => op.status === 'syncing');
  await Promise.all(staleSync.map((op) => updateOperation(op.id, { status: 'pending' })));

  const operations = await getPendingOperations();
  let success = 0;
  let failed = 0;

  for (const op of operations) {
    // Skip if already tried too many times
    if (op.retryCount >= 3) {
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
