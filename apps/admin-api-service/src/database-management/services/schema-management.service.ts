/**
 * Schema Management Service
 *
 * Multi-tenant database schema oluşturma, yönetim ve izolasyon servisi.
 */

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  TenantSchema,
  SchemaStatus,
  SchemaInfo,
  TableInfo,
  ConnectionPoolStatus,
} from '../entities/database-management.entity';

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class SchemaManagementService {
  private readonly logger = new Logger(SchemaManagementService.name);

  // Schema naming convention
  private readonly SCHEMA_PREFIX = 'tenant_';
  private readonly SCHEMA_SUFFIX = '_schema';

  constructor(
    @InjectRepository(TenantSchema)
    private readonly schemaRepository: Repository<TenantSchema>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ============================================================================
  // Schema Creation
  // ============================================================================

  /**
   * Generate schema name from tenant ID
   */
  generateSchemaName(tenantId: string): string {
    // Remove dashes from UUID for cleaner schema name
    const cleanId = tenantId.replace(/-/g, '').substring(0, 12);
    return `${this.SCHEMA_PREFIX}${cleanId}${this.SCHEMA_SUFFIX}`;
  }

  /**
   * Create schema for new tenant
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
      // Create the actual database schema
      await this.createDatabaseSchema(schemaName);

      // Create default tables
      await this.createDefaultTables(schemaName);

      // Update status to active
      schemaRecord.status = 'active';
      schemaRecord.tableCount = await this.getTableCount(schemaName);
      await this.schemaRepository.save(schemaRecord);

      this.logger.log(`Schema created successfully: ${schemaName}`);
      return schemaRecord;
    } catch (err) {
      const error = err as Error;
      // Cleanup on failure
      schemaRecord.status = 'suspended';
      await this.schemaRepository.save(schemaRecord);

      this.logger.error(`Failed to create schema: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create database schema
   */
  private async createDatabaseSchema(schemaName: string): Promise<void> {
    // Validate schema name to prevent SQL injection
    if (!this.isValidSchemaName(schemaName)) {
      throw new BadRequestException('Invalid schema name');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Create default tables for tenant schema
   */
  private async createDefaultTables(schemaName: string): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Base metadata table for tenant-specific settings
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "${schemaName}"."_metadata" (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          key VARCHAR(100) NOT NULL UNIQUE,
          value JSONB,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Audit trail table
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "${schemaName}"."_audit_log" (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          entity_type VARCHAR(100),
          entity_id VARCHAR(100),
          action VARCHAR(50),
          old_data JSONB,
          new_data JSONB,
          user_id VARCHAR(100),
          ip_address VARCHAR(45),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert initial metadata
      await queryRunner.query(`
        INSERT INTO "${schemaName}"."_metadata" (key, value)
        VALUES
          ('schema_version', '"1.0.0"'),
          ('created_at', '"${new Date().toISOString()}"'),
          ('last_migration', 'null')
        ON CONFLICT (key) DO NOTHING
      `);
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  /**
   * Get all tenant schemas
   */
  async getAllSchemas(): Promise<TenantSchema[]> {
    return this.schemaRepository.find({
      order: { createdAt: 'DESC' },
    });
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
   * Delete tenant schema
   */
  async deleteSchema(tenantId: string, hardDelete = false): Promise<void> {
    this.logger.log(`Deleting schema for tenant: ${tenantId}, hardDelete: ${hardDelete}`);

    const schema = await this.getSchemaByTenantId(tenantId);

    if (hardDelete) {
      // Actually drop the schema from database
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        await queryRunner.query(`DROP SCHEMA IF EXISTS "${schema.schemaName}" CASCADE`);
        await this.schemaRepository.delete({ id: schema.id });
      } finally {
        await queryRunner.release();
      }
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
   * Validate schema name
   */
  private isValidSchemaName(schemaName: string): boolean {
    // Only allow alphanumeric characters and underscores
    const validPattern = /^[a-z][a-z0-9_]*$/i;
    return validPattern.test(schemaName) && schemaName.length <= 63;
  }

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
      const crossRefs = await queryRunner.query(`
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
      `, [schema.schemaName]);

      if (crossRefs.length > 0) {
        issues.push(`Found ${crossRefs.length} cross-schema foreign key references`);
      }

      // Check for shared sequences
      const sharedSequences = await queryRunner.query(`
        SELECT sequence_name
        FROM information_schema.sequences
        WHERE sequence_schema = 'public'
          AND sequence_name LIKE $1
      `, [`%${schema.schemaName}%`]);

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
  async getConnectionsByTenant(): Promise<Array<{
    tenantId: string;
    schemaName: string;
    activeConnections: number;
    idleConnections: number;
  }>> {
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
        const connections = await queryRunner.query(`
          SELECT
            count(*) FILTER (WHERE state = 'active') as active,
            count(*) FILTER (WHERE state = 'idle') as idle
          FROM pg_stat_activity
          WHERE query LIKE $1
        `, [`%${schema.schemaName}%`]);

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
      const result = await queryRunner.query(`
        SELECT count(*) as count
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
      `, [schemaName]);

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
      const result = await queryRunner.query(`
        SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as size
        FROM pg_tables
        WHERE schemaname = $1
      `, [schemaName]);

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
      const tables = await queryRunner.query(`
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
      `, [schemaName]);

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

    const activeSchemas = schemas.filter(s => s.status === 'active').length;
    const suspendedSchemas = schemas.filter(s => s.status === 'suspended').length;
    const totalSizeBytes = schemas.reduce((sum, s) => sum + Number(s.sizeBytes), 0);

    return {
      totalSchemas: schemas.length,
      activeSchemas,
      suspendedSchemas,
      totalSizeBytes,
      avgSizeBytes: schemas.length > 0 ? Math.round(totalSizeBytes / schemas.length) : 0,
    };
  }
}
