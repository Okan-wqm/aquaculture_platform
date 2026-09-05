/**
 * Migration Management Service
 *
 * Tenant schema migration yönetimi - tek tenant, toplu migration, rollback ve dry-run.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import {
  TenantSchema,
  SchemaStatus,
  SchemaMigration,
  MigrationStatus,
  MigrationPlan,
} from '../entities/database-management.entity';

// ============================================================================
// Migration Registry
// ============================================================================

interface MigrationDefinition {
  version: string;
  name: string;
  description: string;
  affectedTables: string[];
  isDestructive: boolean;
  requiresDowntime: boolean;
}

// Runtime admin-api does not own migration definitions. Tenant schema changes
// are requested through admin ledgers and executed by apps/db-migrate only.
const MIGRATION_REGISTRY: MigrationDefinition[] = [];

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
      upScript: '',
      downScript: '',
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

  // ============================================================================
  // Batch Migration
  // ============================================================================

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
        status: migration?.status || 'pending',
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
    if (status) where['status'] = status;
    if (version) where['version'] = version;

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
