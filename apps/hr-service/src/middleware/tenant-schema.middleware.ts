import { Injectable, NestMiddleware, Logger, BadRequestException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { DataSource, QueryRunner } from 'typeorm';

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
  /** Dedicated QueryRunner pinned to a single pooled connection for this request */
  tenantQueryRunner?: QueryRunner;
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
 * Tenant Schema Middleware for HR Service
 *
 * Sets PostgreSQL search_path to tenant-specific schema at the start of each request.
 * This ensures all database operations target the correct tenant's tables.
 *
 * Connection Safety (D04-M02):
 * Uses a dedicated QueryRunner per request to pin a single pooled connection.
 * SET search_path and RESET search_path are guaranteed to execute on the SAME
 * physical connection, eliminating the race condition where res.on('finish')
 * could RESET a different connection than the one that was SET.
 *
 * Features:
 * - SQL injection prevention via UUID validation
 * - LRU caching for schema existence checks
 * - Per-request QueryRunner for connection-safe search_path management
 * - Fallback to shared 'hr' schema for tenants without dedicated schema
 *
 * Schema naming convention: tenant_{first16chars_of_uuid_without_hyphens}
 * Example: tenant_4b529829ea7948da for tenantId 4b529829-ea79-48da-982c-cd6fbec8ffb7
 * Must match SchemaManagerService.getTenantSchemaName exactly.
 */
@Injectable()
export class TenantSchemaMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantSchemaMiddleware.name);
  private readonly DEFAULT_SCHEMA = 'hr';

  /** LRU cache for schema existence (max 1000 entries, 5 min TTL) */
  private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000);

  constructor(private readonly dataSource: DataSource) {}

  async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
    const startTime = Date.now();

    // Create a dedicated QueryRunner to pin a single pooled connection for this request.
    // This guarantees SET and RESET execute on the same physical connection.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Extract tenant ID from request (set by UserContextMiddleware/TenantContextMiddleware)
      const tenantId = req.tenantId || req.user?.tenantId;

      if (tenantId && tenantId !== 'default-tenant') {
        // Validate UUID format (SQL injection prevention)
        if (!this.isValidUUID(tenantId)) {
          throw new BadRequestException('Invalid tenant ID format');
        }

        const tenantSchema = this.getTenantSchemaName(tenantId);
        const schemaExists = await this.checkSchemaExists(tenantSchema);

        if (schemaExists) {
          // Include 'hr' shared schema so HR lookup tables (leave_types, etc.) are accessible
          await this.setSearchPathSafe(queryRunner, tenantSchema, this.DEFAULT_SCHEMA);
          req.schemaName = tenantSchema;
        } else {
          // Fallback for existing tenants without dedicated schema
          await this.setSearchPathSafe(queryRunner, this.DEFAULT_SCHEMA);
          req.schemaName = this.DEFAULT_SCHEMA;
          this.logger.debug(`Tenant ${tenantId}: using fallback schema ${this.DEFAULT_SCHEMA}`);
        }
      } else {
        await this.setSearchPathSafe(queryRunner, this.DEFAULT_SCHEMA);
        req.schemaName = this.DEFAULT_SCHEMA;
      }

      this.logger.debug(`Schema: ${req.schemaName} (${Date.now() - startTime}ms)`);

    } catch (error) {
      if (error instanceof BadRequestException) {
        await this.safeRelease(queryRunner);
        throw error;
      }

      this.logger.error(`Schema middleware error: ${error instanceof Error ? error.message : String(error)}`);

      // Attempt fallback
      try {
        await this.setSearchPathSafe(queryRunner, this.DEFAULT_SCHEMA);
        req.schemaName = this.DEFAULT_SCHEMA;
      } catch {
        this.logger.error('Fallback also failed - continuing without schema change');
      }
    }

    // Store the QueryRunner on the request so handlers can optionally use it
    req.tenantQueryRunner = queryRunner;

    // CRITICAL: Reset search_path and release the QueryRunner when response finishes.
    // Because we use the same QueryRunner, RESET is guaranteed to hit the same
    // physical connection that SET was called on -- eliminating the D04-M02 race.
    let released = false;
    const cleanup = async () => {
      if (released) return;
      released = true;
      try {
        await queryRunner.query('RESET search_path');
      } catch (err) {
        this.logger.warn(`Failed to reset search path: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await this.safeRelease(queryRunner);
      }
    };

    res.on('finish', () => { cleanup().catch(() => {}); });
    res.on('close', () => { cleanup().catch(() => {}); });

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
   * Uses 16 characters (without hyphens) for collision safety.
   * Must match SchemaManagerService.getTenantSchemaName
   */
  private getTenantSchemaName(tenantId: string): string {
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    return `tenant_${cleanId}`;
  }

  /**
   * Set search_path with SQL injection prevention on a specific QueryRunner.
   * Accepts one or more schema names; 'public' is always appended.
   */
  private async setSearchPathSafe(qr: QueryRunner, ...schemaNames: string[]): Promise<void> {
    // Validate each schema name format as additional safety
    for (const name of schemaNames) {
      if (!/^[a-z0-9_]+$/.test(name)) {
        throw new BadRequestException('Invalid schema name');
      }
    }
    const schemas = [...schemaNames, 'public'].map((s) => `"${s}"`).join(', ');
    await qr.query(`SET search_path TO ${schemas}`);
  }

  /**
   * Safely release a QueryRunner, ignoring errors if already released
   */
  private async safeRelease(qr: QueryRunner): Promise<void> {
    try {
      if (!qr.isReleased) {
        await qr.release();
      }
    } catch (err) {
      this.logger.debug(`QueryRunner release error: ${err instanceof Error ? err.message : String(err)}`);
    }
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
