/**
 * CronJobs Service
 *
 * Zamanlanmış görevlerin yönetimi.
 * Bakım planları, uyarılar ve otomatik işlemler.
 *
 * Görevler:
 * - Bakım planı iş emri oluşturma
 * - Gecikmiş bakım uyarıları
 * - Düşük stok uyarıları
 * - Günlük/haftalık raporlar
 *
 * @module Scheduler
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource, QueryRunner } from 'typeorm';
import { forEachTenantSchema, listTenantSchemas } from '@aquaculture/backend-common/database';
import { withTenantContext } from '@aquaculture/backend-common/context';
import {
  clearManagedTimer,
  createManagedInterval,
  type ManagedInterval,
} from '@aquaculture/backend-common/utils';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Entities
import { WorkOrder, WorkOrderStatus } from '../maintenance/entities/work-order.entity';
import {
  MaintenanceSchedule,
  MaintenanceScheduleStatus,
} from '../maintenance/entities/maintenance-schedule.entity';
import { SparePart, SparePartStatus } from '../maintenance/entities/spare-part.entity';

// Services
import { MaintenanceScheduleService } from '../maintenance/services/maintenance-schedule.service';
import { SparePartService } from '../maintenance/services/spare-part.service';
import { FarmOrphanCleanupService } from '../common/file-cleanup/farm-orphan-cleanup.service';

/**
 * Cron job execution result
 */
export interface CronJobResult {
  jobName: string;
  tenantId: string;
  executedAt: Date;
  success: boolean;
  itemsProcessed: number;
  errors: string[];
  duration: number;
}

/**
 * Tenant configuration for cron jobs
 */
export interface TenantCronConfig {
  tenantId: string;
  maintenanceEnabled: boolean;
  alertsEnabled: boolean;
  reportsEnabled: boolean;
  systemUserId: string;
  lastAccessed: Date;
}

// Default TTL for tenant configs: 24 hours
const TENANT_CONFIG_TTL_MS = 24 * 60 * 60 * 1000;
// Cleanup interval: 1 hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class CronJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronJobsService.name);
  private tenantConfigs: Map<string, TenantCronConfig> = new Map();
  private cleanupInterval: ManagedInterval | null = null;

  constructor(
    @InjectRepository(MaintenanceSchedule)
    private readonly scheduleRepository: Repository<MaintenanceSchedule>,
    @InjectRepository(WorkOrder)
    private readonly workOrderRepository: Repository<WorkOrder>,
    @InjectRepository(SparePart)
    private readonly sparePartRepository: Repository<SparePart>,
    private readonly maintenanceScheduleService: MaintenanceScheduleService,
    private readonly sparePartService: SparePartService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly eventEmitter: EventEmitter2,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    /**
     * `@Optional` so farm-service still boots in environments
     * that haven't wired StorageModule yet (dev harnesses, unit
     * tests of sibling crons). When absent, the orphan-cleanup
     * cron logs a one-time warning and no-ops — a separate
     * concern from the maintenance / analytics crons.
     */
    @Optional() private readonly orphanCleanup?: FarmOrphanCleanupService,
  ) {}

  async onModuleInit() {
    this.logger.log('CronJobsService initialized');
    await this.loadTenantConfigs();

    // Start periodic cleanup of stale tenant configs
    this.cleanupInterval = createManagedInterval(() => {
      this.cleanupStaleTenantConfigs();
    }, CLEANUP_INTERVAL_MS);

    this.logger.log('Started tenant config cleanup interval');
  }

  /**
   * Cleanup resources on module destroy to prevent memory leaks
   */
  onModuleDestroy() {
    this.logger.log('CronJobsService shutting down, cleaning up resources');

    // Clear the cleanup interval
    if (this.cleanupInterval) {
      clearManagedTimer(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Clear tenant configs
    this.tenantConfigs.clear();

    this.logger.log('CronJobsService cleanup completed');
  }

  /**
   * Remove stale tenant configurations that haven't been accessed recently
   * This prevents memory leaks from accumulating tenant data
   */
  private cleanupStaleTenantConfigs(): void {
    const now = Date.now();
    const staleThreshold = now - TENANT_CONFIG_TTL_MS;
    let removedCount = 0;

    for (const [tenantId, config] of this.tenantConfigs) {
      if (config.lastAccessed.getTime() < staleThreshold) {
        this.tenantConfigs.delete(tenantId);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.logger.log(`Cleaned up ${removedCount} stale tenant configs`);
    }
  }

  /**
   * Remove a specific tenant's configuration (e.g., when tenant is deactivated)
   */
  removeTenantConfig(tenantId: string): void {
    if (this.tenantConfigs.has(tenantId)) {
      this.tenantConfigs.delete(tenantId);
      this.logger.log(`Removed tenant config for ${tenantId}`);
    }
  }

  /**
   * Clear all tenant configurations (useful for testing or full refresh)
   */
  clearAllTenantConfigs(): void {
    const count = this.tenantConfigs.size;
    this.tenantConfigs.clear();
    this.logger.log(`Cleared all ${count} tenant configs`);
  }

  /**
   * Get tenant config and update lastAccessed timestamp
   * This helps track which configs are actively used for TTL-based cleanup
   */
  private getTenantConfig(tenantId: string): TenantCronConfig | undefined {
    const config = this.tenantConfigs.get(tenantId);
    if (config) {
      config.lastAccessed = new Date();
    }
    return config;
  }

  // getTenantSchemas replaced by listTenantSchemas from @aquaculture/backend-common

  /**
   * Load tenant configurations for cron jobs
   * Updates existing configs with fresh lastAccessed time, adds new ones
   */
  private async loadTenantConfigs(): Promise<void> {
    const schedules = await this.scheduleRepository
      .createQueryBuilder('s')
      .select('DISTINCT s.tenantId', 'tenantId')
      .getRawMany();

    const now = new Date();
    const currentTenantIds = new Set<string>();

    for (const { tenantId } of schedules) {
      currentTenantIds.add(tenantId);
      const existingConfig = this.tenantConfigs.get(tenantId);

      if (existingConfig) {
        // Update lastAccessed for existing config
        existingConfig.lastAccessed = now;
      } else {
        // Add new tenant config
        this.tenantConfigs.set(tenantId, {
          tenantId,
          maintenanceEnabled: true,
          alertsEnabled: true,
          reportsEnabled: true,
          systemUserId: 'system',
          lastAccessed: now,
        });
      }
    }

    // Remove configs for tenants that no longer have active schedules
    for (const tenantId of this.tenantConfigs.keys()) {
      if (!currentTenantIds.has(tenantId)) {
        this.tenantConfigs.delete(tenantId);
        this.logger.debug(`Removed config for inactive tenant ${tenantId}`);
      }
    }

    this.logger.log(`Loaded configurations for ${this.tenantConfigs.size} tenants`);
  }

  // -------------------------------------------------------------------------
  // MAINTENANCE SCHEDULE JOBS
  // -------------------------------------------------------------------------

  /**
   * Her gün saat 06:00'da çalışır - Otomatik iş emri oluşturma
   * Iterates ALL tenant schemas with dedicated QueryRunner per tenant.
   */
  @Cron(CronExpression.EVERY_DAY_AT_6AM, {
    name: 'generateMaintenanceWorkOrders',
    timeZone: 'Europe/Istanbul',
  })
  async generateMaintenanceWorkOrders(): Promise<void> {
    this.logger.log('Starting maintenance work order generation job');
    const startTime = Date.now();

    // Refresh tenant configs before processing
    await this.loadTenantConfigs();

    // cron-fairness (FARM-MEDIUM-061): bounded-concurrency + per-tenant Node+DB
    // timeout + error isolation + rotation. Replaces the strictly-serial
    // `for (const schema) { createQueryRunner … }` loop where one slow/hanging
    // tenant stalled every later tenant (and could overrun the schedule). The
    // helper owns the QueryRunner lifecycle + `SET search_path` per tenant.
    await forEachTenantSchema(
      this.dataSource,
      async ({ schema, queryRunner }) => {
        // Discover tenantIds within this schema
        const tenantRows: { tenantId: string }[] = await queryRunner.query(
          `SELECT DISTINCT "tenantId" AS "tenantId" FROM maintenance_schedules
           WHERE "deletedAt" IS NULL LIMIT 100`,
        );

        for (const { tenantId } of tenantRows) {
          const config = this.getTenantConfig(tenantId);
          if (config && !config.maintenanceEnabled) continue;

          try {
            const workOrders = await this.maintenanceScheduleService.processAutoGenerateWorkOrders(
              tenantId,
              config?.systemUserId || 'system',
            );

            if (workOrders.length > 0) {
              this.logger.log(
                `Generated ${workOrders.length} work orders for tenant ${tenantId} (schema: ${schema})`,
              );

              this.eventEmitter.emit('maintenance.workOrders.generated', {
                tenantId,
                workOrders,
              });
            }
          } catch (error) {
            this.logger.error(
              `Failed to generate work orders for tenant ${tenantId} in schema ${schema}: ${error}`,
            );
          }
        }
      },
      {
        searchPathSuffix: 'farm, public',
        concurrency: 4,
        perTenantTimeoutMs: 120_000,
        logger: this.logger,
      },
    );

    const duration = Date.now() - startTime;
    this.logger.log(`Maintenance work order generation completed in ${duration}ms`);
  }

  /**
   * Her gün saat 07:00'da çalışır - Gecikmiş bakım uyarıları
   * Iterates ALL tenant schemas with dedicated QueryRunner per tenant.
   */
  @Cron(CronExpression.EVERY_DAY_AT_7AM, {
    name: 'checkOverdueMaintenance',
    timeZone: 'Europe/Istanbul',
  })
  async checkOverdueMaintenance(): Promise<void> {
    this.logger.log('Starting overdue maintenance check job');

    // Refresh tenant configs before processing
    await this.loadTenantConfigs();
    const tenantSchemas = await listTenantSchemas(this.dataSource);

    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

        // Find all active schedules within this schema
        const overdueSchedules = await queryRunner.manager.find(MaintenanceSchedule, {
          where: {
            status: MaintenanceScheduleStatus.ACTIVE,
          },
        });

        if (overdueSchedules.length === 0) continue;

        // Group by tenantId for proper event emission
        const byTenant = new Map<string, MaintenanceSchedule[]>();
        for (const s of overdueSchedules) {
          const list = byTenant.get(s.tenantId) || [];
          list.push(s);
          byTenant.set(s.tenantId, list);
        }

        for (const [tenantId, schedules] of byTenant) {
          const config = this.getTenantConfig(tenantId);
          if (config && !config.alertsEnabled) continue;

          try {
            const actuallyOverdue = schedules.filter((s) => s.isOverdue());

            if (actuallyOverdue.length > 0) {
              this.logger.warn(
                `Found ${actuallyOverdue.length} overdue maintenance schedules for tenant ${tenantId} (schema: ${schema})`,
              );

              this.eventEmitter.emit('maintenance.overdue', {
                tenantId,
                schedules: actuallyOverdue,
              });
            }

            const upcoming = schedules.filter((s) => {
              const days = s.getDaysUntilDue();
              return days >= 0 && days <= 3;
            });

            if (upcoming.length > 0) {
              this.eventEmitter.emit('maintenance.upcoming', {
                tenantId,
                schedules: upcoming,
              });
            }
          } catch (error) {
            this.logger.error(
              `Failed to check overdue maintenance for tenant ${tenantId} in schema ${schema}: ${error}`,
            );
          }
        }
      } catch (err) {
        this.logger.error(
          `Overdue maintenance check failed for schema ${schema}: ${(err as Error).message}`,
        );
      } finally {
        await queryRunner.query('RESET search_path').catch(() => {});
        await queryRunner.release();
      }
    }
  }

  /**
   * Her gün saat 08:00'da çalışır - Gecikmiş iş emirleri uyarısı
   * Iterates ALL tenant schemas with dedicated QueryRunner per tenant.
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM, {
    name: 'checkOverdueWorkOrders',
    timeZone: 'Europe/Istanbul',
  })
  async checkOverdueWorkOrders(): Promise<void> {
    this.logger.log('Starting overdue work orders check job');

    // Refresh tenant configs before processing
    await this.loadTenantConfigs();
    const tenantSchemas = await listTenantSchemas(this.dataSource);

    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

        const overdueWorkOrders = await queryRunner.manager.find(WorkOrder, {
          where: {
            status: In([
              WorkOrderStatus.DRAFT,
              WorkOrderStatus.PENDING_APPROVAL,
              WorkOrderStatus.APPROVED,
              WorkOrderStatus.SCHEDULED,
              WorkOrderStatus.IN_PROGRESS,
              WorkOrderStatus.ON_HOLD,
            ]),
          },
        });

        if (overdueWorkOrders.length === 0) continue;

        // Group by tenantId
        const byTenant = new Map<string, WorkOrder[]>();
        for (const wo of overdueWorkOrders) {
          const list = byTenant.get(wo.tenantId) || [];
          list.push(wo);
          byTenant.set(wo.tenantId, list);
        }

        for (const [tenantId, workOrders] of byTenant) {
          const config = this.getTenantConfig(tenantId);
          if (config && !config.alertsEnabled) continue;

          try {
            const actuallyOverdue = workOrders.filter((wo) => wo.isOverdue());

            if (actuallyOverdue.length > 0) {
              this.logger.warn(
                `Found ${actuallyOverdue.length} overdue work orders for tenant ${tenantId} (schema: ${schema})`,
              );

              this.eventEmitter.emit('workOrder.overdue', {
                tenantId,
                workOrders: actuallyOverdue,
              });
            }
          } catch (error) {
            this.logger.error(
              `Failed to check overdue work orders for tenant ${tenantId} in schema ${schema}: ${error}`,
            );
          }
        }
      } catch (err) {
        this.logger.error(
          `Overdue work orders check failed for schema ${schema}: ${(err as Error).message}`,
        );
      } finally {
        await queryRunner.query('RESET search_path').catch(() => {});
        await queryRunner.release();
      }
    }
  }

  // -------------------------------------------------------------------------
  // INVENTORY JOBS
  // -------------------------------------------------------------------------

  /**
   * Her gün saat 09:00'da çalışır - Düşük stok uyarıları
   * Iterates ALL tenant schemas with dedicated QueryRunner per tenant.
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM, {
    name: 'checkLowStock',
    timeZone: 'Europe/Istanbul',
  })
  async checkLowStock(): Promise<void> {
    this.logger.log('Starting low stock check job');

    // Refresh tenant configs before processing
    await this.loadTenantConfigs();
    const tenantSchemas = await listTenantSchemas(this.dataSource);

    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

        const lowStockParts = await queryRunner.manager.find(SparePart, {
          where: {
            isActive: true,
            status: In([SparePartStatus.LOW_STOCK, SparePartStatus.OUT_OF_STOCK]),
          },
        });

        if (lowStockParts.length === 0) continue;

        // Group by tenantId
        const byTenant = new Map<string, SparePart[]>();
        for (const p of lowStockParts) {
          const list = byTenant.get(p.tenantId) || [];
          list.push(p);
          byTenant.set(p.tenantId, list);
        }

        for (const [tenantId, parts] of byTenant) {
          const config = this.getTenantConfig(tenantId);
          if (config && !config.alertsEnabled) continue;

          try {
            this.logger.warn(
              `Found ${parts.length} low stock parts for tenant ${tenantId} (schema: ${schema})`,
            );

            const outOfStock = parts.filter((p) => p.status === SparePartStatus.OUT_OF_STOCK);
            const lowStock = parts.filter((p) => p.status === SparePartStatus.LOW_STOCK);

            this.eventEmitter.emit('inventory.lowStock', {
              tenantId,
              outOfStock,
              lowStock,
            });
          } catch (error) {
            this.logger.error(
              `Failed to check low stock for tenant ${tenantId} in schema ${schema}: ${error}`,
            );
          }
        }
      } catch (err) {
        this.logger.error(`Low stock check failed for schema ${schema}: ${(err as Error).message}`);
      } finally {
        await queryRunner.query('RESET search_path').catch(() => {});
        await queryRunner.release();
      }
    }
  }

  // -------------------------------------------------------------------------
  // REPORTING JOBS
  // -------------------------------------------------------------------------

  /**
   * Her Pazartesi saat 06:00'da çalışır - Haftalık bakım özeti
   * Iterates ALL tenant schemas with dedicated QueryRunner per tenant.
   */
  @Cron(CronExpression.EVERY_WEEK, {
    name: 'weeklyMaintenanceSummary',
    timeZone: 'Europe/Istanbul',
  })
  async weeklyMaintenanceSummary(): Promise<void> {
    this.logger.log('Starting weekly maintenance summary job');

    // Refresh tenant configs before processing
    await this.loadTenantConfigs();
    const tenantSchemas = await listTenantSchemas(this.dataSource);

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

        const completedWorkOrders = await queryRunner.manager.find(WorkOrder, {
          where: {
            status: In([WorkOrderStatus.COMPLETED, WorkOrderStatus.VERIFIED]),
          },
        });

        if (completedWorkOrders.length === 0) continue;

        // Group by tenantId
        const byTenant = new Map<string, WorkOrder[]>();
        for (const wo of completedWorkOrders) {
          const list = byTenant.get(wo.tenantId) || [];
          list.push(wo);
          byTenant.set(wo.tenantId, list);
        }

        for (const [tenantId, workOrders] of byTenant) {
          const config = this.getTenantConfig(tenantId);
          if (config && !config.reportsEnabled) continue;

          try {
            const lastWeekCompleted = workOrders.filter(
              (wo) => wo.completedAt && wo.completedAt >= weekAgo,
            );

            const totalCompleted = lastWeekCompleted.length;
            const totalCost = lastWeekCompleted.reduce(
              (sum, wo) => sum + (Number(wo.costSummary?.totalCost) || 0),
              0,
            );
            const avgDuration =
              lastWeekCompleted.length > 0
                ? lastWeekCompleted.reduce((sum, wo) => sum + (wo.actualDurationMinutes || 0), 0) /
                  lastWeekCompleted.length
                : 0;

            this.eventEmitter.emit('report.weeklyMaintenance', {
              tenantId,
              period: { from: weekAgo, to: new Date() },
              statistics: { totalCompleted, totalCost, avgDuration },
              workOrders: lastWeekCompleted,
            });
          } catch (error) {
            this.logger.error(
              `Failed to generate weekly summary for tenant ${tenantId} in schema ${schema}: ${error}`,
            );
          }
        }
      } catch (err) {
        this.logger.error(
          `Weekly maintenance summary failed for schema ${schema}: ${(err as Error).message}`,
        );
      } finally {
        await queryRunner.query('RESET search_path').catch(() => {});
        await queryRunner.release();
      }
    }
  }

  /**
   * Her ayın 1'inde saat 06:00'da çalışır - Aylık compliance raporu
   * Iterates ALL tenant schemas with dedicated QueryRunner per tenant.
   */
  @Cron('0 6 1 * *', {
    name: 'monthlyComplianceReport',
    timeZone: 'Europe/Istanbul',
  })
  async monthlyComplianceReport(): Promise<void> {
    this.logger.log('Starting monthly compliance report job');

    // Refresh tenant configs before processing
    await this.loadTenantConfigs();
    const tenantSchemas = await listTenantSchemas(this.dataSource);

    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

        // Discover tenantIds within this schema
        const tenantRows: { tenantId: string }[] = await queryRunner.query(
          `SELECT DISTINCT "tenantId" AS "tenantId" FROM maintenance_schedules
           WHERE "deletedAt" IS NULL LIMIT 100`,
        );

        for (const { tenantId } of tenantRows) {
          const config = this.getTenantConfig(tenantId);
          if (config && !config.reportsEnabled) continue;

          try {
            const report = await this.maintenanceScheduleService.getComplianceReport(tenantId);

            this.eventEmitter.emit('report.monthlyCompliance', {
              tenantId,
              report,
              generatedAt: new Date(),
            });

            this.logger.log(
              `Compliance report generated for tenant ${tenantId} (schema: ${schema}): ${report.avgComplianceRate}% compliance`,
            );
          } catch (error) {
            this.logger.error(
              `Failed to generate compliance report for tenant ${tenantId} in schema ${schema}: ${error}`,
            );
          }
        }
      } catch (err) {
        this.logger.error(
          `Monthly compliance report failed for schema ${schema}: ${(err as Error).message}`,
        );
      } finally {
        await queryRunner.query('RESET search_path').catch(() => {});
        await queryRunner.release();
      }
    }
  }

  /**
   * Nightly data cleanup — runs 02:00 Europe/Istanbul.
   *
   * Currently invokes the `cleanup_old_audit_logs(p_retention_days int)`
   * PL/pgSQL function (defined in
   * apps/farm-service/src/database/migrations/003_create_audit_logs_table.sql)
   * for every tenant schema. The function was already shipped with the
   * audit_logs migration but was never scheduled — the farm_audit_logs
   * table was growing unbounded in practice. Tracked as Girdi 14b /
   * 15-B18 in docs/illustrator/farm-modulu-kor-noktalar-dogrulama.md.
   *
   * Retention window is read from the AUDIT_RETENTION_DAYS env var so
   * operators can raise it to satisfy stricter audit-trail requirements
   * (e.g. 365 days for some compliance regimes). Default 90 matches the
   * original SQL default and the existing audit-log.entity.ts docstring.
   *
   * Per-tenant iteration mirrors the pattern used by other cron jobs in
   * this file: each schema gets its own QueryRunner so a failure in one
   * tenant cannot block the rest.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: 'cleanupOldData',
    timeZone: 'Europe/Istanbul',
  })
  async cleanupOldData(): Promise<void> {
    const retentionPlan: Array<{
      label: string;
      fn: string;
      envVar: string;
      defaultDays: number;
    }> = [
      {
        label: 'farm_audit_logs',
        fn: 'cleanup_old_audit_logs',
        envVar: 'AUDIT_RETENTION_DAYS',
        defaultDays: 90,
      },
      {
        label: 'feeding_records',
        fn: 'cleanup_old_feeding_records',
        envVar: 'FEEDING_RECORD_RETENTION_DAYS',
        defaultDays: 800,
      },
      {
        label: 'growth_measurements',
        fn: 'cleanup_old_growth_measurements',
        envVar: 'GROWTH_MEASUREMENT_RETENTION_DAYS',
        defaultDays: 1825,
      },
      {
        label: 'water_quality_measurements',
        fn: 'cleanup_old_water_quality_measurements',
        envVar: 'WATER_QUALITY_RETENTION_DAYS',
        defaultDays: 1095,
      },
      {
        label: 'tank_operations',
        fn: 'cleanup_old_tank_operations',
        envVar: 'TANK_OPERATION_RETENTION_DAYS',
        defaultDays: 2555,
      },
      {
        label: 'harvest_records',
        fn: 'cleanup_old_harvest_records',
        envVar: 'HARVEST_RECORD_RETENTION_DAYS',
        defaultDays: 3650,
      },
    ];

    this.logger.log(`Starting nightly retention cleanup across ${retentionPlan.length} table(s)`);

    let tenantSchemas: string[];
    try {
      tenantSchemas = await listTenantSchemas(this.dataSource);
    } catch (err) {
      this.logger.error(
        `Failed to list tenant schemas for retention cleanup: ${(err as Error).message}`,
      );
      return;
    }

    const summary: Record<string, number> = {};
    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

        for (const plan of retentionPlan) {
          const retentionDays = Number(
            this.configService.get<number | string>(plan.envVar, plan.defaultDays),
          );
          const effective =
            Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : plan.defaultDays;

          try {
            const rows = (await queryRunner.query(`SELECT ${plan.fn}($1) AS deleted_count`, [
              effective,
            ])) as Array<{ deleted_count: number | string | null }>;

            const deleted = Number(rows?.[0]?.deleted_count ?? 0);
            summary[plan.label] = (summary[plan.label] ?? 0) + deleted;
            if (deleted > 0) {
              this.logger.log(
                `Tenant ${schema}: deleted ${deleted} ${plan.label} row(s) older than ${effective} days`,
              );
            }
          } catch (err) {
            // Retention functions may be missing on tenants whose
            // schema has not yet received the 1787000000000
            // migration. Log and continue so one missing function
            // does not abort the rest of the plan for this tenant.
            this.logger.warn(
              `Retention cleanup skipped for ${plan.label} on tenant ${schema}: ${(err as Error).message}`,
            );
          }
        }
      } finally {
        await queryRunner.release();
      }
    }

    const totalDeleted = Object.values(summary).reduce((a, b) => a + b, 0);
    const breakdown = Object.entries(summary)
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `${label}=${n}`)
      .join(', ');
    this.logger.log(
      `Retention cleanup completed — ${totalDeleted} row(s) deleted across ${tenantSchemas.length} tenant schema(s)${breakdown ? `; ${breakdown}` : ''}`,
    );
  }

  /**
   * Nightly materialized-view refresh — runs 03:00 Europe/Istanbul.
   *
   * Phase 7.2: farm analytics dashboards read from
   * `farm.mv_daily_batch_feeding` (migration 1787400000000) instead
   * of scanning `feeding_records` row-by-row. The view is refreshed
   * CONCURRENTLY so dashboard reads never block during the refresh.
   * Per-tenant iteration uses a dedicated QueryRunner per schema
   * so a single tenant's failure does not stall the rest.
   *
   * Worst-case staleness is one day — acceptable because the
   * batch-performance dashboards drive weekly operational reviews,
   * not real-time control loops. Ops can trigger a manual refresh
   * via `triggerJob('refreshAnalyticsViews')` for urgent cases.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'refreshAnalyticsViews',
    timeZone: 'Europe/Istanbul',
  })
  async refreshAnalyticsViews(): Promise<void> {
    const viewsToRefresh = ['farm.mv_daily_batch_feeding', 'farm.mv_daily_tank_water_quality'];

    this.logger.log(
      `Refreshing ${viewsToRefresh.length} analytics materialized view(s) across tenant schemas`,
    );

    let tenantSchemas: string[];
    try {
      tenantSchemas = await listTenantSchemas(this.dataSource);
    } catch (err) {
      this.logger.error(
        `Failed to list tenant schemas for analytics refresh: ${(err as Error).message}`,
      );
      return;
    }

    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);
        for (const view of viewsToRefresh) {
          try {
            await queryRunner.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
            this.logger.log(`Tenant ${schema}: refreshed ${view}`);
          } catch (err) {
            // View may not exist on a legacy tenant schema; log
            // and continue so the rest of the views still refresh
            // for the other tenants.
            this.logger.warn(
              `Tenant ${schema}: ${view} refresh skipped — ${(err as Error).message}`,
            );
          }
        }
      } finally {
        await queryRunner.release();
      }
    }
  }

  /**
   * Nightly MinIO orphan cleanup (phase 6.2.3). Deletes objects
   * in the configured bucket that no longer have a live
   * database reference AND are older than the safety threshold
   * (default 24 hours). Runs at 04:00 Europe/Istanbul — after
   * the 03:00 analytics view refresh completes but well before
   * the morning operator shift.
   *
   * The cron is a no-op when FarmOrphanCleanupService isn't DI-
   * registered (dev harnesses without StorageModule). This is
   * deliberate: the cron must be configurable to stay
   * independent of the rest of the scheduler's hot paths.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, {
    name: 'minioOrphanCleanup',
    timeZone: 'Europe/Istanbul',
  })
  async minioOrphanCleanup(): Promise<void> {
    if (!this.orphanCleanup) {
      this.logger.warn(
        'FarmOrphanCleanupService not available — minioOrphanCleanup ' +
          'cron is a no-op. Register StorageModule + FarmFileCleanupModule ' +
          'in app.module.ts to enable nightly MinIO orphan sweeps.',
      );
      return;
    }

    // Per-tenant execution is MANDATORY for correctness. The live-paths
    // providers read per-tenant document tables (cloned into tenant_<uuid>
    // schemas) and the bucket keys are tenant-prefixed
    // (`${tenantId}/...`, see MinioClientService.generateFilePath).
    // Running the cleanup with no tenant context routes the live-set query
    // to the EMPTY source `farm` schema while the bucket scan stays global
    // — which would delete every tenant's objects. Driving it per-tenant
    // inside withTenantContext makes the live-set scope and the
    // bucket-delete scope structurally identical: one tenant's documents
    // validated against one tenant's bucket prefix.
    const tenantSchemas = await listTenantSchemas(this.dataSource);
    let tenantsProcessed = 0;

    for (const schema of tenantSchemas) {
      let tenantId: string | null = null;

      const discoveryRunner = this.dataSource.createQueryRunner();
      await discoveryRunner.connect();
      try {
        await discoveryRunner.query(`SET search_path TO "${schema}", farm, public`);
        tenantId = await this.resolveTenantIdForSchema(discoveryRunner);
      } catch (err) {
        this.logger.error(
          `minioOrphanCleanup: tenant discovery failed for schema ${schema}: ` +
            `${(err as Error).message}`,
        );
      } finally {
        await discoveryRunner.query('RESET search_path').catch(() => {});
        await discoveryRunner.release();
      }

      // No document references in this schema → nothing this cleanup
      // could safely delete (the storage layer refuses to delete against
      // an empty live-set), so skip rather than scan its prefix blind.
      if (!tenantId) continue;

      try {
        await withTenantContext(tenantId, async () => {
          // `prefix` confines the bucket scan + delete to THIS tenant's
          // object namespace; withTenantContext routes the live-paths
          // providers' repositories to THIS tenant's schema. Both scopes
          // are the same tenant by construction.
          const summary = await this.orphanCleanup!.run({ prefix: `${tenantId}/` });
          tenantsProcessed += 1;
          if (summary.refused) {
            this.logger.warn(
              `minioOrphanCleanup: storage layer refused deletion for tenant ` +
                `${tenantId} (empty live-set over a non-empty scan) — ` +
                'investigate before trusting subsequent runs.',
            );
          }
        });
      } catch (err) {
        // One tenant's failure must not abort the whole sweep.
        this.logger.error(
          `minioOrphanCleanup failed for tenant ${tenantId} (schema ${schema}): ` +
            `${(err as Error).message}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    this.logger.log(
      `minioOrphanCleanup complete — schemas=${tenantSchemas.length} ` +
        `tenantsProcessed=${tenantsProcessed}`,
    );
  }

  /**
   * Resolve the full tenant UUID owning a tenant schema by reading it
   * from any document-bearing table within that schema.
   *
   * The schema name (`tenant_<first16hex>`) is NOT reversible to the
   * full UUID, and minioOrphanCleanup needs the full UUID for BOTH the
   * tenant context (search_path routing) AND the bucket key prefix
   * (`${tenantId}/...`). Returns null when the tenant has no document
   * references at all — there is nothing this cleanup could safely
   * delete in that case.
   *
   * The QueryRunner MUST already have its search_path pinned to the
   * target schema. All three tables expose a camelCase `"tenantId"`
   * column.
   */
  private async resolveTenantIdForSchema(queryRunner: QueryRunner): Promise<string | null> {
    const documentTables = ['farm_documents', 'batch_documents', 'chemicals'];
    for (const table of documentTables) {
      const rows: Array<{ tenantId: string }> = await queryRunner.query(
        `SELECT "tenantId" FROM "${table}" WHERE "tenantId" IS NOT NULL LIMIT 1`,
      );
      if (rows[0]?.tenantId) return rows[0].tenantId;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // MANUAL EXECUTION
  // -------------------------------------------------------------------------

  async triggerJob(jobName: string): Promise<void> {
    this.logger.log(`Manually triggering job: ${jobName}`);

    switch (jobName) {
      case 'generateMaintenanceWorkOrders':
        await this.generateMaintenanceWorkOrders();
        break;
      case 'checkOverdueMaintenance':
        await this.checkOverdueMaintenance();
        break;
      case 'checkOverdueWorkOrders':
        await this.checkOverdueWorkOrders();
        break;
      case 'checkLowStock':
        await this.checkLowStock();
        break;
      case 'weeklyMaintenanceSummary':
        await this.weeklyMaintenanceSummary();
        break;
      case 'monthlyComplianceReport':
        await this.monthlyComplianceReport();
        break;
      case 'refreshAnalyticsViews':
        await this.refreshAnalyticsViews();
        break;
      case 'minioOrphanCleanup':
        await this.minioOrphanCleanup();
        break;
      default:
        throw new Error(`Unknown job: ${jobName}`);
    }
  }

  getRegisteredJobs(): string[] {
    const jobs = this.schedulerRegistry.getCronJobs();
    return Array.from(jobs.keys());
  }

  getJobStatus(jobName: string): { running: boolean; lastRun?: Date; nextRun?: Date } {
    try {
      const job = this.schedulerRegistry.getCronJob(jobName);
      const isRunning = job.isCallbackRunning || false;
      return {
        running: isRunning,
        lastRun: job.lastDate() || undefined,
        nextRun: job.nextDate().toJSDate(),
      };
    } catch (error: unknown) {
      this.logger.debug(
        `Error in getJobStatus: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { running: false };
    }
  }

  pauseJob(jobName: string): void {
    const job = this.schedulerRegistry.getCronJob(jobName);
    job.stop();
    this.logger.log(`Paused job: ${jobName}`);
  }

  resumeJob(jobName: string): void {
    const job = this.schedulerRegistry.getCronJob(jobName);
    job.start();
    this.logger.log(`Resumed job: ${jobName}`);
  }
}
