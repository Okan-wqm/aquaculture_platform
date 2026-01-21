import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
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
 * Tenant Schema Middleware
 *
 * Sets PostgreSQL search_path to tenant-specific schema at the start of each request.
 * This ensures all database operations target the correct tenant's tables.
 *
 * Schema naming convention: tenant_{first8chars_of_uuid}
 * Example: tenant_4b529829 for tenantId 4b529829-ea79-48da-982c-cd6fbec8ffb7
 */
@Injectable()
export class TenantSchemaMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantSchemaMiddleware.name);

  constructor(private readonly dataSource: DataSource) {}

  async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // Extract tenant ID from request (set by UserContextMiddleware/TenantContextMiddleware)
      const tenantId = req.tenantId || req.user?.tenantId;

      if (tenantId && tenantId !== 'default-tenant') {
        const schemaName = this.getTenantSchemaName(tenantId);

        // Set search_path for this connection
        await this.dataSource.query(`SET search_path TO "${schemaName}", public`);

        this.logger.debug(`Schema search_path set to: ${schemaName}`);
      } else {
        // Fallback to sensor schema for unauthenticated or default requests
        await this.dataSource.query(`SET search_path TO "sensor", public`);
        this.logger.debug('Schema search_path set to: sensor (default)');
      }
    } catch (error) {
      this.logger.error(`Failed to set tenant schema: ${error instanceof Error ? error.message : String(error)}`);
      // Don't block the request, fallback to default schema
      try {
        await this.dataSource.query(`SET search_path TO "sensor", public`);
      } catch {
        // Ignore if this also fails
      }
    }

    next();
  }

  /**
   * Generate tenant schema name from tenant ID
   * Format: tenant_{first8chars_of_uuid}
   */
  private getTenantSchemaName(tenantId: string): string {
    const cleanId = tenantId.replace(/-/g, '').substring(0, 8);
    return `tenant_${cleanId}`;
  }
}
