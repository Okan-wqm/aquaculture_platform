import { ForbiddenException, Logger } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType, Field } from '@nestjs/graphql';
import { CurrentUser, Public, SuperAdminOnly, TenantAdminOrHigher, Role } from '@aquaculture/backend-common';

import { User } from '../../authentication/entities/user.entity';
import { CreateTenantInput, UpdateTenantInput, AssignModuleManagerInput } from '../dto/create-tenant.dto';
import { TenantStats, TenantDatabaseInfo, TableSchemaInfo, AuditLogPage, TenantActivityResponse, ModuleUsageStatResponse } from '../dto/tenant-stats.dto';
import { TenantModule } from '../entities/tenant-module.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import { AuditLogService } from '../../../audit/audit-log.service';

/**
 * Minimal public tenant info exposed by the unauthenticated tenantBySlug query.
 * SECURITY: Does not expose plan, maxUsers, settings, contactEmail, etc.
 */
@ObjectType()
class TenantPublicInfo {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field(() => String, { nullable: true })
  logoUrl!: string | null;

  @Field(() => TenantStatus)
  status!: TenantStatus;
}
import { TenantService } from '../services/tenant.service';

@Resolver(() => Tenant)
export class TenantResolver {
  private readonly logger = new Logger(TenantResolver.name);

  constructor(
    private readonly tenantService: TenantService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @SuperAdminOnly()
  @Mutation(() => Tenant)
  async createTenant(
    @Args('input') input: CreateTenantInput,
    @Context() ctx: { req: { user: { id: string } } },
  ): Promise<Tenant> {
    return this.tenantService.create(input, ctx.req.user.id);
  }

  @SuperAdminOnly()
  @Query(() => [Tenant])
  async tenants(): Promise<Tenant[]> {
    return this.tenantService.findAll();
  }

  @TenantAdminOrHigher()
  @Query(() => Tenant)
  async tenant(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser('role') role: Role,
    @CurrentUser('tenantId') userTenantId: string | null,
  ): Promise<Tenant> {
    // SECURITY: Tenant isolation - TENANT_ADMIN can only access their own tenant
    if (role !== Role.SUPER_ADMIN && userTenantId !== id) {
      throw new ForbiddenException('Access denied: You can only access your own tenant');
    }
    return this.tenantService.findById(id);
  }

  @Public()
  @Query(() => TenantPublicInfo)
  async tenantBySlug(@Args('slug') slug: string): Promise<TenantPublicInfo> {
    const tenant = await this.tenantService.findBySlug(slug);
    // SECURITY: Only expose minimal public info — no plan, maxUsers, settings, etc.
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      logoUrl: tenant.logoUrl ?? null,
      status: tenant.status,
    };
  }

  @TenantAdminOrHigher()
  @Mutation(() => Tenant)
  async updateTenant(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateTenantInput,
    @CurrentUser('role') role: Role,
    @CurrentUser('tenantId') userTenantId: string | null,
  ): Promise<Tenant> {
    // SECURITY: Tenant isolation - TENANT_ADMIN can only update their own tenant
    if (role !== Role.SUPER_ADMIN && userTenantId !== id) {
      throw new ForbiddenException('Access denied: You can only update your own tenant');
    }
    // SECURITY: Role-based field filtering is handled inside TenantService.update()
    return this.tenantService.update(id, input);
  }

  @SuperAdminOnly()
  @Mutation(() => Tenant)
  async suspendTenant(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Tenant> {
    return this.tenantService.suspend(id);
  }

  @SuperAdminOnly()
  @Mutation(() => Tenant)
  async activateTenant(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Tenant> {
    return this.tenantService.activate(id);
  }

  @SuperAdminOnly()
  @Mutation(() => Tenant)
  async cancelTenant(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Tenant> {
    return this.tenantService.cancel(id);
  }

  // ============================================================================
  // Tenant Admin Specific Queries and Mutations
  // ============================================================================

  /**
   * Get current user's tenant (for TENANT_ADMIN)
   */
  @TenantAdminOrHigher()
  @Query(() => Tenant)
  async myTenant(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<Tenant> {
    return this.tenantService.findById(tenantId);
  }

  /**
   * Get tenant statistics (users, modules, activity)
   */
  @TenantAdminOrHigher()
  @Query(() => TenantStats)
  async tenantStats(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantStats> {
    return this.tenantService.getTenantStats(tenantId);
  }

  /**
   * Get tenant's assigned modules with details
   */
  @TenantAdminOrHigher()
  @Query(() => [TenantModule])
  async myTenantModules(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantModule[]> {
    return this.tenantService.getTenantModules(tenantId);
  }

  /**
   * Get users belonging to tenant
   */
  @TenantAdminOrHigher()
  @Query(() => [User])
  async tenantUsers(
    @CurrentUser('tenantId') tenantId: string,
    @Args('status', { nullable: true }) status?: string,
    @Args('role', { nullable: true }) role?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<User[]> {
    return this.tenantService.getTenantUsers(tenantId, { status, role, limit, offset });
  }

  /**
   * Get tenant database information (read-only view)
   */
  @TenantAdminOrHigher()
  @Query(() => TenantDatabaseInfo)
  async tenantDatabase(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantDatabaseInfo> {
    return this.tenantService.getTenantDatabaseInfo(tenantId);
  }

  /**
   * Get table schema information (columns, indexes)
   * Only returns schema for tables the tenant has access to
   */
  @TenantAdminOrHigher()
  @Query(() => TableSchemaInfo)
  async tableSchema(
    @Args('schemaName') schemaName: string,
    @Args('tableName') tableName: string,
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TableSchemaInfo> {
    return this.tenantService.getTableSchema(tenantId, schemaName, tableName);
  }

  /**
   * Assign module manager to a module
   */
  @TenantAdminOrHigher()
  @Mutation(() => TenantModule)
  async assignModuleManager(
    @Args('input') input: AssignModuleManagerInput,
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantModule> {
    return this.tenantService.assignModuleManager(
      tenantId,
      input.moduleId,
      input.userId,
    );
  }

  /**
   * Remove module manager from a module
   */
  @TenantAdminOrHigher()
  @Mutation(() => TenantModule)
  async removeModuleManager(
    @Args('moduleId', { type: () => ID }) moduleId: string,
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantModule> {
    return this.tenantService.removeModuleManager(tenantId, moduleId);
  }

  // NOTE: updateTenantSettings mutation removed — consolidated into updateTenant
  // which applies role-based field filtering via TenantService.update()

  // ============================================================================
  // Audit Log & Activity Queries
  // ============================================================================

  /**
   * Get tenant audit logs with filtering and pagination
   */
  @TenantAdminOrHigher()
  @Query(() => AuditLogPage)
  async tenantAuditLogs(
    @CurrentUser('tenantId') tenantId: string,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
    @Args('action', { nullable: true }) action?: string,
    @Args('severity', { nullable: true }) severity?: string,
    @Args('performedBy', { nullable: true }) performedBy?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<AuditLogPage> {
    const result = await this.auditLogService.findByTenant(tenantId, {
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      action: action ?? undefined,
      performedBy: performedBy ?? undefined,
      limit: limit ?? 20,
      offset: offset ?? 0,
    });
    return {
      data: result.data.map(log => ({
        ...log,
        performedByEmail: log.performedByEmail ?? undefined,
        entityId: log.entityId ?? undefined,
        details: log.details ?? undefined,
        ipAddress: log.ipAddress ?? undefined,
        userAgent: log.userAgent ?? undefined,
      })),
      total: result.total,
    };
  }

  /**
   * Get tenant activity data (logins, sessions, DAU)
   * Returns data derived from audit logs since dedicated login tracking is not yet implemented
   */
  @TenantAdminOrHigher()
  @Query(() => TenantActivityResponse)
  async tenantActivity(
    @CurrentUser('tenantId') tenantId: string,
    @Args('period', { nullable: true }) period?: string,
  ): Promise<TenantActivityResponse> {
    const days = period === '30d' ? 30 : 7;
    const since = new Date();
    since.setDate(since.getDate() - days);

    // Derive activity from audit logs
    const { data: logs } = await this.auditLogService.findByTenant(tenantId, {
      startDate: since,
      endDate: new Date(),
      limit: 500,
    });

    // Build recent logins from login-type audit entries
    const loginLogs = logs.filter(l => l.action?.toLowerCase().includes('login'));
    const recentLogins = loginLogs.slice(0, 50).map(l => ({
      id: l.id,
      userId: l.performedBy,
      email: l.performedByEmail ?? l.performedBy,
      firstName: undefined as string | undefined,
      lastName: undefined as string | undefined,
      loginAt: l.createdAt,
      ipAddress: l.ipAddress ?? undefined,
      userAgent: l.userAgent ?? undefined,
      deviceType: undefined as string | undefined,
      success: l.severity !== 'error',
    }));

    // Build user activity summaries
    const userMap = new Map<string, { email: string; actions: number; lastAt: Date | null; logins: number }>();
    for (const log of logs) {
      const key = log.performedBy;
      const existing = userMap.get(key);
      if (existing) {
        existing.actions++;
        if (!existing.lastAt || log.createdAt > existing.lastAt) existing.lastAt = log.createdAt;
        if (log.action?.toLowerCase().includes('login')) existing.logins++;
      } else {
        userMap.set(key, {
          email: log.performedByEmail ?? key,
          actions: 1,
          lastAt: log.createdAt,
          logins: log.action?.toLowerCase().includes('login') ? 1 : 0,
        });
      }
    }

    const userActivitySummaries = Array.from(userMap.entries()).map(([userId, data]) => ({
      userId,
      email: data.email,
      firstName: undefined as string | undefined,
      lastName: undefined as string | undefined,
      totalActions: data.actions,
      lastActiveAt: data.lastAt ?? undefined,
      loginCount: data.logins,
    }));

    // Build daily active users
    const dayMap = new Map<string, Set<string>>();
    for (const log of logs) {
      const dateKey = log.createdAt.toISOString().slice(0, 10);
      if (!dayMap.has(dateKey)) dayMap.set(dateKey, new Set());
      dayMap.get(dateKey)!.add(log.performedBy);
    }

    const dailyActiveUsers = Array.from(dayMap.entries())
      .map(([date, users]) => ({ date, count: users.size }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Real active session count from non-revoked, non-expired refresh tokens
    const activeSessions = await this.tenantService.countActiveSessions(tenantId);

    return {
      recentLogins,
      activeSessions,
      userActivitySummaries,
      dailyActiveUsers,
    };
  }

  /**
   * Get module usage statistics
   * Returns per-module active user counts from user_module_assignments
   */
  @TenantAdminOrHigher()
  @Query(() => [ModuleUsageStatResponse])
  async moduleUsageStats(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<ModuleUsageStatResponse[]> {
    return this.tenantService.getModuleUsageStats(tenantId);
  }
}
