import { isValidUUID } from '@aquaculture/backend-common/database';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import {
  createBaseEvent,
  requiresDurableDelivery,
  type FeedingWindowReadinessEvent,
  type MealWindowUpcomingEvent,
} from '@platform/event-contracts';

import { FeedingWindowReadinessService } from './feeding-window-readiness.service';

@Injectable()
export class FeedingWindowEventHandler
  implements IEventHandler<MealWindowUpcomingEvent>, OnModuleInit
{
  private readonly logger = new Logger(FeedingWindowEventHandler.name);

  constructor(
    private readonly readinessService: FeedingWindowReadinessService,
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('MealWindowUpcoming', this);
  }

  getEventType(): string {
    return 'MealWindowUpcoming';
  }

  async handle(event: MealWindowUpcomingEvent): Promise<void> {
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      throw new Error('MealWindowUpcoming requires a valid tenantId');
    }
    if (!Array.isArray(event.meals) || event.meals.length === 0) return;

    try {
      const evaluatedAt = new Date(event.timestamp);
      const verdicts = await this.readinessService.evaluate(
        event.tenantId,
        event.meals,
        evaluatedAt,
      );
      if (verdicts.length === 0) return;

      const readiness: FeedingWindowReadinessEvent = {
        ...createBaseEvent<FeedingWindowReadinessEvent>('FeedingWindowReadiness', event.tenantId, {
          correlationId: event.correlationId,
          causationId: String(event.eventId),
          aggregateId: String(event.eventId),
          aggregateType: 'MealWindow',
        }),
        schemaVersion: 'feeding-window-readiness/v1',
        sourceWindowEventId: String(event.eventId),
        windowStart: event.windowStart,
        windowEnd: event.windowEnd,
        evaluatedAt: evaluatedAt.toISOString(),
        batchIndex: event.batchIndex,
        batchCount: event.batchCount,
        verdicts,
      };
      await this.eventBus.publish(readiness);
    } catch (error) {
      this.logger.error(
        `Feeding-window readiness evaluation failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
      if (requiresDurableDelivery(event.eventType)) throw error;
    }
  }
}
