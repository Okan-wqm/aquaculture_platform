import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import {
  TenantDetailDto,
  UserStatsByRole,
  ModuleUsageStats,
  ResourceUsage,
  BillingSummary,
} from '../dto/tenant-detail.dto';
import {
  TenantActivity,
  TenantNote,
  TenantBillingInfo,
} from '../entities/tenant-activity.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';

import { TenantActivityService } from './tenant-activity.service';

@Injectable()
export class TenantDetailService {
  private readonly logger = new Logger(TenantDetailService.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(TenantBillingInfo)
    private readonly billingRepository: Repository<TenantBillingInfo>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly activityService: TenantActivityService,
  ) {}

  /**
   * Get comprehensive tenant detail with all related information
   */
  async getTenantDetail(tenantId: string): Promise<TenantDetailDto> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
    }

    // Fetch all related data in parallel
    const [userStats, modules, activities, notes, billing, resourceUsage] =
      await Promise.all([
        this.getUserStats(tenantId),
        this.getModuleUsage(tenantId),
        this.activityService.getRecentActivities(tenantId, 20),
        this.activityService.getNotes(tenantId, { limit: 10 }),
        this.getBillingSummary(tenantId, tenant),
        this.getResourceUsage(tenant),
      ]);

    return {
      // Basic Info
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      description: tenant.description,
      domain: tenant.domain,

      // Status & Tier
      status: tenant.status,
      tier: tenant.tier,
      trialEndsAt: tenant.trialEndsAt,
      suspendedAt: tenant.suspendedAt,
      suspendedReason: tenant.suspendedReason,

      // Contact Info
      primaryContact: tenant.primaryContact,
      billingContact: tenant.billingContact,
      billingEmail: tenant.billingEmail,

      // Location
      country: tenant.country,
      region: tenant.region,

      // Settings & Limits
      settings: tenant.settings as any,
      limits: tenant.limits as any,

      // Statistics
      userStats,
      resourceUsage,

      // Modules
      modules,

      // Activity & Notes
      recentActivities: activities,
      notes,

      // Billing
      billing,

      // Metadata
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
      createdBy: tenant.createdBy,
      lastActivityAt: tenant.lastActivityAt,
    };
  }

  /**
   * Get user statistics for a tenant
   */
  private async getUserStats(tenantId: string): Promise<UserStatsByRole> {
    try {
      // Query auth-service database for user stats
      // In a real implementation, this would call auth-service API or use shared DB
      const result = await this.dataSource.query(
        `
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE "isActive" = true) as active,
          COUNT(*) FILTER (WHERE "isActive" = false) as inactive,
          COUNT(*) FILTER (WHERE role = 'TENANT_ADMIN') as admin_count,
          COUNT(*) FILTER (WHERE role = 'MODULE_MANAGER') as manager_count,
          COUNT(*) FILTER (WHERE role = 'MODULE_USER') as user_count,
          COUNT(*) FILTER (WHERE "lastLoginAt" > NOW() - INTERVAL '7 days') as recently_active,
          COUNT(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '30 days') as new_users
        FROM auth.users
        WHERE "tenantId" = $1
      `,
        [tenantId],
      );

      const stats = result[0] || {};

      return {
        total: parseInt(stats.total || '0', 10),
        active: parseInt(stats.active || '0', 10),
        inactive: parseInt(stats.inactive || '0', 10),
        byRole: {
          admin: parseInt(stats.admin_count || '0', 10),
          manager: parseInt(stats.manager_count || '0', 10),
          supervisor: 0, // Add if role exists
          operator: 0,
          viewer: parseInt(stats.user_count || '0', 10),
        },
        recentlyActive: parseInt(stats.recently_active || '0', 10),
        newUsersLast30Days: parseInt(stats.new_users || '0', 10),
      };
    } catch (error) {
      // BUG-007 fix: log the actual error object so root cause is visible to operators
      this.logger.warn(
        `Could not fetch user stats for tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // Return default stats if query fails
      return {
        total: 0,
        active: 0,
        inactive: 0,
        byRole: { admin: 0, manager: 0, supervisor: 0, operator: 0, viewer: 0 },
        recentlyActive: 0,
        newUsersLast30Days: 0,
      };
    }
  }

  /**
   * Get module usage for a tenant
   */
  private async getModuleUsage(tenantId: string): Promise<ModuleUsageStats[]> {
    try {
      const result = await this.dataSource.query(
        `
        SELECT
          tm."moduleId" as "moduleId",
          m.code as "moduleCode",
          m.name as "moduleName",
          tm."isEnabled" as "isActive",
          tm."activatedAt" as "assignedAt",
          tm."expiresAt" as "expiresAt"
        FROM auth.tenant_modules tm
        JOIN auth.modules m ON tm."moduleId" = m.id
        WHERE tm."tenantId" = $1
        ORDER BY m.name
      `,
        [tenantId],
      );

      return result.map((row: Record<string, unknown>) => ({
        moduleId: row.moduleId as string,
        moduleCode: row.moduleCode as string,
        moduleName: row.moduleName as string,
        isActive: row.isActive as boolean,
        assignedAt: row.assignedAt as Date,
      }));
    } catch (error) {
      this.logger.warn(`Could not fetch module usage for tenant ${tenantId}`);
      return [];
    }
  }

  /**
   * Get resource usage statistics
   */
  private async getResourceUsage(tenant: Tenant): Promise<ResourceUsage> {
    const limits = tenant.limits || {
      maxUsers: 0,
      maxFarms: 0,
      maxSensors: 0,
      storageGb: 0,
      apiRateLimit: 0,
    };

    const calculatePercentage = (used: number, max: number): number => {
      if (max === -1) return 0; // unlimited
      if (max === 0) return 100;
      return Math.min(Math.round((used / max) * 100), 100);
    };

    // Get API call counts (would come from metrics service in production)
    let apiCalls24h = 0;
    let apiCalls7d = 0;
    try {
      const apiResult = await this.dataSource.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '24 hours') as calls_24h,
          COUNT(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '7 days') as calls_7d
        FROM audit_logs
        WHERE "tenantId" = $1
      `,
        [tenant.id],
      );
      if (apiResult[0]) {
        apiCalls24h = parseInt(apiResult[0].calls_24h || '0', 10);
        apiCalls7d = parseInt(apiResult[0].calls_7d || '0', 10);
      }
    } catch (error) {
      // Ignore - metrics may not be available
    }

    return {
      storage: {
        usedGb: 0, // Would calculate from actual storage usage
        limitGb: limits.storageGb === -1 ? -1 : limits.storageGb,
        percentage: 0,
      },
      users: {
        count: tenant.userCount,
        limit: limits.maxUsers,
        percentage: calculatePercentage(tenant.userCount, limits.maxUsers),
      },
      farms: {
        count: tenant.farmCount,
        limit: limits.maxFarms,
        percentage: calculatePercentage(tenant.farmCount, limits.maxFarms),
      },
      sensors: {
        count: tenant.sensorCount,
        limit: limits.maxSensors,
        percentage: calculatePercentage(tenant.sensorCount, limits.maxSensors),
      },
      apiCalls: {
        last24h: apiCalls24h,
        last7d: apiCalls7d,
        limit: limits.apiRateLimit,
      },
    };
  }

  /**
   * Get billing summary
   * BUG-008 fix: accept the already-fetched tenant object to avoid a redundant DB round-trip
   */
  private async getBillingSummary(
    tenantId: string,
    tenant: Tenant,
  ): Promise<BillingSummary | undefined> {
    const billing = await this.billingRepository.findOne({
      where: { tenantId },
    });

    if (!billing) {
      return undefined;
    }

    return {
      currentPlan: tenant.tier || 'free',
      monthlyAmount: Number(billing.monthlyAmount),
      currency: billing.currency,
      billingCycle: billing.billingCycle,
      paymentStatus: billing.paymentStatus,
      nextBillingDate: billing.nextBillingDate || null,
      lastPaymentDate: billing.lastPaymentDate || null,
      lastPaymentAmount: billing.lastPaymentAmount
        ? Number(billing.lastPaymentAmount)
        : null,
    };
  }

  /**
   * Get activities timeline with pagination
   */
  async getActivitiesTimeline(
    tenantId: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: TenantActivity[]; total: number; totalPages: number }> {
    // BUG-031 fix: guard against limit=0 to prevent Math.ceil producing Infinity
    const safeLimit = limit > 0 ? limit : 20;

    const result = await this.activityService.getActivities(tenantId, {
      limit: safeLimit,
      offset: (page - 1) * safeLimit,
    });

    return {
      data: result.data,
      total: result.total,
      totalPages: Math.ceil(result.total / safeLimit),
    };
  }

  /**
   * Bulk suspend tenants.
   * HIGH-003 fix: replaced sequential per-tenant UPDATE + activity log calls
   * with a single bulk UPDATE and a batch activity log INSERT.
   */
  async bulkSuspend(
    tenantIds: string[],
    reason: string,
    performedBy: string,
  ): Promise<{ success: string[]; failed: string[] }> {
    if (tenantIds.length === 0) return { success: [], failed: [] };

    try {
      // Fetch current statuses in one query (needed for the audit trail)
      const existingTenants = await this.tenantRepository
        .createQueryBuilder('t')
        .select(['t.id', 't.status'])
        .where('t.id IN (:...ids)', { ids: tenantIds })
        .getMany();

      const foundIds = new Set(existingTenants.map(t => t.id));
      const failed  = tenantIds.filter(id => !foundIds.has(id));
      const success = tenantIds.filter(id =>  foundIds.has(id));

      if (success.length === 0) return { success: [], failed };

      // Single bulk UPDATE
      const now = new Date();
      await this.dataSource.query(
        `UPDATE tenants
         SET    status            = 'SUSPENDED',
                "suspendedAt"     = $1,
                "suspendedReason" = $2,
                "suspendedBy"     = $3,
                "updatedAt"       = $1
         WHERE  id = ANY($4::uuid[])`,
        [now, reason, performedBy, success],
      );

      // Batch-create activity log entries (single INSERT … VALUES …)
      const activityRows = existingTenants.filter(t => foundIds.has(t.id));
      if (activityRows.length > 0) {
        await this.dataSource.query(
          `INSERT INTO tenant_activities
             ("tenantId", "activityType", title, description,
              "previousValue", "newValue", "performedBy", "createdAt", "updatedAt")
           SELECT
             unnest($1::uuid[]),
             'SUSPENDED'::varchar,
             'Status changed: suspended',
             $2,
             jsonb_build_object('status', prev_status),
             '{"status":"suspended"}'::jsonb,
             $3,
             NOW(), NOW()
           FROM unnest($4::text[]) AS prev_status`,
          [
            activityRows.map(t => t.id),
            reason || 'Bulk suspended',
            performedBy,
            activityRows.map(t => t.status),
          ],
        );
      }

      return { success, failed };
    } catch (error) {
      this.logger.error(`bulkSuspend failed: ${(error as Error).message}`);
      return { success: [], failed: tenantIds };
    }
  }

  /**
   * Bulk activate tenants.
   * HIGH-003 fix: replaced sequential per-tenant UPDATE + activity log calls
   * with a single bulk UPDATE and a batch activity log INSERT.
   */
  async bulkActivate(
    tenantIds: string[],
    performedBy: string,
  ): Promise<{ success: string[]; failed: string[] }> {
    if (tenantIds.length === 0) return { success: [], failed: [] };

    try {
      // Fetch current statuses in one query (needed for the audit trail)
      const existingTenants = await this.tenantRepository
        .createQueryBuilder('t')
        .select(['t.id', 't.status'])
        .where('t.id IN (:...ids)', { ids: tenantIds })
        .getMany();

      const foundIds = new Set(existingTenants.map(t => t.id));
      const failed  = tenantIds.filter(id => !foundIds.has(id));
      const success = tenantIds.filter(id =>  foundIds.has(id));

      if (success.length === 0) return { success: [], failed };

      // Single bulk UPDATE
      const now = new Date();
      await this.dataSource.query(
        `UPDATE tenants
         SET    status            = 'ACTIVE',
                "suspendedAt"     = NULL,
                "suspendedReason" = NULL,
                "suspendedBy"     = NULL,
                "updatedAt"       = $1
         WHERE  id = ANY($2::uuid[])`,
        [now, success],
      );

      // Batch-create activity log entries
      const activityRows = existingTenants.filter(t => foundIds.has(t.id));
      if (activityRows.length > 0) {
        await this.dataSource.query(
          `INSERT INTO tenant_activities
             ("tenantId", "activityType", title, description,
              "previousValue", "newValue", "performedBy", "createdAt", "updatedAt")
           SELECT
             unnest($1::uuid[]),
             'ACTIVATED'::varchar,
             'Status changed: active',
             'Bulk activated',
             jsonb_build_object('status', prev_status),
             '{"status":"active"}'::jsonb,
             $2,
             NOW(), NOW()
           FROM unnest($3::text[]) AS prev_status`,
          [
            activityRows.map(t => t.id),
            performedBy,
            activityRows.map(t => t.status),
          ],
        );
      }

      return { success, failed };
    } catch (error) {
      this.logger.error(`bulkActivate failed: ${(error as Error).message}`);
      return { success: [], failed: tenantIds };
    }
  }
}
