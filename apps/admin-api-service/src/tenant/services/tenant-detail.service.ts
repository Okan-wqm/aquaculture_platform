import * as crypto from 'crypto';

import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import {
  TenantDetailDto,
  TenantAvailableAction,
  UserStatsByRole,
  TenantModuleUsageStats,
  ResourceUsage,
  BillingSummary,
} from '../dto/tenant-detail.dto';
import {
  TenantActivity,
  TenantBillingInfo,
} from '../entities/tenant-activity.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';

import { AuthTenantProvisioningClientService } from './auth-tenant-provisioning-client.service';
import { TenantActivityService } from './tenant-activity.service';

/**
 * The outcome of a bulk tenant lifecycle command, partitioned by tenant id.
 *
 * Named because it is a RESULT, not an acknowledgement: a bulk operation can
 * half-succeed, and the panel has to tell the operator which tenants moved. An
 * inline `Promise<{ success: string[]; failed: string[] }>` on two controller
 * routes gave the panel nothing to import, so it re-declared the pair by hand.
 */
export interface BulkTenantOperationResult {
  success: string[];
  failed: string[];
}

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
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
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
    tenant.hydrateCompatibilityFields();

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
      availableActions: this.getAvailableActions(tenant),

      // Contact Info
      primaryContact: tenant.primaryContact,
      billingContact: tenant.billingContact,
      billingEmail: tenant.billingEmail,

      // Location
      country: tenant.country,
      region: tenant.region,

      // Settings & Limits
      settings: tenant.settings as TenantDetailDto['settings'],
      limits: tenant.limits,
      userCount: tenant.userCount,
      // MT-MEDIUM-002: real counts computed in getResourceUsage from the
      // per-tenant schema, not the dropped auth.tenants denormalization.
      farmCount: resourceUsage.farms.count,
      sensorCount: resourceUsage.sensors.count,
      maxStorage: tenant.maxStorage,
      // MT-MEDIUM-001: derive trial state from trialEndsAt (the SSoT); the
      // is_trial_active column was dropped from auth.tenants.
      isTrialActive: tenant.trialEndsAt != null && tenant.trialEndsAt > new Date(),

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
    };
  }

  private getAvailableActions(tenant: Tenant): TenantAvailableAction[] {
    const status = this.toTenantStatus(tenant.status);
    switch (status) {
      case TenantStatus.ACTIVE:
        return ['suspend', 'deactivate'];
      case TenantStatus.SUSPENDED:
        return ['activate', 'deactivate'];
      case TenantStatus.DEACTIVATED:
        return ['archive'];
      case TenantStatus.PROVISIONING_FAILED:
        return ['retryProvisioning'];
      default:
        return [];
    }
  }

  private toTenantStatus(status: string): TenantStatus | undefined {
    return Object.values(TenantStatus).find((candidate) => String(candidate) === status);
  }

  /**
   * Get user statistics for a tenant
   */
  private async getUserStats(tenantId: string): Promise<UserStatsByRole> {
    try {
      // Query auth-service database for user stats
      // In a real implementation, this would call auth-service API or use shared DB
      // pg returns COUNT(*) as a numeric string, so each column is typed string.
      type UserStatsRow = {
        total: string;
        active: string;
        inactive: string;
        admin_count: string;
        manager_count: string;
        user_count: string;
        recently_active: string;
        new_users: string;
      };
      const result = await this.dataSource.query<UserStatsRow[]>(
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

      const stats: Partial<UserStatsRow> = result[0] ?? {};

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
  private async getModuleUsage(tenantId: string): Promise<TenantModuleUsageStats[]> {
    try {
      type ModuleUsageRow = {
        moduleId: string;
        moduleCode: string;
        moduleName: string;
        isActive: boolean;
        assignedAt: Date;
        expiresAt: Date | null;
      };
      const result = await this.dataSource.query<ModuleUsageRow[]>(
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

      return result.map((row) => ({
        moduleId: row.moduleId,
        moduleCode: row.moduleCode,
        moduleName: row.moduleName,
        isActive: row.isActive,
        assignedAt: row.assignedAt,
      }));
    } catch (error) {
      this.logger.warn(
        `Could not fetch module usage for tenant ${tenantId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Get resource usage statistics
   */
  /**
   * Count a tenant's resources from its OWN per-tenant schema (the SSoT for
   * farms/sensors), replacing the dropped auth.tenants denormalization
   * (MT-MEDIUM-002). Returns 0 when the schema/table is not yet provisioned — a
   * PENDING/PROVISIONING tenant legitimately has none — checked via
   * information_schema rather than swallowing a query error. The schema name is
   * derived from the validated tenant UUID and the table is a fixed literal, so
   * the identifier interpolation carries no injection surface.
   */
  private async countTenantResource(
    tenantId: string,
    table: 'farms' | 'sensors',
  ): Promise<number> {
    const schema = getTenantSchemaName(tenantId);
    // Existence check first: a tenant whose schema has not been provisioned yet
    // (or a SUPER_ADMIN pseudo-tenant) has no farms/sensors table — that is 0
    // resources, not an error, so we never let a missing table throw.
    const exists = await this.dataSource.query<unknown[]>(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
      [schema, table],
    );
    if (exists.length === 0) {
      return 0;
    }
    const rows = await this.dataSource.query<Array<{ c: number }>>(
      `SELECT COUNT(*)::int AS c FROM "${schema}"."${table}"`,
    );
    return rows[0]?.c ?? 0;
  }

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
      const apiResult = await this.dataSource.query<
        Array<{ calls_24h: string; calls_7d: string }>
      >(
        `
        SELECT
          COUNT(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '24 hours') as calls_24h,
          COUNT(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '7 days') as calls_7d
        FROM shared.audit_logs
        WHERE "tenantId" = $1
      `,
        [tenant.id],
      );
      if (apiResult[0]) {
        apiCalls24h = parseInt(apiResult[0].calls_24h || '0', 10);
        apiCalls7d = parseInt(apiResult[0].calls_7d || '0', 10);
      }
    } catch {
      // Ignore - metrics may not be available
    }

    // MT-MEDIUM-002: real farm/sensor counts from the per-tenant schema (the
    // owning SSoT) instead of the dropped, always-0 auth.tenants denormalization.
    const farmCount = await this.countTenantResource(tenant.id, 'farms');
    const sensorCount = await this.countTenantResource(tenant.id, 'sensors');

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
        count: farmCount,
        limit: limits.maxFarms,
        percentage: calculatePercentage(farmCount, limits.maxFarms),
      },
      sensors: {
        count: sensorCount,
        limit: limits.maxSensors,
        percentage: calculatePercentage(sensorCount, limits.maxSensors),
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
      currentPlan: tenant.tier,
      monthlyAmount: Number(billing.monthlyAmount),
      currency: billing.currency,
      billingCycle: billing.billingCycle,
      paymentStatus: billing.paymentStatus,
      nextBillingDate: billing.nextBillingDate || null,
      lastPaymentDate: billing.lastPaymentDate || null,
      lastPaymentAmount: billing.lastPaymentAmount !== null && billing.lastPaymentAmount !== undefined
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
  ): Promise<IStandardPaginatedResult<TenantActivity>> {
    // The page window and the BUG-031 limit floor now live in getActivities,
    // which returns the canonical envelope directly — nothing to re-derive here.
    return this.activityService.getActivities(tenantId, { page, limit });
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
  ): Promise<BulkTenantOperationResult> {
    if (tenantIds.length === 0) return { success: [], failed: [] };

    try {
      // Fetch current statuses in one query (needed for the audit trail)
      const existingTenants = await this.tenantRepository
        .createQueryBuilder('t')
        .select(['t.id', 't.status'])
        .where('t.id IN (:...ids)', { ids: tenantIds })
        .getMany();

      const foundIds = new Set(existingTenants.map(t => t.id));
      const activeIds = new Set(
        existingTenants
          .filter(t => t.status === TenantStatus.ACTIVE)
          .map(t => t.id),
      );
      const failed  = tenantIds.filter(id => !foundIds.has(id) || !activeIds.has(id));
      const success = tenantIds.filter(id => activeIds.has(id));

      if (success.length === 0) return { success: [], failed };

      const commandSucceeded: string[] = [];
      for (const tenantId of success) {
        try {
          await this.authProvisioningClient.suspendTenant({
            ...buildTenantDetailLifecycleCommandMetadata(
              'SuspendTenant',
              tenantId,
              performedBy,
              { reason, bulk: true },
            ),
            reason,
          });
          commandSucceeded.push(tenantId);
        } catch (error) {
          this.logger.warn(
            `bulkSuspend auth command failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
          failed.push(tenantId);
        }
      }
      success.splice(0, success.length, ...commandSucceeded);

      // Batch-create activity log entries (single INSERT … VALUES …)
      const successIds = new Set(success);
      const activityRows = existingTenants.filter(t => successIds.has(t.id));
      if (activityRows.length > 0) {
        await this.dataSource.query(
          `INSERT INTO admin.tenant_activities
             ("tenantId", "activityType", title, description,
              "previousValue", "newValue", "performedBy", "createdAt", "updatedAt")
           SELECT
             unnest($1::uuid[]),
             'suspended'::admin.tenant_activities_activitytype_enum,
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
  ): Promise<BulkTenantOperationResult> {
    if (tenantIds.length === 0) return { success: [], failed: [] };

    try {
      // Fetch current statuses in one query (needed for the audit trail)
      const existingTenants = await this.tenantRepository
        .createQueryBuilder('t')
        .select(['t.id', 't.status'])
        .where('t.id IN (:...ids)', { ids: tenantIds })
        .getMany();

      const foundIds = new Set(existingTenants.map(t => t.id));
      const suspendedIds = new Set(
        existingTenants
          .filter(t => t.status === TenantStatus.SUSPENDED)
          .map(t => t.id),
      );
      const failed  = tenantIds.filter(id => !foundIds.has(id) || !suspendedIds.has(id));
      const success = tenantIds.filter(id => suspendedIds.has(id));

      if (success.length === 0) return { success: [], failed };

      const commandSucceeded: string[] = [];
      for (const tenantId of success) {
        try {
          await this.authProvisioningClient.activateTenant({
            ...buildTenantDetailLifecycleCommandMetadata(
              'ActivateTenant',
              tenantId,
              performedBy,
              { bulk: true },
            ),
          });
          commandSucceeded.push(tenantId);
        } catch (error) {
          this.logger.warn(
            `bulkActivate auth command failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
          failed.push(tenantId);
        }
      }
      success.splice(0, success.length, ...commandSucceeded);

      // Batch-create activity log entries
      const successIds = new Set(success);
      const activityRows = existingTenants.filter(t => successIds.has(t.id));
      if (activityRows.length > 0) {
        await this.dataSource.query(
          `INSERT INTO admin.tenant_activities
             ("tenantId", "activityType", title, description,
              "previousValue", "newValue", "performedBy", "createdAt", "updatedAt")
           SELECT
             unnest($1::uuid[]),
             'activated'::admin.tenant_activities_activitytype_enum,
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

function buildTenantDetailLifecycleCommandMetadata(
  commandType: string,
  tenantId: string,
  actorId: string,
  _payload: unknown,
): {
  operationId: string;
  tenantId: string;
  actor: { id: string; type: 'user' };
  requestReference: string;
  auditMetadata: Record<string, unknown>;
} {
  return {
    operationId: crypto.randomUUID(),
    tenantId,
    actor: { id: actorId, type: 'user' },
    requestReference: `${commandType}:${tenantId}:${actorId}`,
    auditMetadata: {
      source: 'admin-api-service',
      commandType,
    },
  };
}
