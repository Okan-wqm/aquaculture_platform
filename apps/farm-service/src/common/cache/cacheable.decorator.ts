/**
 * @Cacheable Decorator
 *
 * Marks a resolver / service method as cache-eligible. The
 * CacheableInterceptor reads the attached metadata, computes a
 * Redis key from (prefix, tenant, method-args), and serves cached
 * results directly when present. Cache miss calls the underlying
 * method and writes the result with the configured TTL.
 *
 * Usage:
 *
 *   @Query(() => [SpeciesResponse])
 *   @Cacheable({ prefix: 'species:list', ttlSeconds: 3600 })
 *   async speciesList(@CurrentTenant() tenantId: string): Promise<Species[]> {
 *     return this.queryBus.execute(new ListSpeciesQuery(tenantId));
 *   }
 *
 * Per-entity TTL defaults (calibrated to the churn rate of the
 * underlying catalogue) are documented alongside the individual
 * @Cacheable call sites — operators can tune via env overrides the
 * call site reads when it composes the options object.
 *
 * Invariants this decorator commits to:
 *
 *   1. **Tenant-scoped by default.** The key always includes the
 *      tenant identifier so a cached entry never bleeds across
 *      tenants. `scopeToTenant: false` disables the scoping for
 *      deliberately-global lookups (e.g. `supplierTypes` /
 *      `parameterTemplates`). Missing tenant on a tenant-scoped
 *      method is a bug; the interceptor logs and bypasses the
 *      cache rather than producing a cross-tenant cache entry.
 *
 *   2. **Error pass-through.** Cache read/write failures never
 *      bubble up as method errors — the interceptor falls back to
 *      the underlying method and logs the cache error.
 *
 * Phase 7.3 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 15-C3.
 */
import { SetMetadata } from '@nestjs/common';

export const CACHEABLE_METADATA_KEY = 'farm:cacheable';

export interface CacheableOptions {
  /**
   * Key prefix, typically `<entity>:<operation>` (e.g.
   * `species:list`, `feed:byId`). Lands in the Redis key alongside
   * tenant + args so multiple methods with different prefixes
   * never share an entry.
   */
  prefix: string;
  /**
   * Time-to-live in seconds. Longer TTL = fewer reads but staler
   * data on invalidation miss. Per-entity defaults live at the
   * call site so a PR review can reason about them in context.
   */
  ttlSeconds: number;
  /**
   * When true (default), the Redis key includes the caller's
   * tenant id. Set to false for deliberately-global lookups that
   * are identical across tenants. Tenant-scoped methods called
   * WITHOUT a tenant context bypass the cache entirely rather
   * than risk a cross-tenant entry.
   */
  scopeToTenant?: boolean;
}

export const Cacheable = (options: CacheableOptions): MethodDecorator =>
  SetMetadata(CACHEABLE_METADATA_KEY, {
    scopeToTenant: true,
    ...options,
  });
