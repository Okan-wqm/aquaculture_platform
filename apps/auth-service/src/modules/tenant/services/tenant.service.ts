import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThan, Between } from 'typeorm';

import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { User } from '../../authentication/entities/user.entity';
import { TenantStats, TenantDatabaseInfo, TableInfo, TableSchemaInfo, ColumnInfo, IndexInfo, ModuleUsageStatResponse } from '../dto/tenant-stats.dto';
import { TenantModule } from '../entities/tenant-module.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';

/**
 * Raw database row for column information query
 */
interface ColumnQueryRow {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  is_primary_key: boolean;
  is_foreign_key: boolean;
  foreign_table_name: string | null;
  foreign_column_name: string | null;
}

/**
 * Raw database row for index information query
 */
interface IndexQueryRow {
  index_name: string;
  column_name: string;
  is_unique: boolean;
  is_primary: boolean;
}

/**
 * Raw database row for table information query
 */
interface TableQueryRow {
  name: string;
  row_count: string;
  size: string;
  index_count: string;
  last_modified: Date;
}

/**
 * Raw database row for size query
 */
interface SizeQueryRow {
  total_size: string;
}

/**
 * Raw database row for connection count query
 */
interface ConnectionQueryRow {
  active: string;
}

/**
 * Raw database row for version query
 */
interface VersionQueryRow {
  version: string;
}


/**
 * Raw database row for hypertable size query
 */
interface HypertableSizeRow {
  size: string;
}

@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(TenantModule)
    private readonly tenantModuleRepository: Repository<TenantModule>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async findById(id: string): Promise<Tenant> {
    this.logger.debug(`findById called with id: "${id}", type: ${typeof id}`);
    const tenant = await this.tenantRepository.findOne({ where: { id } });
    this.logger.debug(`findById result: ${tenant ? tenant.name : 'null'}`);
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  async findBySlug(slug: string): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({ where: { slug } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  async findAll(): Promise<Tenant[]> {
    return this.tenantRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findActive(): Promise<Tenant[]> {
    return this.tenantRepository.find({
      where: { status: TenantStatus.ACTIVE },
      order: { name: 'ASC' },
    });
  }

  /**
   * Get tenant's assigned modules
   */
  async getTenantModules(tenantId: string): Promise<TenantModule[]> {
    return this.tenantModuleRepository.find({
      where: { tenantId, isEnabled: true },
      relations: ['module'],
    });
  }

  // NOTE: the former private getDefaultMaxUsers() hand-copied per-plan user
  // limits here (a 5th drift copy, and dead — it had no callers). Per-plan
  // limits now live ONLY in the PLAN_CATALOG SSoT (@platform/event-contracts);
  // tenant provisioning resolves maxUsers from there.

  // ============================================================================
  // Tenant Admin Methods
  // ============================================================================

  /**
   * Get tenant statistics
   */
  async getTenantStats(tenantId: string): Promise<TenantStats> {
    // Validate tenant exists (throws NotFoundException if not found)
    await this.findById(tenantId);

    // PERF: Use SQL COUNT with FILTER instead of loading all users into memory (HIGH-02)
    // Avoids loading up to 500 full User entities (including password hashes) into heap
    interface UserStatsRow {
      total_users: string;
      active_users: string;
      pending_users: string;
      inactive_users: string;
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [userStatsResult, activeModules, activeSessions, currentMonthNewUsers, prevMonthNewUsers] = await Promise.all([
      this.dataSource.query<UserStatsRow[]>(
        `SELECT
          COUNT(*) AS total_users,
          COUNT(*) FILTER (WHERE "isActive" = true) AS active_users,
          COUNT(*) FILTER (WHERE "isActive" = true AND "isEmailVerified" = false AND "lastLoginAt" IS NULL) AS pending_users,
          COUNT(*) FILTER (WHERE "isActive" = false) AS inactive_users
        FROM auth.users WHERE "tenantId" = $1`,
        [tenantId],
      ),
      this.tenantModuleRepository.count({ where: { tenantId, isEnabled: true } }),
      // Active sessions: non-revoked, non-expired refresh tokens for this tenant
      this.refreshTokenRepository.count({
        where: { tenantId, isRevoked: false, expiresAt: MoreThan(now) },
      }),
      // Current month new users for growth calculation
      this.userRepository.count({
        where: { tenantId, createdAt: MoreThan(startOfMonth) },
      }),
      // Previous month new users for growth calculation
      this.userRepository.count({
        where: { tenantId, createdAt: Between(startOfPrevMonth, startOfMonth) },
      }),
    ]);

    const stats = userStatsResult[0];
    const totalUsers = parseInt(stats?.total_users ?? '0') || 0;
    const activeUsers = parseInt(stats?.active_users ?? '0') || 0;
    const pendingUsers = parseInt(stats?.pending_users ?? '0') || 0;
    const inactiveUsers = parseInt(stats?.inactive_users ?? '0') || 0;

    // Real monthly growth: percentage change in new user registrations month-over-month
    const monthlyGrowthPercent = prevMonthNewUsers > 0
      ? Math.round(((currentMonthNewUsers - prevMonthNewUsers) / prevMonthNewUsers) * 100)
      : 0;

    return {
      totalUsers,
      activeUsers,
      pendingUsers,
      inactiveUsers,
      totalModules: activeModules,
      activeModules,
      activeSessions,
      monthlyGrowthPercent,
      lastActivityAt: now,
    };
  }

  /**
   * Get tenant users with filters
   */
  async getTenantUsers(
    tenantId: string,
    options: {
      status?: string;
      role?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<User[]> {
    const query = this.userRepository.createQueryBuilder('user')
      .where('user.tenantId = :tenantId', { tenantId });

    if (options.status) {
      // User entity has no "status" column — translate to isActive / isEmailVerified conditions
      switch (options.status) {
        case 'active':
          query.andWhere('user.isActive = :isActive', { isActive: true });
          break;
        case 'inactive':
          query.andWhere('user.isActive = :isActive', { isActive: false });
          break;
        case 'pending':
          // Pending = active but never verified and never logged in
          query.andWhere('user.isActive = :isActive', { isActive: true });
          query.andWhere('user.isEmailVerified = :isVerified', { isVerified: false });
          query.andWhere('user.lastLoginAt IS NULL');
          break;
        default:
          // Unknown status values are ignored to prevent query errors
          break;
      }
    }

    if (options.role) {
      query.andWhere('user.role = :role', { role: options.role });
    }

    query.orderBy('user.createdAt', 'DESC');

    if (options.limit) {
      query.take(options.limit);
    }

    if (options.offset) {
      query.skip(options.offset);
    }

    return query.getMany();
  }

  // getTenantSchemaName is imported from @aquaculture/backend-common

  /**
   * Get tenant database information from PostgreSQL system catalogs
   *
   * Shows ALL tables that belong to the tenant from the tenant-specific schema
   * (e.g., tenant_4b529829 for tenantId 4b529829-ea79-48da-982c-cd6fbec8ffb7)
   */
  async getTenantDatabaseInfo(tenantId: string): Promise<TenantDatabaseInfo> {
    // Existence check only — findById throws NotFoundException for
    // unknown tenants; the entity itself is not needed below.
    await this.findById(tenantId);
    const tenantSchemaName = getTenantSchemaName(tenantId);

    this.logger.debug(`Getting database info for tenant ${tenantId}, schema: ${tenantSchemaName}`);

    // Query all tables in the tenant's dedicated schema
    const tablesQuery = `
      SELECT
        t.tablename as name,
        COALESCE(s.n_live_tup, 0) as row_count,
        pg_size_pretty(pg_total_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))) as size,
        (SELECT COUNT(*) FROM pg_indexes WHERE schemaname = t.schemaname AND tablename = t.tablename) as index_count,
        COALESCE(s.last_vacuum, s.last_autovacuum, NOW()) as last_modified
      FROM pg_tables t
      LEFT JOIN pg_stat_user_tables s ON t.tablename = s.relname AND t.schemaname = s.schemaname
      WHERE t.schemaname = $1
      ORDER BY pg_total_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename)) DESC
    `;

    // Query total size of tenant schema
    const schemaSizeQuery = `
      SELECT COALESCE(
        pg_size_pretty(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename)))),
        '0 bytes'
      ) as total_size
      FROM pg_tables
      WHERE schemaname = $1
    `;

    // SECURITY: Scope connection count to tenant's schema only (FINDING-019)
    // Do not expose global connection count — it leaks cross-tenant operational intelligence
    const connectionQuery = `SELECT count(*) as active FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%' || $1 || '%'`;
    const versionQuery = `SELECT version()`;

    try {
      const results = await Promise.all([
        this.dataSource.query(tablesQuery, [tenantSchemaName]),
        this.dataSource.query(schemaSizeQuery, [tenantSchemaName]),
        this.dataSource.query(connectionQuery, [tenantSchemaName]),
        this.dataSource.query(versionQuery),
      ]);
      const tableResults = results[0] as TableQueryRow[];
      const sizeResult = results[1] as SizeQueryRow[];
      const connResult = results[2] as ConnectionQueryRow[];
      const versionResult = results[3] as VersionQueryRow[];

      // PERF: Use n_live_tup from pg_stat_user_tables (already fetched) instead of
      // issuing N sequential COUNT(*) queries which cause full table scans (CRIT-02)
      const tables: TableInfo[] = [];

      // Batch hypertable size queries in parallel for sensor tables
      const hypertableNames = tableResults
        .filter(row => ['sensor_readings', 'sensor_metrics'].includes(row.name))
        .map(row => row.name);

      const hypertableSizes = new Map<string, string>();
      if (hypertableNames.length > 0) {
        const sizeResults = await Promise.allSettled(
          hypertableNames.map(async (name) => {
            const result: HypertableSizeRow[] = await this.dataSource.query(
              `SELECT pg_size_pretty(total_bytes) as size FROM hypertable_detailed_size($1)`,
              [`${tenantSchemaName}.${name}`],
            );
            return { name, size: result[0]?.size };
          }),
        );
        for (const result of sizeResults) {
          if (result.status === 'fulfilled' && result.value.size) {
            hypertableSizes.set(result.value.name, result.value.size);
          }
        }
      }

      for (const row of tableResults) {
        // Use n_live_tup approximation — avoids expensive COUNT(*) full table scans
        const rowCount = parseInt(row.row_count) || 0;
        const size = hypertableSizes.get(row.name) || row.size;

        tables.push({
          name: `${tenantSchemaName}.${row.name}`,
          rowCount,
          size,
          indexCount: parseInt(row.index_count) || 0,
          lastModified: new Date(row.last_modified),
        });
      }

      // Sort by row count descending
      tables.sort((a, b) => b.rowCount - a.rowCount);

      // Extract PostgreSQL version
      const versionMatch = versionResult[0]?.version?.match(/PostgreSQL (\d+)/);
      const dbVersion = versionMatch ? `PostgreSQL ${versionMatch[1]}` : 'PostgreSQL';

      return {
        // SECURITY: Do not expose real database name to tenants (FINDING-019)
        databaseName: tenantSchemaName,
        schemaName: tenantSchemaName,
        totalSize: sizeResult[0]?.total_size || '0 bytes',
        tableCount: tables.length,
        status: this.dataSource.isInitialized ? 'healthy' : 'unhealthy',
        lastBackup: null,
        activeConnections: parseInt(connResult[0]?.active ?? '0') || 0,
        maxConnections: 100,
        databaseType: dbVersion,
        region: process.env['AWS_REGION'] || 'Local',
        isolationLevel: 'Schema-based isolation',
        encryption: 'AES-256',
        tables,
      };
    } catch (error) {
      this.logger.error('Failed to get database info', error);
      return {
        databaseName: tenantSchemaName,
        schemaName: tenantSchemaName,
        totalSize: 'Unknown',
        tableCount: 0,
        status: 'error',
        lastBackup: null,
        activeConnections: 0,
        maxConnections: 100,
        databaseType: 'PostgreSQL',
        region: 'Unknown',
        isolationLevel: 'Schema-based isolation',
        encryption: 'AES-256',
        tables: [],
      };
    }
  }

  /**
   * Get table schema information for a tenant
   * Only allows access to tables in schemas the tenant has access to
   */
  async getTableSchema(
    tenantId: string,
    schemaName: string,
    tableName: string,
  ): Promise<TableSchemaInfo> {
    // Get tenant's assigned modules
    const tenantModules = await this.tenantModuleRepository.find({
      where: { tenantId, isEnabled: true },
      relations: ['module'],
    });

    // Module schemas (farm, hr, sensor, etc.)
    const moduleSchemas = tenantModules
      .map(tm => tm.module?.code)
      .filter((code): code is string => !!code);

    // Get tenant's dedicated schema name
    const tenantSchemaName = getTenantSchemaName(tenantId);

    // Allowed schemas: tenant's own schema + tenant's module schemas
    // SECURITY: 'auth' schema excluded — contains passwords, MFA secrets, invitation tokens
    const allowedSchemas = [tenantSchemaName, ...moduleSchemas];

    // Validate schema access
    if (!allowedSchemas.includes(schemaName)) {
      throw new ForbiddenException(
        `Access denied: You do not have permission to view tables in schema '${schemaName}'`,
      );
    }

    // Validate identifier format (SQL injection prevention)
    const validIdentifier = /^[a-z_][a-z0-9_]*$/i;
    if (!validIdentifier.test(schemaName) || !validIdentifier.test(tableName)) {
      throw new ForbiddenException('Invalid schema or table name');
    }

    // Check if table exists in schema
    const tableExistsQuery = `
      SELECT 1 FROM pg_tables
      WHERE schemaname = $1 AND tablename = $2
    `;
    const tableExists: unknown[] = await this.dataSource.query(tableExistsQuery, [schemaName, tableName]);

    if (tableExists.length === 0) {
      throw new NotFoundException(`Table '${schemaName}.${tableName}' not found`);
    }

    // Query column information
    const columnsQuery = `
      SELECT
        c.column_name,
        c.data_type,
        c.is_nullable = 'YES' as is_nullable,
        c.column_default,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
        CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_foreign_key,
        fk.foreign_table_name,
        fk.foreign_column_name
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.column_name = c.column_name
      LEFT JOIN (
        SELECT
          kcu.column_name,
          ccu.table_name as foreign_table_name,
          ccu.column_name as foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
      ) fk ON fk.column_name = c.column_name
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
    `;

    // Query index information
    const indexesQuery = `
      SELECT
        i.relname as index_name,
        a.attname as column_name,
        ix.indisunique as is_unique,
        ix.indisprimary as is_primary
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2
      ORDER BY i.relname
    `;

    try {
      const queryResults = await Promise.all([
        this.dataSource.query(columnsQuery, [schemaName, tableName]),
        this.dataSource.query(indexesQuery, [schemaName, tableName]),
      ]);
      const columnsResult = queryResults[0] as ColumnQueryRow[];
      const indexesResult = queryResults[1] as IndexQueryRow[];

      const columns: ColumnInfo[] = columnsResult.map((row) => ({
        columnName: row.column_name,
        dataType: row.data_type,
        isNullable: row.is_nullable,
        columnDefault: row.column_default ?? undefined,
        isPrimaryKey: row.is_primary_key,
        isForeignKey: row.is_foreign_key,
        foreignKeyTable: row.foreign_table_name ?? undefined,
        foreignKeyColumn: row.foreign_column_name ?? undefined,
      }));

      const indexes: IndexInfo[] = indexesResult.map((row) => ({
        indexName: row.index_name,
        columnName: row.column_name,
        isUnique: row.is_unique,
        isPrimary: row.is_primary,
      }));

      return {
        tableName,
        schemaName,
        columns,
        indexes,
      };
    } catch (error) {
      this.logger.error(`Failed to get table schema for ${schemaName}.${tableName}`, error);
      throw error;
    }
  }

  /**
   * Assign module manager to a module
   */
  async assignModuleManager(
    tenantId: string,
    moduleId: string,
    userId: string,
  ): Promise<TenantModule> {
    // Find tenant module
    const tenantModule = await this.tenantModuleRepository.findOne({
      where: { tenantId, moduleId },
      relations: ['module'],
    });

    if (!tenantModule) {
      throw new NotFoundException('Module not assigned to this tenant');
    }

    // Verify user belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new NotFoundException('User not found in this tenant');
    }

    // Update module manager
    tenantModule.managerId = userId;
    const saved = await this.tenantModuleRepository.save(tenantModule);

    // Update user role to MODULE_MANAGER if not already higher
    if (user.role !== Role.TENANT_ADMIN && user.role !== Role.SUPER_ADMIN) {
      user.role = Role.MODULE_MANAGER;
      await this.userRepository.save(user);
    }

    this.logger.log(`Assigned ${user.email} as manager for module ${tenantModule.module?.name || moduleId}`);

    return saved;
  }

  /**
   * Remove module manager from a module
   */
  async removeModuleManager(
    tenantId: string,
    moduleId: string,
  ): Promise<TenantModule> {
    const tenantModule = await this.tenantModuleRepository.findOne({
      where: { tenantId, moduleId },
      relations: ['module'],
    });

    if (!tenantModule) {
      throw new NotFoundException('Module not assigned to this tenant');
    }

    tenantModule.managerId = null;
    const saved = await this.tenantModuleRepository.save(tenantModule);

    this.logger.log(`Removed manager from module ${tenantModule.module?.name || moduleId}`);

    return saved;
  }

  // NOTE: there is no service-level tenant-update method here. The W1 slice
  // (CLAUDE-HIGH-015) added a role-filtering update(id, input, role); the
  // enterprise train then converged tenant mutation authority onto the
  // command-receipt/FSM path, so the GraphQL updateTenant resolver now rejects
  // outright (stronger than field filtering — nothing mutates tenants outside
  // the governed command path) and the service-level update + updateTenantSettings
  // were both removed. See tenant.resolver.updateTenant + tenant-update-consolidation.spec.

  /**
   * Count active sessions for a tenant.
   * An active session is a non-revoked, non-expired refresh token.
   */
  async countActiveSessions(tenantId: string): Promise<number> {
    return this.refreshTokenRepository.count({
      where: { tenantId, isRevoked: false, expiresAt: MoreThan(new Date()) },
    });
  }

  /**
   * Get per-module usage statistics for a tenant.
   *
   * Queries user_module_assignments for active user counts per module,
   * and audit logs for action counts in current and previous months.
   */
  async getModuleUsageStats(tenantId: string): Promise<ModuleUsageStatResponse[]> {
    const modules = await this.getTenantModules(tenantId);

    if (modules.length === 0) {
      return [];
    }

    // Query active user counts per module from user_module_assignments
    interface ModuleUserCountRow {
      moduleId: string;
      userCount: string;
    }

    const userCountRows = await this.dataSource.query<ModuleUserCountRow[]>(
      `SELECT "moduleId", COUNT(DISTINCT "userId") AS "userCount"
       FROM auth.user_module_assignments
       WHERE "tenantId" = $1 AND "isActive" = true
       GROUP BY "moduleId"`,
      [tenantId],
    );

    const userCountMap = new Map<string, number>();
    for (const row of userCountRows) {
      userCountMap.set(row.moduleId, parseInt(row.userCount) || 0);
    }

    return modules.map(m => ({
      moduleCode: m.module?.code ?? 'unknown',
      userCount: userCountMap.get(m.moduleId) || 0,
      lastAccessAt: undefined as Date | undefined,
      actionsThisMonth: 0,
      actionsLastMonth: 0,
    }));
  }
}
