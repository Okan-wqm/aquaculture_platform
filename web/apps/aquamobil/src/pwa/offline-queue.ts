import { get, set, del, keys, entries } from 'idb-keyval';
import type { QueuedOperation, OperationType, MortalityInput, CullInput, HarvestInput } from '@/types';

const QUEUE_PREFIX = 'pending_';
const CACHE_PREFIX = 'cache_';

// ============================================================================
// Offline Queue Operations
// ============================================================================

export async function queueOperation(
  type: OperationType,
  payload: MortalityInput | CullInput | HarvestInput
): Promise<string> {
  const id = crypto.randomUUID();
  const operation: QueuedOperation = {
    id,
    type,
    payload,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    status: 'pending',
  };

  await set(`${QUEUE_PREFIX}${id}`, operation);

  // Try to register background sync
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await (registration as any).sync.register('sync-operations');
    } catch (error) {
      console.warn('Background sync registration failed:', error);
    }
  }

  return id;
}

export async function getPendingOperations(): Promise<QueuedOperation[]> {
  const allEntries = await entries();
  return allEntries
    .filter(([key]) => String(key).startsWith(QUEUE_PREFIX))
    .map(([, value]) => value as QueuedOperation)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export async function getPendingCount(): Promise<number> {
  const allKeys = await keys();
  return allKeys.filter((k) => String(k).startsWith(QUEUE_PREFIX)).length;
}

export async function getOperation(id: string): Promise<QueuedOperation | undefined> {
  return get(`${QUEUE_PREFIX}${id}`);
}

export async function updateOperation(id: string, updates: Partial<QueuedOperation>): Promise<void> {
  const existing = await getOperation(id);
  if (existing) {
    await set(`${QUEUE_PREFIX}${id}`, { ...existing, ...updates });
  }
}

export async function removeOperation(id: string): Promise<void> {
  await del(`${QUEUE_PREFIX}${id}`);
}

export async function clearAllOperations(): Promise<void> {
  const allKeys = await keys();
  const queueKeys = allKeys.filter((k) => String(k).startsWith(QUEUE_PREFIX));
  await Promise.all(queueKeys.map((k) => del(k)));
}

// ============================================================================
// Data Cache Operations (for offline tank/batch data)
// ============================================================================

export async function cacheData<T>(key: string, data: T, ttlMs: number = 1000 * 60 * 60): Promise<void> {
  await set(`${CACHE_PREFIX}${key}`, {
    data,
    cachedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
}

export async function getCachedData<T>(key: string): Promise<T | null> {
  const cached = await get(`${CACHE_PREFIX}${key}`);
  if (!cached) return null;

  const { data, expiresAt } = cached as { data: T; expiresAt: string };
  if (new Date(expiresAt) < new Date()) {
    await del(`${CACHE_PREFIX}${key}`);
    return null;
  }

  return data;
}

export async function clearCache(): Promise<void> {
  const allKeys = await keys();
  const cacheKeys = allKeys.filter((k) => String(k).startsWith(CACHE_PREFIX));
  await Promise.all(cacheKeys.map((k) => del(k)));
}

// ============================================================================
// Sync Logic
// ============================================================================

type GraphQLExecutor = (
  type: OperationType,
  payload: MortalityInput | CullInput | HarvestInput
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
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
