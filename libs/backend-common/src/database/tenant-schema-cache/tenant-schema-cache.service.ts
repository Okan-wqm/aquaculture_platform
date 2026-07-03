import { Injectable } from '@nestjs/common';

import { SchemaLRUCache } from '../schema-lru-cache';

/**
 * Injectable, app-singleton wrapper around {@link SchemaLRUCache} for tenant
 * schema-existence checks.
 *
 * # Why this is a shared DI singleton, not a per-middleware `new SchemaLRUCache`
 *
 * `TenantSchemaMiddleware` POPULATES this cache (negative entry = "schema not
 * provisioned"); `TenantSchemaCacheInvalidationSubscriber` CLEARS it the
 * instant a tenant finishes provisioning. Both must operate on the SAME
 * instance for the invalidation to be observable by the middleware — hence a
 * provider shared via {@link TenantSchemaCacheModule} instead of an instance
 * field private to each middleware. This is the structural mechanism that
 * guarantees a freshly provisioned tenant is never blocked by a stale negative
 * entry, rather than relying on the 30s negative TTL to eventually expire.
 *
 * TTLs (preserved from the previous inline cache): positive 5min (schemas are
 * rarely deleted), negative 30s. The negative TTL stays as a DoS guard for
 * genuinely bad / unprovisioned tenant IDs; the invalidation subscriber — not
 * the TTL — is the correctness mechanism for legitimately-new tenants.
 */
@Injectable()
export class TenantSchemaCacheService {
  private readonly cache = new SchemaLRUCache(1000, 5 * 60 * 1000, 30 * 1000);

  getOrCheck(schemaName: string, checker: () => Promise<boolean>): Promise<boolean> {
    return this.cache.getOrCheck(schemaName, checker);
  }

  invalidate(schemaName: string): void {
    this.cache.invalidate(schemaName);
  }

  /** Current number of cached entries — for tests / observability only. */
  get size(): number {
    return this.cache.size;
  }
}
