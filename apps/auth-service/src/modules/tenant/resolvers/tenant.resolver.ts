import { CurrentUser, Public, SuperAdminOnly, TenantAdminOrHigher, RequireTenantPermission, Role } from '@aquaculture/backend-common/decorators';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Int, ObjectType, Field } from '@nestjs/graphql';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuditLogService } from '../../../audit/audit-log.service';
import { User } from '../../authentication/entities/user.entity';
import { UpdateTenantInput, AssignModuleManagerInput } from '../dto/create-tenant.dto';
import { TenantStats, TenantDatabaseInfo, TableSchemaInfo, AuditLogPage, TenantActivityResponse, ModuleUsageStatResponse } from '../dto/tenant-stats.dto';
import { TenantModule } from '../entities/tenant-module.entity';
import { Tenant } from '../entities/tenant.entity';
import { TenantService } from '../services/tenant.service';

/**
 * Minimal public tenant info exposed by the unauthenticated tenantBySlug query.
 * SECURITY: Does not expose plan, maxUsers, settings, contactEmail, etc.
 */
@ObjectType()
class TenantPublicInfo {
  // SECURITY (MT-LOW-001): internal tenant `id` and `status` were REMOVED
  // from this public type. The exposed UUID was the harvest leg that turned
  // the register-mutation injection (SEC-CRITICAL-001) from "guess a UUID"
  // into "look it up by slug"; status leaked lifecycle state to anonymous
  // callers. The login/branding flow needs only name/slug/logo.
  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field(() => String, { nullable: true })
  logoUrl!: string | null;
}

@Resolver(() => Tenant)
export class TenantResolver {
  private readonly logger = new Logger(TenantResolver.name);

  constructor(
    private readonly tenantService: TenantService,
    private readonly auditLogService: AuditLogService,
  ) {}

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
    // SECURITY: Only expose minimal branding info — no id, status, plan,
    // maxUsers, settings, contact details (MT-LOW-001).
    return {
      name: tenant.name,
      slug: tenant.slug,
      logoUrl: tenant.logoUrl ?? null,
    };
  }

  @TenantAdminOrHigher()
  @Mutation(() => Tenant)
  updateTenant(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateTenantInput,
    @CurrentUser('role') role: Role,
    @CurrentUser('tenantId') userTenantId: string | null,
  ): Tenant {
    // SECURITY: Tenant isolation - TENANT_ADMIN can only update their own tenant
    if (role !== Role.SUPER_ADMIN && userTenantId !== id) {
      throw new ForbiddenException('Access denied: You can only update your own tenant');
    }
    // Tenant mutation authority converged on the command-receipt/FSM
    // path in the enterprise train; the resolver-level update is
    // rejected outright (stronger than role-based field filtering —
    // nothing mutates tenants outside the governed command path).
    void input;
    throw new BadRequestException(
      'Tenant updates are command-receipt owned. Use the auth tenant command/FSM path.',
    );
  }

  @SuperAdminOnly()
  @Mutation(() => Tenant)
  suspendTenant(
    @Args('id', { type: () => ID }) id: string,
  ): Tenant {
    void id;
    throw new BadRequestException(
      'Tenant lifecycle is command-receipt owned. Use the auth tenant command/FSM path.',
    );
  }

  @SuperAdminOnly()
  @Mutation(() => Tenant)
  activateTenant(
    @Args('id', { type: () => ID }) id: string,
  ): Tenant {
    void id;
    throw new BadRequestException(
      'Tenant lifecycle is command-receipt owned. Use the auth tenant command/FSM path.',
    );
  }

  @SuperAdminOnly()
  @Mutation(() => Tenant)
  cancelTenant(
    @Args('id', { type: () => ID }) id: string,
  ): Tenant {
    void id;
    throw new BadRequestException(
      'Tenant lifecycle is command-receipt owned. Use the auth tenant command/FSM path.',
    );
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
   * Get users belonging to tenant.
   *
   * RBAC-HIGH-005: gated on the granular `users:view` capability rather than the
   * coarse TENANT_ADMIN role. SUPER_ADMIN/TENANT_ADMIN still bypass inside
   * TenantPermissionGuard (hasAllResourcePermissions), so this is a strict
   * superset that additionally lets a delegate holding `users:view` load the
   * users list — completing the end-to-end path for the capability the
   * frontend (TenantUsers page) and the sibling getUserEffectivePermissions
   * query already gate on. tenantId is still sourced from the caller's JWT
   * claim, so a delegate can only ever read their own tenant's users.
   */
  @RequireTenantPermission('users:view')
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

  // NOTE: both updateTenantSettings and the writable TenantService lifecycle
  // methods (create/update/activate/suspend/cancel/assignModules) were removed
  // (W3.3, MT-HIGH-001/002). Tenant writes are command-receipt/FSM owned via
  // TenantProvisioningCommandService; the resolver's updateTenant/lifecycle
  // mutations reject outright. TenantService is now a read + module-manager
  // service only.

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
      success: l.severity !== AuditLogSeverity.ERROR,
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
      const dayUsers = dayMap.get(dateKey) ?? new Set<string>();
      dayUsers.add(log.performedBy);
      dayMap.set(dateKey, dayUsers);
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
