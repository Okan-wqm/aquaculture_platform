/**
 * FeedingCompletedListener
 *
 * Handles in-process feeding lifecycle events emitted by the feeding
 * scheduler:
 * - Feeding reminders
 * - Daily feeding summaries
 * - FCR alerts
 * - Weekly feed forecasts
 *
 * Feed-stock + batch-feeding-stat updates are NOT handled here. They are
 * applied transactionally on the feeding WRITE path
 * (CreateFeedingRecordHandler / DailyFeedingExecutionService) which is the
 * SSoT for stock movement. The former `@OnEvent(FEEDING_COMPLETED)` handler
 * here was DEAD: nothing in farm-service emits FEEDING_COMPLETED on the
 * in-process EventEmitter2 (the real producer publishes FeedingRecorded
 * through outbox → NATS). Its inline Feed.quantity / batch-stat / low-stock
 * mutations duplicated — and could silently diverge from — the write path,
 * so they were removed with the dead handler (ORPHAN-MEDIUM-106).
 *
 * @module Events/Listeners
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  EventNames,
  FeedingReminderEventPayload,
  FeedingDailySummaryEventPayload,
  FeedingFCRAlertEventPayload,
  FeedingWeeklyForecastEventPayload,
} from '../event-types';

@Injectable()
export class FeedingCompletedListener {
  private readonly logger = new Logger(FeedingCompletedListener.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Handle FeedingReminder event
   */
  @OnEvent(EventNames.FEEDING_REMINDER)
  async handleFeedingReminder(
    payload: FeedingReminderEventPayload,
  ): Promise<void> {
    // tankCode is optional (a batch can span tanks) — render it only when set
    // so the message never reads "in tank undefined".
    const tankSuffix = payload.tankCode ? ` in tank ${payload.tankCode}` : '';
    this.logger.log(
      `[FeedingReminder] Batch ${payload.batchNumber}${tankSuffix}: ` +
      `${payload.quantity}${payload.unit} of ${payload.feedName} scheduled at ${payload.scheduledTime}`,
    );

    // Send notification — tenantId now flows from the reminder payload so the
    // fan-out routes to the correct tenant (was hardcoded undefined).
    this.eventEmitter.emit('notification.send', {
      tenantId: payload.tenantId,
      type: 'feeding_reminder',
      priority: 'normal',
      title: `Feeding Reminder: ${payload.batchNumber}`,
      message: `Feed ${payload.quantity}${payload.unit} of ${payload.feedName} to batch ${payload.batchNumber}${tankSuffix}.`,
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
}
