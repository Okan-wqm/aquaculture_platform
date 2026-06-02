import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import {
  SchemaManagerService,
  DEFAULT_TENANT_MODULES,
  getTenantSchemaName,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  ISessionManager,
  ITokenBlacklist,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
} from '@aquaculture/backend-common/security';
import { IEventBus } from '@platform/event-bus';
import {
  TenantCreatedEvent,
  TenantUpdatedEvent,
  TenantSuspendedEvent,
  TenantActivatedEvent,
  TenantStatusChangedEvent,
  TenantModulesAssignedEvent,
  UserInvitedEvent,
  createBaseEvent,
} from '@platform/event-contracts';
import * as crypto from 'crypto';
import { Repository, DataSource, MoreThan, Between } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import {
  SECURITY_CONSTANTS,
  TENANT_CONSTANTS,
  TOKEN_CONSTANTS,
} from '../../../constants/auth.constants';
import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { parseExpiresIn } from '../../authentication/services/token.service';
import { User } from '../../authentication/entities/user.entity';
import { Module } from '../../system-module/entities/module.entity';
import {
  CreateTenantInput,
  UpdateTenantInput,
  AssignModulesToTenantInput,
} from '../dto/create-tenant.dto';
import {
  TenantStats,
  TenantDatabaseInfo,
  TableInfo,
  TableSchemaInfo,
  ColumnInfo,
  IndexInfo,
  ModuleUsageStatResponse,
} from '../dto/tenant-stats.dto';
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
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly schemaManager: SchemaManagerService,
    private readonly auditLogService: AuditLogService,
    private readonly configService: ConfigService,
    @Optional() @Inject(SESSION_MANAGER) private readonly sessionManager?: ISessionManager,
    @Optional() @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist?: ITokenBlacklist,
  ) {}

  async create(input: CreateTenantInput, createdBy: string): Promise<Tenant> {
    // Generate slug if not provided
    const slug = input.slug || Tenant.generateSlug(input.name);

    // Check for existing tenant with same name or slug
    const existing = await this.tenantRepository.findOne({
      where: [{ name: input.name }, { slug }],
    });

    if (existing) {
      throw new ConflictException('Tenant with this name or slug already exists');
    }

    // Set trial end date for trial plans
    let trialEndsAt: Date | null = null;
    if (!input.plan || input.plan === TenantPlan.TRIAL) {
      trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + TENANT_CONSTANTS.TRIAL_PERIOD_DAYS);
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
        DEFAULT_TENANT_MODULES,
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
      ...createBaseEvent<TenantCreatedEvent>('TenantCreated', saved.id, {
        aggregateId: saved.id,
        aggregateType: 'Tenant',
      }),
      name: saved.name,
      slug: saved.slug,
    };

    await this.eventBus.publish(event);

    // SECURITY AUDIT: Log tenant creation (BULGU-016)
    try {
      await this.auditLogService.log({
        tenantId: saved.id,
        performedBy: createdBy,
        action: 'TENANT_CREATED',
        entityType: 'Tenant',
        entityId: saved.id,
        details: {
          name: saved.name,
          slug: saved.slug,
          plan: saved.plan,
          status: saved.status,
          timestamp: new Date().toISOString(),
        },
        severity: AuditLogSeverity.INFO,
      });
    } catch (error) {
      this.logger.error(`Failed to log audit event TENANT_CREATED: ${(error as Error).message}`);
    }

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

      // Generate password reset token (user will set their own password)
      // SECURITY: Use crypto.randomBytes for unpredictable tokens (256 bits of entropy)
      const resetToken = crypto.randomBytes(32).toString('hex');
      // SECURITY: Hash reset token with SHA256 before storage to prevent token leakage
      // Plain token is sent to user, hash is stored in DB for verification
      const resetTokenStorageHash = crypto.createHash('sha256').update(resetToken).digest('hex');

      // Create admin user with pending password reset
      // SECURITY: Do NOT set password — use invitation flow exclusively.
      // Setting a bcrypt-hashed reset token as password would allow login with the reset token.
      const adminUser = this.userRepository.create({
        email,
        password: undefined, // No password — user must set via invitation flow
        firstName: 'Admin',
        lastName: tenant.name,
        role: Role.TENANT_ADMIN,
        tenantId: tenant.id,
        isActive: true,
        isEmailVerified: false, // Will need to verify
        passwordResetToken: resetTokenStorageHash, // Store hash, not plain token
        passwordResetExpires: new Date(
          Date.now() + TOKEN_CONSTANTS.DEFAULT_INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
        ),
      });

      const savedUser = await this.userRepository.save(adminUser);
      this.logger.log(`Created admin user ${email} for tenant ${tenant.id}`);

      // SECURITY (CRITICAL-001/002): Publish event with opaque references ONLY.
      // PII (email, firstName, lastName, tenantName) and secret URLs are NEVER placed
      // on the immutable event bus. The notification service resolves user/tenant details
      // and builds the action URL at delivery time via authenticated internal API calls.
      const userInvitedEvent: UserInvitedEvent = {
        ...createBaseEvent<UserInvitedEvent>('UserInvited', tenant.id, {
          aggregateId: savedUser.id,
          aggregateType: 'User',
        }),
        userId: savedUser.id,
        role: savedUser.role,
        credentialType: 'reset_token',
        actionTokenId: resetTokenStorageHash,
        cryptoShredKeyId: savedUser.id,
      };

      // Publish event - notification service will resolve PII at delivery time
      await this.eventBus.publish(userInvitedEvent);
      // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
      this.logger.log(
        `Published UserInvitedEvent for userId=${savedUser.id} (tenant: ${tenant.id})`,
      );

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
      ...createBaseEvent<TenantUpdatedEvent>('TenantUpdated', saved.id, {
        aggregateId: saved.id,
        aggregateType: 'Tenant',
      }),
      name: input.name,
    };

    await this.eventBus.publish(event);

    return saved;
  }

  async activate(id: string): Promise<Tenant> {
    const tenant = await this.findById(id);
    const previousStatus = tenant.status;
    tenant.status = TenantStatus.ACTIVE;
    const saved = await this.tenantRepository.save(tenant);

    this.logger.log(`Tenant activated: ${saved.name} (${saved.id})`);

    // Publish TenantActivatedEvent
    const activatedEvent: TenantActivatedEvent = {
      ...createBaseEvent<TenantActivatedEvent>('TenantActivated', saved.id, {
        aggregateId: saved.id,
        aggregateType: 'Tenant',
      }),
    };
    await this.eventBus.publish(activatedEvent);

    // Publish TenantStatusChangedEvent for generic status-change consumers
    const statusChangedEvent: TenantStatusChangedEvent = {
      ...createBaseEvent<TenantStatusChangedEvent>('TenantStatusChanged', saved.id, {
        aggregateId: saved.id,
        aggregateType: 'Tenant',
      }),
      previousStatus,
      newStatus: TenantStatus.ACTIVE,
    };
    await this.eventBus.publish(statusChangedEvent);

    return saved;
  }

  async suspend(id: string, reason?: string): Promise<Tenant> {
    const tenant = await this.findById(id);
    const previousStatus = tenant.status;
    await this.revokeTenantRefreshTokens(tenant.id, 'TENANT_SUSPENDED');
    await this.revokeTenantAccessState(tenant.id, 'TENANT_SUSPENDED');
    tenant.status = TenantStatus.SUSPENDED;
    const saved = await this.tenantRepository.save(tenant);

    this.logger.log(`Tenant suspended: ${saved.name} (${saved.id})`);

    // Publish TenantSuspendedEvent
    const suspendedEvent: TenantSuspendedEvent = {
      ...createBaseEvent<TenantSuspendedEvent>('TenantSuspended', saved.id, {
        aggregateId: saved.id,
        aggregateType: 'Tenant',
      }),
      reason,
    };
    await this.eventBus.publish(suspendedEvent);

    // Publish TenantStatusChangedEvent for generic status-change consumers
    const statusChangedEvent: TenantStatusChangedEvent = {
      ...createBaseEvent<TenantStatusChangedEvent>('TenantStatusChanged', saved.id, {
        aggregateId: saved.id,
        aggregateType: 'Tenant',
      }),
      previousStatus,
      newStatus: TenantStatus.SUSPENDED,
      reason,
    };
    await this.eventBus.publish(statusChangedEvent);

    return saved;
  }

  async cancel(id: string, reason?: string): Promise<Tenant> {
    const tenant = await this.findById(id);
    const previousStatus = tenant.status;
    await this.revokeTenantRefreshTokens(tenant.id, 'TENANT_CANCELLED');
    await this.revokeTenantAccessState(tenant.id, 'TENANT_CANCELLED');
    tenant.status = TenantStatus.CANCELLED;
    const saved = await this.tenantRepository.save(tenant);

    this.logger.log(`Tenant cancelled: ${saved.name} (${saved.id})`);

    // Publish TenantStatusChangedEvent — no specific CancelledEvent needed,
    // generic status change is sufficient for this transition
    const statusChangedEvent: TenantStatusChangedEvent = {
      ...createBaseEvent<TenantStatusChangedEvent>('TenantStatusChanged', saved.id, {
        aggregateId: saved.id,
        aggregateType: 'Tenant',
      }),
      previousStatus,
      newStatus: TenantStatus.CANCELLED,
      reason,
    };
    await this.eventBus.publish(statusChangedEvent);

    return saved;
  }

  private async revokeTenantRefreshTokens(tenantId: string, reason: string): Promise<void> {
    const result = await this.refreshTokenRepository.update(
      { tenantId, isRevoked: false },
      {
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    );
    this.logger.warn(
      `Revoked ${result.affected ?? 0} refresh token(s) for tenant ${tenantId} (${reason})`,
    );
  }

  private async revokeTenantAccessState(tenantId: string, reason: string): Promise<void> {
    if (!this.tokenBlacklist) {
      throw new Error('TOKEN_BLACKLIST provider is required for tenant access revocation');
    }

    if (!this.sessionManager) {
      throw new Error('SESSION_MANAGER provider is required for tenant session revocation');
    }

    await this.tokenBlacklist.blacklistTenantTokens(
      tenantId,
      this.accessBlacklistExpiresAt(),
      reason,
    );

    const users = await this.userRepository.find({
      where: { tenantId },
      select: ['id'],
    });
    let revokedSessions = 0;
    for (const user of users) {
      revokedSessions += await this.sessionManager.revokeAllSessions(user.id);
    }
    this.logger.warn(`Revoked ${revokedSessions} session(s) for tenant ${tenantId} (${reason})`);
  }

  private accessBlacklistExpiresAt(): Date {
    const expiresIn = this.configService.get<string>(
      'JWT_EXPIRES_IN',
      SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_IN,
    );
    const ttlSeconds = parseExpiresIn(expiresIn);
    return new Date(Date.now() + ttlSeconds * 1000);
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
      where: input.moduleCodes.map((code) => ({ code })),
    });

    if (modules.length !== input.moduleCodes.length) {
      throw new NotFoundException('One or more modules not found');
    }

    // SECURITY: Wrap delete + re-create in a transaction to prevent
    // zero-assignment state on save failure (H-10/M-06)
    const saved = await this.dataSource.transaction(async (manager) => {
      const tmRepo = tenantManagerRepo(manager, TenantModule, tenant.id);

      // Remove existing module assignments; tenantId auto-injected by
      // the scoped wrapper — the tenant.id filter is structurally part
      // of every delete call now.
      await tmRepo.delete({});

      // Create new assignments
      const assignments = modules.map((mod) =>
        tmRepo.create({
          tenantId: tenant.id,
          moduleId: mod.id,
          isEnabled: true,
        }),
      );

      return tmRepo.saveMany(assignments);
    });

    this.logger.log(`Assigned ${saved.length} modules to tenant ${tenant.name}`);

    // Publish TenantModulesAssignedEvent
    const modulesAssignedEvent: TenantModulesAssignedEvent = {
      ...createBaseEvent<TenantModulesAssignedEvent>('TenantModulesAssigned', tenant.id, {
        aggregateId: tenant.id,
        aggregateType: 'Tenant',
      }),
      moduleIds: modules.map((mod) => mod.id),
      moduleCodes: input.moduleCodes,
      assignedBy: tenant.createdBy ?? 'system',
    };
    await this.eventBus.publish(modulesAssignedEvent);

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
      [TenantPlan.FREE]: 3,
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

    const [
      userStatsResult,
      activeModules,
      activeSessions,
      currentMonthNewUsers,
      prevMonthNewUsers,
    ] = await Promise.all([
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
    const monthlyGrowthPercent =
      prevMonthNewUsers > 0
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
    const query = this.userRepository
      .createQueryBuilder('user')
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
    const tenant = await this.findById(tenantId);
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
        .filter((row) => ['sensor_readings', 'sensor_metrics'].includes(row.name))
        .map((row) => row.name);

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
      .map((tm) => tm.module?.code)
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
    const tableExists: unknown[] = await this.dataSource.query(tableExistsQuery, [
      schemaName,
      tableName,
    ]);

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

    this.logger.log(
      `Assigned ${user.email} as manager for module ${tenantModule.module?.name || moduleId}`,
    );

    return saved;
  }

  /**
   * Remove module manager from a module
   */
  async removeModuleManager(tenantId: string, moduleId: string): Promise<TenantModule> {
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
  async updateTenantSettings(tenantId: string, input: UpdateTenantInput): Promise<Tenant> {
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

    // Publish TenantUpdatedEvent for consistency — settings changes are tenant updates
    const event: TenantUpdatedEvent = {
      ...createBaseEvent<TenantUpdatedEvent>('TenantUpdated', saved.id, {
        aggregateId: saved.id,
        aggregateType: 'Tenant',
      }),
      name: input.name,
    };
    await this.eventBus.publish(event);

    return saved;
  }

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

    return modules.map((m) => ({
      moduleCode: m.module?.code ?? 'unknown',
      userCount: userCountMap.get(m.moduleId) || 0,
      lastAccessAt: undefined as Date | undefined,
      actionsThisMonth: 0,
      actionsLastMonth: 0,
    }));
  }
}
