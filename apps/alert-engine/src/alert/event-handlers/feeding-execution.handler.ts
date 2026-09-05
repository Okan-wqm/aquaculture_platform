/**
 * FeedingExecutionEventHandler (plan §6 — feeding-execution tüketicisi)
 *
 * v2 motorunun dört durable yürütme sinyalini tüketir: `MealUnderfed`,
 * `MealMissed`, `UnfedUnitDetected` → incident; `FeedTypeTransitioned` →
 * INFO/audit satırı. Eşik/dedup kararları FeedingExecutionAlertService'te.
 * NATS handler'ları HTTP bağlamı dışında koşar — tenant search_path bağlamı
 * burada kurulur (FeedCoverageEventHandler emsali).
 *
 * HATA POLİTİKASI (W7 / D-B5 — FARM-MEDIUM-260): burada karar YOK. Sınıf
 * event'in kendi sözleşmesinden okunur (`FARM_SIGNAL_DELIVERY_SEMANTICS`):
 * `one_shot` sinyaller (MealMissed/MealUnderfed/FeedTypeTransitioned) hatayı
 * YENİDEN FIRLATIR — event-bus NAK'lar, `max_deliver` tükenince
 * platform dead-letter akışına (AQUACULTURE_DLQ) yazar; `reproducible` sinyaller (UnfedUnitDetected)
 * loglanıp yutulur çünkü 06:00 üretimi ertesi gün yeniden tespit eder.
 * Abonelik listesi de aynı registry'den türetilir: sınıfsız bir event'e
 * abone olmak DERLENMEZ.
 */
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { requiresDurableDelivery } from '@platform/event-contracts';
import type {
  BaseEvent,
  ConsumedFarmSignalEventType,
  FeedTypeTransitionedEvent,
  FeedingWindowReadinessEvent,
  MealMissedEvent,
  MealUnderfedEvent,
  UnfedUnitDetectedEvent,
} from '@platform/event-contracts';
import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';
import { requestContextStorage, RequestContext } from '@aquaculture/backend-common/logging';

import { FeedingExecutionAlertService } from '../services/feeding-execution-alert.service';

/**
 * `ConsumedFarmSignalEventType` ile tiplenmiştir — buraya sınıflandırılmamış bir
 * event adı yazmak derleme hatasıdır (tier-1).
 */
const SUBSCRIBED_TYPES: readonly ConsumedFarmSignalEventType[] = [
  'MealUnderfed',
  'MealMissed',
  'UnfedUnitDetected',
  'FeedTypeTransitioned',
  // W7/FARM-MEDIUM-271 — sensor-service'in öğün öncesi oksijen verdiktleri.
  'FeedingWindowReadiness',
];

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
        } else if (event.eventType === 'FeedingWindowReadiness') {
          await this.executionAlertService.recordFeedingWindowReadiness(
            event as FeedingWindowReadinessEvent,
          );
        }
      });
    } catch (error) {
      this.logger.error(
        `Error handling ${event.eventType}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      if (requiresDurableDelivery(event.eventType)) {
        // Tek-atımlık durum geçişi: yutmak "bu tank aç kaldı" gerçeğini SİLER.
        // Yeniden fırlat → NAK + backoff → tükenince platform dead-letter akışı (AQUACULTURE_DLQ).
        throw error;
      }
      // Yeniden üretilebilir sinyal: 06:00 üretimi aynı tespiti yarın tekrar
      // yapar, zehirli mesajı sonsuz yeniden teslime sokmanın faydası yok.
    }
  }
}
