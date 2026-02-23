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
  };
}

/**
 * Simple LRU Cache for schema existence checks.
 *
 * Uses separate TTLs for positive (schema exists) and negative (schema missing) entries
 * to avoid routing new-tenant traffic to the shared schema for up to 5 minutes (LOW-03).
 * Positive TTL: 5 minutes (schema existence is stable once created).
 * Negative TTL: 30 seconds (new tenant schemas are provisioned frequently; quick re-check).
 */
class SchemaLRUCache {
  private cache = new Map<string, { value: boolean; expiry: number }>();
  private readonly maxSize: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;

  constructor(maxSize = 1000, positiveTtlMs = 5 * 60 * 1000, negativeTtlMs = 30_000) {
    this.maxSize = maxSize;
    this.positiveTtlMs = positiveTtlMs;
    this.negativeTtlMs = negativeTtlMs;
  }

  get(key: string): boolean | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to end (most-recently-used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: boolean): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    // Apply shorter TTL for negative entries so newly-provisioned tenant schemas are
    // picked up within 30 seconds rather than the full 5-minute positive TTL (LOW-03)
    const ttl = value ? this.positiveTtlMs : this.negativeTtlMs;
    this.cache.set(key, { value, expiry: Date.now() + ttl });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }
}

/**
 * Tenant Schema Middleware for Sensor Service
 *
 * Sets PostgreSQL search_path to tenant-specific schema at the start of each request.
 * This ensures all database operations target the correct tenant's tables.
 *
 * Features:
 * - SQL injection prevention via UUID validation
 * - LRU caching for schema existence checks
 * - Connection pool safety with search_path reset on response finish
 * - Fallback to shared 'sensor' schema for tenants without dedicated schema
 *
 * Schema naming convention: tenant_{first16chars_of_uuid_without_hyphens}
 * Example: tenant_4b529829ea7948da for tenantId 4b529829-ea79-48da-982c-cd6fbec8ffb7
 */
@Injectable()
export class TenantSchemaMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantSchemaMiddleware.name);
  private readonly DEFAULT_SCHEMA = 'sensor';

  /** LRU cache for schema existence (max 1000 entries, positive TTL=5 min, negative TTL=30 s) */
  private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000, 30_000);

  constructor(private readonly dataSource: DataSource) {}

  async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
    // Extract tenant ID from request (set by UserContextMiddleware/TenantContextMiddleware)
    const tenantId = req.tenantId || req.user?.tenantId;

    try {

      if (tenantId && tenantId !== 'default-tenant') {
        // Validate UUID format (SQL injection prevention)
        if (!this.isValidUUID(tenantId)) {
          throw new BadRequestException('Invalid tenant ID format');
        }

        const schemaName = this.getTenantSchemaName(tenantId);
        const schemaExists = await this.checkSchemaExists(schemaName);

        if (schemaExists) {
          // Set search_path to tenant schema with public fallback
          await this.setSearchPathSafe(schemaName);
          this.logger.debug(`Schema search_path set to: ${schemaName}`);
        } else {
          // Fallback to sensor schema for unauthenticated or default requests
          await this.setSearchPathSafe(this.DEFAULT_SCHEMA);
          this.logger.debug(`Tenant ${tenantId}: using fallback schema ${this.DEFAULT_SCHEMA}`);
        }
      } else {
        // Fallback to sensor schema for unauthenticated or default requests
        await this.setSearchPathSafe(this.DEFAULT_SCHEMA);
        this.logger.debug('Schema search_path set to: sensor (default)');
      }
    } catch (error) {
      this.logger.error(`Failed to set tenant schema: ${error instanceof Error ? error.message : String(error)}`);
      // For authenticated requests with a tenant ID, return 503 instead of falling back
      // to the shared schema, which would cause cross-tenant data contamination
      if (tenantId && tenantId !== 'default-tenant') {
        throw new BadRequestException('Tenant schema unavailable. Please try again later.');
      }
      // Only fall back to shared schema for unauthenticated requests
      try {
        await this.setSearchPathSafe(this.DEFAULT_SCHEMA);
      } catch {
        // Ignore if this also fails
      }
    }

    // CRITICAL: Reset search_path when response finishes
    // Prevents connection pool contamination
    res.on('finish', () => {
      this.resetSearchPath().catch((err) => {
        this.logger.debug(`Failed to reset search_path on finish: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    // Also reset on connection close (client disconnect)
    res.on('close', () => {
      this.resetSearchPath().catch((err) => {
        this.logger.debug(`Failed to reset search_path on close: ${err instanceof Error ? err.message : String(err)}`);
      });
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
   * Format: tenant_{first16chars_of_uuid_without_hyphens}
   * Must match SchemaManagerService.getTenantSchemaName
   */
  private getTenantSchemaName(tenantId: string): string {
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    return `tenant_${cleanId}`;
  }

  /**
   * Set search_path with SQL injection prevention
   *
   * Search path order:
   * 1. Target schema (tenant-specific or sensor default)
   * 2. Sensor schema (shared system data like sensor_protocols, sensor_type_definitions)
   * 3. Public schema (extensions, common functions)
   */
  private async setSearchPathSafe(schemaName: string): Promise<void> {
    // Validate schema name format as additional safety
    if (!/^[a-z0-9_]+$/.test(schemaName)) {
      throw new BadRequestException('Invalid schema name');
    }
    // Include 'sensor' schema for shared system tables (same pattern as farm-service)
    await this.dataSource.query(`SET search_path TO "${schemaName}", sensor, public`);
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
