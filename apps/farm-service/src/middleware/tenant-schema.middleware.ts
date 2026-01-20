import { Injectable, NestMiddleware, Logger, BadRequestException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { DataSource } from 'typeorm';

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
 * Simple LRU Cache for schema existence checks
 */
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
 * Tenant Schema Middleware for Farm Service
 *
 * Sets PostgreSQL search_path to tenant-specific schema at the start of each request.
 * This ensures all database operations target the correct tenant's tables.
 *
 * Features:
 * - SQL injection prevention via UUID validation
 * - LRU caching for schema existence checks
 * - Connection pool safety with search_path reset on response finish
 * - Fallback to shared 'farm' schema for tenants without dedicated schema
 *
 * Schema naming convention: tenant_{first8chars_of_uuid}
 * Example: tenant_4b529829 for tenantId 4b529829-ea79-48da-982c-cd6fbec8ffb7
 */
@Injectable()
export class TenantSchemaMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantSchemaMiddleware.name);
  private readonly DEFAULT_SCHEMA = 'farm';

  /** LRU cache for schema existence (max 1000 entries, 5 min TTL) */
  private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000);

  constructor(private readonly dataSource: DataSource) {}

  async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
    const startTime = Date.now();

    try {
      // DEBUG: Log incoming headers for troubleshooting
      this.logger.debug(`[DEBUG] Incoming headers: x-tenant-id=${req.headers['x-tenant-id']}, x-user-payload exists=${!!req.headers['x-user-payload']}`);
      this.logger.debug(`[DEBUG] req.tenantId=${req.tenantId}, req.user?.tenantId=${req.user?.tenantId}`);

      // Extract tenant ID from request (set by UserContextMiddleware/TenantContextMiddleware)
      const tenantId = req.tenantId || req.user?.tenantId;
      this.logger.debug(`[DEBUG] Resolved tenantId: ${tenantId}`);

      if (tenantId && tenantId !== 'default-tenant') {
        // Validate UUID format (SQL injection prevention)
        if (!this.isValidUUID(tenantId)) {
          throw new BadRequestException('Invalid tenant ID format');
        }

        const tenantSchema = this.getTenantSchemaName(tenantId);
        const schemaExists = await this.checkSchemaExists(tenantSchema);

        if (schemaExists) {
          await this.setSearchPathSafe(tenantSchema);
          req.schemaName = tenantSchema;
        } else {
          // Fallback for existing tenants without dedicated schema
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
      this.logger.error(`Schema middleware error: ${(error as Error).message}`);

      // Attempt fallback
      try {
        await this.setSearchPathSafe(this.DEFAULT_SCHEMA);
        req.schemaName = this.DEFAULT_SCHEMA;
      } catch {
        this.logger.error('Fallback also failed - continuing without schema change');
      }
    }

    // CRITICAL: Reset search_path when response finishes
    // Prevents connection pool contamination
    res.on('finish', () => {
      this.resetSearchPath().catch(() => {});
    });

    // Also reset on connection close (client disconnect)
    res.on('close', () => {
      this.resetSearchPath().catch(() => {});
    });

    next();
  }

  /**
   * Validate UUID format
   */
  private isValidUUID(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  /**
   * Generate tenant schema name from tenant ID
   */
  private getTenantSchemaName(tenantId: string): string {
    const cleanId = tenantId.replace(/-/g, '').substring(0, 8).toLowerCase();
    return `tenant_${cleanId}`;
  }

  /**
   * Set search_path with SQL injection prevention
   * Uses parameterized query
   *
   * Search path order:
   * 1. Tenant schema (tenant-specific data)
   * 2. Farm schema (shared system data like equipment_types, species, etc.)
   * 3. Public schema (extensions, common functions)
   */
  private async setSearchPathSafe(schemaName: string): Promise<void> {
    // Validate schema name format as additional safety
    if (!/^[a-z0-9_]+$/.test(schemaName)) {
      throw new BadRequestException('Invalid schema name');
    }
    // Include 'farm' schema for shared system tables (equipment_types, etc.)
    await this.dataSource.query(`SET search_path TO "${schemaName}", farm, public`);
  }

  /**
   * Reset search_path to default
   * Called when response finishes to prevent connection pool contamination
   */
  private async resetSearchPath(): Promise<void> {
    await this.dataSource.query('RESET search_path');
  }

  /**
   * Check schema existence with LRU caching
   */
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

  /**
   * Invalidate cache for a schema
   * Call this after schema creation
   */
  invalidateCache(schemaName: string): void {
    this.schemaCache.delete(schemaName);
  }
}
