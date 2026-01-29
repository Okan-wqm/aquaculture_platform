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
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
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
}

@Injectable()
export class CronJobsService implements OnModuleInit {
  private readonly logger = new Logger(CronJobsService.name);
  private tenantConfigs: Map<string, TenantCronConfig> = new Map();

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
  ) {}

  async onModuleInit() {
    this.logger.log('CronJobsService initialized');
    await this.loadTenantConfigs();
  }

  /**
   * Load tenant configurations for cron jobs
   */
  private async loadTenantConfigs(): Promise<void> {
    const schedules = await this.scheduleRepository
      .createQueryBuilder('s')
      .select('DISTINCT s.tenantId', 'tenantId')
      .getRawMany();

    for (const { tenantId } of schedules) {
      this.tenantConfigs.set(tenantId, {
        tenantId,
        maintenanceEnabled: true,
        alertsEnabled: true,
        reportsEnabled: true,
        systemUserId: 'system',
      });
    }

    this.logger.log(`Loaded configurations for ${this.tenantConfigs.size} tenants`);
  }

  // -------------------------------------------------------------------------
  // MAINTENANCE SCHEDULE JOBS
  // -------------------------------------------------------------------------

  /**
   * Her gün saat 06:00'da çalışır - Otomatik iş emri oluşturma
   */
  @Cron(CronExpression.EVERY_DAY_AT_6AM, {
    name: 'generateMaintenanceWorkOrders',
    timeZone: 'Europe/Istanbul',
  })
  async generateMaintenanceWorkOrders(): Promise<void> {
    this.logger.log('Starting maintenance work order generation job');
    const startTime = Date.now();

    for (const [tenantId, config] of this.tenantConfigs) {
      if (!config.maintenanceEnabled) continue;

      try {
        const workOrders = await this.maintenanceScheduleService.processAutoGenerateWorkOrders(
          tenantId,
          config.systemUserId,
        );

        if (workOrders.length > 0) {
          this.logger.log(
            `Generated ${workOrders.length} work orders for tenant ${tenantId}`,
          );

          this.eventEmitter.emit('maintenance.workOrders.generated', {
            tenantId,
            workOrders,
          });
        }
      } catch (error) {
        this.logger.error(
          `Failed to generate work orders for tenant ${tenantId}: ${error}`,
        );
      }
    }

    const duration = Date.now() - startTime;
    this.logger.log(`Maintenance work order generation completed in ${duration}ms`);
  }

  /**
   * Her gün saat 07:00'da çalışır - Gecikmiş bakım uyarıları
   */
  @Cron(CronExpression.EVERY_DAY_AT_7AM, {
    name: 'checkOverdueMaintenance',
    timeZone: 'Europe/Istanbul',
  })
  async checkOverdueMaintenance(): Promise<void> {
    this.logger.log('Starting overdue maintenance check job');

    for (const [tenantId, config] of this.tenantConfigs) {
      if (!config.alertsEnabled) continue;

      try {
        const overdueSchedules = await this.scheduleRepository.find({
          where: {
            tenantId,
            status: MaintenanceScheduleStatus.ACTIVE,
          },
        });

        const actuallyOverdue = overdueSchedules.filter((s) => s.isOverdue());

        if (actuallyOverdue.length > 0) {
          this.logger.warn(
            `Found ${actuallyOverdue.length} overdue maintenance schedules for tenant ${tenantId}`,
          );

          this.eventEmitter.emit('maintenance.overdue', {
            tenantId,
            schedules: actuallyOverdue,
          });
        }

        const upcoming = overdueSchedules.filter((s) => {
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
          `Failed to check overdue maintenance for tenant ${tenantId}: ${error}`,
        );
      }
    }
  }

  /**
   * Her gün saat 08:00'da çalışır - Gecikmiş iş emirleri uyarısı
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM, {
    name: 'checkOverdueWorkOrders',
    timeZone: 'Europe/Istanbul',
  })
  async checkOverdueWorkOrders(): Promise<void> {
    this.logger.log('Starting overdue work orders check job');

    for (const [tenantId, config] of this.tenantConfigs) {
      if (!config.alertsEnabled) continue;

      try {
        const overdueWorkOrders = await this.workOrderRepository.find({
          where: {
            tenantId,
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

        const actuallyOverdue = overdueWorkOrders.filter((wo) => wo.isOverdue());

        if (actuallyOverdue.length > 0) {
          this.logger.warn(
            `Found ${actuallyOverdue.length} overdue work orders for tenant ${tenantId}`,
          );

          this.eventEmitter.emit('workOrder.overdue', {
            tenantId,
            workOrders: actuallyOverdue,
          });
        }
      } catch (error) {
        this.logger.error(
          `Failed to check overdue work orders for tenant ${tenantId}: ${error}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // INVENTORY JOBS
  // -------------------------------------------------------------------------

  /**
   * Her gün saat 09:00'da çalışır - Düşük stok uyarıları
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM, {
    name: 'checkLowStock',
    timeZone: 'Europe/Istanbul',
  })
  async checkLowStock(): Promise<void> {
    this.logger.log('Starting low stock check job');

    for (const [tenantId, config] of this.tenantConfigs) {
      if (!config.alertsEnabled) continue;

      try {
        const lowStockParts = await this.sparePartRepository.find({
          where: {
            tenantId,
            isActive: true,
            status: In([SparePartStatus.LOW_STOCK, SparePartStatus.OUT_OF_STOCK]),
          },
        });

        if (lowStockParts.length > 0) {
          this.logger.warn(
            `Found ${lowStockParts.length} low stock parts for tenant ${tenantId}`,
          );

          const outOfStock = lowStockParts.filter(
            (p) => p.status === SparePartStatus.OUT_OF_STOCK,
          );
          const lowStock = lowStockParts.filter(
            (p) => p.status === SparePartStatus.LOW_STOCK,
          );

          this.eventEmitter.emit('inventory.lowStock', {
            tenantId,
            outOfStock,
            lowStock,
          });
        }
      } catch (error) {
        this.logger.error(
          `Failed to check low stock for tenant ${tenantId}: ${error}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // REPORTING JOBS
  // -------------------------------------------------------------------------

  /**
   * Her Pazartesi saat 06:00'da çalışır - Haftalık bakım özeti
   */
  @Cron(CronExpression.EVERY_WEEK, {
    name: 'weeklyMaintenanceSummary',
    timeZone: 'Europe/Istanbul',
  })
  async weeklyMaintenanceSummary(): Promise<void> {
    this.logger.log('Starting weekly maintenance summary job');

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    for (const [tenantId, config] of this.tenantConfigs) {
      if (!config.reportsEnabled) continue;

      try {
        const completedWorkOrders = await this.workOrderRepository.find({
          where: {
            tenantId,
            status: In([WorkOrderStatus.COMPLETED, WorkOrderStatus.VERIFIED]),
          },
        });

        const lastWeekCompleted = completedWorkOrders.filter(
          (wo) => wo.completedAt && wo.completedAt >= weekAgo,
        );

        const totalCompleted = lastWeekCompleted.length;
        const totalCost = lastWeekCompleted.reduce(
          (sum, wo) => sum + (Number(wo.costSummary?.totalCost) || 0),
          0,
        );
        const avgDuration =
          lastWeekCompleted.length > 0
            ? lastWeekCompleted.reduce(
                (sum, wo) => sum + (wo.actualDurationMinutes || 0),
                0,
              ) / lastWeekCompleted.length
            : 0;

        this.eventEmitter.emit('report.weeklyMaintenance', {
          tenantId,
          period: { from: weekAgo, to: new Date() },
          statistics: { totalCompleted, totalCost, avgDuration },
          workOrders: lastWeekCompleted,
        });
      } catch (error) {
        this.logger.error(
          `Failed to generate weekly summary for tenant ${tenantId}: ${error}`,
        );
      }
    }
  }

  /**
   * Her ayın 1'inde saat 06:00'da çalışır - Aylık compliance raporu
   */
  @Cron('0 6 1 * *', {
    name: 'monthlyComplianceReport',
    timeZone: 'Europe/Istanbul',
  })
  async monthlyComplianceReport(): Promise<void> {
    this.logger.log('Starting monthly compliance report job');

    for (const [tenantId, config] of this.tenantConfigs) {
      if (!config.reportsEnabled) continue;

      try {
        const report = await this.maintenanceScheduleService.getComplianceReport(
          tenantId,
        );

        this.eventEmitter.emit('report.monthlyCompliance', {
          tenantId,
          report,
          generatedAt: new Date(),
        });

        this.logger.log(
          `Compliance report generated for tenant ${tenantId}: ${report.avgComplianceRate}% compliance`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to generate compliance report for tenant ${tenantId}: ${error}`,
        );
      }
    }
  }

  /**
   * Her gece saat 02:00'da çalışır - Eski verilerin temizliği
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: 'cleanupOldData',
    timeZone: 'Europe/Istanbul',
  })
  async cleanupOldData(): Promise<void> {
    this.logger.log('Starting data cleanup job');
    // Cleanup logic would go here
    this.logger.log('Data cleanup completed');
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
      return {
        running: job.running || false,
        lastRun: job.lastDate() || undefined,
        nextRun: job.nextDate().toJSDate(),
      };
    } catch {
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
