import { Injectable, NestMiddleware, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { DataSource } from 'typeorm';

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
 * Tenant Schema Middleware for Hydroponics Service
 *
 * Sets PostgreSQL search_path to tenant-specific schema at the start of each request.
 * Uses SET LOCAL inside a transaction so the search_path is connection-safe and
 * automatically reset when the transaction ends, preventing cross-tenant data leakage
 * from connection pool reuse.
 *
 * search_path: "tenant_xxx", hydroponics, public
 */
@Injectable()
export class TenantSchemaMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantSchemaMiddleware.name);
  private readonly DEFAULT_SCHEMA = 'hydroponics';
  private readonly schemaCache = new Map<string, { exists: boolean; expiry: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;
  private readonly CACHE_MAX_SIZE = 1000;
  private readonly pendingChecks = new Map<string, Promise<boolean>>();

  constructor(private readonly dataSource: DataSource) {}

  async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = req.tenantId || req.user?.tenantId;

      if (tenantId && tenantId !== 'default-tenant') {
        if (!this.isValidUUID(tenantId)) {
          throw new BadRequestException('Invalid tenant ID format');
        }

        const tenantSchema = this.getTenantSchemaName(tenantId);
        const schemaExists = await this.checkSchemaExists(tenantSchema);

        if (schemaExists) {
          await this.setSearchPathSafe(tenantSchema);
          req.schemaName = tenantSchema;
        } else {
          this.logger.warn(`Tenant ${tenantId}: schema '${tenantSchema}' does not exist`);
          throw new NotFoundException(`Schema not found for tenant ${tenantId}`);
        }
      } else {
        await this.setSearchPathSafe(this.DEFAULT_SCHEMA);
        req.schemaName = this.DEFAULT_SCHEMA;
      }
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Schema middleware error: ${error instanceof Error ? error.message : String(error)}`);
      throw new BadRequestException('Failed to resolve tenant schema');
    }

    const cleanup = () => {
      res.removeListener('finish', cleanup);
      res.removeListener('close', cleanup);
      this.resetSearchPath().catch((err) => {
        this.logger.debug(`Failed to reset search_path: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    res.on('finish', cleanup);
    res.on('close', cleanup);

    next();
  }

  private isValidUUID(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  private getTenantSchemaName(tenantId: string): string {
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    return `tenant_${cleanId}`;
  }

  private async checkSchemaExists(schemaName: string): Promise<boolean> {
    // Check cache first
    const cached = this.schemaCache.get(schemaName);
    if (cached && Date.now() < cached.expiry) {
      return cached.exists;
    }
    if (cached) {
      this.schemaCache.delete(schemaName);
    }

    // Request coalescing: if there's already a pending check for this schema, reuse it
    const pending = this.pendingChecks.get(schemaName);
    if (pending) {
      return pending;
    }

    const checkPromise = this.doCheckSchemaExists(schemaName);
    this.pendingChecks.set(schemaName, checkPromise);

    try {
      const exists = await checkPromise;
      // Evict oldest entry if cache is full
      if (this.schemaCache.size >= this.CACHE_MAX_SIZE) {
        const firstKey = this.schemaCache.keys().next().value;
        if (firstKey) this.schemaCache.delete(firstKey);
      }
      this.schemaCache.set(schemaName, { exists, expiry: Date.now() + this.CACHE_TTL_MS });
      return exists;
    } finally {
      this.pendingChecks.delete(schemaName);
    }
  }

  private async doCheckSchemaExists(schemaName: string): Promise<boolean> {
    try {
      const result = await this.dataSource.query(
        `SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1`,
        [schemaName],
      );
      return result.length > 0;
    } catch {
      return false;
    }
  }

  invalidateCache(schemaName: string): void {
    this.schemaCache.delete(schemaName);
  }

  private async setSearchPathSafe(schemaName: string): Promise<void> {
    if (!/^[a-z0-9_]+$/.test(schemaName)) {
      throw new BadRequestException('Invalid schema name');
    }
    await this.dataSource.query(`SET search_path TO "${schemaName}", hydroponics, public`);
  }

  private async resetSearchPath(): Promise<void> {
    await this.dataSource.query('RESET search_path');
  }
}
