/**
 * The encrypted offline read cache (SEC-03-A; MOB-MEDIUM-031, PKG-42).
 *
 * WHY: a field worker opens the app where there is no signal, and a list that reads as empty
 * is a false "all clear". So reads keep an encrypted copy on the device. But the copy was keyed
 * by tenant and domain key only, and every hook served it from one catch-all — so the server's
 * refusal (FORBIDDEN, UNAUTHENTICATED) put cached alarms, tanks and readings on screen exactly
 * as an outage did, until each entry expired.
 *
 * WHAT — one read path, and nothing else touches the store:
 *   - readThroughOfflineCache(scope, { key, ttlMs }, load) runs `load` and keeps an encrypted
 *     copy under the caller's scope (offline-cache-scope.ts: tenant + user + moduleAccess
 *     fingerprint). On failure it asks request-failure.ts why:
 *       unreachable → serve the scope's copy, flagged `servedFromCache`, or rethrow when none;
 *       refused     → purge every entry of this tenant and user, then rethrow;
 *       failed      → rethrow, cache untouched.
 *     Without a scope it only runs `load`. A copy the device cannot store does not fail the
 *     read: the network answer is authoritative, the copy a convenience.
 *   - retainOnlyCacheScope(scope) deletes every entry outside the current scope; the app runs
 *     it whenever the token's scope changes (useRetainOfflineCacheScope), so a changed grant
 *     purges what was cached under the old one.
 *   - clearCache() is the logout wipe.
 * The entry format is unchanged: AES-GCM ciphertext under the queue's device key (the cipher
 * offline-queue.ts owns, wiped with the queue on logout), TTL metadata in plaintext. Entries
 * keyed the old way (`cache_<tenant>:<key>`) are outside every scope and go on the first
 * retention pass.
 */
import { createStore, del, get, keys, set } from 'idb-keyval';

import { decryptString, encryptString } from './offline-queue';

import type { OfflineCacheScope } from '@/pwa/offline-cache-scope';
import { classifyRequestFailure } from '@/services/request-failure';
import { logger } from '@/utils/logger';

const cacheStore = createStore('aquamobil-cache', 'cache');
const CACHE_PREFIX = 'cache_';

interface EncryptedCacheEntry {
  _enc: { iv: string; ciphertext: string };
  cachedAt: string;
  expiresAt: string;
}

/** One cached read: its key inside the scope, and how long the copy may stand in. */
export interface OfflineCacheRead {
  readonly key: string;
  readonly ttlMs: number;
}

export interface OfflineRead<T> {
  readonly data: T;
  /** True when the server could not be reached and the scope's copy stood in. */
  readonly servedFromCache: boolean;
}

function entryKey(scope: OfflineCacheScope, key: string): string {
  return `${CACHE_PREFIX}${scope.keyPrefix}${key}`;
}

async function writeEntry<T>(storeKey: string, data: T, ttlMs: number): Promise<void> {
  const entry: EncryptedCacheEntry = {
    _enc: await encryptString(JSON.stringify(data)),
    cachedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  await set(storeKey, entry, cacheStore);
}

/** The decrypted copy, or null when absent, expired, unencrypted or undecryptable (deleted). */
async function readEntry<T>(storeKey: string): Promise<T | null> {
  // WHY Record<string, unknown>: idb-keyval's get<T = any> would discard type safety; each
  // field is narrowed below.
  const entry = await get<Record<string, unknown>>(storeKey, cacheStore);
  if (entry === undefined) return null;
  const expiresAt = entry.expiresAt;
  if (typeof expiresAt === 'string' && new Date(expiresAt) < new Date()) {
    await del(storeKey, cacheStore);
    return null;
  }
  const enc = entry._enc;
  if (typeof enc === 'object' && enc !== null && 'iv' in enc && 'ciphertext' in enc) {
    const { iv, ciphertext } = enc;
    if (typeof iv === 'string' && typeof ciphertext === 'string') {
      try {
        return JSON.parse(await decryptString(iv, ciphertext)) as T;
      } catch {
        // The device key was rotated or the entry corrupted: purge it.
        await del(storeKey, cacheStore);
        return null;
      }
    }
  }
  // A legacy unencrypted entry is never served: purge it.
  await del(storeKey, cacheStore);
  return null;
}

async function deleteWhere(matches: (storeKey: string) => boolean): Promise<void> {
  const storeKeys = await keys(cacheStore);
  // Entry keys are always the `cache_…` strings this module wrote; narrowing to string avoids
  // stringifying idb-keyval's IDBValidKey union.
  const doomed = storeKeys.filter(
    (storeKey): storeKey is string =>
      typeof storeKey === 'string' && storeKey.startsWith(CACHE_PREFIX) && matches(storeKey),
  );
  await Promise.all(doomed.map((storeKey) => del(storeKey, cacheStore)));
}

/** Every entry of the scope's tenant and user, under any grants. */
async function purgeCallerEntries(scope: OfflineCacheScope): Promise<void> {
  const caller = `${CACHE_PREFIX}${scope.callerKeyPrefix}`;
  await deleteWhere((storeKey) => storeKey.startsWith(caller));
}

export async function readThroughOfflineCache<T>(
  scope: OfflineCacheScope | null,
  read: OfflineCacheRead,
  load: () => Promise<T>,
): Promise<OfflineRead<T>> {
  if (scope === null) return { data: await load(), servedFromCache: false };
  const storeKey = entryKey(scope, read.key);
  let data: T;
  try {
    data = await load();
  } catch (error) {
    const failure = classifyRequestFailure(error);
    if (failure === 'refused') {
      await purgeCallerEntries(scope);
    } else if (failure === 'unreachable') {
      const cached = await readEntry<T>(storeKey);
      if (cached !== null) return { data: cached, servedFromCache: true };
    }
    throw error;
  }
  try {
    await writeEntry(storeKey, data, read.ttlMs);
  } catch (error) {
    logger.warn('[offline-cache] could not keep an offline copy of a read', error);
  }
  return { data, servedFromCache: false };
}

/** Delete every entry outside `scope`: other users, other tenants, other grants. */
export async function retainOnlyCacheScope(scope: OfflineCacheScope): Promise<void> {
  const kept = `${CACHE_PREFIX}${scope.keyPrefix}`;
  await deleteWhere((storeKey) => !storeKey.startsWith(kept));
}

/** The logout wipe: every entry of every scope. */
export async function clearCache(): Promise<void> {
  await deleteWhere(() => true);
}
