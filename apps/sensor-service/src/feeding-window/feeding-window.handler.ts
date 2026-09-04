/**
 * FeedingWindowEventHandler (W7 — FARM-MEDIUM-271, user decision 4)
 *
 * The real consumer of `MealWindowUpcoming`. Before this handler the event was
 * a dead end: farm published it every 15 minutes, stamped `windowNotifiedAt`
 * in the same transaction (so it could never be replayed), and nothing on the
 * platform read `minDissolvedOxygen` / `lowOxygenReductionPercent`. An
 * operator who set an oxygen floor in the protocol got no behaviour from it.
 *
 * Now: each batch is evaluated against the tenant's live DO readings and every
 * NON-ready unit produces a `FeedingWindowReadiness` event, consumed by
 * alert-engine (WARNING incident) and farm-service (meal badge on the
 * MealBoard). VFD/aerator actuation remains future work — but the event is no
 * longer a dead end, and the fields it carries now change what an operator
 * sees before the feed starts.
 *
 * ERROR POLICY (D-B5): `MealWindowUpcoming` is classified `reproducible` — the
 * 15-minute cron re-emits for any meal still inside its lead window, so a lost
 * batch costs at most one tick of lead time. Errors are logged and swallowed
 * rather than NAK'd into a redelivery storm.
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { isValidUUID } from '@aquaculture/backend-common/database';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import type {
  FeedingWindowReadinessEvent,
  MealWindowUpcomingEvent,
} from '@platform/event-contracts';

import { FeedingWindowReadinessService } from './feeding-window-readiness.service';

@Injectable()
export class FeedingWindowEventHandler
  implements IEventHandler<MealWindowUpcomingEvent>, OnModuleInit
{
  private readonly logger = new Logger(FeedingWindowEventHandler.name);

  constructor(
    private readonly readinessService: FeedingWindowReadinessService,
    // Optional for the same reason as SensorCacheInvalidationHandler: unit
    // tests of unrelated modules build sensor-service without a broker.
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn('EVENT_BUS not provided; FeedingWindowEventHandler will not subscribe');
      return;
    }
    await this.eventBus.subscribeWildcard<MealWindowUpcomingEvent>('MealWindowUpcoming', this);
    this.logger.log(
      'Subscribed to MealWindowUpcoming for pre-meal oxygen readiness (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'MealWindowUpcoming';
  }

  async handle(event: MealWindowUpcomingEvent): Promise<void> {
    // SECURITY: tenantId becomes a schema name inside runInTenantRead.
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'MealWindowUpcoming event has missing/invalid tenantId — skipping ' +
          'to prevent cross-tenant sensor reads.',
      );
      return;
    }

    if (!Array.isArray(event.meals) || event.meals.length === 0) {
      return;
    }

    try {
      const verdicts = await this.readinessService.evaluate(event.tenantId, event.meals);
      if (verdicts.length === 0) {
        return;
      }

      const bus = this.eventBus;
      if (!bus) {
        return;
      }

      for (const verdict of verdicts) {
        const readiness: FeedingWindowReadinessEvent = {
          ...createBaseEvent<FeedingWindowReadinessEvent>(
            'FeedingWindowReadiness',
            event.tenantId,
            {
              correlationId: event.correlationId,
              causationId: String(event.eventId),
              aggregateId: verdict.entry.mealId,
              aggregateType: 'FeedingMeal',
            },
          ),
          unitId: verdict.entry.unitId,
          unitCode: verdict.entry.unitCode,
          mealId: verdict.entry.mealId,
          dayPlanId: verdict.entry.dayPlanId,
          scheduledAt: verdict.entry.scheduledAt,
          status: verdict.status,
          minDissolvedOxygen: verdict.entry.minDissolvedOxygen ?? 0,
          observedDissolvedOxygen: verdict.observedDissolvedOxygen,
          observedAt: verdict.observedAt,
          lowOxygenReductionPercent: verdict.entry.lowOxygenReductionPercent,
        };
        await bus.publish<FeedingWindowReadinessEvent>(readiness);
      }

      this.logger.warn(
        `Published ${verdicts.length} FeedingWindowReadiness verdict(s) for tenant ` +
          `${event.tenantId.substring(0, 8)}... (window ${event.windowStart}–${event.windowEnd})`,
      );
    } catch (error) {
      // Reproducible signal — the next 15-minute tick re-evaluates any meal
      // still inside its lead window (D-B5).
      this.logger.error(
        `Feeding-window readiness evaluation failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
