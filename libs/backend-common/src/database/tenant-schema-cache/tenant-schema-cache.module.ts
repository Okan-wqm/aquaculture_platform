import { Module } from '@nestjs/common';

import { TenantSchemaCacheInvalidationSubscriber } from './tenant-schema-cache-invalidation.subscriber';
import { TenantSchemaCacheService } from './tenant-schema-cache.service';

/**
 * SSoT module for the shared tenant schema-existence cache + its
 * provisioning-driven invalidation.
 *
 * Every tenant-scoped service that applies `TenantSchemaMiddleware` (the seven
 * services that call `createTenantSchemaMiddleware`) imports this ONCE so:
 *   1. the middleware and {@link TenantSchemaCacheInvalidationSubscriber} share
 *      ONE `TenantSchemaCacheService` instance, and
 *   2. a freshly provisioned tenant is never blocked by a stale negative cache
 *      entry — the subscriber clears it on `TenantProvisioned`.
 *
 * Enforced by `tests/invariants/tenant-schema-cache-module-registered.spec.ts`.
 */
@Module({
  providers: [TenantSchemaCacheService, TenantSchemaCacheInvalidationSubscriber],
  exports: [TenantSchemaCacheService],
})
export class TenantSchemaCacheModule {}
