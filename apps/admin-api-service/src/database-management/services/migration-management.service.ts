/**
 * Migration Management Service
 *
 * Tenant schema migration yönetimi - tek tenant, toplu migration, rollback ve dry-run.
 */

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';

import {
  TenantSchema,
  SchemaStatus,
  SchemaMigration,
  MigrationStatus,
  MigrationPlan,
  MigrationResult,
} from '../entities/database-management.entity';

// ============================================================================
// Migration Registry
// ============================================================================

interface MigrationDefinition {
  version: string;
  name: string;
  description: string;
  upScript: string;
  downScript: string;
  affectedTables: string[];
  isDestructive: boolean;
  requiresDowntime: boolean;
}

/**
 * SECURITY: Validate SQL identifier (schema name) to prevent injection
 * Only allows alphanumeric characters and underscores
 */
function validateSchemaName(schemaName: string): string {
  const identifierRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  if (!identifierRegex.test(schemaName) || schemaName.length > 63) {
    throw new BadRequestException(
      `SECURITY: Invalid schema name: ${schemaName}. Only alphanumeric and underscore allowed.`
    );
  }
  return schemaName;
}

// ============================================================================
// SQL Statement Validator (NEW-05)
// ============================================================================

/**
 * Result of SQL statement validation against the migration security policy.
 */
interface MigrationValidationResult {
  /** Statements that passed the whitelist and are safe to execute */
  valid: string[];
  /** Statements that were rejected with their rejection reasons */
  rejected: Array<{ statement: string; reason: string }>;
}

/**
 * SECURITY (NEW-05): Validates that SQL statements conform to a DDL-only whitelist.
 *
 * Migration scripts should only contain schema-definition statements (CREATE, ALTER, DROP
 * on tables, indexes, constraints, etc.). This validator rejects:
 *   - DML statements (INSERT, UPDATE, DELETE, SELECT INTO) unless ALLOW_DML_MIGRATIONS=true
 *   - DCL statements (GRANT, REVOKE)
 *   - Dangerous operations (DROP DATABASE, DROP SCHEMA public, TRUNCATE, COPY)
 *   - PostgreSQL administrative commands (SET ROLE, pg_* functions)
 *
 * The blacklist check runs BEFORE the whitelist, so dangerous statements are always
 * rejected regardless of the ALLOW_DML_MIGRATIONS flag.
 *
 * @param statements - Array of individual SQL statements to validate
 * @param allowDml - When true, permits DML statements (INSERT/UPDATE/DELETE/SELECT)
 *                   in addition to DDL. Defaults to false.
 * @returns MigrationValidationResult with valid and rejected statement arrays
 */
function validateMigrationStatements(
  statements: string[],
  allowDml = false,
): MigrationValidationResult {
  /**
   * Whitelist: DDL statements that are safe for tenant schema migrations.
   * Matches CREATE/ALTER/DROP on standard database objects.
   */
  const DDL_WHITELIST =
    /^\s*(CREATE|ALTER|DROP)\s+(TABLE|INDEX|CONSTRAINT|TYPE|SEQUENCE|EXTENSION|VIEW|FUNCTION|TRIGGER)\b/i;

  /**
   * Extended whitelist: CREATE TABLE IF NOT EXISTS, CREATE UNIQUE INDEX, etc.
   * Covers common DDL variants with optional qualifiers.
   */
  const DDL_EXTENDED_WHITELIST =
    /^\s*(CREATE\s+(OR\s+REPLACE\s+)?(UNIQUE\s+)?|ALTER|DROP)\s+(TABLE|INDEX|CONSTRAINT|TYPE|SEQUENCE|EXTENSION|VIEW|FUNCTION|TRIGGER)\b/i;

  /**
   * DML whitelist: Only enabled when ALLOW_DML_MIGRATIONS=true.
   * Permits data manipulation for seed/backfill migrations.
   */
  const DML_WHITELIST = /^\s*(INSERT|UPDATE|DELETE|SELECT)\b/i;

  /**
   * Blacklist: Statements that are ALWAYS rejected regardless of configuration.
   * These represent operations that could destroy infrastructure, exfiltrate data,
   * or escalate privileges beyond tenant schema scope.
   */
  const DANGEROUS_BLACKLIST =
    /^\s*(DROP\s+DATABASE|DROP\s+SCHEMA\s+public|TRUNCATE|GRANT|REVOKE|COPY|\\copy|LOAD|DO\s+\$|SET\s+ROLE\s+(?!NONE))/i;

  /**
   * Additional blacklist: PostgreSQL administrative function calls that could
   * access system internals or modify server configuration.
   */
  const PG_ADMIN_BLACKLIST = /\bpg_(read_file|write_file|execute_server_program|ls_dir|sleep)\b/i;

  const valid: string[] = [];
  const rejected: Array<{ statement: string; reason: string }> = [];

  for (const rawStatement of statements) {
    const statement = rawStatement.trim();
    if (!statement) continue;

    // Dangerous operations are ALWAYS rejected (blacklist before whitelist)
    if (DANGEROUS_BLACKLIST.test(statement)) {
      rejected.push({
        statement: statement.substring(0, 200),
        reason: 'Matches dangerous operation blacklist (DROP DATABASE, TRUNCATE, GRANT, etc.)',
      });
      continue;
    }

    if (PG_ADMIN_BLACKLIST.test(statement)) {
      rejected.push({
        statement: statement.substring(0, 200),
        reason: 'Contains PostgreSQL administrative function call',
      });
      continue;
    }

    // DDL is always allowed
    if (DDL_WHITELIST.test(statement) || DDL_EXTENDED_WHITELIST.test(statement)) {
      valid.push(statement);
      continue;
    }

    // DML is conditionally allowed
    if (allowDml && DML_WHITELIST.test(statement)) {
      valid.push(statement);
      continue;
    }

    // Everything else is rejected
    rejected.push({
      statement: statement.substring(0, 200),
      reason: allowDml
        ? 'Statement does not match DDL or DML whitelist'
        : 'Statement does not match DDL whitelist (set ALLOW_DML_MIGRATIONS=true for DML)',
    });
  }

  return { valid, rejected };
}

// Available migrations registry
const MIGRATION_REGISTRY: MigrationDefinition[] = [
  {
    version: '1.0.0',
    name: 'initial_schema',
    description: 'Initial schema setup with metadata and audit tables',
    upScript: `
      CREATE TABLE IF NOT EXISTS "_metadata" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(100) NOT NULL UNIQUE,
        value JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS "_audit_log" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type VARCHAR(100),
        entity_id VARCHAR(100),
        action VARCHAR(50),
        old_data JSONB,
        new_data JSONB,
        user_id VARCHAR(100),
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `,
    downScript: `
      DROP TABLE IF EXISTS "_audit_log";
      DROP TABLE IF EXISTS "_metadata";
    `,
    affectedTables: ['_metadata', '_audit_log'],
    isDestructive: false,
    requiresDowntime: false,
  },
  {
    version: '1.1.0',
    name: 'add_tenant_settings',
    description: 'Add tenant-specific settings table',
    upScript: `
      CREATE TABLE IF NOT EXISTS "tenant_settings" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category VARCHAR(100) NOT NULL,
        key VARCHAR(100) NOT NULL,
        value JSONB,
        is_encrypted BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(category, key)
      );
      CREATE INDEX idx_tenant_settings_category ON "tenant_settings"(category);
    `,
    downScript: `
      DROP INDEX IF EXISTS idx_tenant_settings_category;
      DROP TABLE IF EXISTS "tenant_settings";
    `,
    affectedTables: ['tenant_settings'],
    isDestructive: false,
    requiresDowntime: false,
  },
  {
    version: '1.2.0',
    name: 'add_data_export_logs',
    description: 'Add data export tracking table',
    upScript: `
      CREATE TABLE IF NOT EXISTS "data_exports" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        export_type VARCHAR(50) NOT NULL,
        format VARCHAR(20) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        file_path VARCHAR(500),
        file_size BIGINT,
        row_count INT,
        requested_by VARCHAR(100),
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX idx_data_exports_status ON "data_exports"(status);
      CREATE INDEX idx_data_exports_created ON "data_exports"(created_at DESC);
    `,
    downScript: `
      DROP INDEX IF EXISTS idx_data_exports_created;
      DROP INDEX IF EXISTS idx_data_exports_status;
      DROP TABLE IF EXISTS "data_exports";
    `,
    affectedTables: ['data_exports'],
    isDestructive: false,
    requiresDowntime: false,
  },
  {
    version: '1.3.0',
    name: 'add_activity_tracking',
    description: 'Add user activity tracking table',
    upScript: `
      CREATE TABLE IF NOT EXISTS "user_activities" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(100) NOT NULL,
        activity_type VARCHAR(50) NOT NULL,
        entity_type VARCHAR(100),
        entity_id VARCHAR(100),
        metadata JSONB,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX idx_user_activities_user ON "user_activities"(user_id);
      CREATE INDEX idx_user_activities_type ON "user_activities"(activity_type);
      CREATE INDEX idx_user_activities_created ON "user_activities"(created_at DESC);
    `,
    downScript: `
      DROP INDEX IF EXISTS idx_user_activities_created;
      DROP INDEX IF EXISTS idx_user_activities_type;
      DROP INDEX IF EXISTS idx_user_activities_user;
      DROP TABLE IF EXISTS "user_activities";
    `,
    affectedTables: ['user_activities'],
    isDestructive: false,
    requiresDowntime: false,
  },
];

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class MigrationManagementService {
  private readonly logger = new Logger(MigrationManagementService.name);

  constructor(
    @InjectRepository(TenantSchema)
    private readonly schemaRepository: Repository<TenantSchema>,
    @InjectRepository(SchemaMigration)
    private readonly migrationRepository: Repository<SchemaMigration>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ============================================================================
  // Migration Registry
  // ============================================================================

  /**
   * Get all available migrations
   */
  getAvailableMigrations(): MigrationPlan[] {
    return MIGRATION_REGISTRY.map(m => ({
      id: `migration_${m.version.replace(/\./g, '_')}`,
      name: m.name,
      version: m.version,
      description: m.description,
      upScript: m.upScript,
      downScript: m.downScript,
      affectedTables: m.affectedTables,
      estimatedDuration: this.estimateMigrationDuration(m),
      isDestructive: m.isDestructive,
      requiresDowntime: m.requiresDowntime,
    }));
  }

  /**
   * Estimate migration duration based on complexity
   */
  private estimateMigrationDuration(migration: MigrationDefinition): number {
    let baseDuration = 5000; // 5 seconds base
    baseDuration += migration.affectedTables.length * 2000;
    if (migration.isDestructive) baseDuration += 10000;
    return baseDuration;
  }

  // ============================================================================
  // Single Tenant Migration
  // ============================================================================

  /**
   * Get pending migrations for a tenant
   */
  async getPendingMigrations(tenantId: string): Promise<MigrationPlan[]> {
    const schema = await this.schemaRepository.findOne({
      where: { tenantId },
    });

    if (!schema) {
      throw new NotFoundException(`Schema not found for tenant: ${tenantId}`);
    }

    // Get applied migrations
    const appliedMigrations = await this.migrationRepository.find({
      where: {
        tenantId,
        status: 'completed' as MigrationStatus,
      },
      select: ['version'],
    });

    const appliedVersions = new Set(appliedMigrations.map(m => m.version));

    // Filter to pending migrations
    return this.getAvailableMigrations().filter(m => !appliedVersions.has(m.version));
  }

  /**
   * Run migration for single tenant
   */
  async runMigration(
    tenantId: string,
    version: string,
    isDryRun = false,
    executedBy?: string,
  ): Promise<MigrationResult> {
    this.logger.log(`Running migration ${version} for tenant ${tenantId}, dryRun: ${isDryRun}`);

    const schema = await this.schemaRepository.findOne({
      where: { tenantId },
    });

    if (!schema) {
      throw new NotFoundException(`Schema not found for tenant: ${tenantId}`);
    }

    const migration = MIGRATION_REGISTRY.find(m => m.version === version);
    if (!migration) {
      throw new NotFoundException(`Migration version not found: ${version}`);
    }

    // Check if already applied
    const existingMigration = await this.migrationRepository.findOne({
      where: {
        tenantId,
        version,
        status: 'completed' as MigrationStatus,
      },
    });

    if (existingMigration && !isDryRun) {
      throw new BadRequestException(`Migration ${version} already applied to tenant ${tenantId}`);
    }

    // Create migration record
    const migrationRecord = this.migrationRepository.create({
      tenantId,
      schemaName: schema.schemaName,
      migrationName: migration.name,
      version: migration.version,
      status: 'running' as MigrationStatus,
      upScript: migration.upScript,
      downScript: migration.downScript,
      isDryRun,
      affectedTables: migration.affectedTables,
      executedBy,
      startedAt: new Date(),
    });
    await this.migrationRepository.save(migrationRecord);

    const startTime = Date.now();
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Update schema status
      if (!isDryRun) {
        schema.status = 'migrating';
        await this.schemaRepository.save(schema);
      }

      await queryRunner.startTransaction();

      // Set search path to tenant schema (with SQL injection protection)
      const safeSchemaName = validateSchemaName(schema.schemaName);
      await queryRunner.query(`SET search_path TO "${safeSchemaName}"`);

      // SECURITY (NEW-05): Validate all SQL statements against DDL whitelist before execution
      const rawStatements = migration.upScript.split(';').filter(s => s.trim());
      const allowDml = process.env['ALLOW_DML_MIGRATIONS'] === 'true';
      const validation = validateMigrationStatements(rawStatements, allowDml);

      if (validation.rejected.length > 0) {
        // Log each rejected statement with WARNING level and the executor identity
        for (const rejection of validation.rejected) {
          this.logger.warn(
            `SECURITY: Migration ${version} for tenant ${tenantId} — rejected SQL statement ` +
            `by user ${executedBy ?? 'unknown'}: "${rejection.statement}" — Reason: ${rejection.reason}`,
          );
        }
        // Atomic rejection: if ANY statement fails validation, abort the entire migration
        throw new BadRequestException(
          `Migration ${version} contains ${validation.rejected.length} disallowed SQL statement(s). ` +
          `All statements must conform to the DDL whitelist. ` +
          `Rejected: ${validation.rejected.map(r => r.reason).join('; ')}`,
        );
      }

      if (isDryRun) {
        // For dry run, validate the SQL plan without executing
        if (validation.valid.length > 0) {
          await queryRunner.query(`EXPLAIN ${validation.valid[0]}`);
        }
        this.logger.log(`Dry run successful for migration ${version} (${validation.valid.length} statements validated)`);
      } else {
        // Execute validated statements only
        for (const statement of validation.valid) {
          await queryRunner.query(statement);
        }
      }

      await queryRunner.commitTransaction();

      // Update migration record
      migrationRecord.status = 'completed' as MigrationStatus;
      migrationRecord.completedAt = new Date();
      migrationRecord.executionTimeMs = Date.now() - startTime;
      await this.migrationRepository.save(migrationRecord);

      // Update schema
      if (!isDryRun) {
        schema.status = 'active';
        schema.currentVersion = version;
        schema.lastMigrationAt = new Date();
        await this.schemaRepository.save(schema);
      }

      return {
        migrationId: migrationRecord.id,
        tenantId,
        schemaName: schema.schemaName,
        status: 'completed',
        executionTimeMs: migrationRecord.executionTimeMs,
      };
    } catch (err) {
      const error = err as Error;
      await queryRunner.rollbackTransaction();

      migrationRecord.status = 'failed' as MigrationStatus;
      migrationRecord.errorMessage = error.message;
      migrationRecord.executionTimeMs = Date.now() - startTime;
      await this.migrationRepository.save(migrationRecord);

      if (!isDryRun) {
        schema.status = 'active';
        await this.schemaRepository.save(schema);
      }

      this.logger.error(`Migration failed: ${error.message}`);

      return {
        migrationId: migrationRecord.id,
        tenantId,
        schemaName: schema.schemaName,
        status: 'failed',
        executionTimeMs: migrationRecord.executionTimeMs,
        error: error.message,
      };
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Batch Migration
  // ============================================================================

  /**
   * Run migration for all active tenants
   */
  async runBatchMigration(
    version: string,
    isDryRun = false,
    executedBy?: string,
  ): Promise<MigrationResult[]> {
    this.logger.log(`Running batch migration ${version}, dryRun: ${isDryRun}`);

    const activeSchemas = await this.schemaRepository.find({
      where: { status: 'active' as SchemaStatus },
    });

    const results: MigrationResult[] = [];

    for (const schema of activeSchemas) {
      try {
        const result = await this.runMigration(
          schema.tenantId,
          version,
          isDryRun,
          executedBy,
        );
        results.push(result);
      } catch (err) {
        const error = err as Error;
        results.push({
          migrationId: '',
          tenantId: schema.tenantId,
          schemaName: schema.schemaName,
          status: 'failed',
          executionTimeMs: 0,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Get batch migration status
   */
  async getBatchMigrationStatus(version: string): Promise<{
    totalTenants: number;
    completed: number;
    pending: number;
    failed: number;
    tenants: Array<{
      tenantId: string;
      status: MigrationStatus;
      completedAt: Date | null;
    }>;
  }> {
    const activeSchemas = await this.schemaRepository.find({
      where: { status: 'active' as SchemaStatus },
    });

    const migrations = await this.migrationRepository.find({
      where: {
        version,
        tenantId: In(activeSchemas.map(s => s.tenantId)),
      },
    });

    const migrationMap = new Map(migrations.map(m => [m.tenantId, m]));

    const tenants = activeSchemas.map(schema => {
      const migration = migrationMap.get(schema.tenantId);
      return {
        tenantId: schema.tenantId,
        status: migration?.status || ('pending' as MigrationStatus),
        completedAt: migration?.completedAt || null,
      };
    });

    const completed = tenants.filter(t => t.status === 'completed').length;
    const failed = tenants.filter(t => t.status === 'failed').length;
    const pending = tenants.filter(t => t.status === 'pending').length;

    return {
      totalTenants: tenants.length,
      completed,
      pending,
      failed,
      tenants,
    };
  }

  // ============================================================================
  // Rollback
  // ============================================================================

  /**
   * Rollback migration for tenant
   */
  async rollbackMigration(
    tenantId: string,
    version: string,
    executedBy?: string,
  ): Promise<MigrationResult> {
    this.logger.log(`Rolling back migration ${version} for tenant ${tenantId}`);

    const schema = await this.schemaRepository.findOne({
      where: { tenantId },
    });

    if (!schema) {
      throw new NotFoundException(`Schema not found for tenant: ${tenantId}`);
    }

    // Find the completed migration
    const completedMigration = await this.migrationRepository.findOne({
      where: {
        tenantId,
        version,
        status: 'completed' as MigrationStatus,
      },
    });

    if (!completedMigration) {
      throw new BadRequestException(`No completed migration ${version} found for tenant ${tenantId}`);
    }

    const migration = MIGRATION_REGISTRY.find(m => m.version === version);
    if (!migration) {
      throw new NotFoundException(`Migration version not found: ${version}`);
    }

    // Create rollback record
    const rollbackRecord = this.migrationRepository.create({
      tenantId,
      schemaName: schema.schemaName,
      migrationName: `rollback_${migration.name}`,
      version: `rollback_${version}`,
      status: 'running' as MigrationStatus,
      upScript: migration.downScript,
      downScript: migration.upScript,
      affectedTables: migration.affectedTables,
      executedBy,
      startedAt: new Date(),
    });
    await this.migrationRepository.save(rollbackRecord);

    const startTime = Date.now();
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      schema.status = 'migrating';
      await this.schemaRepository.save(schema);

      await queryRunner.startTransaction();

      // Validate schema name before using in SQL (SQL injection protection)
      const safeSchemaName = validateSchemaName(schema.schemaName);
      await queryRunner.query(`SET search_path TO "${safeSchemaName}"`);

      // SECURITY (NEW-05): Validate rollback statements against DDL whitelist
      const rawStatements = migration.downScript.split(';').filter(s => s.trim());
      const allowDml = process.env['ALLOW_DML_MIGRATIONS'] === 'true';
      const validation = validateMigrationStatements(rawStatements, allowDml);

      if (validation.rejected.length > 0) {
        for (const rejection of validation.rejected) {
          this.logger.warn(
            `SECURITY: Rollback ${version} for tenant ${tenantId} — rejected SQL statement ` +
            `by user ${executedBy ?? 'unknown'}: "${rejection.statement}" — Reason: ${rejection.reason}`,
          );
        }
        throw new BadRequestException(
          `Rollback ${version} contains ${validation.rejected.length} disallowed SQL statement(s). ` +
          `Rejected: ${validation.rejected.map(r => r.reason).join('; ')}`,
        );
      }

      // Execute validated rollback statements
      for (const statement of validation.valid) {
        await queryRunner.query(statement);
      }

      await queryRunner.commitTransaction();

      // Update records
      completedMigration.status = 'rolled_back' as MigrationStatus;
      await this.migrationRepository.save(completedMigration);

      rollbackRecord.status = 'completed' as MigrationStatus;
      rollbackRecord.completedAt = new Date();
      rollbackRecord.executionTimeMs = Date.now() - startTime;
      await this.migrationRepository.save(rollbackRecord);

      // Find previous version
      const previousVersion = this.getPreviousVersion(version);
      schema.status = 'active';
      schema.currentVersion = previousVersion;
      schema.lastMigrationAt = new Date();
      await this.schemaRepository.save(schema);

      return {
        migrationId: rollbackRecord.id,
        tenantId,
        schemaName: schema.schemaName,
        status: 'completed',
        executionTimeMs: rollbackRecord.executionTimeMs,
      };
    } catch (err) {
      const error = err as Error;
      await queryRunner.rollbackTransaction();

      rollbackRecord.status = 'failed' as MigrationStatus;
      rollbackRecord.errorMessage = error.message;
      rollbackRecord.executionTimeMs = Date.now() - startTime;
      await this.migrationRepository.save(rollbackRecord);

      schema.status = 'active';
      await this.schemaRepository.save(schema);

      this.logger.error(`Rollback failed: ${error.message}`);

      return {
        migrationId: rollbackRecord.id,
        tenantId,
        schemaName: schema.schemaName,
        status: 'failed',
        executionTimeMs: rollbackRecord.executionTimeMs,
        error: error.message,
      };
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }
  }

  /**
   * Get previous version
   */
  private getPreviousVersion(currentVersion: string): string {
    const versions = MIGRATION_REGISTRY.map(m => m.version).sort();
    const currentIndex = versions.indexOf(currentVersion);
    const previousVersion = currentIndex > 0 ? versions[currentIndex - 1] : undefined;
    return previousVersion ?? '0.0.0';
  }

  // ============================================================================
  // Migration History
  // ============================================================================

  /**
   * Get migration history for tenant
   */
  async getMigrationHistory(tenantId: string): Promise<SchemaMigration[]> {
    return this.migrationRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get all migration history
   */
  async getAllMigrationHistory(options: {
    page?: number;
    limit?: number;
    status?: MigrationStatus;
    version?: string;
  }): Promise<{
    data: SchemaMigration[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page = 1, limit = 20, status, version } = options;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (version) where.version = version;

    const [data, total] = await this.migrationRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total, page, limit };
  }

  /**
   * Get migration summary
   */
  async getMigrationSummary(): Promise<{
    totalMigrations: number;
    completed: number;
    failed: number;
    rolledBack: number;
    latestVersion: string;
    tenantsUpToDate: number;
    tenantsOutdated: number;
  }> {
    const allMigrations = await this.migrationRepository.find();
    const allSchemas = await this.schemaRepository.find({
      where: { status: 'active' as SchemaStatus },
    });

    const latestVersion = MIGRATION_REGISTRY[MIGRATION_REGISTRY.length - 1]?.version || '0.0.0';

    const tenantsUpToDate = allSchemas.filter(s => s.currentVersion === latestVersion).length;

    return {
      totalMigrations: allMigrations.length,
      completed: allMigrations.filter(m => m.status === 'completed').length,
      failed: allMigrations.filter(m => m.status === 'failed').length,
      rolledBack: allMigrations.filter(m => m.status === 'rolled_back').length,
      latestVersion,
      tenantsUpToDate,
      tenantsOutdated: allSchemas.length - tenantsUpToDate,
    };
  }
}
