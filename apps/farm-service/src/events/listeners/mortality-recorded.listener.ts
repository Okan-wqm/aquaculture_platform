/**
 * MortalityRecordedListener
 *
 * Subscribes to the `MortalityRecorded` NATS domain event (published by
 * RecordMortalityHandler through the transactional outbox) and performs the
 * follow-up actions that close the mortality loop:
 *   - Re-derives daily / cumulative mortality trends from the tenant's records
 *   - Raises high-mortality alerts when thresholds are breached
 *   - Refreshes batch mortality-by-cause statistics
 *
 * WHY THIS WAS REWRITTEN (dead-listeners HIGH):
 *   The previous implementation subscribed via `@OnEvent(EventNames.MORTALITY_RECORDED)`
 *   on the in-process EventEmitter2 bus, expecting a `MortalityRecordedEventPayload`.
 *   But the producer (RecordMortalityHandler) publishes ONLY through
 *   `@platform/outbox` → NATS, emitting the flat `@platform/event-contracts`
 *   `MortalityRecordedEvent`. Nothing ever emitted on the in-process bus, so the
 *   listener — and therefore every high-mortality alert — was dead.
 *
 *   The fix mirrors the in-repo reference pattern (HarvestCompletedListener):
 *   implement `IEventHandler<MortalityRecordedEvent>` + `OnModuleInit` and
 *   `eventBus.subscribeWildcard('MortalityRecorded', this)`. The handler body is
 *   remapped onto the contract's flat field names.
 *
 * FIELD REMAP (local payload → contract):
 *   The old `MortalityRecordedEventPayload` carried DB-derived display fields
 *   (`batchNumber`, `biomassLoss`, `currentQuantity`, `tankCode`, `observedAt`)
 *   that the wire contract `MortalityRecordedEvent` does NOT carry — the contract
 *   is flat and minimal (`batchId`, `tankId?`, `quantity`, `reason`,
 *   `mortalityDate`, `newTotalMortality`, `newMortalityRate`). Anything the
 *   listener needs beyond the contract is re-derived from the tenant's own rows
 *   (it already queries them for trend analysis), so no contract field is invented.
 *
 * TENANT CONTEXT:
 *   NATS handlers run OUTSIDE the HTTP request context — there is no
 *   AsyncLocalStorage tenant context and no TenantSchemaMiddleware. All repository
 *   work is wrapped in `withTenantContext(event.tenantId, ...)` so the injected
 *   repositories route to the correct `tenant_<uuid>` schema via search_path
 *   (the documented primitive; see libs/backend-common withTenantContext).
 *
 * @module Events/Listeners
 */
import { isValidUUID } from '@aquaculture/backend-common/database';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { RedisService } from '@aquaculture/backend-common/redis';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { toEventIso,
  createBaseEvent,
  type MortalityAlertRaisedEvent,
  type MortalityRecordedEvent,
} from '@platform/event-contracts';
import { MoreThan, Repository } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { MortalityRecord } from '../../batch/entities/mortality-record.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';

/**
 * Alert thresholds for mortality events
 */
interface MortalityAlertThresholds {
  dailyMortalityWarning: number; // % of current quantity
  dailyMortalityCritical: number; // % of current quantity
  cumulativeRateWarning: number; // Total mortality rate %
  cumulativeRateCritical: number; // Total mortality rate %
  singleEventQuantity: number; // Absolute number for single event
}

const DEFAULT_THRESHOLDS: MortalityAlertThresholds = {
  dailyMortalityWarning: 0.5, // 0.5% daily mortality
  dailyMortalityCritical: 1.0, // 1% daily mortality
  cumulativeRateWarning: 5.0, // 5% cumulative mortality
  cumulativeRateCritical: 10.0, // 10% cumulative mortality
  singleEventQuantity: 100, // 100+ fish in single event
};

/**
 * A single mortality alert derived from threshold evaluation. Surfaced so the
 * handler can both publish it on the bus and so unit tests can assert the
 * alerting side effect fires.
 */
export interface MortalityAlert {
  type: 'single_event' | 'daily_rate' | 'cumulative_rate';
  severity: 'warning' | 'critical';
  message: string;
}

@Injectable()
export class MortalityRecordedListener
  implements IEventHandler<MortalityRecordedEvent>, OnModuleInit
{
  private readonly logger = new Logger(MortalityRecordedListener.name);

  /**
   * Idempotency-claim TTL. Comfortably exceeds the consumer's redelivery window
   * (max_deliver 3 × ack_wait) so every crash-before-ack / ack-timeout retry of
   * one trigger sees the claim, while still expiring so the key space does not
   * grow unbounded. Symmetric with HarvestCompletedListener.
   */
  private static readonly DEDUP_TTL_SECONDS = 24 * 60 * 60; // 24h

  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(MortalityRecord)
    private readonly mortalityRecordRepository: Repository<MortalityRecord>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    // EVENT_BUS is provided globally by EventBusModule (@Global). @Optional()
    // keeps the listener constructible in unit tests / NATS-less harnesses;
    // subscription is then skipped with a warning rather than crashing boot.
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
    // RedisService (RedisModule @Global) backs the inbound idempotency claim so a
    // crash-before-ack redelivery does not write a duplicate AlertHistory row.
    // @Optional() + narrowed Pick type keeps the listener constructible in
    // Redis-less harnesses (claim degrades to best-effort) and lets unit tests
    // pass a minimal double with no cast.
    @Optional() @Inject(RedisService)
    private readonly redisService?: Pick<RedisService, 'setNx' | 'del'>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — MortalityRecorded subscription skipped. ' +
          'High-mortality alerts and mortality statistics will not update.',
      );
      return;
    }

    // `subscribeWildcard` builds `events.*.MortalityRecorded`, matching the
    // producer's per-tenant `events.{tenantId}.MortalityRecorded` for every
    // tenant — mortality alerting is a cross-tenant platform concern.
    await this.eventBus.subscribeWildcard('MortalityRecorded', this);
    this.logger.log(
      'Subscribed to MortalityRecorded events for high-mortality alerting (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'MortalityRecorded';
  }

  /**
   * Handle a MortalityRecorded contract event.
   *
   * Fault-tolerant by design: a failure in alerting/statistics must never
   * affect the already-committed mortality record (the outbox guarantees the
   * source write landed). Errors are logged and swallowed so NATS does not
   * redeliver a poison message indefinitely.
   */
  async handle(event: MortalityRecordedEvent): Promise<void> {
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'MortalityRecorded event has missing/invalid tenantId — skipping to ' +
          'prevent cross-tenant statistics corruption.',
      );
      return;
    }

    this.logger.log(
      `[MortalityRecorded] Processing batch=${event.batchId} ` +
        `quantity=${event.quantity} reason=${event.reason} ` +
        `tenant=${event.tenantId.substring(0, 8)}...`,
    );

    // INBOUND IDEMPOTENCY: atomically claim this trigger eventId. A prior
    // delivery that already ran the alert side effects wins the claim, so a
    // crash-before-ack / ack-timeout redelivery skips re-publishing and never
    // writes a duplicate AlertHistory row downstream (symmetric with
    // HarvestCompletedListener).
    const claimed = await this.claimEvent(event);
    if (!claimed) {
      this.logger.log(
        `[MortalityRecorded] eventId=${event.eventId} already processed — ` +
          'skipping to avoid a duplicate mortality alert.',
      );
      return;
    }

    try {
      await withTenantContext(event.tenantId, async () => {
        // 1. Re-derive daily mortality trend from the tenant's records.
        const dailyMortality = await this.calculateDailyMortality(event);

        // 2. Evaluate alert thresholds and publish any breaches.
        const alerts = this.evaluateMortalityAlerts(event, dailyMortality);
        await this.publishMortalityAlerts(event, alerts);

        // 3. Refresh batch mortality-by-cause statistics.
        await this.refreshBatchMortalityStats(event);
      });

      this.logger.log(
        `[MortalityRecorded] Successfully processed batch=${event.batchId}`,
      );
    } catch (error) {
      // Release the claim so a legitimate redelivery can retry the side effects
      // rather than being permanently suppressed by a transient failure.
      await this.releaseEvent(event);
      this.logger.error(
        `[MortalityRecorded] Failed to process batch=${event.batchId}: ` +
          `${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /** Redis key for the inbound idempotency claim of one trigger eventId. */
  private dedupKey(event: MortalityRecordedEvent): string {
    return `mortality-listener:processed:${event.tenantId}:${event.eventId}`;
  }

  /**
   * Atomically claim this trigger eventId. Returns true when this delivery won
   * the claim (first to process), false when a prior delivery already claimed it.
   * When Redis is unavailable the claim is treated as won (best-effort
   * single-instance dev) — fresh follow-up ids still prevent the msgID-collision
   * class, so duplicate-suppression degrades gracefully without breaking output.
   */
  private async claimEvent(event: MortalityRecordedEvent): Promise<boolean> {
    if (!this.redisService) {
      return true;
    }
    try {
      return await this.redisService.setNx(
        this.dedupKey(event),
        '1',
        MortalityRecordedListener.DEDUP_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Idempotency claim failed (treating as won): ${(error as Error).message}`,
      );
      return true;
    }
  }

  /** Release a previously-won claim so a redelivery can retry after a failure. */
  private async releaseEvent(event: MortalityRecordedEvent): Promise<void> {
    if (!this.redisService) {
      return;
    }
    try {
      await this.redisService.del(this.dedupKey(event));
    } catch (error) {
      this.logger.warn(
        `Idempotency claim release failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Calculate daily / weekly mortality trend for the batch from its records.
   *
   * The contract event carries `newTotalMortality` and `newMortalityRate`
   * (post-write cumulative figures) but NOT the per-day rate, so the per-day
   * figures are derived from the tenant's mortality_records rows.
   */
  private async calculateDailyMortality(event: MortalityRecordedEvent): Promise<{
    todayCount: number;
    todayRate: number;
    weeklyAverage: number;
    trend: 'increasing' | 'stable' | 'decreasing';
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const todayRecords = await this.mortalityRecordRepository.find({
      where: {
        batchId: event.batchId,
        tenantId: event.tenantId,
        recordDate: MoreThan(today),
      },
    });
    const todayCount = todayRecords.reduce((sum, r) => sum + r.count, 0);

    const weekRecords = await this.mortalityRecordRepository.find({
      where: {
        batchId: event.batchId,
        tenantId: event.tenantId,
        recordDate: MoreThan(weekAgo),
      },
      order: { recordDate: 'ASC' },
    });
    const weeklyTotal = weekRecords.reduce((sum, r) => sum + r.count, 0);
    const weeklyAverage = weeklyTotal / 7;

    const threeDaysAgo = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
    const firstHalf = weekRecords
      .filter((r) => new Date(r.recordDate) < threeDaysAgo)
      .reduce((sum, r) => sum + r.count, 0);
    const secondHalf = weekRecords
      .filter((r) => new Date(r.recordDate) >= threeDaysAgo)
      .reduce((sum, r) => sum + r.count, 0);

    let trend: 'increasing' | 'stable' | 'decreasing' = 'stable';
    if (secondHalf > firstHalf * 1.5) {
      trend = 'increasing';
    } else if (secondHalf < firstHalf * 0.5) {
      trend = 'decreasing';
    }

    // Today's rate against the batch quantity that existed BEFORE this event:
    // re-derive from the batch's current quantity + this event's quantity.
    const batch = await this.batchRepository.findOne({
      where: { id: event.batchId, tenantId: event.tenantId },
    });
    const quantityBeforeMortality = (batch?.currentQuantity ?? 0) + event.quantity;
    const todayRate =
      quantityBeforeMortality > 0
        ? (todayCount / quantityBeforeMortality) * 100
        : 0;

    return { todayCount, todayRate, weeklyAverage, trend };
  }

  /**
   * Evaluate the configured thresholds against this event + trend and return
   * the breached alerts. Pure (no I/O) so it is trivially unit-testable.
   */
  evaluateMortalityAlerts(
    event: MortalityRecordedEvent,
    dailyMortality: { todayRate: number },
  ): MortalityAlert[] {
    const thresholds = DEFAULT_THRESHOLDS;
    const alerts: MortalityAlert[] = [];

    if (event.quantity >= thresholds.singleEventQuantity) {
      alerts.push({
        type: 'single_event',
        severity:
          event.quantity >= thresholds.singleEventQuantity * 2
            ? 'critical'
            : 'warning',
        message: `Single mortality event of ${event.quantity} fish recorded`,
      });
    }

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

    if (event.newMortalityRate >= thresholds.cumulativeRateCritical) {
      alerts.push({
        type: 'cumulative_rate',
        severity: 'critical',
        message: `Cumulative mortality rate ${event.newMortalityRate.toFixed(2)}% is critical`,
      });
    } else if (event.newMortalityRate >= thresholds.cumulativeRateWarning) {
      alerts.push({
        type: 'cumulative_rate',
        severity: 'warning',
        message: `Cumulative mortality rate ${event.newMortalityRate.toFixed(2)}% is elevated`,
      });
    }

    return alerts;
  }

  /**
   * Publish each breached alert onto the NATS bus as a first-class flat
   * `MortalityAlertRaised` (`@platform/event-contracts`) follow-up so the
   * alert-engine can convert it into a real AlertIncident. Distinct from the
   * alert-engine-owned `AlertTriggered`: a farm producer cannot supply
   * alertId/ruleId/channels/recipients, so it raises the lighter signal and the
   * alert-engine owns the conversion.
   *
   * FRESH IDENTITY (dead-listeners CRITICAL): each alert is minted with
   * `createBaseEvent` — a fresh branded `eventId` + timestamp — threading
   * `causationId = trigger.eventId` and `correlationId = trigger.correlationId`.
   * The previous code REUSED `trigger.eventId`, which NatsEventBus stamps as the
   * JetStream `msgID`; under the 2-minute `duplicate_window` every alert collided
   * with the still-resident trigger msgID and was silently dropped — the alert
   * was dead on the wire (CLAUDE.md rule 4).
   *
   * `recordedAt` is coerced from the wire ISO string (deserializeEvent returns
   * timestamps as strings; the contract types `mortalityDate`/`recordedAt` as Date).
   */
  private async publishMortalityAlerts(
    event: MortalityRecordedEvent,
    alerts: MortalityAlert[],
  ): Promise<void> {
    if (alerts.length === 0 || !this.eventBus) {
      return;
    }

    this.logger.warn(
      `[MortalityAlert] ${alerts.length} alert(s) triggered for batch ${event.batchId}`,
    );

    const recordedAt = new Date(event.mortalityDate);

    for (const alert of alerts) {
      const raised: MortalityAlertRaisedEvent = {
        ...createBaseEvent<MortalityAlertRaisedEvent>(
          'MortalityAlertRaised',
          event.tenantId,
          {
            causationId: event.eventId,
            correlationId: event.correlationId,
            userId: event.userId,
            aggregateId: event.batchId,
            aggregateType: 'Batch',
          },
        ),
        batchId: event.batchId,
        tankId: event.tankId,
        alertType: alert.type,
        severity: alert.severity,
        message: alert.message,
        mortalityRate: event.newMortalityRate,
        reason: event.reason,
        recordedAt: toEventIso(recordedAt),
      };
      await this.eventBus.publish(raised);
      this.logger.warn(`[${alert.severity.toUpperCase()}] ${alert.message}`);
    }
  }

  /**
   * Refresh batch mortality-by-cause statistics for observability/dashboards.
   */
  private async refreshBatchMortalityStats(
    event: MortalityRecordedEvent,
  ): Promise<void> {
    const batch = await this.batchRepository.findOne({
      where: { id: event.batchId, tenantId: event.tenantId },
    });
    if (!batch) {
      this.logger.warn(
        `Batch ${event.batchId} not found for mortality-stats refresh`,
      );
      return;
    }

    const causeStats = await this.getMortalityByCause(
      event.tenantId,
      event.batchId,
    );
    this.logger.debug(
      `Batch ${event.batchId} mortality by cause: ` +
        Object.entries(causeStats)
          .map(([cause, count]) => `${cause}: ${count}`)
          .join(', '),
    );

    if (event.tankId) {
      const tankBatch = await this.tankBatchRepository.findOne({
        where: { tankId: event.tankId, tenantId: event.tenantId },
      });
      if (tankBatch) {
        this.logger.debug(
          `Tank ${tankBatch.tankCode || tankBatch.tankId}: ` +
            `${tankBatch.totalQuantity} fish, ` +
            `${Number(tankBatch.totalBiomassKg).toFixed(2)}kg, ` +
            `density: ${Number(tankBatch.densityKgM3).toFixed(2)}kg/m3`,
        );
      }
    }
  }

  /**
   * Get mortality count grouped by cause for the batch.
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
}
