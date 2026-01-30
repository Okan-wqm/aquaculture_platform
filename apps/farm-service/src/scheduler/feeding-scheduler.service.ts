/**
 * FeedingScheduler Service
 *
 * Otomatik yemleme planlaması ve yönetimi.
 * Batch bazlı yemleme programları ve FCR optimizasyonu.
 *
 * Görevler:
 * - Günlük yemleme planı oluşturma
 * - Yemleme hatırlatmaları
 * - FCR analizi ve uyarıları
 * - Yem stok kontrolü
 *
 * @module Scheduler
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual, In } from 'typeorm';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Entities
import { FeedingRecord, FeedingMethod, FishAppetite } from '../feeding/entities/feeding-record.entity';
import { FeedingTable, FeedingTableStatus } from '../feeding/entities/feeding-table.entity';
import { Batch, BatchStatus } from '../batch/entities/batch.entity';
import { Feed, FeedStatus } from '../feed/entities/feed.entity';
import { FeedInventory, InventoryStatus } from '../feeding/entities/feed-inventory.entity';

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Feeding schedule entry
 */
export interface FeedingEntry {
  id: string;
  batchId: string;
  batchNumber: string;
  tankId: string;
  tankCode: string;
  feedId: string;
  feedName: string;
  scheduledTime: Date;
  quantity: number;
  unit: string;
  status: 'pending' | 'completed' | 'skipped' | 'overdue';
}

/**
 * Daily feeding plan
 */
export interface DailyFeedingPlan {
  tenantId: string;
  date: Date;
  entries: FeedingEntry[];
  totalFeedQuantity: number;
  batchCount: number;
}

/**
 * FCR Alert
 */
export interface FCRAlert {
  batchId: string;
  batchNumber: string;
  currentFCR: number;
  targetFCR: number;
  variance: number;
  alertLevel: 'warning' | 'critical';
}

/**
 * Feeding schedule status
 */
export type FeedingStatus = 'pending' | 'completed' | 'skipped' | 'overdue';

/**
 * Upcoming feeding result
 */
export interface UpcomingFeeding {
  scheduleId: string;
  batchId: string;
  batchNumber: string;
  feedId: string;
  feedName: string;
  scheduledDate: Date;
  feedAmount: number;
  feedingFrequency: number;
  perFeedingAmount: number;
}

/**
 * Feeding execution result
 */
export interface FeedingExecutionResult {
  success: boolean;
  feedingRecordId?: string;
  error?: string;
  feedAmount: number;
  feedCost?: number;
}

/**
 * Calculate feed amount result
 */
export interface FeedAmountCalculation {
  dailyFeedKg: number;
  perMealFeedKg: number;
  feedingFrequency: number;
  feedingRatePercent: number;
  biomassKg: number;
  avgWeightG: number;
  quantity: number;
  method: 'table' | 'calculated' | 'default';
}

/**
 * Tenant configuration for feeding scheduler
 */
interface TenantFeedingConfig {
  tenantId: string;
  feedingEnabled: boolean;
  fcrAlertsEnabled: boolean;
  stockAlertsEnabled: boolean;
  systemUserId: string;
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class FeedingSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(FeedingSchedulerService.name);
  private tenantConfigs: Map<string, TenantFeedingConfig> = new Map();

  constructor(
    @InjectRepository(FeedingRecord)
    private readonly feedingRecordRepository: Repository<FeedingRecord>,
    @InjectRepository(FeedingTable)
    private readonly feedingTableRepository: Repository<FeedingTable>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(FeedInventory)
    private readonly feedInventoryRepository: Repository<FeedInventory>,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    this.logger.log('FeedingSchedulerService initialized');
    await this.loadTenantConfigs();
  }

  // -------------------------------------------------------------------------
  // TENANT CONFIGURATION
  // -------------------------------------------------------------------------

  /**
   * Load tenant configurations for feeding scheduler
   */
  private async loadTenantConfigs(): Promise<void> {
    try {
      // Get all unique tenants from active batches
      const tenants = await this.batchRepository
        .createQueryBuilder('batch')
        .select('DISTINCT batch.tenantId', 'tenantId')
        .where('batch.isActive = :isActive', { isActive: true })
        .getRawMany();

      for (const { tenantId } of tenants) {
        this.tenantConfigs.set(tenantId, {
          tenantId,
          feedingEnabled: true,
          fcrAlertsEnabled: true,
          stockAlertsEnabled: true,
          systemUserId: 'system',
        });
      }

      this.logger.log(`Loaded feeding configurations for ${this.tenantConfigs.size} tenants`);
    } catch (error) {
      this.logger.error(`Failed to load tenant configs: ${error}`);
    }
  }

  /**
   * Get active tenants for scheduled jobs
   */
  private async getActiveTenants(): Promise<string[]> {
    // Refresh tenant configs
    await this.loadTenantConfigs();
    return Array.from(this.tenantConfigs.keys());
  }

  // -------------------------------------------------------------------------
  // CORE METHODS (User requested)
  // -------------------------------------------------------------------------

  /**
   * Get active feeding schedules for a tenant
   * Returns all active FeedingTable records with their schedules
   *
   * @param tenantId - Tenant identifier for data isolation
   * @returns Array of active FeedingTable records
   */
  async getFeedingSchedules(tenantId: string): Promise<FeedingTable[]> {
    this.logger.debug(`Getting feeding schedules for tenant ${tenantId}`);

    try {
      const schedules = await this.feedingTableRepository.find({
        where: {
          tenantId,
          status: FeedingTableStatus.ACTIVE,
          isActive: true,
        },
        relations: ['batch', 'feed'],
        order: {
          startDate: 'ASC',
        },
      });

      this.logger.debug(`Found ${schedules.length} active feeding schedules for tenant ${tenantId}`);
      return schedules;
    } catch (error) {
      this.logger.error(`Failed to get feeding schedules for tenant ${tenantId}: ${error}`);
      throw error;
    }
  }

  /**
   * Get upcoming feedings due in the next X hours
   *
   * @param tenantId - Tenant identifier for data isolation
   * @param hours - Number of hours to look ahead
   * @returns Array of upcoming feeding entries
   */
  async getUpcomingFeedings(tenantId: string, hours: number = 24): Promise<UpcomingFeeding[]> {
    this.logger.debug(`Getting upcoming feedings for tenant ${tenantId} in next ${hours} hours`);

    try {
      const now = new Date();
      const futureDate = new Date(now.getTime() + hours * 60 * 60 * 1000);
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);

      // Get active feeding tables
      const feedingTables = await this.feedingTableRepository.find({
        where: {
          tenantId,
          status: FeedingTableStatus.ACTIVE,
          isActive: true,
        },
        relations: ['batch', 'feed'],
      });

      const upcomingFeedings: UpcomingFeeding[] = [];

      for (const table of feedingTables) {
        // Check if the schedule has entries for today or coming days within the range
        if (!table.schedule || table.schedule.length === 0) {
          continue;
        }

        // Find schedule entries within the time range
        for (const entry of table.schedule) {
          const entryDate = new Date(entry.date);

          // Check if this entry falls within our time window
          if (entryDate >= today && entryDate <= futureDate) {
            upcomingFeedings.push({
              scheduleId: table.id,
              batchId: table.batchId,
              batchNumber: table.batch?.batchNumber || 'Unknown',
              feedId: table.feedId,
              feedName: table.feed?.name || 'Unknown Feed',
              scheduledDate: entryDate,
              feedAmount: entry.feedAmount,
              feedingFrequency: entry.feedingFrequency,
              perFeedingAmount: entry.perFeedingAmount,
            });
          }
        }
      }

      // Sort by scheduled date
      upcomingFeedings.sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime());

      this.logger.debug(`Found ${upcomingFeedings.length} upcoming feedings for tenant ${tenantId}`);
      return upcomingFeedings;
    } catch (error) {
      this.logger.error(`Failed to get upcoming feedings for tenant ${tenantId}: ${error}`);
      throw error;
    }
  }

  /**
   * Execute a feeding schedule - creates a feeding record
   *
   * @param scheduleId - FeedingTable ID to execute
   * @param executedBy - User ID who performed the feeding
   * @param actualAmount - Optional actual amount fed (defaults to scheduled amount)
   * @param notes - Optional notes about the feeding
   * @returns Feeding execution result
   */
  async executeFeedingSchedule(
    scheduleId: string,
    executedBy: string = 'system',
    actualAmount?: number,
    notes?: string,
  ): Promise<FeedingExecutionResult> {
    this.logger.log(`Executing feeding schedule ${scheduleId}`);

    try {
      // Get the feeding table
      const feedingTable = await this.feedingTableRepository.findOne({
        where: { id: scheduleId },
        relations: ['batch', 'feed'],
      });

      if (!feedingTable) {
        throw new NotFoundException(`Feeding schedule ${scheduleId} not found`);
      }

      if (feedingTable.status !== FeedingTableStatus.ACTIVE) {
        throw new BadRequestException(`Feeding schedule ${scheduleId} is not active`);
      }

      // Get today's schedule entry
      const todayEntry = feedingTable.getTodaySchedule();
      if (!todayEntry) {
        throw new BadRequestException(`No schedule entry found for today in schedule ${scheduleId}`);
      }

      // Determine the feed amount
      const plannedAmount = todayEntry.perFeedingAmount;
      const feedAmount = actualAmount ?? plannedAmount;

      // Get the batch to find tank information
      const batch = feedingTable.batch;
      if (!batch) {
        throw new NotFoundException(`Batch not found for schedule ${scheduleId}`);
      }

      // Calculate feed cost
      const feed = feedingTable.feed;
      const feedCost = feed?.pricePerKg ? feedAmount * Number(feed.pricePerKg) : undefined;

      // Determine current feeding sequence for today
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const existingRecords = await this.feedingRecordRepository.count({
        where: {
          tenantId: feedingTable.tenantId,
          batchId: feedingTable.batchId,
          feedingDate: Between(todayStart, todayEnd),
        },
      });

      const feedingSequence = existingRecords + 1;

      // Create feeding record
      const feedingRecord = this.feedingRecordRepository.create({
        tenantId: feedingTable.tenantId,
        batchId: feedingTable.batchId,
        feedId: feedingTable.feedId,
        feedingDate: new Date(),
        feedingTime: new Date().toTimeString().slice(0, 5), // HH:MM format
        feedingSequence,
        totalMealsToday: todayEntry.feedingFrequency,
        plannedAmount,
        actualAmount: feedAmount,
        variance: feedAmount - plannedAmount,
        variancePercent: plannedAmount > 0 ? ((feedAmount - plannedAmount) / plannedAmount) * 100 : 0,
        feedingMethod: FeedingMethod.MANUAL,
        feedCost,
        currency: feed?.currency || 'TRY',
        fedBy: executedBy,
        notes,
      });

      const savedRecord = await this.feedingRecordRepository.save(feedingRecord);

      // Update batch feed consumption
      await this.updateBatchFeedConsumption(feedingTable.tenantId, feedingTable.batchId, feedAmount, feedCost);

      // Emit feeding executed event
      this.eventEmitter.emit('feeding.executed', {
        tenantId: feedingTable.tenantId,
        feedingRecordId: savedRecord.id,
        batchId: feedingTable.batchId,
        feedAmount,
        executedBy,
      });

      this.logger.log(`Successfully executed feeding for schedule ${scheduleId}, record ${savedRecord.id}`);

      return {
        success: true,
        feedingRecordId: savedRecord.id,
        feedAmount,
        feedCost,
      };
    } catch (error) {
      this.logger.error(`Failed to execute feeding schedule ${scheduleId}: ${error}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        feedAmount: 0,
      };
    }
  }

  /**
   * Update feeding record status
   *
   * @param id - FeedingRecord ID
   * @param status - New status ('pending', 'completed', 'skipped', 'overdue')
   * @param reason - Optional reason for status change (required for 'skipped')
   * @param updatedBy - User ID who updated the status
   */
  async updateFeedingStatus(
    id: string,
    status: FeedingStatus,
    reason?: string,
    updatedBy?: string,
  ): Promise<FeedingRecord> {
    this.logger.debug(`Updating feeding record ${id} status to ${status}`);

    try {
      const feedingRecord = await this.feedingRecordRepository.findOne({
        where: { id },
      });

      if (!feedingRecord) {
        throw new NotFoundException(`Feeding record ${id} not found`);
      }

      // Update status-related fields based on new status
      if (status === 'completed') {
        if (!feedingRecord.verifiedBy && updatedBy) {
          feedingRecord.verifiedBy = updatedBy;
          feedingRecord.verifiedAt = new Date();
        }
      } else if (status === 'skipped') {
        if (!reason) {
          throw new BadRequestException('Reason is required when skipping a feeding');
        }
        feedingRecord.skipReason = reason;
        feedingRecord.actualAmount = 0;
        feedingRecord.calculateVariance();
      }

      // Note: FeedingRecord entity doesn't have a status field directly
      // The status is typically derived from actualAmount and other fields
      // We'll add a note to track the status change
      const statusNote = `Status changed to ${status}${reason ? ': ' + reason : ''}`;
      feedingRecord.notes = feedingRecord.notes
        ? `${feedingRecord.notes}\n${statusNote}`
        : statusNote;

      const updatedRecord = await this.feedingRecordRepository.save(feedingRecord);

      // Emit status change event
      this.eventEmitter.emit('feeding.statusChanged', {
        feedingRecordId: id,
        status,
        reason,
        updatedBy,
      });

      this.logger.log(`Successfully updated feeding record ${id} status to ${status}`);
      return updatedRecord;
    } catch (error) {
      this.logger.error(`Failed to update feeding status for ${id}: ${error}`);
      throw error;
    }
  }

  /**
   * Calculate feed amount based on batch biomass
   *
   * Uses the following priority:
   * 1. Active FeedingTable for the batch (if exists)
   * 2. Feed's feeding curve/matrix with bilinear interpolation
   * 3. Default 3% of body weight
   *
   * @param batchId - Batch ID to calculate feed for
   * @param waterTemperature - Optional water temperature for 2D matrix interpolation
   * @returns Feed amount calculation result
   */
  async calculateFeedAmount(
    batchId: string,
    waterTemperature?: number,
  ): Promise<FeedAmountCalculation> {
    this.logger.debug(`Calculating feed amount for batch ${batchId}`);

    try {
      // Get batch with current biomass data
      const batch = await this.batchRepository.findOne({
        where: { id: batchId },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} not found`);
      }

      const biomassKg = batch.getCurrentBiomass();
      const avgWeightG = batch.getCurrentAvgWeight();
      const quantity = batch.currentQuantity;

      // Method 1: Check for active FeedingTable
      const feedingTable = await this.feedingTableRepository.findOne({
        where: {
          tenantId: batch.tenantId,
          batchId,
          status: FeedingTableStatus.ACTIVE,
          isActive: true,
        },
      });

      if (feedingTable) {
        const todaySchedule = feedingTable.getTodaySchedule();
        if (todaySchedule) {
          return {
            dailyFeedKg: todaySchedule.feedAmount,
            perMealFeedKg: todaySchedule.perFeedingAmount,
            feedingFrequency: todaySchedule.feedingFrequency,
            feedingRatePercent: todaySchedule.feedingRatePercent,
            biomassKg,
            avgWeightG,
            quantity,
            method: 'table',
          };
        }
      }

      // Method 2: Calculate based on feed's feeding curve/matrix
      // Get the batch's current feed assignment
      const currentFeedId = batch.feedingSummary?.currentFeedId;
      if (currentFeedId) {
        const feed = await this.feedRepository.findOne({
          where: { id: currentFeedId },
        });

        if (feed) {
          let feedingRatePercent = 3.0; // Default

          // Try 2D matrix with water temperature
          if (feed.feedingMatrix2D && waterTemperature !== undefined) {
            const matrix = typeof feed.feedingMatrix2D === 'string'
              ? JSON.parse(feed.feedingMatrix2D)
              : feed.feedingMatrix2D;

            feedingRatePercent = this.interpolateFeedingRate(
              matrix,
              waterTemperature,
              avgWeightG,
            );
          }
          // Try 1D feeding curve
          else if (feed.feedingCurve) {
            const curve = typeof feed.feedingCurve === 'string'
              ? JSON.parse(feed.feedingCurve)
              : feed.feedingCurve;

            feedingRatePercent = this.getFeedingRateFromCurve(curve, avgWeightG);
          }

          const dailyFeedKg = (biomassKg * feedingRatePercent) / 100;
          const feedingFrequency = this.getRecommendedFeedingFrequency(avgWeightG);

          return {
            dailyFeedKg: Math.round(dailyFeedKg * 100) / 100,
            perMealFeedKg: Math.round((dailyFeedKg / feedingFrequency) * 100) / 100,
            feedingFrequency,
            feedingRatePercent,
            biomassKg,
            avgWeightG,
            quantity,
            method: 'calculated',
          };
        }
      }

      // Method 3: Default calculation (3% of body weight)
      const defaultFeedingRatePercent = 3.0;
      const dailyFeedKg = (biomassKg * defaultFeedingRatePercent) / 100;
      const feedingFrequency = this.getRecommendedFeedingFrequency(avgWeightG);

      return {
        dailyFeedKg: Math.round(dailyFeedKg * 100) / 100,
        perMealFeedKg: Math.round((dailyFeedKg / feedingFrequency) * 100) / 100,
        feedingFrequency,
        feedingRatePercent: defaultFeedingRatePercent,
        biomassKg,
        avgWeightG,
        quantity,
        method: 'default',
      };
    } catch (error) {
      this.logger.error(`Failed to calculate feed amount for batch ${batchId}: ${error}`);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // DAILY FEEDING JOBS
  // -------------------------------------------------------------------------

  /**
   * Her gün saat 05:00'da çalışır - Günlük yemleme planı oluşturma
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM, {
    name: 'generateDailyFeedingPlan',
    timeZone: 'Europe/Istanbul',
  })
  async generateDailyFeedingPlan(): Promise<void> {
    this.logger.log('Starting daily feeding plan generation');

    try {
      const tenantIds = await this.getActiveTenants();

      for (const tenantId of tenantIds) {
        const config = this.tenantConfigs.get(tenantId);
        if (!config?.feedingEnabled) continue;

        try {
          await this.generateTenantFeedingPlan(tenantId, new Date());
        } catch (error) {
          this.logger.error(`Failed to generate feeding plan for tenant ${tenantId}: ${error}`);
        }
      }

      this.logger.log('Daily feeding plan generation completed');
    } catch (error) {
      this.logger.error(`Failed to generate daily feeding plan: ${error}`);
    }
  }

  /**
   * Her saat başı çalışır - Yemleme hatırlatmaları
   */
  @Cron(CronExpression.EVERY_HOUR, {
    name: 'sendFeedingReminders',
    timeZone: 'Europe/Istanbul',
  })
  async sendFeedingReminders(): Promise<void> {
    this.logger.log('Checking for feeding reminders');

    try {
      const tenantIds = await this.getActiveTenants();
      const now = new Date();

      for (const tenantId of tenantIds) {
        const config = this.tenantConfigs.get(tenantId);
        if (!config?.feedingEnabled) continue;

        try {
          const upcomingFeedings = await this.getUpcomingFeedings(tenantId, 1);

          for (const feeding of upcomingFeedings) {
            this.eventEmitter.emit('feeding.reminder', {
              tenantId,
              ...feeding,
              reminderTime: now,
            });
          }

          if (upcomingFeedings.length > 0) {
            this.logger.log(`Sent ${upcomingFeedings.length} feeding reminders for tenant ${tenantId}`);
          }
        } catch (error) {
          this.logger.error(`Failed to send feeding reminders for tenant ${tenantId}: ${error}`);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to send feeding reminders: ${error}`);
    }
  }

  /**
   * Her gün saat 20:00'da çalışır - Günlük yemleme özeti ve analizi
   */
  @Cron(CronExpression.EVERY_DAY_AT_8PM, {
    name: 'dailyFeedingSummary',
    timeZone: 'Europe/Istanbul',
  })
  async dailyFeedingSummary(): Promise<void> {
    this.logger.log('Generating daily feeding summary');

    try {
      const tenantIds = await this.getActiveTenants();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      for (const tenantId of tenantIds) {
        try {
          const summary = await this.generateFeedingSummary(tenantId, today);

          this.eventEmitter.emit('feeding.dailySummary', {
            tenantId,
            date: today,
            summary,
          });
        } catch (error) {
          this.logger.error(`Failed to generate feeding summary for tenant ${tenantId}: ${error}`);
        }
      }

      this.logger.log('Daily feeding summary completed');
    } catch (error) {
      this.logger.error(`Failed to generate daily feeding summary: ${error}`);
    }
  }

  // -------------------------------------------------------------------------
  // FCR MONITORING JOBS
  // -------------------------------------------------------------------------

  /**
   * Her gün saat 18:00'da çalışır - FCR analizi ve uyarıları
   */
  @Cron(CronExpression.EVERY_DAY_AT_6PM, {
    name: 'analyzeFCR',
    timeZone: 'Europe/Istanbul',
  })
  async analyzeFCR(): Promise<void> {
    this.logger.log('Starting FCR analysis');

    try {
      const tenantIds = await this.getActiveTenants();

      for (const tenantId of tenantIds) {
        const config = this.tenantConfigs.get(tenantId);
        if (!config?.fcrAlertsEnabled) continue;

        try {
          const alerts = await this.checkFCRAlerts(tenantId);

          if (alerts.length > 0) {
            this.logger.warn(
              `Found ${alerts.length} FCR alerts for tenant ${tenantId}`,
            );

            this.eventEmitter.emit('feeding.fcrAlerts', {
              tenantId,
              alerts,
            });
          }
        } catch (error) {
          this.logger.error(`Failed to analyze FCR for tenant ${tenantId}: ${error}`);
        }
      }

      this.logger.log('FCR analysis completed');
    } catch (error) {
      this.logger.error(`Failed to analyze FCR: ${error}`);
    }
  }

  // -------------------------------------------------------------------------
  // FEED STOCK JOBS
  // -------------------------------------------------------------------------

  /**
   * Her gün saat 10:00'da çalışır - Yem stok kontrolü
   */
  @Cron(CronExpression.EVERY_DAY_AT_10AM, {
    name: 'checkFeedStock',
    timeZone: 'Europe/Istanbul',
  })
  async checkFeedStock(): Promise<void> {
    this.logger.log('Checking feed stock levels');

    try {
      const tenantIds = await this.getActiveTenants();

      for (const tenantId of tenantIds) {
        const config = this.tenantConfigs.get(tenantId);
        if (!config?.stockAlertsEnabled) continue;

        try {
          const lowStockFeeds = await this.getLowStockFeeds(tenantId);

          if (lowStockFeeds.length > 0) {
            this.logger.warn(
              `Found ${lowStockFeeds.length} low stock feeds for tenant ${tenantId}`,
            );

            this.eventEmitter.emit('feeding.lowStock', {
              tenantId,
              feeds: lowStockFeeds,
            });
          }

          const expiringFeeds = await this.getExpiringFeeds(tenantId, 7);
          if (expiringFeeds.length > 0) {
            this.eventEmitter.emit('feeding.expiryWarning', {
              tenantId,
              feeds: expiringFeeds,
              daysUntilExpiry: 7,
            });
          }
        } catch (error) {
          this.logger.error(`Failed to check feed stock for tenant ${tenantId}: ${error}`);
        }
      }

      this.logger.log('Feed stock check completed');
    } catch (error) {
      this.logger.error(`Failed to check feed stock: ${error}`);
    }
  }

  /**
   * Her hafta Pazartesi saat 07:00'da çalışır - Haftalık yem tüketim tahmini
   */
  @Cron('0 7 * * 1', {
    name: 'weeklyFeedForecast',
    timeZone: 'Europe/Istanbul',
  })
  async weeklyFeedForecast(): Promise<void> {
    this.logger.log('Generating weekly feed consumption forecast');

    try {
      const tenantIds = await this.getActiveTenants();

      for (const tenantId of tenantIds) {
        try {
          const forecast = await this.generateFeedForecast(tenantId, 7);

          this.eventEmitter.emit('feeding.weeklyForecast', {
            tenantId,
            forecast,
          });
        } catch (error) {
          this.logger.error(`Failed to generate feed forecast for tenant ${tenantId}: ${error}`);
        }
      }

      this.logger.log('Weekly feed forecast completed');
    } catch (error) {
      this.logger.error(`Failed to generate weekly feed forecast: ${error}`);
    }
  }

  // -------------------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------------------

  /**
   * Generate tenant feeding plan for a specific date
   */
  private async generateTenantFeedingPlan(
    tenantId: string,
    date: Date,
  ): Promise<DailyFeedingPlan> {
    const entries: FeedingEntry[] = [];
    let totalFeedQuantity = 0;

    // Get active feeding tables
    const feedingTables = await this.feedingTableRepository.find({
      where: {
        tenantId,
        status: FeedingTableStatus.ACTIVE,
        isActive: true,
      },
      relations: ['batch', 'feed'],
    });

    for (const table of feedingTables) {
      const scheduleEntry = table.getScheduleForDate(date);
      if (!scheduleEntry) continue;

      // Create feeding entries for each meal of the day
      const mealTimes = this.getMealTimes(scheduleEntry.feedingFrequency);

      for (let i = 0; i < mealTimes.length; i++) {
        const mealTime = mealTimes[i];
        if (mealTime === undefined) continue;

        const scheduledTime = new Date(date);
        scheduledTime.setHours(mealTime, 0, 0, 0);

        entries.push({
          id: `${table.id}-${i + 1}`,
          batchId: table.batchId,
          batchNumber: table.batch?.batchNumber || 'Unknown',
          tankId: '', // Would need to be populated from batch location
          tankCode: '',
          feedId: table.feedId,
          feedName: table.feed?.name || 'Unknown',
          scheduledTime,
          quantity: scheduleEntry.perFeedingAmount,
          unit: 'kg',
          status: 'pending',
        });

        totalFeedQuantity += scheduleEntry.perFeedingAmount;
      }
    }

    const uniqueBatches = new Set(entries.map((e) => e.batchId));

    this.eventEmitter.emit('feeding.planGenerated', {
      tenantId,
      date,
      entryCount: entries.length,
      totalFeedQuantity,
      batchCount: uniqueBatches.size,
    });

    return {
      tenantId,
      date,
      entries,
      totalFeedQuantity,
      batchCount: uniqueBatches.size,
    };
  }

  /**
   * Generate feeding summary for a date
   */
  private async generateFeedingSummary(
    tenantId: string,
    date: Date,
  ): Promise<{
    planned: number;
    completed: number;
    skipped: number;
    totalFeedUsed: number;
  }> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // Get feeding records for the day
    const records = await this.feedingRecordRepository.find({
      where: {
        tenantId,
        feedingDate: Between(startOfDay, endOfDay),
      },
    });

    // Get expected feedings from active schedules
    const schedules = await this.feedingTableRepository.find({
      where: {
        tenantId,
        status: FeedingTableStatus.ACTIVE,
        isActive: true,
      },
    });

    let planned = 0;
    for (const schedule of schedules) {
      const todayEntry = schedule.getScheduleForDate(date);
      if (todayEntry) {
        planned += todayEntry.feedingFrequency;
      }
    }

    const completed = records.filter((r) => r.actualAmount > 0).length;
    const skipped = records.filter((r) => r.skipReason != null).length;
    const totalFeedUsed = records.reduce(
      (sum, r) => sum + Number(r.actualAmount || 0),
      0,
    );

    return {
      planned,
      completed,
      skipped,
      totalFeedUsed,
    };
  }

  /**
   * Check FCR alerts for a tenant
   */
  private async checkFCRAlerts(tenantId: string): Promise<FCRAlert[]> {
    const alerts: FCRAlert[] = [];

    // Get active batches with FCR data
    const batches = await this.batchRepository.find({
      where: {
        tenantId,
        isActive: true,
        status: In([BatchStatus.ACTIVE, BatchStatus.GROWING]),
      },
    });

    for (const batch of batches) {
      const targetFCR = batch.fcr?.target || 1.5;
      const currentFCR = batch.fcr?.actual || 0;

      if (currentFCR <= 0) continue;

      const variance = ((currentFCR - targetFCR) / targetFCR) * 100;

      // Warning if FCR is 10-20% above target
      // Critical if FCR is >20% above target
      if (variance > 20) {
        alerts.push({
          batchId: batch.id,
          batchNumber: batch.batchNumber,
          currentFCR,
          targetFCR,
          variance,
          alertLevel: 'critical',
        });
      } else if (variance > 10) {
        alerts.push({
          batchId: batch.id,
          batchNumber: batch.batchNumber,
          currentFCR,
          targetFCR,
          variance,
          alertLevel: 'warning',
        });
      }
    }

    return alerts;
  }

  /**
   * Get low stock feeds for a tenant
   */
  private async getLowStockFeeds(
    tenantId: string,
  ): Promise<{ feedId: string; feedName: string; currentStock: number; minStock: number }[]> {
    // Check feed inventory
    const lowStockInventory = await this.feedInventoryRepository.find({
      where: {
        tenantId,
        status: In([InventoryStatus.LOW_STOCK, InventoryStatus.OUT_OF_STOCK]),
      },
      relations: ['feed'],
    });

    return lowStockInventory.map((inv) => ({
      feedId: inv.feedId,
      feedName: inv.feed?.name || 'Unknown',
      currentStock: Number(inv.quantityKg),
      minStock: Number(inv.minStockKg),
    }));
  }

  /**
   * Get expiring feeds for a tenant
   */
  private async getExpiringFeeds(
    tenantId: string,
    days: number,
  ): Promise<{ feedId: string; feedName: string; expiryDate: Date; quantity: number }[]> {
    const expiryThreshold = new Date();
    expiryThreshold.setDate(expiryThreshold.getDate() + days);

    const expiringInventory = await this.feedInventoryRepository.find({
      where: {
        tenantId,
        expiryDate: LessThanOrEqual(expiryThreshold),
        status: In([InventoryStatus.AVAILABLE, InventoryStatus.LOW_STOCK]),
      },
      relations: ['feed'],
    });

    return expiringInventory
      .filter((inv) => inv.expiryDate != null)
      .map((inv) => ({
        feedId: inv.feedId,
        feedName: inv.feed?.name || 'Unknown',
        expiryDate: inv.expiryDate as Date,
        quantity: Number(inv.quantityKg),
      }));
  }

  /**
   * Generate feed forecast for a tenant
   */
  private async generateFeedForecast(
    tenantId: string,
    days: number,
  ): Promise<{
    totalRequired: number;
    byFeedType: { feedId: string; feedName: string; quantity: number }[];
    currentStock: number;
    shortfall: number;
  }> {
    const feedRequirements = new Map<string, { feedId: string; feedName: string; quantity: number }>();
    let totalRequired = 0;

    // Get active feeding tables
    const feedingTables = await this.feedingTableRepository.find({
      where: {
        tenantId,
        status: FeedingTableStatus.ACTIVE,
        isActive: true,
      },
      relations: ['feed'],
    });

    const today = new Date();
    for (const table of feedingTables) {
      for (let d = 0; d < days; d++) {
        const date = new Date(today);
        date.setDate(date.getDate() + d);

        const scheduleEntry = table.getScheduleForDate(date);
        if (scheduleEntry) {
          const dailyAmount = scheduleEntry.feedAmount;
          totalRequired += dailyAmount;

          const existing = feedRequirements.get(table.feedId);
          if (existing) {
            existing.quantity += dailyAmount;
          } else {
            feedRequirements.set(table.feedId, {
              feedId: table.feedId,
              feedName: table.feed?.name || 'Unknown',
              quantity: dailyAmount,
            });
          }
        }
      }
    }

    // Get current stock
    const inventory = await this.feedInventoryRepository.find({
      where: {
        tenantId,
        status: In([InventoryStatus.AVAILABLE, InventoryStatus.LOW_STOCK]),
      },
    });

    const currentStock = inventory.reduce(
      (sum, inv) => sum + Number(inv.quantityKg),
      0,
    );

    const shortfall = Math.max(0, totalRequired - currentStock);

    return {
      totalRequired: Math.round(totalRequired * 100) / 100,
      byFeedType: Array.from(feedRequirements.values()),
      currentStock: Math.round(currentStock * 100) / 100,
      shortfall: Math.round(shortfall * 100) / 100,
    };
  }

  /**
   * Update batch feed consumption after feeding
   */
  private async updateBatchFeedConsumption(
    tenantId: string,
    batchId: string,
    feedAmount: number,
    feedCost?: number,
  ): Promise<void> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    if (batch) {
      batch.totalFeedConsumed = Number(batch.totalFeedConsumed) + feedAmount;
      if (feedCost) {
        batch.totalFeedCost = Number(batch.totalFeedCost) + feedCost;
      }

      // Update feeding summary
      batch.feedingSummary = {
        ...batch.feedingSummary,
        totalFeedGiven: Number(batch.feedingSummary?.totalFeedGiven || 0) + feedAmount,
        totalFeedCost: Number(batch.feedingSummary?.totalFeedCost || 0) + (feedCost || 0),
        lastFeedingAt: new Date(),
      };

      await this.batchRepository.save(batch);
    }
  }

  /**
   * Get meal times based on feeding frequency
   */
  private getMealTimes(frequency: number): number[] {
    switch (frequency) {
      case 1:
        return [8];
      case 2:
        return [8, 16];
      case 3:
        return [7, 12, 17];
      case 4:
        return [6, 10, 14, 18];
      case 5:
        return [6, 9, 12, 15, 18];
      case 6:
        return [6, 8, 10, 14, 16, 18];
      default:
        return [8, 12, 16];
    }
  }

  /**
   * Get recommended feeding frequency based on fish weight
   */
  private getRecommendedFeedingFrequency(avgWeightG: number): number {
    if (avgWeightG < 5) return 6;
    if (avgWeightG < 20) return 5;
    if (avgWeightG < 50) return 4;
    if (avgWeightG < 100) return 3;
    if (avgWeightG < 500) return 2;
    return 1;
  }

  /**
   * Simple bilinear interpolation for feeding rate
   */
  private interpolateFeedingRate(
    matrix: { temperatures: number[]; weights: number[]; rates: number[][] },
    temperature: number,
    weightG: number,
  ): number {
    const { temperatures, weights, rates } = matrix;

    if (!temperatures?.length || !weights?.length || !rates?.length) {
      return 3.0; // Default
    }

    // Find bounding indices for temperature
    const tIdx = this.findBoundingIndex(temperatures, temperature);
    const wIdx = this.findBoundingIndex(weights, weightG);

    // Simple nearest neighbor for now (could be enhanced with full bilinear)
    const tI = Math.max(0, Math.min(tIdx, temperatures.length - 1));
    const wI = Math.max(0, Math.min(wIdx, weights.length - 1));

    return rates[tI]?.[wI] ?? 3.0;
  }

  /**
   * Find bounding index in sorted array
   */
  private findBoundingIndex(arr: number[], value: number): number {
    for (let i = 0; i < arr.length - 1; i++) {
      const current = arr[i];
      const next = arr[i + 1];
      if (current !== undefined && next !== undefined && value >= current && value < next) {
        return i;
      }
    }
    return arr.length - 1;
  }

  /**
   * Get feeding rate from 1D curve
   */
  private getFeedingRateFromCurve(
    curve: { fishWeightG: number; feedingRatePercent: number }[],
    avgWeightG: number,
  ): number {
    if (!Array.isArray(curve) || curve.length === 0) {
      return 3.0;
    }

    const sorted = [...curve].sort((a, b) => b.fishWeightG - a.fishWeightG);
    const point = sorted.find((p) => avgWeightG >= p.fishWeightG);

    return point?.feedingRatePercent ?? 3.0;
  }

  // -------------------------------------------------------------------------
  // MANUAL EXECUTION
  // -------------------------------------------------------------------------

  /**
   * Manually trigger feeding plan generation for a tenant
   */
  async triggerFeedingPlanGeneration(tenantId: string, date?: Date): Promise<DailyFeedingPlan> {
    const targetDate = date || new Date();
    this.logger.log(`Manually generating feeding plan for tenant ${tenantId}`);
    return this.generateTenantFeedingPlan(tenantId, targetDate);
  }

  /**
   * Get feeding schedule for a specific date
   */
  async getFeedingSchedule(tenantId: string, date: Date): Promise<FeedingEntry[]> {
    const plan = await this.generateTenantFeedingPlan(tenantId, date);
    return plan.entries;
  }

  /**
   * Mark a feeding as completed
   */
  async markFeedingCompleted(
    feedingId: string,
    actualQuantity: number,
    completedBy: string,
    notes?: string,
  ): Promise<void> {
    this.logger.log(`Marking feeding ${feedingId} as completed`);

    const record = await this.feedingRecordRepository.findOne({
      where: { id: feedingId },
    });

    if (!record) {
      throw new NotFoundException(`Feeding record ${feedingId} not found`);
    }

    record.actualAmount = actualQuantity;
    record.calculateVariance();
    record.verifiedBy = completedBy;
    record.verifiedAt = new Date();
    if (notes) {
      record.notes = record.notes ? `${record.notes}\n${notes}` : notes;
    }

    await this.feedingRecordRepository.save(record);

    // Update batch consumption
    await this.updateBatchFeedConsumption(
      record.tenantId,
      record.batchId,
      actualQuantity,
      record.feedCost ? Number(record.feedCost) : undefined,
    );
  }

  /**
   * Skip a feeding with reason
   */
  async skipFeeding(
    feedingId: string,
    reason: string,
    skippedBy: string,
  ): Promise<void> {
    this.logger.log(`Skipping feeding ${feedingId}: ${reason}`);

    await this.updateFeedingStatus(feedingId, 'skipped', reason, skippedBy);
  }

  /**
   * Get registered scheduler jobs
   */
  getRegisteredJobs(): string[] {
    const jobs = this.schedulerRegistry.getCronJobs();
    return Array.from(jobs.keys()).filter((name) =>
      ['generateDailyFeedingPlan', 'sendFeedingReminders', 'dailyFeedingSummary',
       'analyzeFCR', 'checkFeedStock', 'weeklyFeedForecast'].includes(name),
    );
  }
}
