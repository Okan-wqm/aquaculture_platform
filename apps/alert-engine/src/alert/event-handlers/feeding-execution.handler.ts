/**
 * FeedingExecutionEventHandler (plan §6 — feeding-execution tüketicisi)
 *
 * v2 motorunun dört durable yürütme sinyalini tüketir: `MealUnderfed`,
 * `MealMissed`, `UnfedUnitDetected` → incident; `FeedTypeTransitioned` →
 * INFO/audit satırı. Eşik/dedup kararları FeedingExecutionAlertService'te.
 * NATS handler'ları HTTP bağlamı dışında koşar — tenant search_path bağlamı
 * burada kurulur (FeedCoverageEventHandler emsali).
 */
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type {
  BaseEvent,
  FeedTypeTransitionedEvent,
  MealMissedEvent,
  MealUnderfedEvent,
  UnfedUnitDetectedEvent,
} from '@platform/event-contracts';
import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';
import { requestContextStorage, RequestContext } from '@aquaculture/backend-common/logging';

import { FeedingExecutionAlertService } from '../services/feeding-execution-alert.service';

const SUBSCRIBED_TYPES = [
  'MealUnderfed',
  'MealMissed',
  'UnfedUnitDetected',
  'FeedTypeTransitioned',
] as const;

@Injectable()
export class FeedingExecutionEventHandler implements IEventHandler<BaseEvent>, OnModuleInit {
  private readonly logger = new Logger(FeedingExecutionEventHandler.name);

  constructor(
    private readonly executionAlertService: FeedingExecutionAlertService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const eventType of SUBSCRIBED_TYPES) {
      await this.eventBus.subscribeWildcard(eventType, {
        getEventType: (): string => eventType,
        handle: async (event: BaseEvent): Promise<void> => this.handle(event),
      });
    }
    this.logger.log(`Subscribed to ${SUBSCRIBED_TYPES.join(' + ')} (cross-tenant wildcard)`);
  }

  getEventType(): string {
    return 'MealUnderfed';
  }

  async handle(event: BaseEvent): Promise<void> {
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        `${event.eventType} event has missing/invalid tenantId — skipping ` +
          'to prevent cross-tenant incident creation.',
      );
      return;
    }

    const context: RequestContext = {
      tenantId: event.tenantId,
      schemaName: getTenantSchemaName(event.tenantId),
      correlationId: event.correlationId,
    };

    try {
      await requestContextStorage.run(context, async () => {
        if (event.eventType === 'MealUnderfed') {
          await this.executionAlertService.recordMealUnderfed(event as MealUnderfedEvent);
        } else if (event.eventType === 'MealMissed') {
          await this.executionAlertService.recordMealMissed(event as MealMissedEvent);
        } else if (event.eventType === 'UnfedUnitDetected') {
          await this.executionAlertService.recordUnfedUnit(event as UnfedUnitDetectedEvent);
        } else if (event.eventType === 'FeedTypeTransitioned') {
          await this.executionAlertService.recordFeedTransitioned(
            event as FeedTypeTransitionedEvent,
          );
        }
      });
    } catch (error) {
      // Swallow so NATS does not redeliver a poison message indefinitely —
      // az-atım/missed/unfed sinyalleri sonraki cron döngüsünde yeniden üretilir.
      this.logger.error(
        `Error handling ${event.eventType}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
