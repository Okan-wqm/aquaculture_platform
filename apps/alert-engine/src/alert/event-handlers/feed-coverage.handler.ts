/**
 * FeedCoverageEventHandler (Faz 7, plan §6)
 *
 * 07:00 kapsama süpürmesinin iki durable sinyalini tüketir:
 * `FeedStockoutForecast` + `FeedTransitionUpcoming` → FeedCoverageAlertService
 * (eşik kararı ve dedup orada). NATS handler'ları HTTP bağlamı dışında koşar —
 * tenant search_path bağlamı burada kurulur (FcrAlertEventHandler emsali).
 */
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type {
  BaseEvent,
  FeedStockoutForecastEvent,
  FeedTransitionUpcomingEvent,
} from '@platform/event-contracts';
import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';
import { requestContextStorage, RequestContext } from '@aquaculture/backend-common/logging';

import { FeedCoverageAlertService } from '../services/feed-coverage-alert.service';

@Injectable()
export class FeedCoverageEventHandler implements IEventHandler<BaseEvent>, OnModuleInit {
  private readonly logger = new Logger(FeedCoverageEventHandler.name);

  constructor(
    private readonly coverageAlertService: FeedCoverageAlertService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('FeedStockoutForecast', this);
    await this.eventBus.subscribeWildcard('FeedTransitionUpcoming', {
      getEventType: (): string => 'FeedTransitionUpcoming',
      handle: async (event: BaseEvent): Promise<void> => this.handle(event),
    });
    this.logger.log(
      'Subscribed to FeedStockoutForecast + FeedTransitionUpcoming (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'FeedStockoutForecast';
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
        if (event.eventType === 'FeedStockoutForecast') {
          await this.coverageAlertService.recordStockoutForecast(
            event as FeedStockoutForecastEvent,
          );
        } else if (event.eventType === 'FeedTransitionUpcoming') {
          await this.coverageAlertService.recordTransitionGap(
            event as FeedTransitionUpcomingEvent,
          );
        }
      });
    } catch (error) {
      // Swallow so NATS does not redeliver a poison message indefinitely —
      // ertesi 07:00 süpürmesi sinyali zaten yeniden üretir.
      this.logger.error(
        `Error creating feed-coverage incident: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
