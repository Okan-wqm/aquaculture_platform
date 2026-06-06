/**
 * Schema Management Service
 *
 * Multi-tenant database schema oluşturma, yönetim ve izolasyon servisi.
 */

import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  SchemaManagerService,
  DEFAULT_TENANT_MODULES,
  getTenantSchemaName,
} from '@aquaculture/backend-common/database';

import { AuditLogService } from '../../audit/audit.service';
import {
  TenantSchema,
  SchemaStatus,
  SchemaInfo,
  TableInfo,
  ConnectionPoolStatus,
} from '../entities/database-management.entity';

// ============================================================================
// Interfaces
// ============================================================================

/** Context about the user performing a destructive operation, passed from the controller. */
export interface DestructiveActionContext {
  performedBy: string;
  ipAddress?: string;
  userAgent?: string;
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class SchemaManagementService {
  private readonly logger = new Logger(SchemaManagementService.name);

  // Schema naming convention - MUST match farm-service TenantSchemaMiddleware
  private readonly SCHEMA_PREFIX = 'tenant_';

  constructor(
    @InjectRepository(TenantSchema)
    private readonly schemaRepository: Repository<TenantSchema>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    @Optional()
    private readonly schemaManager?: SchemaManagerService,
  ) {}

  // ============================================================================
  // Schema Creation
  // ============================================================================

  /**
   * Generate schema name from tenant ID
   * Uses 16 characters (without hyphens) for collision safety.
   * MUST match farm-service TenantSchemaMiddleware.getTenantSchemaName()
   */
  generateSchemaName(tenantId: string): string {
    // Remove dashes from UUID for cleaner schema name
    // Use 16 chars to match farm-service convention
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    return `${this.SCHEMA_PREFIX}${cleanId}`;
  }

  /**
   * Create schema for new tenant with all module tables.
   * Delegates to backend-common SchemaManagerService for full module table creation
   * (sensor, farm, hr, hydroponics) so tenant schemas are production-ready.
   */
  async createTenantSchema(tenantId: string): Promise<TenantSchema> {
    this.logger.log(`Creating schema for tenant: ${tenantId}`);

    // Check if schema already exists
    const existing = await this.schemaRepository.findOne({
      where: { tenantId },
    });

    if (existing) {
      throw new BadRequestException(`Schema already exists for tenant: ${tenantId}`);
    }

    const schemaName = this.generateSchemaName(tenantId);

    // Create schema record first (status: creating)
    const schemaRecord = this.schemaRepository.create({
      tenantId,
      schemaName,
      status: 'creating' as SchemaStatus,
      currentVersion: '1.0.0',
    });
    await this.schemaRepository.save(schemaRecord);

    try {
      if (!this.schemaManager) {
        throw new ConflictException(
          'Runtime tenant schema creation requires SchemaManagerService and cannot use admin-api fallback DDL.',
        );
      }

      // Use backend-common SchemaManagerService for full module table creation.
      const allModules = DEFAULT_TENANT_MODULES;
      const result = await this.schemaManager.createTenantSchema(tenantId, allModules);

      if (!result.success && !result.partialSuccess) {
        throw new Error(`Schema creation failed: ${result.errors.join(', ')}`);
      }

      if (result.errors.length > 0) {
        this.logger.warn(
          `Schema ${schemaName} created with warnings: ${result.errors.join(', ')}`,
        );
      }

      this.logger.log(
        `Schema ${schemaName}: ${result.tablesCreated.length} tables created via SchemaManagerService`,
      );

      // Update status to active
      schemaRecord.status = 'active';
      schemaRecord.tableCount = await this.getTableCount(schemaName);
      await this.schemaRepository.save(schemaRecord);

      this.logger.log(
        `Schema created successfully: ${schemaName} (${schemaRecord.tableCount} tables)`,
      );
      return schemaRecord;
    } catch (err) {
      const error = err as Error;
      // Cleanup on failure
      schemaRecord.status = 'suspended';
      await this.schemaRepository.save(schemaRecord);

      this.logger.error(`Tenant schema provisioning failed: ${error.message}`);
      throw error;
    }
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  /**
   * Get all tenant schemas
   */
  async getAllSchemas(
    options: { page?: number; limit?: number } = {},
  ): Promise<{ data: TenantSchema[]; total: number; page: number; limit: number }> {
    const { page = 1, limit = 50 } = options;

    const [data, total] = await this.schemaRepository.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total, page, limit };
  }

  /**
   * Get schema by tenant ID
   */
  async getSchemaByTenantId(tenantId: string): Promise<TenantSchema> {
    const schema = await this.schemaRepository.findOne({
      where: { tenantId },
    });

    if (!schema) {
      throw new NotFoundException(`Schema not found for tenant: ${tenantId}`);
    }

    return schema;
  }

  /**
   * Get detailed schema info
   */
  async getSchemaInfo(tenantId: string): Promise<SchemaInfo> {
    const schema = await this.getSchemaByTenantId(tenantId);
    const tables = await this.getTableInfo(schema.schemaName);
    const sizeBytes = await this.getSchemaSize(schema.schemaName);

    return {
      schemaName: schema.schemaName,
      tenantId: schema.tenantId,
      status: schema.status,
      version: schema.currentVersion,
      sizeBytes,
      tableCount: tables.length,
      tables,
      createdAt: schema.createdAt,
      lastMigrationAt: schema.lastMigrationAt,
      lastBackupAt: schema.lastBackupAt,
    };
  }

  /**
   * Update schema status
   */
  async updateSchemaStatus(tenantId: string, status: SchemaStatus): Promise<TenantSchema> {
    const schema = await this.getSchemaByTenantId(tenantId);
    schema.status = status;
    return this.schemaRepository.save(schema);
  }

  /**
   * Suspend tenant schema
   */
  async suspendSchema(tenantId: string): Promise<TenantSchema> {
    this.logger.log(`Suspending schema for tenant: ${tenantId}`);
    return this.updateSchemaStatus(tenantId, 'suspended');
  }

  /**
   * Activate tenant schema
   */
  async activateSchema(tenantId: string): Promise<TenantSchema> {
    this.logger.log(`Activating schema for tenant: ${tenantId}`);
    return this.updateSchemaStatus(tenantId, 'active');
  }

  /**
   * Delete tenant schema.
   *
   * Soft delete marks the schema record as 'deleted'.
   * Hard delete is intentionally blocked here. Destructive tenant deletion must
   * run through TenantDeprovisionWorkflow with CleanupDropProof evidence.
   *
   * @param tenantId - UUID of the tenant whose schema should be deleted
   * @param hardDelete - when true, physically drops the database schema
   * @param actionContext - initiator identity for the audit trail (required for hard delete)
   */
  async deleteSchema(
    tenantId: string,
    hardDelete: boolean,
    actionContext: DestructiveActionContext,
  ): Promise<void> {
    this.logger.log(`Deleting schema for tenant: ${tenantId}, hardDelete: ${hardDelete}`);

    const schema = await this.getSchemaByTenantId(tenantId);

    if (hardDelete) {
      void actionContext;
      throw new ConflictException(
        'Schema hard delete is deprovision-workflow-owned and requires CleanupDropProof.',
      );
    } else {
      // Soft delete - just mark as deleted
      schema.status = 'deleted';
      await this.schemaRepository.save(schema);
    }
  }

  // ============================================================================
  // Schema Validation
  // ============================================================================

  /**
   * Validate schema isolation
   */
  async validateSchemaIsolation(tenantId: string): Promise<{
    isIsolated: boolean;
    issues: string[];
  }> {
    const schema = await this.getSchemaByTenantId(tenantId);
    const issues: string[] = [];

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Check for cross-schema references
      const crossRefs = await queryRunner.query(
        `
        SELECT DISTINCT
          tc.table_schema,
          tc.table_name,
          ccu.table_schema AS foreign_schema,
          ccu.table_name AS foreign_table
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.constraint_column_usage AS ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = $1
          AND ccu.table_schema != $1
      `,
        [schema.schemaName],
      );

      if (crossRefs.length > 0) {
        issues.push(`Found ${crossRefs.length} cross-schema foreign key references`);
      }

      // Check for shared sequences
      const sharedSequences = await queryRunner.query(
        `
        SELECT sequence_name
        FROM information_schema.sequences
        WHERE sequence_schema = 'public'
          AND sequence_name LIKE $1
      `,
        [`%${schema.schemaName}%`],
      );

      if (sharedSequences.length > 0) {
        issues.push(`Found ${sharedSequences.length} potentially shared sequences`);
      }

      return {
        isIsolated: issues.length === 0,
        issues,
      };
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Connection Pool Management
  // ============================================================================

  /**
   * Get connection pool status
   */
  async getConnectionPoolStatus(): Promise<ConnectionPoolStatus[]> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const stats = await queryRunner.query(`
        SELECT
          datname as database,
          count(*) as total_connections,
          count(*) FILTER (WHERE state = 'active') as active_connections,
          count(*) FILTER (WHERE state = 'idle') as idle_connections,
          count(*) FILTER (WHERE wait_event IS NOT NULL) as waiting_connections
        FROM pg_stat_activity
        WHERE datname = current_database()
        GROUP BY datname
      `);

      const maxConnResult = await queryRunner.query(`
        SHOW max_connections
      `);
      const maxConnections = parseInt(maxConnResult[0]?.max_connections || '100', 10);

      return stats.map((stat: Record<string, unknown>) => ({
        poolName: stat.database as string,
        totalConnections: parseInt(stat.total_connections as string, 10),
        activeConnections: parseInt(stat.active_connections as string, 10),
        idleConnections: parseInt(stat.idle_connections as string, 10),
        waitingRequests: parseInt(stat.waiting_connections as string, 10),
        maxConnections,
        utilizationPercent: (parseInt(stat.total_connections as string, 10) / maxConnections) * 100,
      }));
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get connections by tenant
   */
  async getConnectionsByTenant(): Promise<
    Array<{
      tenantId: string;
      schemaName: string;
      activeConnections: number;
      idleConnections: number;
    }>
  > {
    const schemas = await this.schemaRepository.find({
      where: { status: 'active' as SchemaStatus },
    });

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const results: Array<{
        tenantId: string;
        schemaName: string;
        activeConnections: number;
        idleConnections: number;
      }> = [];

      for (const schema of schemas) {
        const connections = await queryRunner.query(
          `
          SELECT
            count(*) FILTER (WHERE state = 'active') as active,
            count(*) FILTER (WHERE state = 'idle') as idle
          FROM pg_stat_activity
          WHERE query LIKE $1
        `,
          [`%${schema.schemaName}%`],
        );

        results.push({
          tenantId: schema.tenantId,
          schemaName: schema.schemaName,
          activeConnections: parseInt(connections[0]?.active || '0', 10),
          idleConnections: parseInt(connections[0]?.idle || '0', 10),
        });
      }

      return results;
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Get table count in schema
   */
  private async getTableCount(schemaName: string): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const result = await queryRunner.query(
        `
        SELECT count(*) as count
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
      `,
        [schemaName],
      );

      return parseInt(result[0]?.count || '0', 10);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get schema size
   */
  private async getSchemaSize(schemaName: string): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const result = await queryRunner.query(
        `
        SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as size
        FROM pg_tables
        WHERE schemaname = $1
      `,
        [schemaName],
      );

      return parseInt(result[0]?.size || '0', 10);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get table info for schema
   */
  private async getTableInfo(schemaName: string): Promise<TableInfo[]> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const tables = await queryRunner.query(
        `
        SELECT
          t.tablename as table_name,
          COALESCE(s.n_live_tup, 0) as row_count,
          pg_total_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename)) as size_bytes,
          (SELECT count(*) FROM pg_indexes WHERE schemaname = t.schemaname AND tablename = t.tablename) as index_count,
          s.last_vacuum,
          s.last_analyze
        FROM pg_tables t
        LEFT JOIN pg_stat_user_tables s ON t.tablename = s.relname AND t.schemaname = s.schemaname
        WHERE t.schemaname = $1
        ORDER BY size_bytes DESC
      `,
        [schemaName],
      );

      return tables.map((t: Record<string, unknown>) => ({
        tableName: t.table_name as string,
        rowCount: parseInt(t.row_count as string, 10),
        sizeBytes: parseInt(t.size_bytes as string, 10),
        indexCount: parseInt(t.index_count as string, 10),
        lastVacuum: t.last_vacuum as Date | null,
        lastAnalyze: t.last_analyze as Date | null,
      }));
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Update schema statistics
   */
  async updateSchemaStats(tenantId: string): Promise<TenantSchema> {
    const schema = await this.getSchemaByTenantId(tenantId);

    schema.sizeBytes = await this.getSchemaSize(schema.schemaName);
    schema.tableCount = await this.getTableCount(schema.schemaName);

    return this.schemaRepository.save(schema);
  }

  /**
   * Sync missing tables for existing tenant schemas.
   * If tenantId is provided, syncs only that tenant. Otherwise syncs all active tenants.
   */
  async syncExistingTenantSchemas(
    tenantId?: string,
    _modules?: string[],
  ): Promise<{
    results: Array<{
      tenantId: string;
      schemaName: string;
      created: string[];
      skipped: string[];
      errors: string[];
    }>;
    summary: { totalCreated: number; totalErrors: number; tenantsProcessed: number };
  }> {
    if (!this.schemaManager) {
      throw new BadRequestException('SchemaManagerService not available');
    }

    let schemas: TenantSchema[];
    if (tenantId) {
      const schema = await this.schemaRepository.findOne({ where: { tenantId } });
      schemas = schema ? [schema] : [];
    } else {
      schemas = await this.schemaRepository.find({
        where: { status: 'active' as SchemaStatus },
      });
    }

    const results: Array<{
      tenantId: string;
      schemaName: string;
      created: string[];
      skipped: string[];
      errors: string[];
    }> = [];

    let totalCreated = 0;
    let totalErrors = 0;
    const disabledMessage =
      'Runtime tenant schema repair is disabled for existing tenants. ' +
      'Use authored migrations plus tenant fan-out; this admin schema sync route is report-only during Sites Setup SSOT remediation.';

    for (const schema of schemas) {
      results.push({
        tenantId: schema.tenantId,
        schemaName: schema.schemaName,
        created: [],
        skipped: [],
        errors: [disabledMessage],
      });
      totalErrors++;
    }

    return {
      results,
      summary: {
        totalCreated,
        totalErrors,
        tenantsProcessed: schemas.length,
      },
    };
  }

  /**
   * Get schema summary stats
   */
  async getSchemaSummary(): Promise<{
    totalSchemas: number;
    activeSchemas: number;
    suspendedSchemas: number;
    totalSizeBytes: number;
    avgSizeBytes: number;
  }> {
    const schemas = await this.schemaRepository.find();

    const activeSchemas = schemas.filter((s) => s.status === 'active').length;
    const suspendedSchemas = schemas.filter((s) => s.status === 'suspended').length;
    const totalSizeBytes = schemas.reduce((sum, s) => sum + Number(s.sizeBytes), 0);

    return {
      totalSchemas: schemas.length,
      activeSchemas,
      suspendedSchemas,
      totalSizeBytes,
      avgSizeBytes: schemas.length > 0 ? Math.round(totalSizeBytes / schemas.length) : 0,
    };
  }

  /**
   * Backfill tenant_schemas tracking records for existing tenant schemas
   * that were created before this tracking was added.
   *
   * Scans information_schema for schemas matching the tenant_* naming pattern,
   * cross-references with the tenants table, and inserts missing tracking records.
   */
  async backfillTrackingRecords(): Promise<{
    created: number;
    skipped: number;
    errors: string[];
  }> {
    this.logger.log('Starting tenant_schemas backfill...');
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Find all tenant_* schemas in the database
      const existingSchemas: Array<{ schema_name: string }> = await queryRunner.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
        ORDER BY schema_name
      `);

      for (const row of existingSchemas) {
        const schemaName = row.schema_name;

        try {
          // Check if a tracking record already exists for this schema
          const existingRecord = await this.schemaRepository.findOne({
            where: { schemaName },
          });

          if (existingRecord) {
            skipped++;
            continue;
          }

          // Resolve tenantId by matching the schema name pattern against the tenants table
          const tenantRows: Array<{ id: string }> = await queryRunner.query(
            `
            SELECT id FROM tenants
            WHERE LEFT(REPLACE(id::text, '-', ''), 16) = $1
          `,
            [schemaName.replace('tenant_', '')],
          );

          if (tenantRows.length === 0) {
            errors.push(`No matching tenant found for schema ${schemaName}`);
            continue;
          }

          const tenantId = tenantRows[0]!.id;

          // Check if a tracking record already exists by tenantId (different schemaName)
          const existingByTenant = await this.schemaRepository.findOne({
            where: { tenantId },
          });

          if (existingByTenant) {
            skipped++;
            continue;
          }

          // Get table count for this schema
          const tableCount = await this.getTableCount(schemaName);

          // Create tracking record
          const record = this.schemaRepository.create({
            tenantId,
            schemaName,
            status: 'active' as SchemaStatus,
            currentVersion: '1.0.0',
            tableCount,
          });
          await this.schemaRepository.save(record);
          created++;

          this.logger.log(
            `Backfilled tracking record: tenant ${tenantId} → ${schemaName} (${tableCount} tables)`,
          );
        } catch (err) {
          const error = err as Error;
          errors.push(`${schemaName}: ${error.message}`);
          this.logger.warn(`Failed to backfill ${schemaName}: ${error.message}`);
        }
      }

      this.logger.log(
        `Backfill complete: ${created} created, ${skipped} skipped, ${errors.length} errors`,
      );
      return { created, skipped, errors };
    } finally {
      await queryRunner.release();
    }
  }
}
