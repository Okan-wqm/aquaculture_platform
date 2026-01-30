/**
 * MortalityRecordedListener
 *
 * Handles MortalityRecordedEvent and performs follow-up actions:
 * - Updates batch count and statistics
 * - Triggers alerts for high mortality rates
 * - Updates tank density calculations
 * - Notifies relevant personnel
 *
 * @module Events/Listeners
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Batch } from '../../batch/entities/batch.entity';
import { MortalityRecord } from '../../batch/entities/mortality-record.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { EventNames, MortalityRecordedEventPayload } from '../event-types';

/**
 * Alert thresholds for mortality events
 */
interface MortalityAlertThresholds {
  dailyMortalityWarning: number;    // % of current quantity
  dailyMortalityCritical: number;   // % of current quantity
  cumulativeRateWarning: number;    // Total mortality rate %
  cumulativeRateCritical: number;   // Total mortality rate %
  singleEventQuantity: number;      // Absolute number for single event
}

const DEFAULT_THRESHOLDS: MortalityAlertThresholds = {
  dailyMortalityWarning: 0.5,       // 0.5% daily mortality
  dailyMortalityCritical: 1.0,      // 1% daily mortality
  cumulativeRateWarning: 5.0,       // 5% cumulative mortality
  cumulativeRateCritical: 10.0,     // 10% cumulative mortality
  singleEventQuantity: 100,         // 100+ fish in single event
};

@Injectable()
export class MortalityRecordedListener {
  private readonly logger = new Logger(MortalityRecordedListener.name);

  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(MortalityRecord)
    private readonly mortalityRecordRepository: Repository<MortalityRecord>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Handle MortalityRecorded event
   */
  @OnEvent(EventNames.MORTALITY_RECORDED)
  async handleMortalityRecorded(payload: MortalityRecordedEventPayload): Promise<void> {
    this.logger.log(
      `[MortalityRecorded] Processing event for batch ${payload.batchNumber}: ` +
      `${payload.quantity} fish, reason: ${payload.reason}`,
    );

    try {
      // 1. Log mortality event
      this.logMortalityEvent(payload);

      // 2. Calculate daily mortality trends
      const dailyMortality = await this.calculateDailyMortality(payload);

      // 3. Check for alert conditions
      await this.checkMortalityAlerts(payload, dailyMortality);

      // 4. Update batch statistics
      await this.updateBatchMortalityStats(payload);

      // 5. Emit follow-up events
      this.emitFollowUpEvents(payload, dailyMortality);

      this.logger.log(
        `[MortalityRecorded] Successfully processed event for batch ${payload.batchNumber}`,
      );
    } catch (error) {
      this.logger.error(
        `[MortalityRecorded] Failed to process event for batch ${payload.batchNumber}: ${error}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Log mortality event with relevant details
   */
  private logMortalityEvent(payload: MortalityRecordedEventPayload): void {
    this.logger.log(
      `[Mortality] Batch: ${payload.batchNumber}, Tank: ${payload.tankCode || payload.tankId}, ` +
      `Count: ${payload.quantity}, Biomass Loss: ${payload.biomassLoss.toFixed(2)}kg, ` +
      `Reason: ${payload.reason}${payload.detail ? ` (${payload.detail})` : ''}, ` +
      `New Rate: ${payload.newMortalityRate.toFixed(2)}%`,
    );
  }

  /**
   * Calculate daily mortality for the batch
   */
  private async calculateDailyMortality(
    payload: MortalityRecordedEventPayload,
  ): Promise<{
    todayCount: number;
    todayRate: number;
    weeklyAverage: number;
    trend: 'increasing' | 'stable' | 'decreasing';
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    // Get today's mortality records
    const todayRecords = await this.mortalityRecordRepository.find({
      where: {
        batchId: payload.batchId,
        tenantId: payload.tenantId,
        recordDate: MoreThan(today),
      },
    });

    const todayCount = todayRecords.reduce((sum, r) => sum + r.count, 0);

    // Get week's mortality records for trend analysis
    const weekRecords = await this.mortalityRecordRepository.find({
      where: {
        batchId: payload.batchId,
        tenantId: payload.tenantId,
        recordDate: MoreThan(weekAgo),
      },
      order: { recordDate: 'ASC' },
    });

    const weeklyTotal = weekRecords.reduce((sum, r) => sum + r.count, 0);
    const weeklyAverage = weeklyTotal / 7;

    // Calculate trend (compare last 3 days to first 3 days of week)
    const firstHalf = weekRecords
      .filter((r) => new Date(r.recordDate) < new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000))
      .reduce((sum, r) => sum + r.count, 0);
    const secondHalf = weekRecords
      .filter((r) => new Date(r.recordDate) >= new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000))
      .reduce((sum, r) => sum + r.count, 0);

    let trend: 'increasing' | 'stable' | 'decreasing' = 'stable';
    if (secondHalf > firstHalf * 1.5) {
      trend = 'increasing';
    } else if (secondHalf < firstHalf * 0.5) {
      trend = 'decreasing';
    }

    // Calculate today's rate based on current batch quantity before this mortality
    const totalBeforeMortality = payload.currentQuantity + payload.quantity;
    const todayRate = totalBeforeMortality > 0
      ? (todayCount / totalBeforeMortality) * 100
      : 0;

    return {
      todayCount,
      todayRate,
      weeklyAverage,
      trend,
    };
  }

  /**
   * Check for mortality alert conditions
   */
  private async checkMortalityAlerts(
    payload: MortalityRecordedEventPayload,
    dailyMortality: { todayCount: number; todayRate: number; trend: string },
  ): Promise<void> {
    const thresholds = DEFAULT_THRESHOLDS;
    const alerts: Array<{
      type: string;
      severity: 'warning' | 'critical';
      message: string;
    }> = [];

    // Check single event mortality
    if (payload.quantity >= thresholds.singleEventQuantity) {
      alerts.push({
        type: 'single_event',
        severity: payload.quantity >= thresholds.singleEventQuantity * 2 ? 'critical' : 'warning',
        message: `Single mortality event of ${payload.quantity} fish recorded`,
      });
    }

    // Check daily mortality rate
    if (dailyMortality.todayRate >= thresholds.dailyMortalityCritical) {
      alerts.push({
        type: 'daily_rate',
        severity: 'critical',
        message: `Daily mortality rate ${dailyMortality.todayRate.toFixed(2)}% exceeds critical threshold`,
      });
    } else if (dailyMortality.todayRate >= thresholds.dailyMortalityWarning) {
      alerts.push({
        type: 'daily_rate',
        severity: 'warning',
        message: `Daily mortality rate ${dailyMortality.todayRate.toFixed(2)}% exceeds warning threshold`,
      });
    }

    // Check cumulative mortality rate
    if (payload.newMortalityRate >= thresholds.cumulativeRateCritical) {
      alerts.push({
        type: 'cumulative_rate',
        severity: 'critical',
        message: `Cumulative mortality rate ${payload.newMortalityRate.toFixed(2)}% is critical`,
      });
    } else if (payload.newMortalityRate >= thresholds.cumulativeRateWarning) {
      alerts.push({
        type: 'cumulative_rate',
        severity: 'warning',
        message: `Cumulative mortality rate ${payload.newMortalityRate.toFixed(2)}% is elevated`,
      });
    }

    // Emit alerts
    if (alerts.length > 0) {
      this.logger.warn(
        `[MortalityAlert] ${alerts.length} alert(s) triggered for batch ${payload.batchNumber}`,
      );

      for (const alert of alerts) {
        this.eventEmitter.emit(EventNames.ALERT_HIGH_MORTALITY, {
          tenantId: payload.tenantId,
          batchId: payload.batchId,
          batchNumber: payload.batchNumber,
          tankId: payload.tankId,
          ...alert,
          mortalityRate: payload.newMortalityRate,
          reason: payload.reason,
          recordedAt: payload.observedAt,
        });

        this.logger.warn(
          `[${alert.severity.toUpperCase()}] ${alert.message}`,
        );
      }
    }
  }

  /**
   * Update batch mortality statistics
   */
  private async updateBatchMortalityStats(
    payload: MortalityRecordedEventPayload,
  ): Promise<void> {
    // Get the batch and update its mortality summary
    const batch = await this.batchRepository.findOne({
      where: { id: payload.batchId, tenantId: payload.tenantId },
    });

    if (batch) {
      // Update mortality by cause statistics
      const causeStats = await this.getMortalityByCause(
        payload.tenantId,
        payload.batchId,
      );

      this.logger.debug(
        `Batch ${payload.batchNumber} mortality by cause: ` +
        Object.entries(causeStats)
          .map(([cause, count]) => `${cause}: ${count}`)
          .join(', '),
      );

      // Emit statistics update event
      this.eventEmitter.emit('batch.mortalityStats.updated', {
        tenantId: payload.tenantId,
        batchId: payload.batchId,
        batchNumber: payload.batchNumber,
        currentQuantity: payload.currentQuantity,
        mortalityRate: payload.newMortalityRate,
        survivalRate: 100 - payload.newMortalityRate,
        causeBreakdown: causeStats,
      });
    }

    // Update tank batch density
    const tankBatch = await this.tankBatchRepository.findOne({
      where: { tankId: payload.tankId, tenantId: payload.tenantId },
    });

    if (tankBatch) {
      this.logger.debug(
        `Tank ${payload.tankCode || payload.tankId} updated: ` +
        `${tankBatch.totalQuantity} fish, ${Number(tankBatch.totalBiomassKg).toFixed(2)}kg, ` +
        `density: ${Number(tankBatch.densityKgM3).toFixed(2)}kg/m3`,
      );
    }
  }

  /**
   * Get mortality count grouped by cause
   */
  private async getMortalityByCause(
    tenantId: string,
    batchId: string,
  ): Promise<Record<string, number>> {
    const records = await this.mortalityRecordRepository.find({
      where: { tenantId, batchId },
      select: ['cause', 'count'],
    });

    const byCause: Record<string, number> = {};
    for (const record of records) {
      const cause = record.cause || 'unknown';
      byCause[cause] = (byCause[cause] || 0) + record.count;
    }

    return byCause;
  }

  /**
   * Emit follow-up events
   */
  private emitFollowUpEvents(
    payload: MortalityRecordedEventPayload,
    dailyMortality: { todayCount: number; trend: string },
  ): void {
    // Emit event for dashboard updates
    this.eventEmitter.emit('farm.statistics.updated', {
      tenantId: payload.tenantId,
      triggeredBy: 'mortality.recorded',
      batchId: payload.batchId,
      quantityChange: -payload.quantity,
      biomassChange: -payload.biomassLoss,
    });

    // If mortality trend is increasing, emit trend alert
    if (dailyMortality.trend === 'increasing') {
      this.eventEmitter.emit('batch.mortalityTrend.increasing', {
        tenantId: payload.tenantId,
        batchId: payload.batchId,
        batchNumber: payload.batchNumber,
        reason: payload.reason,
        todayCount: dailyMortality.todayCount,
      });
    }

    // Emit notification for severe cases
    if (payload.newMortalityRate > DEFAULT_THRESHOLDS.cumulativeRateCritical) {
      this.eventEmitter.emit('notification.send', {
        tenantId: payload.tenantId,
        type: 'mortality_critical',
        priority: 'high',
        title: `Critical Mortality Alert - ${payload.batchNumber}`,
        message: `Batch ${payload.batchNumber} has reached ${payload.newMortalityRate.toFixed(1)}% mortality rate. Immediate attention required.`,
        data: {
          batchId: payload.batchId,
          tankId: payload.tankId,
          reason: payload.reason,
        },
      });
    }
  }
}
