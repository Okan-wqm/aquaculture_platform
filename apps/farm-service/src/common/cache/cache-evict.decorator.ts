/**
 * @CacheEvict Decorator
 *
 * Marks a mutation as a cache-invalidator for one or more
 * @Cacheable prefixes. After the mutation's handler returns
 * successfully, `CacheEvictInterceptor` issues a Redis
 * `deletePattern` against every listed prefix scoped to the
 * caller's tenant, so the next read repopulates the cache from
 * fresh data.
 *
 * Usage:
 *
 *   @Mutation(() => Species)
 *   @CacheEvict({ prefixes: ['species:list', 'species:byId'] })
 *   async updateSpecies(input: UpdateSpeciesInput, ...) { ... }
 *
 * Invariants this decorator commits to:
 *
 *   1. **Runs on success only.** Eviction happens AFTER the
 *      handler's observable completes. A thrown error skips
 *      eviction so a failed write does not wipe the cache.
 *
 *   2. **Tenant-scoped.** The pattern always narrows to the
 *      caller's tenant (`farm:cache:<prefix>:t:<tenantId>:*`).
 *      Missing tenant on a mutation is unusual; the interceptor
 *      logs and skips eviction rather than blowing away every
 *      tenant's entries.
 *
 *   3. **Non-global by default.** Explicitly setting
 *      `scopeToTenant: false` evicts the whole prefix regardless
 *      of tenant — needed for global lookups that are ALSO cached
 *      with `scopeToTenant: false` on the read side. Keep them
 *      paired or a stale read slips through.
 *
 *   4. **Best-effort.** Redis outage never fails the mutation —
 *      the interceptor logs and returns. TTL on the cached entry
 *      still eventually expires the stale data.
 *
 * Phase 7.3.2 of the "Farm modülü kalan kör noktalar" plan.
 */
import { SetMetadata } from '@nestjs/common';

export const CACHE_EVICT_METADATA_KEY = 'farm:cacheEvict';

export interface CacheEvictOptions {
  /**
   * List of cache prefixes to invalidate. MUST match the `prefix`
   * value on the paired @Cacheable call sites — the eviction
   * pattern is `farm:cache:<prefix>:t:<tenantId>:*` (or without
   * the tenant segment when `scopeToTenant: false`).
   */
  prefixes: readonly string[];
  /**
   * When true (default), eviction narrows to the caller's tenant.
   * Set to false to invalidate across all tenants — required
   * when the paired @Cacheable used `scopeToTenant: false`.
   */
  scopeToTenant?: boolean;
}

export const CacheEvict = (options: CacheEvictOptions): MethodDecorator =>
  SetMetadata(CACHE_EVICT_METADATA_KEY, {
    scopeToTenant: true,
    ...options,
  });
