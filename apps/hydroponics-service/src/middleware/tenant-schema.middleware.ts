import { Injectable, NestMiddleware, Logger, BadRequestException } from '@nestjs/common';
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

class SchemaLRUCache {
  private cache = new Map<string, { value: boolean; expiry: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 1000, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): boolean | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: boolean): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiry: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }
}

/**
 * Tenant Schema Middleware for Hydroponics Service
 *
 * Sets PostgreSQL search_path to tenant-specific schema at the start of each request.
 * search_path: "tenant_xxx", hydroponics, public
 */
@Injectable()
export class TenantSchemaMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantSchemaMiddleware.name);
  private readonly DEFAULT_SCHEMA = 'hydroponics';
  private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000);

  constructor(private readonly dataSource: DataSource) {}

  async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
    const startTime = Date.now();

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
          await this.setSearchPathSafe(this.DEFAULT_SCHEMA);
          req.schemaName = this.DEFAULT_SCHEMA;
          this.logger.debug(`Tenant ${tenantId}: using fallback schema ${this.DEFAULT_SCHEMA}`);
        }
      } else {
        await this.setSearchPathSafe(this.DEFAULT_SCHEMA);
        req.schemaName = this.DEFAULT_SCHEMA;
      }

      this.logger.debug(`Schema: ${req.schemaName} (${Date.now() - startTime}ms)`);

    } catch (error) {
      this.logger.error(`Schema middleware error: ${error instanceof Error ? error.message : String(error)}`);

      try {
        await this.setSearchPathSafe(this.DEFAULT_SCHEMA);
        req.schemaName = this.DEFAULT_SCHEMA;
      } catch {
        this.logger.error('Fallback also failed - continuing without schema change');
      }
    }

    res.on('finish', () => {
      this.resetSearchPath().catch((err: unknown) => {
        this.logger.warn(`Failed to reset search path: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    res.on('close', () => {
      this.resetSearchPath().catch((err: unknown) => {
        this.logger.warn(`Failed to reset search path: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    next();
  }

  private isValidUUID(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  private getTenantSchemaName(tenantId: string): string {
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    return `tenant_${cleanId}`;
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

  private async checkSchemaExists(schemaName: string): Promise<boolean> {
    const cached = this.schemaCache.get(schemaName);
    if (cached !== undefined) return cached;

    try {
      const result = await this.dataSource.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
        [schemaName],
      );
      const exists = result.length > 0;
      this.schemaCache.set(schemaName, exists);
      return exists;
    } catch {
      return false;
    }
  }

  invalidateCache(schemaName: string): void {
    this.schemaCache.delete(schemaName);
  }
}
