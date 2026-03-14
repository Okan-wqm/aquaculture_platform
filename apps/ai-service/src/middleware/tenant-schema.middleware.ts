import { Injectable, NestMiddleware, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { DataSource, QueryRunner } from 'typeorm';

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
 * Tenant Schema Middleware for AI Service
 *
 * Sets PostgreSQL search_path to tenant-specific schema at the start of each request.
 *
 * Connection Safety (D04-M02):
 * Uses a dedicated QueryRunner per request to pin a single pooled connection.
 * SET search_path and RESET search_path are guaranteed to execute on the SAME
 * physical connection, eliminating the race condition where res.on('finish')
 * could RESET a different connection than the one that was SET.
 *
 * search_path: "tenant_xxx", ai, public
 */
@Injectable()
export class TenantSchemaMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantSchemaMiddleware.name);
  private readonly DEFAULT_SCHEMA = 'ai';
  private readonly schemaCache = new Map<string, { exists: boolean; expiry: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;
  private readonly CACHE_MAX_SIZE = 1000;
  private readonly pendingChecks = new Map<string, Promise<boolean>>();

  constructor(private readonly dataSource: DataSource) {}

  async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
    // Create a dedicated QueryRunner to pin a single pooled connection for this request.
    // This guarantees SET and RESET execute on the same physical connection.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const tenantId = req.tenantId || req.user?.tenantId;

      if (tenantId && tenantId !== 'default-tenant') {
        if (!this.isValidUUID(tenantId)) {
          throw new BadRequestException('Invalid tenant ID format');
        }

        const tenantSchema = this.getTenantSchemaName(tenantId);
        const schemaExists = await this.checkSchemaExists(tenantSchema);

        if (schemaExists) {
          await this.setSearchPathSafe(queryRunner, tenantSchema);
          req.schemaName = tenantSchema;
        } else {
          this.logger.warn(`Tenant ${tenantId}: schema '${tenantSchema}' does not exist`);
          throw new NotFoundException(`Schema not found for tenant ${tenantId}`);
        }
      } else {
        await this.setSearchPathSafe(queryRunner, this.DEFAULT_SCHEMA);
        req.schemaName = this.DEFAULT_SCHEMA;
      }
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        await this.safeRelease(queryRunner);
        throw error;
      }
      this.logger.error(`Schema middleware error: ${error instanceof Error ? error.message : String(error)}`);
      await this.safeRelease(queryRunner);
      throw new BadRequestException('Failed to resolve tenant schema');
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
        this.logger.debug(`Failed to reset search_path: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await this.safeRelease(queryRunner);
      }
    };

    res.on('finish', () => { cleanup().catch(() => {}); });
    res.on('close', () => { cleanup().catch(() => {}); });

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

  private async setSearchPathSafe(qr: QueryRunner, schemaName: string): Promise<void> {
    if (!/^[a-z0-9_]+$/.test(schemaName)) {
      throw new BadRequestException('Invalid schema name');
    }
    await qr.query(`SET search_path TO "${schemaName}", ai, public`);
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
}
