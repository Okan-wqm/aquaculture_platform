import { Injectable, NestMiddleware, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { DataSource } from 'typeorm';
import { requestContextStorage } from '../logging/request-context';
import { SchemaLRUCache } from '../database/schema-lru-cache';
import { getTenantSchemaName, isValidUUID } from '../database/tenant-schema.utils';

/**
 * Request with tenant context
 */
interface TenantRequest extends Request {
  tenantId?: string;
  user?: {
    tenantId?: string;
    sub?: string;
    email?: string;
    role?: string;
  };
  schemaName?: string;
}

/**
 * Factory: creates a service-specific TenantSchemaMiddleware class.
 *
 * Each multi-tenant service calls this once at import time:
 *   const TenantSchemaMiddleware = createTenantSchemaMiddleware('farm');
 */
export function createTenantSchemaMiddleware(defaultSchema: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(defaultSchema)) {
    throw new Error(`Invalid defaultSchema: "${defaultSchema}" — must be lowercase alphanumeric with underscores`);
  }

  @Injectable()
  class TenantSchemaMiddlewareImpl implements NestMiddleware {
    readonly logger = new Logger(`TenantSchemaMiddleware[${defaultSchema}]`);
    readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000, 30_000);

    constructor(readonly dataSource: DataSource) {}

    async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
      const startTime = Date.now();

      this.logger.debug(`[DEBUG] Incoming headers: x-tenant-id=${req.headers['x-tenant-id']}, x-user-payload exists=${!!req.headers['x-user-payload']}`);
      this.logger.debug(`[DEBUG] req.tenantId=${req.tenantId}, req.user?.tenantId=${req.user?.tenantId}`);

      const tenantId = req.tenantId || req.user?.tenantId;
      this.logger.debug(`[DEBUG] Resolved tenantId: ${tenantId}`);

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
        const rows = await this.dataSource.query(
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
