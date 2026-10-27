/**
 * The session's offline cache scope (MOB-MEDIUM-031, PKG-42).
 *
 * useOfflineCacheScope: the scope every cached read passes to readThroughOfflineCache —
 * tenant, user and the moduleAccess fingerprint of the access token the server last signed
 * (pwa/offline-cache-scope.ts). The access token is the source chosen for hash(moduleAccess):
 * it is what the gateway trusts, it carries the claim from release R1 (PKG-04) on every
 * login and refresh, and it is in memory before any read runs; `me.moduleAccess` would cost a
 * request and is read by clients only from R2.
 *
 * useRetainOfflineCacheScope: mounted once (OfflineProvider). Whenever the scope changes — a
 * token whose grants differ, another user — every entry outside it is deleted, so a revoked
 * grant leaves no cached data behind. A token re-minted with the same grants keeps the same
 * key prefix and deletes nothing. Without a scope it does nothing: logout wipes the cache.
 */
import { useEffect, useMemo, useRef } from 'react';

import { useAuth } from './useAuth';

import { retainOnlyCacheScope } from '@/pwa/offline-cache';
import { offlineCacheScopeOf, type OfflineCacheScope } from '@/pwa/offline-cache-scope';
import { logger } from '@/utils/logger';

export function useOfflineCacheScope(): OfflineCacheScope | null {
  const { accessToken, tenantId } = useAuth();
  return useMemo(() => offlineCacheScopeOf(accessToken, tenantId), [accessToken, tenantId]);
}

export function useRetainOfflineCacheScope(): void {
  const scope = useOfflineCacheScope();
  // The key prefix is the scope's identity: a token re-minted with the same grants is a new
  // scope object with the same prefix, and must not re-run the purge.
  const retainedKeyPrefix = useRef<string | null>(null);

  useEffect(() => {
    if (scope === null || retainedKeyPrefix.current === scope.keyPrefix) return;
    retainedKeyPrefix.current = scope.keyPrefix;
    retainOnlyCacheScope(scope).catch((error: unknown) => {
      logger.error('[offline-cache] failed to purge entries outside the current scope', error);
    });
  }, [scope]);
}
