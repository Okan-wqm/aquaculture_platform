import {
  Injectable,
  NestMiddleware,
  Logger,
  BadRequestException,
  UnauthorizedException,
  Type,
} from '@nestjs/common';
import { Response, NextFunction } from 'express';
import { DataSource } from 'typeorm';

import { executeQueryRowsNormalized } from '../database/query-result-normalizer';
import { TenantSchemaCacheService } from '../database/tenant-schema-cache';
import { getTenantSchemaName, isValidUUID } from '../database/tenant-schema.utils';
import { requestContextStorage } from '../logging/request-context';
import { TenantRequest } from '../types/tenant-request.interface';

/**
 * Factory: creates a service-specific TenantSchemaMiddleware class.
 *
 * Each multi-tenant service calls this once at import time:
 *   const TenantSchemaMiddleware = createTenantSchemaMiddleware('farm');
 */
export function createTenantSchemaMiddleware(defaultSchema: string): Type<NestMiddleware> {
  if (!/^[a-z][a-z0-9_]*$/.test(defaultSchema)) {
    throw new Error(
      `Invalid defaultSchema: "${defaultSchema}" — must be lowercase alphanumeric with underscores`,
    );
  }

  @Injectable()
  class TenantSchemaMiddlewareImpl implements NestMiddleware {
    readonly logger = new Logger(`TenantSchemaMiddleware[${defaultSchema}]`);

    // The schema-existence cache is a SHARED app-singleton injected from
    // TenantSchemaCacheModule — NOT a per-middleware `new SchemaLRUCache`.
    // TenantSchemaCacheInvalidationSubscriber clears the SAME instance on
    // TenantProvisioned, so a freshly provisioned tenant is never blocked by a
    // stale negative entry. Every tenant-scoped service imports
    // TenantSchemaCacheModule (enforced by an invariant).
    constructor(
      readonly dataSource: DataSource,
      readonly schemaCache: TenantSchemaCacheService,
    ) {}

    async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
      const startTime = Date.now();

      // SEC-LOW-003 cure: removed three DEBUG lines that printed
      // raw tenantId values + the contents of x-tenant-id /
      // x-user-payload header presence. Even at DEBUG severity,
      // structured-log aggregation pipelines persist debug rows long
      // enough for tenantId to leak into third-party retention.
      // The schema-resolution flow below uses tenantId by reference
      // without echoing it; failures still produce a structured WARN
      // (Tenant schema not found for tenant <id>) which is the
      // operational signal that matters.
      const tenantId = req.tenantId || req.user?.tenantId;

      if (tenantId && tenantId !== 'default-tenant') {
        if (!isValidUUID(tenantId)) {
          throw new BadRequestException('Invalid tenant ID format');
        }

        const tenantSchema = getTenantSchemaName(tenantId);
        const schemaExists = await this.checkSchemaExists(tenantSchema);

        if (schemaExists) {
          req.schemaName = tenantSchema;
        } else {
          this.logger.warn(`Tenant schema not found for tenant ${tenantId}`);
          throw new UnauthorizedException('Tenant not provisioned');
        }
      } else {
        req.schemaName = defaultSchema;
      }

      // SECURITY (CRITICAL-MSG-001 ROOT CAUSE):
      // Mutating the existing AsyncLocalStorage store with `ctx.schemaName = …`
      // is fragile when downstream Apollo/Express handling can break the
      // original `requestContextStorage.run()` callback chain — async hops
      // through resolvers may end up reading a context that NEVER had
      // schemaName attached, falling through TenantConnectionBootstrap to
      // the default search_path and triggering SourceSchemaWriteGuard.
      //
      // ARCHITECTURAL FIX: re-`run()` the rest of the request inside a
      // FRESH context that already carries schemaName. Every async
      // operation scheduled by next() — middleware, resolver, repo.save,
      // outbox writes, audit logs — runs with `schemaName` GUARANTEED to
      // be in `getStore()`. No silent loss possible.
      //
      // We compose by spreading the current store (correlationId, traceId,
      // userId, etc.) so we don't drop fields set by upstream middleware.
      const currentStore = requestContextStorage.getStore();
      const newStore = { ...(currentStore ?? {}), schemaName: req.schemaName };

      this.logger.debug(`Schema: ${req.schemaName} (${Date.now() - startTime}ms)`);
      requestContextStorage.run(newStore, () => next());
    }

    /** @internal */
    async checkSchemaExists(schemaName: string): Promise<boolean> {
      return this.schemaCache.getOrCheck(schemaName, async () => {
        const rows = await executeQueryRowsNormalized<Record<string, unknown>>(
          this.dataSource,
          `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
          [schemaName],
        );
        return rows.length > 0;
      });
    }

    invalidateCache(schemaName: string): void {
      this.schemaCache.invalidate(schemaName);
    }
  }

  return TenantSchemaMiddlewareImpl;
}
