import { Injectable, NestMiddleware, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { DataSource } from 'typeorm';
import { getRequestContext, SchemaLRUCache, getTenantSchemaName, isValidUUID } from '@platform/backend-common';

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
 * Tenant Schema Middleware for AI Service
 *
 * Resolves the tenant schema name from the request and stores it in:
 * 1. req.schemaName - for direct access by handlers
 * 2. AsyncLocalStorage RequestContext.schemaName - for pool-level search_path injection
 *
 * The actual SET search_path is handled transparently by TenantConnectionBootstrap,
 * which patches pg Pool.connect() to read schemaName from AsyncLocalStorage on every
 * connection checkout. This ensures ALL database operations (including TypeORM repository
 * calls that create their own QueryRunners) execute on the correct tenant schema.
 *
 * search_path: "tenant_xxx", ai, public
 */
@Injectable()
export class TenantSchemaMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantSchemaMiddleware.name);
  private readonly DEFAULT_SCHEMA = 'ai';

  /** LRU cache for schema existence (max 1000 entries, positive TTL=5 min, negative TTL=30 s) */
  private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000, 30_000);

  constructor(private readonly dataSource: DataSource) {}

  async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
    try {
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
          this.logger.warn(`Tenant ${tenantId}: schema '${tenantSchema}' does not exist`);
          throw new UnauthorizedException(`Tenant schema not found for tenant ${tenantId}`);
        }
      } else {
        req.schemaName = this.DEFAULT_SCHEMA;
      }
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error(`Schema middleware error: ${error instanceof Error ? error.message : String(error)}`);
      throw new BadRequestException('Failed to resolve tenant schema');
    }

    // Store in request context (AsyncLocalStorage) for pool-level search_path injection
    try {
      const ctx = getRequestContext();
      if (ctx) {
        ctx.schemaName = req.schemaName;
      }
    } catch {
      // RequestContext not available -- schemaName still on req
    }

    next();
  }

  // isValidUUID and getTenantSchemaName imported from @platform/backend-common

  private async checkSchemaExists(schemaName: string): Promise<boolean> {
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
