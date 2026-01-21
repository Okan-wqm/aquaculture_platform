import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Role, SchemaManagerService } from '@platform/backend-common';
import { IEventBus } from '@platform/event-bus';
import { TenantCreatedEvent, TenantUpdatedEvent } from '@platform/event-contracts';
import * as bcrypt from 'bcryptjs';
import { Repository, In, DataSource } from 'typeorm';

import { User } from '../../authentication/entities/user.entity';
import { Module } from '../../system-module/entities/module.entity';
import { CreateTenantInput, UpdateTenantInput, AssignModulesToTenantInput } from '../dto/create-tenant.dto';
import { TenantStats, TenantDatabaseInfo, TableInfo, TableSchemaInfo, ColumnInfo, IndexInfo } from '../dto/tenant-stats.dto';
import { TenantModule } from '../entities/tenant-module.entity';
import { Tenant, TenantStatus, TenantPlan } from '../entities/tenant.entity';

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
 * Raw database row for count query
 */
interface CountQueryRow {
  cnt: string;
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
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly schemaManager: SchemaManagerService,
  ) {}

  async create(input: CreateTenantInput, createdBy: string): Promise<Tenant> {
    // Generate slug if not provided
    const slug = input.slug || Tenant.generateSlug(input.name);

    // Check for existing tenant with same name or slug
    const existing = await this.tenantRepository.findOne({
      where: [{ name: input.name }, { slug }],
    });

    if (existing) {
      throw new ConflictException(
        'Tenant with this name or slug already exists',
      );
    }

    // Set trial end date for trial plans
    let trialEndsAt: Date | null = null;
    if (!input.plan || input.plan === TenantPlan.TRIAL) {
      trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 14); // 14 day trial
    }

    const tenant = this.tenantRepository.create({
      name: input.name,
      slug,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone || null,
      description: input.description || null,
      address: input.address || null,
      taxId: input.taxId || null,
      plan: input.plan || TenantPlan.TRIAL,
      status: TenantStatus.PENDING,
      maxUsers: input.maxUsers || this.getDefaultMaxUsers(input.plan || TenantPlan.TRIAL),
      trialEndsAt,
      settings: input.settings || null,
      createdBy,
    });

    const saved = await this.tenantRepository.save(tenant);
    this.logger.log(`Tenant created: ${saved.name} (${saved.id})`);

    // ============================================================
    // SYNCHRONOUS PROVISIONING - Schema MUST exist before tenant is usable
    // ============================================================
    const provisionStartTime = Date.now();

    try {
      // Step 1: Create tenant schema with default modules
      this.logger.log(`Creating schema for tenant ${saved.id}...`);
      const schemaResult = await this.schemaManager.createTenantSchema(
        saved.id,
        ['sensor', 'farm', 'hr'], // Default modules
      );

      if (!schemaResult.success && !schemaResult.alreadyExists) {
        this.logger.error(`Schema creation failed for tenant ${saved.id}`, {
          errors: schemaResult.errors,
        });
        // Don't throw - tenant record exists but remains PENDING
      } else {
        this.logger.log(
          `Schema ${schemaResult.schemaName} created: ${schemaResult.tablesCreated.length} tables in ${schemaResult.duration}ms`,
        );

        // Step 2: Create admin user if contactEmail provided
        if (input.contactEmail) {
          await this.createTenantAdminUser(saved, input.contactEmail);
        }

        // Step 3: Update tenant status to ACTIVE
        saved.status = TenantStatus.ACTIVE;
        await this.tenantRepository.save(saved);
        this.logger.log(`Tenant ${saved.id} activated successfully`);
      }

    } catch (provisionError) {
      const duration = Date.now() - provisionStartTime;
      this.logger.error(
        `Provisioning error for tenant ${saved.id} after ${duration}ms: ${(provisionError as Error).message}`,
        (provisionError as Error).stack,
      );
      // Tenant remains PENDING - manual intervention may be needed
    }

    // Publish event
    const event: TenantCreatedEvent = {
      eventId: crypto.randomUUID(),
      eventType: 'TenantCreated',
      timestamp: new Date(),
      tenantId: saved.id,
      name: saved.name,
      slug: saved.slug,
    };

    await this.eventBus.publish(event);

    return saved;
  }

  /**
   * Create admin user for a new tenant
   */
  private async createTenantAdminUser(tenant: Tenant, email: string): Promise<User | null> {
    try {
      // Check if user already exists
      const existingUser = await this.userRepository.findOne({
        where: { email, tenantId: tenant.id },
      });

      if (existingUser) {
        this.logger.log(`Admin user ${email} already exists for tenant ${tenant.id}`);
        return existingUser;
      }

      // Generate temporary password (user will need to reset)
      const tempPassword = crypto.randomUUID().substring(0, 12);
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      // Create admin user
      const adminUser = this.userRepository.create({
        email,
        password: passwordHash,
        firstName: 'Admin',
        lastName: tenant.name,
        role: Role.TENANT_ADMIN,
        tenantId: tenant.id,
        isActive: true,
        isEmailVerified: false, // Will need to verify
      });

      const savedUser = await this.userRepository.save(adminUser);
      this.logger.log(`Created admin user ${email} for tenant ${tenant.id}`);

      // TODO: Send welcome email with password reset link
      // await this.emailService.sendWelcomeEmail(email, tempPassword, tenant.name);

      return savedUser;
    } catch (error) {
      this.logger.error(
        `Failed to create admin user for tenant ${tenant.id}: ${(error as Error).message}`,
      );
      return null;
    }
  }

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

  async update(id: string, input: UpdateTenantInput): Promise<Tenant> {
    const tenant = await this.findById(id);

    // Update max users if plan changes
    if (input.plan && input.plan !== tenant.plan) {
      if (!input.maxUsers) {
        input.maxUsers = this.getDefaultMaxUsers(input.plan);
      }
    }

    Object.assign(tenant, input);
    const saved = await this.tenantRepository.save(tenant);

    this.logger.log(`Tenant updated: ${saved.name} (${saved.id})`);

    // Publish event
    const event: TenantUpdatedEvent = {
      eventId: crypto.randomUUID(),
      eventType: 'TenantUpdated',
      timestamp: new Date(),
      tenantId: saved.id,
      name: input.name,
    };

    await this.eventBus.publish(event);

    return saved;
  }

  async activate(id: string): Promise<Tenant> {
    const tenant = await this.findById(id);
    tenant.status = TenantStatus.ACTIVE;
    const saved = await this.tenantRepository.save(tenant);

    this.logger.log(`Tenant activated: ${saved.name} (${saved.id})`);

    return saved;
  }

  async suspend(id: string): Promise<Tenant> {
    const tenant = await this.findById(id);
    tenant.status = TenantStatus.SUSPENDED;
    const saved = await this.tenantRepository.save(tenant);

    this.logger.log(`Tenant suspended: ${saved.name} (${saved.id})`);

    return saved;
  }

  async cancel(id: string): Promise<Tenant> {
    const tenant = await this.findById(id);
    tenant.status = TenantStatus.CANCELLED;
    const saved = await this.tenantRepository.save(tenant);

    this.logger.log(`Tenant cancelled: ${saved.name} (${saved.id})`);

    return saved;
  }

  /**
   * Assign modules to tenant
   */
  async assignModules(
    input: AssignModulesToTenantInput,
    moduleRepository: Repository<Module>,
  ): Promise<TenantModule[]> {
    const tenant = await this.findById(input.tenantId);

    // Find all modules by codes
    const modules = await moduleRepository.find({
      where: input.moduleCodes.map(code => ({ code })),
    });

    if (modules.length !== input.moduleCodes.length) {
      throw new NotFoundException('One or more modules not found');
    }

    // Remove existing module assignments
    await this.tenantModuleRepository.delete({ tenantId: tenant.id });

    // Create new assignments
    const assignments = modules.map(mod =>
      this.tenantModuleRepository.create({
        tenantId: tenant.id,
        moduleId: mod.id,
        isEnabled: true,
      }),
    );

    const saved = await this.tenantModuleRepository.save(assignments);
    this.logger.log(`Assigned ${saved.length} modules to tenant ${tenant.name}`);

    return saved;
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

  /**
   * Get default max users based on plan
   */
  private getDefaultMaxUsers(plan: TenantPlan): number {
    const defaults: Record<TenantPlan, number> = {
      [TenantPlan.TRIAL]: 5,
      [TenantPlan.STARTER]: 10,
      [TenantPlan.PROFESSIONAL]: 50,
      [TenantPlan.ENTERPRISE]: 500,
    };
    return defaults[plan] ?? 5;
  }

  // ============================================================================
  // Tenant Admin Methods
  // ============================================================================

  /**
   * Get tenant statistics
   */
  async getTenantStats(tenantId: string): Promise<TenantStats> {
    const tenant = await this.findById(tenantId);

    // Count users by status
    const [users, activeModules] = await Promise.all([
      this.userRepository.find({ where: { tenantId } }),
      this.tenantModuleRepository.count({ where: { tenantId, isEnabled: true } }),
    ]);

    const activeUsers = users.filter(u => u.isActive && !u.isPendingInvitation()).length;
    const pendingUsers = users.filter(u => u.isPendingInvitation()).length;
    const inactiveUsers = users.filter(u => !u.isActive).length;

    // Calculate monthly growth (simplified - would need historical data in production)
    const monthlyGrowthPercent = 15; // Placeholder

    return {
      totalUsers: users.length,
      activeUsers,
      pendingUsers,
      inactiveUsers,
      totalModules: activeModules,
      activeModules,
      activeSessions: activeUsers, // Simplified - would need session tracking
      monthlyGrowthPercent,
      lastActivityAt: new Date(),
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
      query.andWhere('user.status = :status', { status: options.status });
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

  /**
   * Generate tenant schema name from tenant ID
   * Format: tenant_{first8chars_of_uuid} (e.g., tenant_4b529829)
   * Must match SchemaManagerService.getTenantSchemaName
   */
  private getTenantSchemaName(tenantId: string): string {
    const cleanId = tenantId.replace(/-/g, '').substring(0, 8);
    return `tenant_${cleanId}`;
  }

  /**
   * Get tenant database information from PostgreSQL system catalogs
   *
   * Shows ALL tables that belong to the tenant from the tenant-specific schema
   * (e.g., tenant_4b529829 for tenantId 4b529829-ea79-48da-982c-cd6fbec8ffb7)
   */
  async getTenantDatabaseInfo(tenantId: string): Promise<TenantDatabaseInfo> {
    const tenant = await this.findById(tenantId);
    const tenantSchemaName = this.getTenantSchemaName(tenantId);

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

    const connectionQuery = `SELECT count(*) as active FROM pg_stat_activity WHERE state = 'active'`;
    const versionQuery = `SELECT version()`;

    try {
      const [tableResults, sizeResult, connResult, versionResult] = await Promise.all([
        this.dataSource.query(tablesQuery, [tenantSchemaName]) as Promise<TableQueryRow[]>,
        this.dataSource.query(schemaSizeQuery, [tenantSchemaName]) as Promise<SizeQueryRow[]>,
        this.dataSource.query(connectionQuery) as Promise<ConnectionQueryRow[]>,
        this.dataSource.query(versionQuery) as Promise<VersionQueryRow[]>,
      ]);

      // Get actual row counts for important tables (pg_stat may be stale)
      const tables: TableInfo[] = [];
      for (const row of tableResults) {
        let rowCount = parseInt(row.row_count) || 0;
        let size = row.size;

        // For time-series tables, get exact count
        if (['sensor_readings', 'sensor_metrics', 'sensors'].includes(row.name)) {
          try {
            const countResult = await this.dataSource.query(
              `SELECT COUNT(*) as cnt FROM "${tenantSchemaName}"."${row.name}"`
            ) as CountQueryRow[];
            rowCount = parseInt(countResult[0]?.cnt) || 0;
          } catch (err) {
            this.logger.debug(`Could not count ${row.name}: ${(err as Error).message}`);
          }
        }

        // For TimescaleDB hypertables, get proper size including chunks
        if (['sensor_readings', 'sensor_metrics'].includes(row.name)) {
          try {
            const hypertableSizeResult = await this.dataSource.query(
              `SELECT pg_size_pretty(total_bytes) as size
               FROM hypertable_detailed_size($1)`,
              [`${tenantSchemaName}.${row.name}`]
            ) as HypertableSizeRow[];
            if (hypertableSizeResult[0]?.size) {
              size = hypertableSizeResult[0].size;
            }
          } catch (err) {
            // Not a hypertable or TimescaleDB not available - use original size
            this.logger.debug(`Could not get hypertable size for ${row.name}: ${(err as Error).message}`);
          }
        }

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
        databaseName: this.dataSource.options.database as string,
        schemaName: tenantSchemaName,
        totalSize: sizeResult[0]?.total_size || '0 bytes',
        tableCount: tables.length,
        status: this.dataSource.isInitialized ? 'healthy' : 'unhealthy',
        lastBackup: null,
        activeConnections: parseInt(connResult[0]?.active) || 0,
        maxConnections: 100,
        databaseType: dbVersion,
        region: process.env.AWS_REGION || 'Local',
        isolationLevel: 'Schema-based isolation',
        encryption: 'AES-256',
        tables,
      };
    } catch (error) {
      this.logger.error('Failed to get database info', error);
      return {
        databaseName: `aquaculture_${tenant.slug}`,
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
    const tenantSchemaName = this.getTenantSchemaName(tenantId);

    // Allowed schemas: tenant's own schema + auth + tenant's module schemas
    const allowedSchemas = [tenantSchemaName, 'auth', ...moduleSchemas];

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
    const tableExists = await this.dataSource.query(tableExistsQuery, [schemaName, tableName]) as unknown[];

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
      const [columnsResult, indexesResult] = await Promise.all([
        this.dataSource.query(columnsQuery, [schemaName, tableName]) as Promise<ColumnQueryRow[]>,
        this.dataSource.query(indexesQuery, [schemaName, tableName]) as Promise<IndexQueryRow[]>,
      ]);

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

  /**
   * Update tenant settings (limited fields for TENANT_ADMIN)
   */
  async updateTenantSettings(
    tenantId: string,
    input: UpdateTenantInput,
  ): Promise<Tenant> {
    const tenant = await this.findById(tenantId);

    // Tenant admins can only update these fields
    const allowedFields: (keyof UpdateTenantInput)[] = [
      'name',
      'description',
      'logoUrl',
      'contactEmail',
      'contactPhone',
      'address',
      'settings',
    ];

    // Filter to allowed fields only
    const updates: Partial<Tenant> = {};
    for (const field of allowedFields) {
      if (input[field] !== undefined) {
        (updates as Record<string, unknown>)[field] = input[field];
      }
    }

    // Prevent updating restricted fields
    if (input.status || input.plan || input.maxUsers) {
      throw new ForbiddenException('Cannot update status, plan, or maxUsers. Contact support.');
    }

    Object.assign(tenant, updates);
    const saved = await this.tenantRepository.save(tenant);

    this.logger.log(`Tenant settings updated by tenant admin: ${saved.name} (${saved.id})`);

    return saved;
  }
}
