import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import {
  TenantActivity,
  TenantNote,
  TenantBillingInfo,
} from '../entities/tenant-activity.entity';
import {
  TenantDetailDto,
  UserStatsByRole,
  ModuleUsageStats,
  ResourceUsage,
  BillingSummary,
} from '../dto/tenant-detail.dto';
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
        this.getBillingSummary(tenantId),
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
        FROM users
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
      this.logger.warn(`Could not fetch user stats for tenant ${tenantId}`);
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
          tm."moduleId",
          m.code as module_code,
          m.name as module_name,
          tm."isEnabled" as is_active,
          tm."activatedAt" as assigned_at,
          tm."expiresAt" as expires_at
        FROM tenant_modules tm
        JOIN modules m ON tm."moduleId" = m.id
        WHERE tm."tenantId" = $1
        ORDER BY m.name
      `,
        [tenantId],
      );

      return result.map((row: Record<string, unknown>) => ({
        moduleId: row.moduleId as string,
        moduleCode: row.module_code as string,
        moduleName: row.module_name as string,
        isActive: row.is_active as boolean,
        assignedAt: row.assigned_at as Date,
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
   */
  private async getBillingSummary(
    tenantId: string,
  ): Promise<BillingSummary | undefined> {
    const billing = await this.billingRepository.findOne({
      where: { tenantId },
    });

    if (!billing) {
      return undefined;
    }

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    return {
      currentPlan: tenant?.tier || 'free',
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
    page: number = 1,
    limit: number = 20,
  ): Promise<{ data: TenantActivity[]; total: number; totalPages: number }> {
    const result = await this.activityService.getActivities(tenantId, {
      limit,
      offset: (page - 1) * limit,
    });

    return {
      data: result.data,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    };
  }

  /**
   * Bulk suspend tenants
   */
  async bulkSuspend(
    tenantIds: string[],
    reason: string,
    performedBy: string,
  ): Promise<{ success: string[]; failed: string[] }> {
    const success: string[] = [];
    const failed: string[] = [];

    for (const tenantId of tenantIds) {
      try {
        await this.tenantRepository.update(tenantId, {
          status: TenantStatus.SUSPENDED,
          suspendedAt: new Date(),
          suspendedReason: reason,
          suspendedBy: performedBy,
        });

        await this.activityService.logStatusChange(
          tenantId,
          'active',
          'suspended',
          reason,
          performedBy,
        );

        success.push(tenantId);
      } catch (error) {
        this.logger.error(
          `Failed to suspend tenant ${tenantId}: ${(error as Error).message}`,
        );
        failed.push(tenantId);
      }
    }

    return { success, failed };
  }

  /**
   * Bulk activate tenants
   */
  async bulkActivate(
    tenantIds: string[],
    performedBy: string,
  ): Promise<{ success: string[]; failed: string[] }> {
    const success: string[] = [];
    const failed: string[] = [];

    for (const tenantId of tenantIds) {
      try {
        await this.tenantRepository.update(tenantId, {
          status: TenantStatus.ACTIVE,
          suspendedAt: undefined,
          suspendedReason: undefined,
          suspendedBy: undefined,
        });

        await this.activityService.logStatusChange(
          tenantId,
          'suspended',
          'active',
          undefined,
          performedBy,
        );

        success.push(tenantId);
      } catch (error) {
        this.logger.error(
          `Failed to activate tenant ${tenantId}: ${(error as Error).message}`,
        );
        failed.push(tenantId);
      }
    }

    return { success, failed };
  }
}
