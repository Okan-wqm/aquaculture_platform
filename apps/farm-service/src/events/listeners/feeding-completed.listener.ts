/**
 * FeedingCompletedListener
 *
 * Handles FeedingCompletedEvent and performs follow-up actions:
 * - Updates feed inventory
 * - Updates batch feeding statistics
 * - Tracks FCR calculations
 * - Handles feeding reminders and summaries
 *
 * @module Events/Listeners
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Feed, FeedStatus } from '../../feed/entities/feed.entity';
import { Batch } from '../../batch/entities/batch.entity';
import {
  EventNames,
  FeedingCompletedEventPayload,
  FeedingReminderEventPayload,
  FeedingDailySummaryEventPayload,
  FeedingFCRAlertEventPayload,
  FeedingWeeklyForecastEventPayload,
} from '../event-types';

@Injectable()
export class FeedingCompletedListener {
  private readonly logger = new Logger(FeedingCompletedListener.name);

  constructor(
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Handle FeedingCompleted event
   */
  @OnEvent(EventNames.FEEDING_COMPLETED)
  async handleFeedingCompleted(
    payload: FeedingCompletedEventPayload,
  ): Promise<void> {
    this.logger.log(
      `[FeedingCompleted] Processing: Batch ${payload.batchNumber}, ` +
      `${payload.quantity}${payload.unit} of ${payload.feedName}`,
    );

    try {
      // 1. Update feed inventory
      await this.updateFeedInventory(payload);

      // 2. Update batch feeding statistics
      await this.updateBatchFeedingStats(payload);

      // 3. Check for low stock after consumption
      await this.checkFeedStock(payload);

      // 4. Emit follow-up events
      this.emitFollowUpEvents(payload);

      this.logger.log(
        `[FeedingCompleted] Successfully processed feeding for batch ${payload.batchNumber}`,
      );
    } catch (error) {
      this.logger.error(
        `[FeedingCompleted] Failed to process feeding: ${error}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Handle FeedingReminder event
   */
  @OnEvent(EventNames.FEEDING_REMINDER)
  async handleFeedingReminder(
    payload: FeedingReminderEventPayload,
  ): Promise<void> {
    this.logger.log(
      `[FeedingReminder] Batch ${payload.batchNumber} in tank ${payload.tankCode}: ` +
      `${payload.quantity}${payload.unit} of ${payload.feedName} scheduled at ${payload.scheduledTime}`,
    );

    // Send notification
    this.eventEmitter.emit('notification.send', {
      tenantId: undefined, // Would need to be included in payload
      type: 'feeding_reminder',
      priority: 'normal',
      title: `Feeding Reminder: ${payload.batchNumber}`,
      message: `Feed ${payload.quantity}${payload.unit} of ${payload.feedName} to batch ${payload.batchNumber} in tank ${payload.tankCode}.`,
      data: {
        batchId: payload.batchId,
        tankId: payload.tankId,
        feedId: payload.feedId,
        quantity: payload.quantity,
        scheduledTime: payload.scheduledTime,
      },
    });
  }

  /**
   * Handle FeedingDailySummary event
   */
  @OnEvent(EventNames.FEEDING_DAILY_SUMMARY)
  async handleFeedingDailySummary(
    payload: FeedingDailySummaryEventPayload,
  ): Promise<void> {
    this.logger.log(
      `[FeedingDailySummary] Tenant ${payload.tenantId}: ` +
      `Planned: ${payload.summary.planned}, Completed: ${payload.summary.completed}, ` +
      `Skipped: ${payload.summary.skipped}, Total Feed: ${payload.summary.totalFeedUsed}kg`,
    );

    const completionRate = payload.summary.planned > 0
      ? ((payload.summary.completed / payload.summary.planned) * 100).toFixed(1)
      : '100';

    // Emit summary for dashboard
    this.eventEmitter.emit('dashboard.feedingSummary', {
      tenantId: payload.tenantId,
      date: payload.date,
      summary: {
        ...payload.summary,
        completionRate: parseFloat(completionRate),
      },
    });

    // Alert if completion rate is low
    if (parseFloat(completionRate) < 80) {
      this.logger.warn(
        `[FeedingDailySummary] Low feeding completion rate: ${completionRate}%`,
      );

      this.eventEmitter.emit('alert.lowFeedingCompletion', {
        tenantId: payload.tenantId,
        date: payload.date,
        completionRate: parseFloat(completionRate),
        skipped: payload.summary.skipped,
      });
    }

    // Send daily summary notification
    this.eventEmitter.emit('notification.send', {
      tenantId: payload.tenantId,
      type: 'feeding_daily_summary',
      priority: 'low',
      title: 'Daily Feeding Summary',
      message: `Feeding completion: ${completionRate}%. Total feed used: ${payload.summary.totalFeedUsed.toFixed(1)}kg.`,
      data: payload.summary,
    });
  }

  /**
   * Handle FeedingFCRAlerts event
   */
  @OnEvent(EventNames.FEEDING_FCR_ALERTS)
  async handleFeedingFCRAlerts(
    payload: FeedingFCRAlertEventPayload,
  ): Promise<void> {
    this.logger.warn(
      `[FeedingFCRAlerts] ${payload.alerts.length} FCR alerts for tenant ${payload.tenantId}`,
    );

    for (const alert of payload.alerts) {
      const variancePercent = ((alert.currentFCR - alert.targetFCR) / alert.targetFCR * 100).toFixed(1);

      this.logger.warn(
        `[${alert.alertLevel.toUpperCase()}] Batch ${alert.batchNumber}: ` +
        `FCR ${alert.currentFCR.toFixed(2)} (target: ${alert.targetFCR.toFixed(2)}, ` +
        `variance: ${variancePercent}%)`,
      );

      // Emit individual FCR alert
      this.eventEmitter.emit(EventNames.ALERT_FCR_THRESHOLD, {
        tenantId: payload.tenantId,
        batchId: alert.batchId,
        batchNumber: alert.batchNumber,
        currentFCR: alert.currentFCR,
        targetFCR: alert.targetFCR,
        variance: alert.variance,
        variancePercent: parseFloat(variancePercent),
        alertLevel: alert.alertLevel,
      });
    }

    // Send consolidated notification for critical alerts
    const criticalAlerts = payload.alerts.filter(
      (a) => a.alertLevel === 'critical',
    );

    if (criticalAlerts.length > 0) {
      this.eventEmitter.emit('notification.send', {
        tenantId: payload.tenantId,
        type: 'fcr_critical_alert',
        priority: 'high',
        title: `Critical FCR Alert: ${criticalAlerts.length} batches`,
        message: `The following batches have critically high FCR: ${criticalAlerts.map((a) => `${a.batchNumber} (FCR: ${a.currentFCR.toFixed(2)})`).join(', ')}`,
        data: { alerts: criticalAlerts },
      });
    }
  }

  /**
   * Handle FeedingWeeklyForecast event
   */
  @OnEvent(EventNames.FEEDING_WEEKLY_FORECAST)
  async handleFeedingWeeklyForecast(
    payload: FeedingWeeklyForecastEventPayload,
  ): Promise<void> {
    this.logger.log(
      `[FeedingWeeklyForecast] Tenant ${payload.tenantId}: ` +
      `Required: ${payload.forecast.totalRequired}kg, Current: ${payload.forecast.currentStock}kg, ` +
      `Shortfall: ${payload.forecast.shortfall}kg`,
    );

    // Alert if there's a projected shortfall
    if (payload.forecast.shortfall > 0) {
      this.logger.warn(
        `[FeedingWeeklyForecast] Projected feed shortfall: ${payload.forecast.shortfall}kg`,
      );

      this.eventEmitter.emit('alert.feedShortfallProjected', {
        tenantId: payload.tenantId,
        shortfall: payload.forecast.shortfall,
        requiredQuantity: payload.forecast.totalRequired,
        currentStock: payload.forecast.currentStock,
        byFeedType: payload.forecast.byFeedType,
      });

      // Send notification
      this.eventEmitter.emit('notification.send', {
        tenantId: payload.tenantId,
        type: 'feed_shortfall_forecast',
        priority: 'high',
        title: 'Weekly Feed Shortfall Projected',
        message: `Based on current consumption, you may run short by ${payload.forecast.shortfall.toFixed(1)}kg this week. ` +
          `Current stock: ${payload.forecast.currentStock.toFixed(1)}kg, Required: ${payload.forecast.totalRequired.toFixed(1)}kg.`,
        data: payload.forecast,
      });

      // Emit procurement suggestion
      this.eventEmitter.emit('procurement.reorderSuggested', {
        tenantId: payload.tenantId,
        type: 'feed',
        items: payload.forecast.byFeedType.map((feed) => ({
          id: feed.feedId,
          name: feed.feedName,
          suggestedQuantity: Math.ceil(feed.quantity * 1.2), // 20% buffer
          priority: 'high',
        })),
        reason: 'weekly_forecast_shortfall',
        suggestedAt: new Date(),
      });
    } else {
      // Log healthy stock levels
      const coverageDays = payload.forecast.totalRequired > 0
        ? ((payload.forecast.currentStock / payload.forecast.totalRequired) * 7).toFixed(1)
        : 'N/A';

      this.logger.log(
        `[FeedingWeeklyForecast] Stock is healthy. Estimated coverage: ${coverageDays} days`,
      );
    }
  }

  /**
   * Update feed inventory after consumption
   */
  private async updateFeedInventory(
    payload: FeedingCompletedEventPayload,
  ): Promise<void> {
    const feed = await this.feedRepository.findOne({
      where: { id: payload.feedId, tenantId: payload.tenantId },
    });

    if (!feed) {
      this.logger.warn(`Feed ${payload.feedId} not found for inventory update`);
      return;
    }

    // Deduct consumed quantity
    const previousQuantity = Number(feed.quantity);
    const consumedQuantity = payload.unit === 'kg' ? payload.quantity : payload.quantity / 1000;
    feed.quantity = Math.max(0, previousQuantity - consumedQuantity);

    // Update status based on new quantity
    if (feed.quantity <= 0) {
      feed.status = FeedStatus.OUT_OF_STOCK;
    } else if (feed.quantity <= feed.minStock) {
      feed.status = FeedStatus.LOW_STOCK;
    } else {
      feed.status = FeedStatus.AVAILABLE;
    }

    await this.feedRepository.save(feed);

    this.logger.debug(
      `Feed ${feed.name} inventory updated: ${previousQuantity}kg -> ${feed.quantity}kg`,
    );
  }

  /**
   * Update batch feeding statistics
   */
  private async updateBatchFeedingStats(
    payload: FeedingCompletedEventPayload,
  ): Promise<void> {
    const batch = await this.batchRepository.findOne({
      where: { id: payload.batchId, tenantId: payload.tenantId },
    });

    if (!batch) {
      this.logger.warn(`Batch ${payload.batchId} not found for feeding stats update`);
      return;
    }

    // Get feed for cost calculation
    const feed = await this.feedRepository.findOne({
      where: { id: payload.feedId, tenantId: payload.tenantId },
    });

    const consumedKg = payload.unit === 'kg' ? payload.quantity : payload.quantity / 1000;
    const feedCost = feed?.pricePerKg ? consumedKg * Number(feed.pricePerKg) : 0;

    // Update batch totals
    batch.totalFeedConsumed = Number(batch.totalFeedConsumed) + consumedKg;
    batch.totalFeedCost = Number(batch.totalFeedCost) + feedCost;

    // Update feeding summary
    batch.feedingSummary = {
      ...batch.feedingSummary,
      currentFeedId: payload.feedId,
      currentFeedName: payload.feedName,
      totalFeedGiven: Number(batch.totalFeedConsumed),
      totalFeedCost: Number(batch.totalFeedCost),
      lastFeedingAt: payload.feedingTime,
    };

    // Recalculate FCR
    const biomassGain = batch.getCurrentBiomass() - (batch.weight?.initial?.totalBiomass || 0);
    if (biomassGain > 0 && batch.totalFeedConsumed > 0) {
      batch.fcr = {
        ...batch.fcr,
        actual: Number(batch.totalFeedConsumed) / biomassGain,
        lastUpdatedAt: new Date(),
      };
    }

    await this.batchRepository.save(batch);

    this.logger.debug(
      `Batch ${batch.batchNumber} feeding stats updated: ` +
      `Total feed: ${batch.totalFeedConsumed}kg, FCR: ${batch.fcr?.actual?.toFixed(2) || 'N/A'}`,
    );
  }

  /**
   * Check feed stock levels after consumption
   */
  private async checkFeedStock(
    payload: FeedingCompletedEventPayload,
  ): Promise<void> {
    const feed = await this.feedRepository.findOne({
      where: { id: payload.feedId, tenantId: payload.tenantId },
    });

    if (!feed) return;

    // Emit low stock alert if needed
    if (feed.status === FeedStatus.OUT_OF_STOCK) {
      this.logger.warn(`Feed ${feed.name} is now OUT OF STOCK`);

      this.eventEmitter.emit(EventNames.FEEDING_LOW_STOCK, {
        tenantId: payload.tenantId,
        feeds: [{
          feedId: feed.id,
          feedName: feed.name,
          currentStock: Number(feed.quantity),
          minStock: Number(feed.minStock),
        }],
      });
    } else if (feed.status === FeedStatus.LOW_STOCK) {
      const percentRemaining = ((Number(feed.quantity) / Number(feed.minStock)) * 100).toFixed(0);

      this.logger.warn(
        `Feed ${feed.name} is LOW STOCK: ${feed.quantity}kg (${percentRemaining}% of min)`,
      );
    }
  }

  /**
   * Emit follow-up events
   */
  private emitFollowUpEvents(payload: FeedingCompletedEventPayload): void {
    // Emit for dashboard updates
    this.eventEmitter.emit('farm.statistics.updated', {
      tenantId: payload.tenantId,
      triggeredBy: 'feeding.completed',
      batchId: payload.batchId,
      feedConsumed: payload.quantity,
      feedUnit: payload.unit,
    });

    // Emit for feeding analytics
    this.eventEmitter.emit('analytics.feedingRecorded', {
      tenantId: payload.tenantId,
      batchId: payload.batchId,
      batchNumber: payload.batchNumber,
      tankId: payload.tankId,
      feedId: payload.feedId,
      feedName: payload.feedName,
      quantity: payload.quantity,
      unit: payload.unit,
      feedingTime: payload.feedingTime,
      fedBy: payload.fedBy,
    });
  }
}
