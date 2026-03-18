import { Injectable, NestMiddleware, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { DataSource } from 'typeorm';
import { getRequestContext } from '../logging/request-context';
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

      try {
        const ctx = getRequestContext();
        if (ctx) {
          ctx.schemaName = req.schemaName;
        }
      } catch {
        // RequestContext not available
      }

      this.logger.debug(`Schema: ${req.schemaName} (${Date.now() - startTime}ms)`);
      next();
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
