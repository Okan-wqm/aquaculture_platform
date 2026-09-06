/**
 * HarvestCompletedListener
 *
 * Subscribes to the `BatchHarvested` NATS domain event (published by
 * CreateHarvestRecordHandler through the transactional outbox) and performs the
 * follow-up actions that close the harvest loop:
 *   - Advances batch status (partial harvest → HARVESTING; final → HARVESTED)
 *   - Generates a harvest report for dashboards
 *   - Publishes a regulatory/traceability follow-up event
 *   - Publishes a tank-cleared follow-up on a final, fully-emptied harvest
 *
 * WHY THIS WAS REWRITTEN (dead-listeners HIGH):
 *   The previous implementation subscribed via `@OnEvent(EventNames.HARVEST_COMPLETED)`
 *   on the in-process EventEmitter2 bus, expecting a `HarvestCompletedEventPayload`.
 *   But the producer (CreateHarvestRecordHandler) publishes ONLY through
 *   `@platform/outbox` → NATS, emitting the flat `@platform/event-contracts`
 *   `BatchHarvestedEvent`. Nothing ever emitted on the in-process bus, so the
 *   partial-harvest → HARVESTING transition and the regulatory follow-up were
 *   dead.
 *
 *   The fix mirrors the in-repo reference pattern (MortalityRecordedListener):
 *   implement `IEventHandler<BatchHarvestedEvent>` + `OnModuleInit` and
 *   `eventBus.subscribeWildcard('BatchHarvested', this)`. The handler body is
 *   remapped onto the contract's flat field names.
 *
 * FIELD REMAP (local payload → contract):
 *   The old `HarvestCompletedEventPayload` carried `batchNumber`, `harvestId`,
 *   `harvestedBiomass`, `avgWeight`, `isPartialHarvest`, `remainingQuantity`,
 *   `harvestedBy`, `qualityGrade`, `destinationInfo`. The wire contract
 *   `BatchHarvestedEvent` is flat and minimal: `batchId`, `harvestedQuantity`,
 *   `harvestedAt`, `averageWeight?`, `totalWeight?`, `isFinal?` (+ BaseEvent
 *   `userId`/`tenantId`). The crucial remap is `isPartialHarvest := !isFinal`
 *   (TOLERANT READER: a missing `isFinal` MUST be read as `false` → partial,
 *   per the contract docstring). `remainingQuantity` is re-derived from the
 *   batch's post-write `currentQuantity`. No contract field is invented.
 *
 * TENANT CONTEXT:
 *   NATS handlers run OUTSIDE the HTTP request context. All repository work is
 *   wrapped in `withTenantContext(event.tenantId, ...)` so the injected
 *   repositories route to the correct `tenant_<uuid>` schema via search_path.
 *
 * FRESH FOLLOW-UP IDENTITY (dead-listeners CRITICAL):
 *   Each follow-up (HarvestRegulatoryRecorded / TankCleared /
 *   BatchProductionCompleted) is minted with `createBaseEvent` — a FRESH branded
 *   `eventId` and timestamp — threading `causationId = trigger.eventId` and
 *   `correlationId = trigger.correlationId`. The previous code REUSED
 *   `trigger.eventId`, which NatsEventBus stamps as the JetStream `msgID`; with a
 *   2-minute `duplicate_window` on a single `events.>` stream every follow-up
 *   collided with the still-resident trigger msgID and was silently dropped. A
 *   fresh id per follow-up is the only correct fix (CLAUDE.md rule 4).
 *
 * INBOUND IDEMPOTENCY (dead-listeners HIGH):
 *   NATS is at-least-once and the consumer's `max_deliver` is 3. A redelivery of
 *   the SAME BatchHarvested would re-run the status transition AND re-publish the
 *   regulatory / tank-cleared / production-completed follow-ups — emitting
 *   duplicate regulatory records. A Redis `setNx` claim keyed by the trigger
 *   eventId (the same atomic primitive the alert-engine uses for cooldown) makes
 *   the side-effecting path run ONCE per trigger. The claim is RELEASED on
 *   failure so a legitimate retry can still proceed (claim-and-release).
 *
 * @module Events/Listeners
 */
import { isValidUUID } from '@aquaculture/backend-common/database';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { RedisService } from '@aquaculture/backend-common/redis';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import {
  toEventIso,
  createBaseEvent,
  type BatchHarvestedEvent,
  type BatchProductionCompletedEvent,
  type HarvestRegulatoryRecordedEvent,
  type TankClearedEvent,
} from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { Batch, BatchStatus } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';

/**
 * Harvest report structure (a subset of the original — fields that depend on
 * data NOT present on the flat contract are derived from the batch aggregate).
 */
export interface HarvestReport {
  batchId: string;
  harvestDate: Date;
  production: {
    initialQuantity: number;
    harvestedQuantity: number;
    harvestedBiomass: number;
    avgWeight: number;
    survivalRate: number;
    mortalityRate: number;
  };
  performance: {
    daysInProduction: number;
    fcr: number;
    sgr: number;
    totalFeedConsumed: number;
  };
  economics: {
    totalFeedCost: number;
    purchaseCost: number;
    estimatedRevenue: number;
    costPerKg: number;
  };
}

@Injectable()
export class HarvestCompletedListener implements IEventHandler<BatchHarvestedEvent>, OnModuleInit {
  private readonly logger = new Logger(HarvestCompletedListener.name);

  /**
   * Idempotency-claim TTL. Comfortably exceeds the consumer's redelivery window
   * (max_deliver 3 × ack_wait) so every retry of one trigger sees the claim,
   * while still expiring so the key space does not grow unbounded.
   */
  private static readonly DEDUP_TTL_SECONDS = 24 * 60 * 60; // 24h

  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
    // RedisService is provided globally (RedisModule @Global). @Optional() keeps
    // the listener constructible in NATS-/Redis-less unit harnesses; without it
    // the dedup guard is skipped (single-instance dev) but the publish path
    // still mints fresh ids, so correctness does not depend on Redis.
    //
    // The DI token is the RedisService class (@Inject(RedisService)); the TS
    // type is NARROWED to the two methods the listener actually uses
    // (Tier-1 "depend on exactly what you need") — this also lets unit tests
    // pass a minimal double with no unsafe casts cast.
    @Optional()
    @Inject(RedisService)
    private readonly redisService?: Pick<RedisService, 'setNx' | 'del'>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — BatchHarvested subscription skipped. ' +
          'Harvest status transitions and regulatory follow-ups will not fire.',
      );
      return;
    }

    // `subscribeWildcard` builds `events.*.BatchHarvested`, matching the
    // producer's per-tenant `events.{tenantId}.BatchHarvested`.
    await this.eventBus.subscribeWildcard('BatchHarvested', this);
    this.logger.log(
      'Subscribed to BatchHarvested events for status transitions and ' +
        'regulatory follow-ups (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'BatchHarvested';
  }

  /**
   * Handle a BatchHarvested contract event.
   *
   * Fault-tolerant: the harvest record is already committed (outbox guarantee),
   * so a failure here is a bounded retry (the idempotency claim is released
   * first), dead-lettered once the consumer's delivery budget is spent —
   * never a silent acknowledgement (PLAT-HIGH-902).
   */
  async handle(event: BatchHarvestedEvent): Promise<HandlerOutcome> {
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'BatchHarvested event has missing/invalid tenantId — skipping to ' +
          'prevent cross-tenant status corruption.',
      );
      return HandlerOutcome.terminate('BatchHarvested: missing or invalid tenantId');
    }

    // TOLERANT READER (contract mandate): a missing/undefined `isFinal` MUST be
    // treated as `false` (partial). Defaulting to `true` would wrongly advance
    // batches to HARVESTED on replayed v1 events.
    const isFinal = event.isFinal === true;

    this.logger.log(
      `[BatchHarvested] Processing batch=${event.batchId} ` +
        `quantity=${event.harvestedQuantity} ` +
        `totalWeight=${event.totalWeight ?? 'n/a'} isFinal=${isFinal} ` +
        `tenant=${event.tenantId.substring(0, 8)}...`,
    );

    // INBOUND IDEMPOTENCY: claim this trigger eventId atomically. If the claim
    // was already taken, a prior delivery already ran the side effects — skip to
    // avoid duplicate regulatory / tank-cleared / production-completed events.
    const claimed = await this.claimEvent(event);
    if (!claimed) {
      this.logger.log(
        `[BatchHarvested] eventId=${event.eventId} already processed — ` +
          'skipping to avoid duplicate follow-ups.',
      );
      return HandlerOutcome.ack();
    }

    try {
      await withTenantContext(event.tenantId, async () => {
        // 1. Advance batch status (the real, previously-dead side effect).
        const remainingQuantity = await this.updateBatchStatus(event, isFinal);

        // 2. Generate a harvest report for dashboards.
        const report = await this.generateHarvestReport(event);

        // 3. Publish follow-up events (regulatory + tank-cleared) onto the bus.
        await this.publishFollowUps(event, isFinal, remainingQuantity, report);
      });

      this.logger.log(`[BatchHarvested] Successfully processed batch=${event.batchId}`);
      return HandlerOutcome.ack();
    } catch (error) {
      // Release the idempotency claim so the redelivery (NATS max_deliver)
      // can retry the side effects rather than being permanently suppressed
      // by a transient failure.
      await this.releaseEvent(event);
      this.logger.error(
        `[BatchHarvested] Failed to process batch=${event.batchId}: ` +
          `${(error as Error).message}`,
        (error as Error).stack,
      );
      return HandlerOutcome.retry(
        `BatchHarvested: follow-ups failed for batch ${event.batchId}`,
        error,
      );
    }
  }

  /** Redis key for the inbound idempotency claim of one trigger eventId. */
  private dedupKey(event: BatchHarvestedEvent): string {
    return `harvest-listener:processed:${event.tenantId}:${event.eventId}`;
  }

  /**
   * Atomically claim this trigger eventId. Returns true when this delivery won
   * the claim (first to process), false when a prior delivery already claimed
   * it. When Redis is unavailable the claim is treated as won (best-effort
   * single-instance dev) — fresh follow-up ids still prevent the msgID-collision
   * class, so duplicate-suppression degrades gracefully without breaking output.
   */
  private async claimEvent(event: BatchHarvestedEvent): Promise<boolean> {
    if (!this.redisService) {
      return true;
    }
    try {
      return await this.redisService.setNx(
        this.dedupKey(event),
        '1',
        HarvestCompletedListener.DEDUP_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(`Idempotency claim failed (treating as won): ${(error as Error).message}`);
      return true;
    }
  }

  /** Release a previously-won claim so a redelivery can retry after a failure. */
  private async releaseEvent(event: BatchHarvestedEvent): Promise<void> {
    if (!this.redisService) {
      return;
    }
    try {
      await this.redisService.del(this.dedupKey(event));
    } catch (error) {
      this.logger.warn(`Idempotency claim release failed: ${(error as Error).message}`);
    }
  }

  /**
   * Advance batch status based on harvest finality and return the batch's
   * post-write `currentQuantity` (the contract carries no `remainingQuantity`,
   * so it is the source of truth derived from the aggregate).
   */
  private async updateBatchStatus(event: BatchHarvestedEvent, isFinal: boolean): Promise<number> {
    const batch = await this.batchRepository.findOne({
      where: { id: event.batchId, tenantId: event.tenantId },
    });

    if (!batch) {
      this.logger.warn(`Batch ${event.batchId} not found for status update`);
      return 0;
    }

    if (!isFinal) {
      // Partial harvest — advance to HARVESTING if not already there. The
      // producer already moves the batch to HARVESTED on a FINAL harvest, so
      // this listener owns ONLY the partial → HARVESTING signal.
      if (batch.status !== BatchStatus.HARVESTING) {
        batch.status = BatchStatus.HARVESTING;
        batch.statusChangedAt = new Date();
        batch.statusReason = 'Partial harvest in progress';
        batch.updatedBy = event.userId;
        await this.batchRepository.save(batch);
        this.logger.log(`Batch ${event.batchId} status updated to HARVESTING`);
      }
    }

    return batch.currentQuantity ?? 0;
  }

  /**
   * Generate a harvest report from the batch aggregate + the contract figures.
   */
  private async generateHarvestReport(event: BatchHarvestedEvent): Promise<HarvestReport> {
    const batch = await this.batchRepository.findOne({
      where: { id: event.batchId, tenantId: event.tenantId },
    });

    if (!batch) {
      throw new Error(`Batch ${event.batchId} not found for harvest report`);
    }

    const daysInProduction = batch.getDaysInProduction();
    const survivalRate = batch.getSurvivalRate();
    const mortalityRate = batch.getMortalityRate();

    const harvestedBiomass = event.totalWeight ?? 0;
    const estimatedPricePerKg = 50; // TODO: source from config-service
    const estimatedRevenue = harvestedBiomass * estimatedPricePerKg;
    const totalCost = (batch.totalFeedCost || 0) + (batch.purchaseCost || 0);
    const costPerKg = harvestedBiomass > 0 ? totalCost / harvestedBiomass : 0;

    const report: HarvestReport = {
      batchId: event.batchId,
      // WIRE FIDELITY (dead-listeners HIGH): NatsEventBus.deserializeEvent
      // returns timestamps as ISO STRINGS (JSON has no Date), but the contract
      // types `harvestedAt` as Date and HarvestReport.harvestDate is Date. Coerce
      // at the boundary so this never assigns a string into a Date-typed field.
      harvestDate: new Date(event.harvestedAt),
      production: {
        initialQuantity: batch.initialQuantity,
        harvestedQuantity: event.harvestedQuantity,
        harvestedBiomass,
        avgWeight: event.averageWeight ?? 0,
        survivalRate,
        mortalityRate,
      },
      performance: {
        daysInProduction,
        fcr: batch.fcr?.actual || 0,
        sgr: batch.sgr || 0,
        totalFeedConsumed: batch.totalFeedConsumed || 0,
      },
      economics: {
        totalFeedCost: batch.totalFeedCost || 0,
        purchaseCost: batch.purchaseCost || 0,
        estimatedRevenue,
        costPerKg,
      },
    };

    this.logger.log(
      `[HarvestReport] Batch ${event.batchId}: ` +
        `FCR: ${report.performance.fcr.toFixed(2)}, ` +
        `Survival: ${survivalRate.toFixed(1)}%, ` +
        `Days: ${daysInProduction}, Cost/kg: ${costPerKg.toFixed(2)}`,
    );

    return report;
  }

  /**
   * Publish the harvest follow-up events onto the NATS bus as FIRST-CLASS flat
   * `@platform/event-contracts` events, each with a FRESH `createBaseEvent`
   * identity (see class header for the msgID-collision rationale):
   *   - HarvestRegulatoryRecorded → notification-service (traceability)
   *   - TankCleared               → gateway FarmNatsBridge → tenant room
   *   - BatchProductionCompleted  → gateway FarmNatsBridge → tenant room
   *
   * `causationId` threads back to the trigger event; `correlationId` carries the
   * trigger's correlation so the whole chain is traceable end-to-end.
   */
  private async publishFollowUps(
    event: BatchHarvestedEvent,
    isFinal: boolean,
    remainingQuantity: number,
    report: HarvestReport,
  ): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    // WIRE FIDELITY: coerce the wire ISO string once for every Date-typed
    // contract field below.
    const harvestedAt = new Date(event.harvestedAt);

    // Shared identity threading for every follow-up minted from this trigger.
    const lineage = {
      causationId: event.eventId,
      correlationId: event.correlationId,
      userId: event.userId,
      aggregateId: event.batchId,
      aggregateType: 'Batch' as const,
    };

    // Regulatory / traceability follow-up — ALWAYS published (every harvest is
    // a traceability event for food-safety recall chains).
    const regulatory: HarvestRegulatoryRecordedEvent = {
      ...createBaseEvent<HarvestRegulatoryRecordedEvent>(
        'HarvestRegulatoryRecorded',
        event.tenantId,
        lineage,
      ),
      batchId: event.batchId,
      harvestedQuantity: event.harvestedQuantity,
      totalWeight: event.totalWeight,
      averageWeight: event.averageWeight,
      harvestedAt: toEventIso(harvestedAt),
      harvestedBy: event.userId,
      isFinal,
    };
    await this.eventBus.publish(regulatory);

    // Tank-cleared follow-up — only on a final harvest that emptied the batch.
    if (isFinal && remainingQuantity === 0) {
      const tankBatches = await this.tankBatchRepository.find({
        where: { tenantId: event.tenantId, primaryBatchId: event.batchId },
      });

      for (const tankBatch of tankBatches) {
        this.logger.log(
          `Tank ${tankBatch.tankCode || tankBatch.tankId} cleared after final harvest`,
        );
        const tankCleared: TankClearedEvent = {
          ...createBaseEvent<TankClearedEvent>('TankCleared', event.tenantId, {
            ...lineage,
            aggregateId: tankBatch.tankId,
            aggregateType: 'Tank',
          }),
          tankId: tankBatch.tankId,
          tankCode: tankBatch.tankCode,
          previousBatchId: event.batchId,
          clearedAt: toEventIso(harvestedAt),
        };
        await this.eventBus.publish(tankCleared);
      }

      // Batch-production-completed follow-up carries the frozen report,
      // FLATTENED per ADR-006 (no nested performance/production objects).
      const completed: BatchProductionCompletedEvent = {
        ...createBaseEvent<BatchProductionCompletedEvent>(
          'BatchProductionCompleted',
          event.tenantId,
          lineage,
        ),
        batchId: event.batchId,
        initialQuantity: report.production.initialQuantity,
        harvestedQuantity: report.production.harvestedQuantity,
        harvestedBiomassKg: report.production.harvestedBiomass,
        avgWeightG: report.production.avgWeight,
        survivalRate: report.production.survivalRate,
        mortalityRate: report.production.mortalityRate,
        daysInProduction: report.performance.daysInProduction,
        fcr: report.performance.fcr,
        sgr: report.performance.sgr,
        totalFeedConsumedKg: report.performance.totalFeedConsumed,
        completedAt: toEventIso(harvestedAt),
      };
      await this.eventBus.publish(completed);
    }
  }
}
